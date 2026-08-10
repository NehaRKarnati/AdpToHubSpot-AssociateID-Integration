const fs = require('fs');
const path = require('path');
const { getCompanyProperty } = require('./hubspotRead');
const { rowsToCsv } = require('./csvUtils');
const { LIST_DEFINITIONS } = require('./config');
const { logger } = require('./logger');

/*
    Pulls every current option (label, value, hidden, displayOrder) from all
    13 dropdown properties, live from HubSpot - a full snapshot so there's
    something to restore from/compare against if anything needs to be rolled
    back. Read-only, no writes.

    Pass a filename suffix (node backupDropdownOptions.js after) to write a
    distinctly-named file instead of overwriting the default - e.g. keeping a
    before/after pair around the same migration.
*/
async function backupDropdownOptions(outputPath) {
    const rows = [];

    for (const listName of Object.keys(LIST_DEFINITIONS)) {
        const property = await getCompanyProperty(listName);
        const options = property.options || [];
        logger.info('Backed up dropdown options for list', { list: listName, count: options.length });

        for (const option of options) {
            rows.push({
                'List': listName,
                'Label': option.label,
                'Internal Value': option.value,
                'Hidden': !!option.hidden,
                'Display Order': option.displayOrder !== undefined ? option.displayOrder : ''
            });
        }
    }

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, rowsToCsv(rows));
    logger.info('Wrote dropdown options backup', { rows: rows.length, outputPath });
    return rows;
}

if (require.main === module) {
    const suffix = process.argv[2];
    const fileName = suffix ? `dropdownOptionsBackup_${suffix}.csv` : 'dropdownOptionsBackup.csv';
    const outputPath = path.join(__dirname, 'reports', fileName);

    backupDropdownOptions(outputPath).catch(error => {
        logger.error('Error backing up dropdown options', { error: error.message });
        process.exitCode = 1;
    });
}

module.exports = { backupDropdownOptions };
