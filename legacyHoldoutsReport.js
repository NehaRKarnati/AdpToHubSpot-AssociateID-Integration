const fs = require('fs');
const path = require('path');
const { hubspotClient, getCompanyProperty } = require('./hubspotRead');
const { rowsToCsv } = require('./csvUtils');
const { LIST_DEFINITIONS } = require('./config');
const { logger } = require('./logger');

const OUTPUT_PATH = path.join(__dirname, 'reports', 'legacyHoldouts.csv');

/*
    After migration has run for all 13 lists, some legacy (name-keyed) option
    values may still be hidden+renamed rather than deleted - meaning at least
    one company somewhere still holds that raw value. This report finds every
    such company, across every list, with enough context (clinic_id/
    lifecyclestage, in-scope or not, and every other ADO-family field) to hand
    to the team for follow-up.

    Read-only - no writes. Run once migration is fully done for all lists.
*/
async function generateLegacyHoldoutsReport() {
    const rows = [];

    for (const listName of Object.keys(LIST_DEFINITIONS)) {
        const property = await getCompanyProperty(listName);
        const options = property.options || [];
        const labelByValue = new Map(options.map(o => [o.value, o.label]));

        // A hidden option whose label ends in "(legacy)" is exactly the state
        // migrateLegacyOptionsForList leaves a still-referenced legacy value
        // in - those are the values worth reporting on here.
        const legacyValues = options
            .filter(o => o.hidden === true && o.label.endsWith(' (legacy)'))
            .map(o => o.value);

        if (legacyValues.length === 0) continue;

        for (const legacyValue of legacyValues) {
            let after = undefined;
            do {
                const response = await hubspotClient.post('/crm/v3/objects/companies/search', {
                    filterGroups: [{ filters: [{ propertyName: listName, operator: 'EQ', value: legacyValue }] }],
                    properties: ['name', 'lifecyclestage', 'clinic_id', 'ard', 'rvp', 'dvp', 'team_lead', 'regional_ops_coordinator'],
                    limit: 100,
                    after
                });

                for (const company of response.data.results) {
                    const inScope = Boolean(company.properties.clinic_id) && company.properties.lifecyclestage === 'customer';
                    rows.push({
                        'List': listName,
                        'Legacy Value': legacyValue,
                        'Current Label': labelByValue.get(legacyValue) || '(unknown)',
                        'Company ID': company.id,
                        'Name': company.properties.name,
                        'Lifecycle Stage': company.properties.lifecyclestage || '',
                        'Clinic ID': company.properties.clinic_id || '',
                        'In Scope': inScope,
                        'ARD': company.properties.ard || '',
                        'RVP': company.properties.rvp || '',
                        'DVP': company.properties.dvp || '',
                        'Team Lead': company.properties.team_lead || '',
                        'ROC': company.properties.regional_ops_coordinator || ''
                    });
                }
                after = response.data.paging && response.data.paging.next ? response.data.paging.next.after : undefined;
            } while (after);
        }

        logger.info('Checked legacy holdouts for list', { list: listName, legacyValues: legacyValues.length });
    }

    fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
    fs.writeFileSync(OUTPUT_PATH, rowsToCsv(rows));
    logger.info('Wrote legacy holdouts report', { rows: rows.length, outputPath: OUTPUT_PATH });
    return rows;
}

if (require.main === module) {
    generateLegacyHoldoutsReport().catch(error => {
        logger.error('Error generating legacy holdouts report', { error: error.message });
        process.exitCode = 1;
    });
}

module.exports = { generateLegacyHoldoutsReport };
