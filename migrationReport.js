const fs = require('fs');
const path = require('path');
const { migrateLegacyOptions } = require('./migrateLegacyOptions');
const { rowsToCsv } = require('./csvUtils');
const { logger } = require('./logger');

// Union of every field any result row from migrateLegacyOptions can have -
// rows are normalized to this same shape so rowsToCsv's headers (taken from
// the first row) don't silently drop columns that only appear on later rows.
const COLUMNS = ['list', 'legacyValue', 'label', 'newAssociateId', 'companyId', 'action', 'error'];

function normalizeRows(results) {
    return results.map(result => {
        const row = {};
        for (const column of COLUMNS) row[column] = result[column] !== undefined ? result[column] : '';
        return row;
    });
}

/*
    Runs the REAL migrateLegacyOptions code path in dry-run mode (no writes)
    and saves its output as a CSV - unlike dryRunReport.js, which is a
    separate approximation of the logic, this reflects exactly what
    migrateLegacyOptions would do, including label-collision side effects,
    since it's the same function actually being exercised.
*/
async function runMigrationReport(numRecords = 99999) {
    logger.info('Starting migration dry-run report (dryRun: true, no writes)');

    const results = await migrateLegacyOptions(numRecords, { dryRun: true });
    const rows = normalizeRows(results);

    const outputPath = path.join(__dirname, 'reports', 'migrationChanges.csv');
    fs.writeFileSync(outputPath, rowsToCsv(rows));

    logger.info('Finished migration dry-run report', { rowCount: rows.length, outputPath });
    return { rows, outputPath };
}

runMigrationReport().catch(error => {
    logger.error('Error during migration dry-run report', { error: error.message });
});

module.exports = { runMigrationReport };
