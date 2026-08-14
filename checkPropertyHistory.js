const { hubspotClient } = require('./hubspotRead');

/*
    Looks up a HubSpot company by either its record ID or its clinic_id, and
    prints its current value + full change history for the given
    property(ies) - who/what changed it and when. Useful for tracing
    "why did this field change" incidents like the A252/Piatt County Nursing
    Home one (a HubSpot workflow reassigning a clinic's ADO independent of
    this integration).

    Usage:
      node checkPropertyHistory.js <companyIdOrClinicId> <property1,property2,...>

    Example:
      node checkPropertyHistory.js A252 ard,future_ado
      node checkPropertyHistory.js 10194976153 ard
*/
async function findCompanyByIdOrClinicId(idOrClinicId) {
    // Record IDs are purely numeric; clinic_id values (e.g. "A252") aren't.
    if (/^\d+$/.test(idOrClinicId)) {
        const response = await hubspotClient.get(`/crm/v3/objects/companies/${idOrClinicId}`, {
            params: { properties: 'name,clinic_id' }
        });
        return response.data;
    }

    const response = await hubspotClient.post('/crm/v3/objects/companies/search', {
        filterGroups: [{ filters: [{ propertyName: 'clinic_id', operator: 'EQ', value: idOrClinicId }] }],
        properties: ['name', 'clinic_id'],
        limit: 1
    });
    if (response.data.results.length === 0) throw new Error(`No company found with clinic_id ${idOrClinicId}`);
    return response.data.results[0];
}

async function checkPropertyHistory(idOrClinicId, propertyNames) {
    const company = await findCompanyByIdOrClinicId(idOrClinicId);

    const response = await hubspotClient.get(`/crm/v3/objects/companies/${company.id}`, {
        params: {
            properties: ['name', 'clinic_id', ...propertyNames].join(','),
            propertiesWithHistory: propertyNames.join(',')
        }
    });

    console.log(`Company: ${response.data.properties.name} (ID: ${company.id}, clinic_id: ${response.data.properties.clinic_id})`);
    console.log('');
    for (const propertyName of propertyNames) {
        console.log(`--- ${propertyName} (current: "${response.data.properties[propertyName]}") ---`);
        const history = response.data.propertiesWithHistory[propertyName] || [];
        for (const entry of history) {
            const who = entry.updatedByUserId ? `user ${entry.updatedByUserId}` : entry.sourceId;
            console.log(`  ${entry.timestamp} | value: [${entry.value}] | source: ${entry.sourceType} (${who})`);
        }
        console.log('');
    }
}

if (require.main === module) {
    const [idOrClinicId, propertiesArg] = process.argv.slice(2);
    if (!idOrClinicId || !propertiesArg) {
        console.error('Usage: node checkPropertyHistory.js <companyIdOrClinicId> <property1,property2,...>');
        process.exitCode = 1;
    } else {
        checkPropertyHistory(idOrClinicId, propertiesArg.split(',')).catch(error => {
            console.error(error.response ? JSON.stringify(error.response.data) : error.message);
            process.exitCode = 1;
        });
    }
}

module.exports = { checkPropertyHistory, findCompanyByIdOrClinicId };
