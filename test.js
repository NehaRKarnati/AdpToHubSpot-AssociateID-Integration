const { getCompanyById, getCompanyProperty, hubspotClient, anyCompanyHasPropertyValue } = require('./hubspotRead');
const { updateSingleCompanyProperty, addSingleDropdownOption } = require('./hubspotWrite');
const { getAllADPWorkers } = require('./adpWorkerFetch');
const { getPrimaryWorkAssignment, extractFullName, sortWorkersIntoRoles } = require('./workerRoleFormatter');
const { HUBSPOT_PROPERTIES } = require('./config');
const { dryRunSingleCompany, cleanupLegacyOptions } = require('./dryRunMigration');


const ADO_PROPERTY_NAMES = ['name', HUBSPOT_PROPERTIES.ado.dropdown, HUBSPOT_PROPERTIES.ado.associateId];

async function getCompany(companyId) {
    const company = await getCompanyById(companyId, ADO_PROPERTY_NAMES);
    console.log(JSON.stringify(company.properties, null, 2));
    return company;
}

async function setCompanyProperty(companyId, propertyName, value) {
    const result = await updateSingleCompanyProperty(companyId, propertyName, value);
    console.log(JSON.stringify(result.properties, null, 2));
    return result;
}

async function setCompanyAdo(companyId, associateId) {
    await updateSingleCompanyProperty(companyId, HUBSPOT_PROPERTIES.ado.dropdown, associateId);
    const result = await updateSingleCompanyProperty(companyId, HUBSPOT_PROPERTIES.ado.associateId, associateId);
    console.log(JSON.stringify(result.properties, null, 2));
    return result;
}

/*
    One-off unblock for label collisions during testing: HubSpot requires
    unique option labels across the whole property, hidden options included.
    Renames the option currently at oldValue (freeing up its label for a new
    associate-ID-keyed option) and hides it, without deleting it.
*/
async function renameAndHideOption(propertyName, oldValue, newLabel) {
    const property = await getCompanyProperty(propertyName);
    const options = property.options || [];
    const target = options.find(opt => opt.value === oldValue);
    if (!target) {
        console.log(`No option found with value "${oldValue}" on ${propertyName}`);
        return;
    }

    const updatedOptions = options.map(opt =>
        opt.value === oldValue ? { ...opt, label: newLabel, hidden: true } : opt
    );

    await hubspotClient.patch(`/crm/v3/properties/companies/${propertyName}`, { options: updatedOptions });
    console.log(`Renamed "${target.label}" -> "${newLabel}" and hid it`);
}

async function addOneAdoOption(fullName, associateId) {
    await addSingleDropdownOption(HUBSPOT_PROPERTIES.ado.dropdown, fullName, associateId);
    console.log(`Added option: ${fullName} -> ${associateId}`);
}

async function getAdoOptions() {
    const property = await getCompanyProperty(HUBSPOT_PROPERTIES.ado.dropdown);
    console.log(JSON.stringify(property.options, null, 2));
    return property.options;
}

/*
    Diagnostic: finds a worker in the (cached) ADP data by full name and
    prints their primary assignment's raw jobCode - use this when a name
    from HubSpot keeps showing up as no_match_found in the dry run, to see
    whether they're actually being excluded from the 'ado' bucket by
    config.js's job code pattern rather than a name-formatting issue.
*/
async function findAdpWorkerByName(fullName) {
    const { activeWorkers, terminatedWorkers } = await getAllADPWorkers();
    const allWorkers = [...activeWorkers, ...terminatedWorkers];

    const matches = allWorkers.filter(w => extractFullName(w) === fullName);
    if (matches.length === 0) {
        console.log(`No ADP worker found with name "${fullName}"`);
        return [];
    }

    const results = matches.map(worker => {
        const primary = getPrimaryWorkAssignment(worker);
        return {
            fullName: extractFullName(worker),
            jobCode: primary && primary.jobCode && primary.jobCode.codeValue,
            statusCode: primary && primary.assignmentStatus && primary.assignmentStatus.statusCode && primary.assignmentStatus.statusCode.codeValue
        };
    });
    console.log(JSON.stringify(results, null, 2));
    return results;
}

/*
    Diagnostic: anyCompanyHasPropertyValue only returns true/false - this
    shows exactly WHICH company(ies) HubSpot's search currently thinks match,
    unfiltered (not scoped to BASE_COMPANY_FILTERS).
*/
async function findCompaniesWithValue(propertyName, value) {
    const response = await hubspotClient.post('/crm/v3/objects/companies/search', {
        filterGroups: [{ filters: [{ propertyName, operator: 'EQ', value }] }],
        properties: ['name', propertyName],
        limit: 10
    });
    console.log(JSON.stringify(response.data.results, null, 2));
    return response.data.results;
}

/*
    Prints every employee's name (not just a count) for one role + status, so
    you can eyeball it against real ADP data. role is one of ado/rvp/dvp/roc/
    carecoord/cd/cd3/dor; status is 'active' or 'terminated'.
*/
async function printRoleMembers(role, status) {
    const { activeWorkers, terminatedWorkers } = await getAllADPWorkers();
    const roleBuckets = sortWorkersIntoRoles(activeWorkers, terminatedWorkers);

    const bucket = roleBuckets[role];
    if (!bucket) {
        console.log(`No such role "${role}". Valid roles: ${Object.keys(roleBuckets).join(', ')}`);
        return [];
    }

    const records = bucket[status];
    if (!records) {
        console.log(`No such status "${status}". Use "active" or "terminated".`);
        return [];
    }

    console.log(`${role} - ${status} (${records.length}):`);
    for (const record of records) {
        console.log(`  ${record.fullName} (${record.associateId})`);
    }
    return records;
}

async function main() {
    //const res = await addSingleDropdownOption(HUBSPOT_PROPERTIES.ado.dropdown, 'Joseph Tytler', '38EQ3NA8M');
    //console.log(res);
    /*const res2 = await dryRunSingleCompany(37393111855);
    console.log(res2);*/
    
    const res = await printRoleMembers('rvp', 'active');
    console.log(res);

    
    //const res3 =await cleanupLegacyOptions(['Joseph Tytler']);
    //console.log(res3);
}




main();
