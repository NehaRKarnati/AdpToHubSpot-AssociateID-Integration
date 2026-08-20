const fs = require('fs');
const path = require('path');
const { populateWorkerData } = require('./adpWorkerFetch');
const { rowsToCsv } = require('./csvUtils');
const { logger } = require('./logger');

const OUTPUT_PATH = path.join(__dirname, 'reports', 'otherWorksites.csv');

/*
    getAllADPWorkers() already merges 'A' (active) and 'L' (leave) workers into
    activeWorkers and keeps terminated separate - so activeWorkers alone is the
    "ignore terminated" set this report needs.
*/
function getPrimaryAssignment(worker) {
    const assignments = worker.workAssignments || [];
    return assignments.find(a => a.primaryIndicator) || assignments[0];
}

// Strips leading/trailing spaces and special characters only - characters in
// the middle of the name (e.g. the "-" in "Boulevard St. Charles-C060") are
// left alone.
function trimEdgeSpecialChars(name) {
    return name.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, '');
}

// "Other Worksites" lives in the worker-level customFieldGroup, not the
// per-assignment one (assignment.customFieldGroup is empty in ADP's payload).
function getOtherWorksiteNames(worker) {
    const multiCodeFields = worker.customFieldGroup && worker.customFieldGroup.multiCodeFields;
    if (!multiCodeFields) return [];
    const field = multiCodeFields.find(f => f.nameCode && f.nameCode.codeValue === 'Other Worksites');
    if (!field || !field.codes) return [];
    return field.codes
        .map(c => c.longName || c.shortName || c.codeValue)
        .filter(Boolean)
        .map(trimEdgeSpecialChars);
}

/*
    One row per work location (home + each "other worksite"), all sharing the
    worker's workerID and primary positionID.
*/
function buildRows(workers) {
    const rows = [];
    for (const worker of workers) {
        const assignment = getPrimaryAssignment(worker);
        if (!assignment) continue;

        const workerID = worker.workerID && worker.workerID.idValue;
        const positionID = assignment.positionID;

        const homeLocationName = assignment.homeWorkLocation &&
            assignment.homeWorkLocation.nameCode &&
            (assignment.homeWorkLocation.nameCode.longName || assignment.homeWorkLocation.nameCode.shortName);

        const locationNames = [];
        if (homeLocationName) locationNames.push(homeLocationName);
        locationNames.push(...getOtherWorksiteNames(worker));

        for (const locationName of locationNames) {
            rows.push({ 'Associate ID': workerID, 'Position ID': positionID, 'Locations': locationName });
        }
    }
    return rows;
}

function writeCsv(rows, outputPath) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, rowsToCsv(rows));
}

/*
    Pulls ACTIVE ('A') and ON LEAVE ('L') workers directly via populateWorkerData,
    ignoring TERMINATED entirely. Calls populateWorkerData directly (rather than
    adpWorkerFetch's getAllADPWorkers) to avoid its cache-read path, which
    throws when tokens/adpWorkersCache.json doesn't exist yet.

    limit: when set, caps how many of EACH status (active/leave) are pulled -
    useful for a quick smoke test instead of pulling every worker.
*/
async function run(limit) {
    const numRecords = limit || 99999;
    const activeWorkers = await populateWorkerData(numRecords, 'A');
    const leaveWorkers = await populateWorkerData(numRecords, 'L');
    const workers = activeWorkers.concat(leaveWorkers);

    const rows = buildRows(workers);
    writeCsv(rows, OUTPUT_PATH);
    logger.info('Wrote other worksites report', {
        active: activeWorkers.length,
        onLeave: leaveWorkers.length,
        rows: rows.length,
        outputPath: OUTPUT_PATH
    });
}

if (require.main === module) {
    const limitArg = process.argv[2];
    const limit = limitArg ? parseInt(limitArg, 10) : undefined;
    run(limit).catch(error => {
        logger.error('Error generating other worksites report', { error: error.message });
        process.exitCode = 1;
    });
}

module.exports = { run, buildRows, getPrimaryAssignment, getOtherWorksiteNames };
