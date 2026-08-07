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
    Pulls every ADO (active + on-leave, terminated ignored) from ADP, keyed by
    associateId, with their work email and home clinic ID.
*/
async function getActiveAdos({ forceRefresh = false } = {}) {
    const workers = await getAdpWorkers({ forceRefresh });

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
    Combines the ADO's own home clinic ID with the clinic IDs of every
    HubSpot company assigned to them, deduped, as a comma-separated string.
*/
function buildOfficeLocationValue(homeClinicId, hubspotClinicIds) {
    const combined = new Set();
    if (homeClinicId) combined.add(homeClinicId);
    for (const clinicId of hubspotClinicIds) combined.add(clinicId);
    return Array.from(combined).join(',');
}


/*
    Finds the OneLogin user matching this ADO's work email. Returns null if no
    match is found (rather than throwing), so the caller can log and skip.
*/
async function findOneLoginUserByEmail(email) {
    try {
        const response = await oneLoginClient.get('/api/2/users', {
            params: { email }
        });
        const users = response.data;
        return (users && users.length > 0) ? users[0] : null;
    } catch (error) {
        logger.error('Failed to look up OneLogin user by email', { email, error: error.message });
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

    const ados = await getActiveAdos();
    const clinicIdsByAdoId = await buildHubspotClinicIdsByAdoId();
    logger.info('Found active/on-leave ADOs', { count: ados.length });

    const changed = [];
    const unchanged = [];
    const skippedNoUser = [];

    for (const ado of ados) {
        const hubspotClinicIds = clinicIdsByAdoId.get(ado.associateId) || [];
        const officeLocationValue = buildOfficeLocationValue(ado.homeClinicId, hubspotClinicIds);

        const oneLoginUser = await findOneLoginUserByEmail(ado.email);
        if (!oneLoginUser) {
            logger.warn('No matching OneLogin user found for ADO', { associateId: ado.associateId, email: ado.email });
            skippedNoUser.push({ fullName: ado.fullName, email: ado.email });
            continue;
        }

        const currentValue = (oneLoginUser.custom_attributes && oneLoginUser.custom_attributes.officelocation) || '';
        if (currentValue === officeLocationValue) {
            unchanged.push({ fullName: ado.fullName, value: officeLocationValue });
            continue;
        }

        if (dryRun) {
            await patchOfficeLocationDryRun(oneLoginUser.id, officeLocationValue);
        } else {
            await patchOfficeLocation(oneLoginUser.id, officeLocationValue);
        }
        changed.push({
            fullName: ado.fullName, email: ado.email, oneLoginUserId: oneLoginUser.id,
            before: currentValue, after: officeLocationValue
        });
    }

    logger.info('Consolidated ADO office location changes for this run', {
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
    Builds the validation CSV (ADO Name, Work Email, OneLogin Office Location
    Value) so the combined home-location + HubSpot-clinic-names string can be
    reviewed by eye before any of this goes to a real OneLogin write. Read-only -
    no OneLogin PATCH/PUT involved.
*/
async function generateValidationReport() {
    const ados = await getActiveAdos();
    const clinicIdsByAdoId = await buildHubspotClinicIdsByAdoId();
    logger.info('Found active/on-leave ADOs for validation report', { count: ados.length });

    const rows = [];
    for (const ado of ados) {
        const hubspotClinicIds = clinicIdsByAdoId.get(ado.associateId) || [];
        const officeLocationValue = buildOfficeLocationValue(ado.homeClinicId, hubspotClinicIds);
        rows.push({
            'ADO Name': ado.fullName,
            'Work Email': ado.email,
            'OneLogin Office Location Value': officeLocationValue
        });
    }

    fs.mkdirSync(path.dirname(VALIDATION_REPORT_PATH), { recursive: true });
    fs.writeFileSync(VALIDATION_REPORT_PATH, rowsToCsv(rows));
    logger.info('Wrote ADO office location validation report', { rows: rows.length, outputPath: VALIDATION_REPORT_PATH });
    return rows;
}

/*
    CLI entry point - defaults to the safe, read-only validation report
    (matches every other report script in this project). Pass "live" to
    actually run the sync for real (node syncOneLoginOfficeLocation.js live),
    or "dry" to run the exact same logic/logging as a live run but through
    patchOfficeLocationDryRun instead of a real PATCH.
*/
if (require.main === module) {
    const mode = process.argv[2];

    if (mode === 'live') {
        run({ dryRun: false }).catch(error => {
            logger.error('Error running ADO office location sync', { error: error.message });
            process.exitCode = 1;
        });
    } else if (mode === 'dry') {
        run({ dryRun: true }).catch(error => {
            logger.error('Error running ADO office location sync (dry run)', { error: error.message });
            process.exitCode = 1;
        });
    } else {
        generateValidationReport().catch(error => {
            logger.error('Error generating ADO office location validation report', { error: error.message });
            process.exitCode = 1;
        });
    }
}

module.exports = {
    run,
    getOneLoginCustomAttributes,
    getAdpWorkers,
    getActiveAdos,
    buildHubspotClinicIdsByAdoId,
    buildOfficeLocationValue,
    findOneLoginUserByEmail,
    patchOfficeLocationDryRun,
    patchOfficeLocation,
    generateValidationReport
};
