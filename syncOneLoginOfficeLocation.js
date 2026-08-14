const fs = require('fs');
const path = require('path');
const { populateWorkerData } = require('./adpWorkerFetch');
const { getAllCompaniesCached } = require('./hubspotRead');
const { oneLoginClient } = require('./oneLoginAuth');
const { classifyJobTitle, getPrimaryWorkAssignment, extractAssociateId, extractFullName, isTestEmployee } = require('./workerRoleFormatter');
const { rowsToCsv } = require('./csvUtils');
const { writeToken, readToken } = require('./tokenStore');
const { logger, logRunBoundary } = require('./oneLoginLogger');

const VALIDATION_REPORT_PATH = path.join(__dirname, 'reports', 'adoOfficeLocationValidation.csv');

// Own cache, separate from adpWorkerFetch.js's getAllADPWorkers() cache (whose
// isFresh check is currently hardcoded to true and crashes on a null cached
// value) - this one does the freshness check properly.
const ADP_WORKERS_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

/*
    Fetches OneLogin's current custom attribute definitions so we can confirm
    the exact internal field name for "office location" before ever writing to
    it - read-only, no patch involved.
*/
async function getOneLoginCustomAttributes() {
    try {
        const response = await oneLoginClient.get('/api/2/users/custom_attributes');
        logger.info('Fetched OneLogin custom attributes', { attributes: response.data });
        return response.data;
    } catch (error) {
        logger.error('Failed to fetch OneLogin custom attributes', { error: error.message });
        throw error;
    }
}

/*
    Home work location's clinic ID - nameCode.codeValue (e.g. "B284"), NOT the
    longName ("Brookdale Montclair Pouls-B284"). Per exportOtherWorksites.js,
    the longName is a human-readable label; the short codeValue is what
    matches HubSpot's clinic_id property format.
*/
function getHomeClinicId(assignment) {
    return assignment.homeWorkLocation &&
        assignment.homeWorkLocation.nameCode &&
        assignment.homeWorkLocation.nameCode.codeValue;
}

function getWorkEmail(worker) {
    const emails = worker.businessCommunication && worker.businessCommunication.emails;
    if (!emails || emails.length === 0) return null;
    return emails[0].emailUri || null;
}

/*
    Pulls active + on-leave ADP workers, caching the raw combined array to disk
    (tokens/onelogin_syncAdpWorkersCache.json) for ADP_WORKERS_CACHE_TTL_MS so
    repeated test runs of this script don't re-pull every worker from ADP each
    time. Pass forceRefresh: true to bypass the cache and pull fresh data.
*/
async function getAdpWorkers({ forceRefresh = false } = {}) {
    if (!forceRefresh) {
        const cached = await readToken('onelogin_syncAdpWorkersCache');
        const isFresh = cached && (Date.now() - cached.timeStamp) < ADP_WORKERS_CACHE_TTL_MS;
        if (isFresh) {
            logger.info('Using cached ADP workers', { count: cached.workers.length });
            return cached.workers;
        }
    }

    const activeWorkers = await populateWorkerData(99999, 'A');
    const leaveWorkers = await populateWorkerData(99999, 'L');
    const workers = activeWorkers.concat(leaveWorkers);

    await writeToken({ workers, timeStamp: Date.now() }, 'onelogin_syncAdpWorkersCache');
    return workers;
}

