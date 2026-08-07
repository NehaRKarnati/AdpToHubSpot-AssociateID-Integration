const fs = require('fs');
const path = require('path');
const { getCompanyProperty } = require('./hubspotRead');
const { rowsToCsv } = require('./csvUtils');
const { LIST_DEFINITIONS } = require('./config');
const { logger } = require('./logger');

const OUTPUT_PATH = path.join(__dirname, 'reports', 'dropdownOptionsBackup.csv');

/*
    Pulls every current option (label, value, hidden, displayOrder) from all
    13 dropdown properties, live from HubSpot - a full pre-migration snapshot
    so there's something to restore from/compare against if anything needs to
    be rolled back. Read-only, no writes.
*/
async function backupDropdownOptions() {
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

    fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
    fs.writeFileSync(OUTPUT_PATH, rowsToCsv(rows));
    logger.info('Wrote dropdown options backup', { rows: rows.length, outputPath: OUTPUT_PATH });
    return rows;
}

if (require.main === module) {
    backupDropdownOptions().catch(error => {
        logger.error('Error backing up dropdown options', { error: error.message });
        process.exitCode = 1;
    });
}

module.exports = { backupDropdownOptions };
