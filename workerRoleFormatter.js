const { JOB_TITLE_PATTERNS, ADP_STATUS, LIST_DEFINITIONS } = require('./config');
const { logger } = require('./logger');

function getPrimaryWorkAssignment(worker) {
    const assignments = worker.workAssignments || [];
    return assignments.find(a => a.primaryIndicator === true);
}

/*
    Classifies a job code into exactly one PRIMARY role (ado/rvp/dvp/roc/
    carecoord/cd/cd3/dor). A single role can still feed multiple dropdown
    lists - see LIST_DEFINITIONS in config.js - but each worker only ever
    has one primary role, driven by their primary work assignment's job code.
*/
function classifyJobTitle(jobCode) {
    if (!jobCode) return null;
    for (const [role, pattern] of Object.entries(JOB_TITLE_PATTERNS)) {
        if (pattern.test(jobCode)) return role;
    }
    return null;
}

/*
    worker.workerID.idValue is the ADP "Associate ID" (schemeCode: 'Associate ID') -
    a short human-facing code, distinct from worker.associateOID (ADP's internal GUID
    used for direct API lookups). The dropdown/text properties in HubSpot key on this value.
*/
function extractAssociateId(worker) {
    return worker.workerID && worker.workerID.idValue;
}

/*
    Builds "First Last" to match HubSpot's naming convention. Deliberately NOT
    using legalName.formattedName - ADP formats that as "Last, First" (e.g.
    "Tester, Hester"), which would never match names already stored in HubSpot.
*/
function extractFullName(worker) {
    const legalName = worker.person && worker.person.legalName;
    if (!legalName || !legalName.givenName || !legalName.familyName1) return null;
    return `${legalName.givenName} ${legalName.familyName1}`;
}

/*
    Excludes ADP sandbox/test employees whose last name is or contains
    "Tester" (e.g. "Hester Tester") - these are dummy records from ADP's test
    environment, not real employees, and pollute reports/classification if
    left in.
*/
function isTestEmployee(worker) {
    const familyName = worker.person && worker.person.legalName && worker.person.legalName.familyName1;
    return !!familyName && familyName.toLowerCase().includes('tester');
}

/*
    Shapes a raw ADP worker record into the minimal record the sync needs.
    Returns null if the worker's primary assignment doesn't match any tracked
    primary role.
*/
function formatWorkerRecord(worker) {
    if (isTestEmployee(worker)) return null;

    const primaryAssignment = getPrimaryWorkAssignment(worker);
    if (!primaryAssignment) {
        logger.warn('No primary work assignment found for worker', { associateId: extractAssociateId(worker) });
        return null;
    }

    const jobCode = primaryAssignment.jobCode && primaryAssignment.jobCode.codeValue;
    const role = classifyJobTitle(jobCode);
    if (!role) return null;

    const associateId = extractAssociateId(worker);
    const fullName = extractFullName(worker);
    const legalName = worker.person && worker.person.legalName;
    const statusCode = primaryAssignment.assignmentStatus &&
        primaryAssignment.assignmentStatus.statusCode &&
        primaryAssignment.assignmentStatus.statusCode.codeValue;

    if (!associateId || !fullName) {
        logger.error('Missing associateId or fullName for worker', { associateId, fullName });
        return null;
    }

    return {
        associateId,
        fullName,
        // Kept for resolveDuplicateFullNames to rebuild a disambiguated
        // fullName (with middle name, or a positionId suffix) if a name
        // collision is found within a dropdown list's scope.
        givenName: legalName.givenName,
        middleName: legalName.middleName || null,
        familyName1: legalName.familyName1,
        positionId: primaryAssignment.positionID || null,
        jobCode,
        role,
        statusCode,
        isActive: statusCode === ADP_STATUS.ACTIVE || statusCode === ADP_STATUS.LEAVE,
        isTerminated: statusCode === ADP_STATUS.TERMINATED,
        terminationDate: primaryAssignment.terminationDate || null
    };
}

/*
    Builds a { fullName: associateId } lookup from a list of records.
    Logs a warning (rather than silently overwriting) if two records share
    a name, since that would make the lookup ambiguous. context identifies
    where this lookup is being built (e.g. "role:ado" or "list:ard active") so
    the warning says exactly which bucket/list the collision was found in.
*/
function buildNameToIdLookup(records, context = 'unknown') {
    const lookup = {};
    for (const record of records) {
        if (lookup[record.fullName] && lookup[record.fullName] !== record.associateId) {
            logger.warn('Duplicate name found while building associate ID lookup', {
                context,
                fullName: record.fullName,
                existingAssociateId: lookup[record.fullName],
                newAssociateId: record.associateId
            });
        }
        lookup[record.fullName] = record.associateId;
    }
    return lookup;
}