/*
    Pure filter over an already-fetched worker list - factored out so
    getPeopleToSync/generateValidationReport can fetch ADP data ONCE and
    derive both ADOs and Care Coordinators from it, instead of each of
    getActiveAdos/getAllActiveCareCoordinators independently calling
    getAdpWorkers (which, with forceRefresh: true, means a full fresh ADP
    pull happening twice in the same run).
*/
function extractActiveAdos(workers) {
    const ados = [];
    for (const worker of workers) {
        if (isTestEmployee(worker)) continue;

        const assignment = getPrimaryWorkAssignment(worker);
        if (!assignment) continue;

        const jobCode = assignment.jobCode && assignment.jobCode.codeValue;
        if (classifyJobTitle(jobCode) !== 'ado') continue;

        const associateId = extractAssociateId(worker);
        const email = getWorkEmail(worker);
        const fullName = extractFullName(worker);
        const homeClinicId = getHomeClinicId(assignment);
        if (!associateId || !email) {
            logger.warn('Skipping ADO missing associateId or work email', { associateId, email });
            continue;
        }

        ados.push({ associateId, email, fullName, homeClinicId });
    }
    return ados;
}

/*
    Pulls every ADO (active + on-leave, terminated ignored) from ADP, keyed by
    associateId, with their work email and home clinic ID. Thin wrapper
    around extractActiveAdos for standalone callers - getPeopleToSync/
    generateValidationReport fetch workers themselves and call
    extractActiveAdos directly instead, to avoid a duplicate ADP pull.
*/
async function getActiveAdos({ forceRefresh = false } = {}) {
    const workers = await getAdpWorkers({ forceRefresh });
    return extractActiveAdos(workers);
}

/*
    ADP's primary work assignment carries a "reportsTo" array naming the
    direct manager - per the user, everyone has exactly one entry, so this
    just takes the first one rather than handling multiple managers.
*/
function extractManagerAssociateId(assignment) {
    const reportsTo = assignment.reportsTo;
    return (reportsTo && reportsTo[0] && reportsTo[0].workerID && reportsTo[0].workerID.idValue) || null;
}

/*
    Manager's display name for a Care Coordinator - prefers looking their
    associateId up among the same worker pool (gives the "First Last" format
    used everywhere else in this project), falling back to ADP's own
    reportsToWorkerName.formattedName ("Last, First") if the manager isn't in
    that pool for some reason (e.g. a manager who isn't active/on-leave).
*/
function getManagerFullName(assignment, fullNameByAssociateId, managerAssociateId) {
    if (managerAssociateId && fullNameByAssociateId.has(managerAssociateId)) {
        return fullNameByAssociateId.get(managerAssociateId);
    }
    const reportsTo = assignment.reportsTo;
    return (reportsTo && reportsTo[0] && reportsTo[0].reportsToWorkerName && reportsTo[0].reportsToWorkerName.formattedName) || null;
}

/*
    Pure filter over an already-fetched worker list - same reasoning as
    extractActiveAdos above. Finds EVERY active/on-leave Care Coordinator
    (job code CARECOOR), regardless of who they report to.
*/
function extractAllActiveCareCoordinators(workers) {
    const fullNameByAssociateId = new Map();
    for (const worker of workers) {
        const id = extractAssociateId(worker);
        const name = extractFullName(worker);
        if (id && name) fullNameByAssociateId.set(id, name);
    }

    const careCoordinators = [];
    for (const worker of workers) {
        if (isTestEmployee(worker)) continue;

        const assignment = getPrimaryWorkAssignment(worker);
        if (!assignment) continue;

        const jobCode = assignment.jobCode && assignment.jobCode.codeValue;
        if (classifyJobTitle(jobCode) !== 'carecoord') continue;

        const associateId = extractAssociateId(worker);
        const email = getWorkEmail(worker);
        const fullName = extractFullName(worker);
        const homeClinicId = getHomeClinicId(assignment);
        const managerAssociateId = extractManagerAssociateId(assignment);
        const managerFullName = getManagerFullName(assignment, fullNameByAssociateId, managerAssociateId);
        if (!associateId || !email) {
            logger.warn('Skipping Care Coordinator missing associateId or work email', { associateId, email });
            continue;
        }

        careCoordinators.push({ associateId, email, fullName, homeClinicId, managerAssociateId, managerFullName });
    }
    return careCoordinators;
}