/*
    Takes the raw active + terminated worker arrays pulled from ADP, dedupes by
    associateId (a worker can appear in both queries if any non-primary assignment
    matches), and classifies each into exactly one primary role bucket
    (ado/rvp/dvp/roc/carecoord/cd/cd3/dor), split into active/terminated.

    Returns: { ado: { active: [...], terminated: [...], activeLookup: {...}, terminatedLookup: {...} }, rvp: {...}, ... }
*/
function sortWorkersIntoRoles(activeWorkers, terminatedWorkers) {
    const roleBuckets = {};
    for (const role of Object.keys(JOB_TITLE_PATTERNS)) {
        roleBuckets[role] = { active: [], terminated: [] };
    }

    const seenAssociateIds = new Set();
    const allWorkers = [...activeWorkers, ...terminatedWorkers];

    for (const worker of allWorkers) {
        const associateId = extractAssociateId(worker);
        if (!associateId || seenAssociateIds.has(associateId)) continue;
        seenAssociateIds.add(associateId);

        const record = formatWorkerRecord(worker);
        if (!record) continue;

        const bucket = roleBuckets[record.role];
        if (record.isActive) bucket.active.push(record); // isActive includes LEAVE, not just ACTIVE
        else if (record.isTerminated) bucket.terminated.push(record);
    }

    for (const [role, bucket] of Object.entries(roleBuckets)) {
        bucket.activeLookup = buildNameToIdLookup(bucket.active, `role:${role} active`);
        bucket.terminatedLookup = buildNameToIdLookup(bucket.terminated, `role:${role} terminated`);
        logger.info('Bucketed records by role', {
            role,
            active: bucket.active.length,
            terminated: bucket.terminated.length
        });
    }

    return roleBuckets;
}

/*
    HubSpot requires option labels to be unique across a whole dropdown
    property, so two different people who'd otherwise get the same fullName
    label ("Elisa Morris") can't both become options on the same list. Returns
    a NEW array (doesn't mutate the input records, since the same record
    object can be shared across multiple lists in buildAllDropdownLists, and a
    collision on one list's scope shouldn't rename that person on another
    list where there's no collision).

    Pass 1: for every colliding group, any record with a middleName gets its
    fullName rebuilt as "Given Middle Family" instead of "Given Family".
    Pass 2: anything STILL colliding after that (no middle name, or same
    middle name too) gets " - <trailing digits of positionId>" appended
    (e.g. "Elisa Morris - 011446", from positionId "I4A011446").
*/
function resolveDuplicateFullNames(records, context = 'unknown') {
    const resolved = records.map(record => ({ ...record }));

    const groupByFullName = () => {
        const groups = {};
        for (const record of resolved) {
            (groups[record.fullName] = groups[record.fullName] || []).push(record);
        }
        return Object.values(groups);
    };

    for (const group of groupByFullName()) {
        if (group.length < 2) continue;
        for (const record of group) {
            if (record.middleName) {
                record.fullName = `${record.givenName} ${record.middleName} ${record.familyName1}`;
            }
        }
    }

    for (const group of groupByFullName()) {
        if (group.length < 2) continue;
        for (const record of group) {
            const trailingDigits = record.positionId && record.positionId.match(/(\d+)$/);
            if (!trailingDigits) {
                logger.warn('Duplicate name still colliding and has no positionId digits to disambiguate with', {
                    context, fullName: record.fullName, associateId: record.associateId
                });
                continue;
            }
            const before = record.fullName;
            record.fullName = `${record.fullName} - ${trailingDigits[1]}`;
            logger.warn('Duplicate name still colliding after adding middle name - appended positionId digits', {
                context, before, after: record.fullName, associateId: record.associateId
            });
        }
    }

    return resolved;
}

/*
    Unions the role buckets a dropdown list is eligible for (per
    LIST_DEFINITIONS[listName].eligibleRoles) into one active/terminated set -
    e.g. the 'ard' list unions the ado, rvp, and roc role buckets, since RVPs
    and ROCs can also be selected as a company's ADO.
*/
function mergeRolesForOneList(roleBuckets, eligibleRoles, listName = 'unknown') {
    const active = [];
    const terminated = [];
    for (const role of eligibleRoles) {
        const bucket = roleBuckets[role];
        if (!bucket) continue;
        active.push(...bucket.active);
        terminated.push(...bucket.terminated);
    }

    const resolvedActive = resolveDuplicateFullNames(active, `list:${listName} active`);
    const resolvedTerminated = resolveDuplicateFullNames(terminated, `list:${listName} terminated`);

    return {
        active: resolvedActive,
        terminated: resolvedTerminated,
        activeLookup: buildNameToIdLookup(resolvedActive, `list:${listName} active`),
        terminatedLookup: buildNameToIdLookup(resolvedTerminated, `list:${listName} terminated`)
    };
}

/*
    Convenience wrapper: builds every dropdown list's active/terminated
    records in one call, keyed by list name (ard, future_ado, rvp, ...),
    using LIST_DEFINITIONS from config.js.
*/
function buildAllDropdownLists(activeWorkers, terminatedWorkers) {
    const roleBuckets = sortWorkersIntoRoles(activeWorkers, terminatedWorkers);
    const lists = {};
    for (const [listName, definition] of Object.entries(LIST_DEFINITIONS)) {
        lists[listName] = mergeRolesForOneList(roleBuckets, definition.eligibleRoles, listName);
    }
    return lists;
}

/*
    Backward-compatible for the ADO-only tools built before the multi-list
    expansion (dryRunAdoMigration.js, migrateLegacyAdoOptions.js) - they read
    buckets.ado.active/terminated/activeLookup/terminatedLookup. Aliases to
    the 'ard' list (ado+rvp+roc eligible), which is what 'ado' meant there.
*/
function bucketAdoRecords(activeWorkers, terminatedWorkers) {
    const lists = buildAllDropdownLists(activeWorkers, terminatedWorkers);
    return { ado: lists.ard };
}

module.exports = {
    getPrimaryWorkAssignment,
    classifyJobTitle,
    extractAssociateId,
    extractFullName,
    isTestEmployee,
    formatWorkerRecord,
    buildNameToIdLookup,
    resolveDuplicateFullNames,
    sortWorkersIntoRoles,
    mergeRolesForOneList,
    buildAllDropdownLists,
    bucketAdoRecords
};