/*
    Pulls EVERY active/on-leave Care Coordinator (job code CARECOOR),
    regardless of who they report to - used for the validation report, so a
    reviewer can see every Care Coordinator's manager and whether that
    manager is currently an ADO (i.e., whether they'd actually get synced by
    run()), not just the ones that already qualify. Thin wrapper around
    extractAllActiveCareCoordinators - getPeopleToSync/generateValidationReport
    fetch workers themselves and call the extract function directly instead,
    to avoid a duplicate ADP pull.
*/
async function getAllActiveCareCoordinators({ forceRefresh = false } = {}) {
    const workers = await getAdpWorkers({ forceRefresh });
    return extractAllActiveCareCoordinators(workers);
}

/*
    Pulls only the subset of getAllActiveCareCoordinators whose direct manager
    is currently an active ADO - everyone else is left completely untouched
    by this script, per the requirement that only Care Coordinators reporting
    to an ADO get their office location synced. This is what run() actually
    uses. adoAssociateIds: Set of active ADO associate IDs (see getActiveAdos).
*/
async function getActiveCareCoordinatorsReportingToAdo(adoAssociateIds, { forceRefresh = false } = {}) {
    const allCareCoordinators = await getAllActiveCareCoordinators({ forceRefresh });
    return allCareCoordinators.filter(cc => cc.managerAssociateId && adoAssociateIds.has(cc.managerAssociateId));
}

/*
    Pulls every in-scope HubSpot company ONCE (cached, 6hr TTL - see
    getAllCompaniesCached) and indexes it by 'ard' value -> clinic_id list, so
    every ADO's lookup afterward is a plain in-memory Map read instead of a
    live search call per person.

    Keyed on the 'ard' dropdown property's value equal to the ADO's
    associateId - matches getCompaniesByPropertyValue's convention elsewhere
    in this project. Only valid AFTER migrateLegacyOptions.js has run and
    reassigned companies off their old name-keyed values - before that, 'ard'
    values are still names, not associateIds, and this index would come back
    empty. (Previously keyed by fullName, pre-migration - see git history if
    that's ever needed again.)
*/
async function buildHubspotClinicIdsByAdoId({ forceRefresh = false } = {}) {
    const companies = await getAllCompaniesCached(['name', 'clinic_id', 'ard'], { forceRefresh });

    const clinicIdsByAssociateId = new Map();
    for (const company of companies) {
        const ardValue = company.properties.ard;
        const clinicId = company.properties.clinic_id;
        if (!ardValue || !clinicId) continue;

        if (!clinicIdsByAssociateId.has(ardValue)) clinicIdsByAssociateId.set(ardValue, []);
        clinicIdsByAssociateId.get(ardValue).push(clinicId);
    }
    return clinicIdsByAssociateId;
}

/*
    Combines a person's own home clinic ID with a set of HubSpot clinic IDs,
    deduped, as a comma-separated string. Used both for an ADO (their own
    home + their own HubSpot 'ard' companies) and for a Care Coordinator who
    reports to an ADO (their own home + THAT ADO's HubSpot 'ard' companies).
*/
function buildOfficeLocationValue(homeClinicId, hubspotClinicIds) {
    const combined = new Set();
    if (homeClinicId) combined.add(homeClinicId);
    for (const clinicId of hubspotClinicIds) combined.add(clinicId);
    return Array.from(combined).join(',');
}

/*
    Builds the full list of people this script syncs office locations for:
    every active/on-leave ADO (their own home + own HubSpot clinics), plus
    every active/on-leave Care Coordinator reporting to one of those ADOs
    (their own home + their MANAGER's HubSpot clinics, not the manager's home
    location). Care Coordinators not reporting to an ADO are never included.

    forceRefresh defaults to true - this script always wants current ADP AND
    HubSpot data (same reasoning as syncOrchestrator.js's runSync forcing a
    fresh ADP pull): a stale HubSpot cache is exactly what caused a Care
    Coordinator to inherit a clinic their manager no longer owns (see A252/
    Piatt County Nursing Home incident - clinic_id had been reassigned to a
    different ADO within the 6hr cache window).
*/
async function getPeopleToSync({ forceRefresh = true } = {}) {
    // One ADP pull, shared - see extractActiveAdos/extractAllActiveCareCoordinators.
    const workers = await getAdpWorkers({ forceRefresh });
    const ados = extractActiveAdos(workers);
    const clinicIdsByAdoId = await buildHubspotClinicIdsByAdoId({ forceRefresh });
    const adoAssociateIds = new Set(ados.map(a => a.associateId));

    const careCoordinators = extractAllActiveCareCoordinators(workers)
        .filter(cc => cc.managerAssociateId && adoAssociateIds.has(cc.managerAssociateId));

    const people = [];
    for (const ado of ados) {
        people.push({
            associateId: ado.associateId,
            email: ado.email,
            fullName: ado.fullName,
            role: 'ado',
            hubspotClinicIds: clinicIdsByAdoId.get(ado.associateId) || [],
            homeClinicId: ado.homeClinicId
        });
    }
    for (const cc of careCoordinators) {
        people.push({
            associateId: cc.associateId,
            email: cc.email,
            fullName: cc.fullName,
            role: 'carecoord',
            hubspotClinicIds: clinicIdsByAdoId.get(cc.managerAssociateId) || [],
            homeClinicId: cc.homeClinicId
        });
    }
    return people;
}


/*
    Finds the OneLogin user matching this ADO's ADP associate ID, via the
    "ADP ID [AQUERA]" custom attribute (shortname: adpid) - confirmed to hold
    the same value as ADP's workerID.idValue, and confirmed filterable
    directly via OneLogin's Users API (custom_attributes.adpid query param).
    More reliable than matching by email (no typo/alias/rename risk).

    IMPORTANT: the custom_attributes.adpid-filtered list response only
    includes a stripped-down user object (just email/id, no custom_attributes
    at all) - confirmed empirically. So once a match is found by ID, this
    does a second GET for that specific user to get the FULL record
    (including current custom_attributes.officelocation) - without this,
    "current value" would always read back as empty/undefined regardless of
    what's actually set.

    Returns null if no match is found (rather than throwing), so the caller
    can log and skip.
*/
async function findOneLoginUserByAssociateId(associateId) {
    try {
        const response = await oneLoginClient.get('/api/2/users', {
            params: { 'custom_attributes.adpid': associateId }
        });
        const users = response.data;
        if (!users || users.length === 0) return null;

        const fullUser = await oneLoginClient.get(`/api/2/users/${users[0].id}`);
        return fullUser.data;
    } catch (error) {
        logger.error('Failed to look up OneLogin user by associate ID', { associateId, error: error.message });
        throw error;
    }
}

/*
    Dry-run only - logs the PATCH that would be sent to set a OneLogin user's
    "Office Location or Community" custom attribute (shortname: officelocation,
    confirmed via getOneLoginCustomAttributes()), but never actually sends it.
*/
async function patchOfficeLocationDryRun(oneLoginUserId, officeLocationValue) {
    logger.info('[DRY RUN] Would PATCH OneLogin user custom attribute - no write performed', {
        oneLoginUserId,
        endpoint: `/api/2/users/${oneLoginUserId}`,
        body: { custom_attributes: { officelocation: officeLocationValue } }
    });
}

/*
    Real write - actually PUTs a OneLogin user's "officelocation" custom
    attribute. Note this goes to /api/2/users/:id (the general user-update
    endpoint) with custom_attributes in the body - the separate
    /api/2/users/:id/custom_attributes sub-resource documented elsewhere
    returned 401 even with Manage All scope; this endpoint shape is the one
    confirmed working against this account.

    Separate from patchOfficeLocationDryRun so the normal ADO sync path
    (run(), still wired to the dry-run version) can't accidentally start
    writing just by this function existing. Intended for manual/one-off use
    (e.g. seeding a test user before an Aquera overwrite test), not the bulk sync.
*/
async function patchOfficeLocation(oneLoginUserId, officeLocationValue) {
    try {
        await oneLoginClient.put(`/api/2/users/${oneLoginUserId}`, {
            custom_attributes: { officelocation: officeLocationValue }
        });
        logger.info('Patched OneLogin user custom attribute', { oneLoginUserId, officeLocationValue });
    } catch (error) {
        logger.error('Failed to patch OneLogin user custom attribute', {
            oneLoginUserId, officeLocationValue, error: error.message
        });
        throw error;
    }
}

/*
    dryRun defaults to true (same safe-by-default pattern as syncOrchestrator's
    runSync) - a bare/careless call never accidentally writes to OneLogin.
    Pass { dryRun: false } to actually PATCH.

    Only writes when the computed office location value actually differs from
    what's currently on the OneLogin user - the first real run will still
    touch every ADO (since officelocation likely doesn't match yet), but every
    run after that only touches people whose value actually changed. Logs one
    consolidated summary (changed/unchanged/skipped) for the day via
    logRunBoundary + logger.info, same pattern as syncOrchestrator.js.
*/
async function run({ dryRun = true } = {}) {
    logRunBoundary(dryRun ? '[DRY RUN] ADO OFFICE LOCATION RUN START' : 'ADO OFFICE LOCATION RUN START');
    await getOneLoginCustomAttributes();

    const people = await getPeopleToSync();
    logger.info('Found active/on-leave ADOs and Care Coordinators reporting to one', { count: people.length });

    const changed = [];
    const unchanged = [];
    const skippedNoUser = [];

    for (const person of people) {
        const officeLocationValue = buildOfficeLocationValue(person.homeClinicId, person.hubspotClinicIds);

        const oneLoginUser = await findOneLoginUserByAssociateId(person.associateId);
        if (!oneLoginUser) {
            logger.warn('No matching OneLogin user found', { associateId: person.associateId, email: person.email, role: person.role });
            skippedNoUser.push({ fullName: person.fullName, email: person.email, associateId: person.associateId, role: person.role });
            continue;
        }

        const currentValue = (oneLoginUser.custom_attributes && oneLoginUser.custom_attributes.officelocation) || '';
        if (currentValue === officeLocationValue) {
            unchanged.push({ fullName: person.fullName, role: person.role, value: officeLocationValue });
            continue;
        }

        if (dryRun) {
            await patchOfficeLocationDryRun(oneLoginUser.id, officeLocationValue);
        } else {
            await patchOfficeLocation(oneLoginUser.id, officeLocationValue);
        }
        changed.push({
            fullName: person.fullName, email: person.email, role: person.role, oneLoginUserId: oneLoginUser.id,
            before: currentValue, after: officeLocationValue
        });
    }

    logger.info('Consolidated office location changes for this run', {
        date: new Date().toISOString(),
        dryRun,
        changed,
        unchangedCount: unchanged.length,
        skippedNoUserCount: skippedNoUser.length,
        skippedNoUser
    });
    logRunBoundary(dryRun ? '[DRY RUN] ADO OFFICE LOCATION RUN END' : 'ADO OFFICE LOCATION RUN END');

    return { changed, unchanged, skippedNoUser };
}

/*
    Builds the validation CSV so the combined home-location + HubSpot-clinic
    value can be reviewed by eye before any of this goes to a real OneLogin
    write. Read-only - no OneLogin PATCH/PUT involved.

    Includes every ADO (all synced), plus EVERY Care Coordinator regardless of
    who they report to (not just the ones that qualify) - "Reports To ADO"
    makes it clear which ones run() will actually sync vs. which are shown for
    visibility only (their "OneLogin Office Location Value" for those is just
    their own home location, since no ADO's clinics apply).
*/
async function generateValidationReport() {
    // forceRefresh: true - same reasoning as getPeopleToSync, always read
    // current ADP + HubSpot data rather than a stale cache. One ADP pull,
    // shared between ados/allCareCoordinators (see extractActiveAdos/
    // extractAllActiveCareCoordinators) - not two separate fresh pulls.
    const workers = await getAdpWorkers({ forceRefresh: true });
    const ados = extractActiveAdos(workers);
    const clinicIdsByAdoId = await buildHubspotClinicIdsByAdoId({ forceRefresh: true });
    const adoAssociateIds = new Set(ados.map(a => a.associateId));
    const allCareCoordinators = extractAllActiveCareCoordinators(workers);
    logger.info('Found active/on-leave ADOs and Care Coordinators for validation report', {
        adoCount: ados.length, careCoordinatorCount: allCareCoordinators.length
    });

    const rows = [];
    for (const ado of ados) {
        const hubspotClinicIds = clinicIdsByAdoId.get(ado.associateId) || [];
        rows.push({
            'Name': ado.fullName,
            'Role': 'ado',
            'Work Email': ado.email,
            'Manager Name': '',
            'Reports To ADO': '',
            'OneLogin Office Location Value': buildOfficeLocationValue(ado.homeClinicId, hubspotClinicIds)
        });
    }
    for (const cc of allCareCoordinators) {
        const reportsToAdo = adoAssociateIds.has(cc.managerAssociateId);
        const hubspotClinicIds = reportsToAdo ? (clinicIdsByAdoId.get(cc.managerAssociateId) || []) : [];
        rows.push({
            'Name': cc.fullName,
            'Role': 'carecoord',
            'Work Email': cc.email,
            'Manager Name': cc.managerFullName || '',
            'Reports To ADO': reportsToAdo,
            'OneLogin Office Location Value': buildOfficeLocationValue(cc.homeClinicId, hubspotClinicIds)
        });
    }

    fs.mkdirSync(path.dirname(VALIDATION_REPORT_PATH), { recursive: true });
    fs.writeFileSync(VALIDATION_REPORT_PATH, rowsToCsv(rows));
    logger.info('Wrote ADO office location validation report', { rows: rows.length, outputPath: VALIDATION_REPORT_PATH });
    return rows;
}

/*
    CLI entry point - REAL RUN by default (node syncOneLoginOfficeLocation.js),
    same pattern as main.js, since this is the file meant to be scheduled by
    cron. Pass "dry" to run the exact same logic/logging but through
    patchOfficeLocationDryRun instead of a real PATCH, or "report" for the
    read-only validation CSV instead of touching OneLogin at all.
*/
if (require.main === module) {
    const mode = process.argv[2];

    if (mode === 'dry') {
        run({ dryRun: true }).catch(error => {
            logger.error('Error running ADO office location sync (dry run)', { error: error.message });
            process.exitCode = 1;
        });
    } else if (mode === 'report') {
        generateValidationReport().catch(error => {
            logger.error('Error generating ADO office location validation report', { error: error.message });
            process.exitCode = 1;
        });
    } else {
        run({ dryRun: false }).catch(error => {
            logger.error('Error running ADO office location sync', { error: error.message });
            process.exitCode = 1;
        });
    }
}

module.exports = {
    run,
    getOneLoginCustomAttributes,
    getAdpWorkers,
    extractActiveAdos,
    extractAllActiveCareCoordinators,
    getActiveAdos,
    getAllActiveCareCoordinators,
    getActiveCareCoordinatorsReportingToAdo,
    getPeopleToSync,
    buildHubspotClinicIdsByAdoId,
    buildOfficeLocationValue,
    findOneLoginUserByAssociateId,
    patchOfficeLocationDryRun,
    patchOfficeLocation,
    generateValidationReport
};
