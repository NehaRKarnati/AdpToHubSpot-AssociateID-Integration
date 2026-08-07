const { getAllADPWorkers } = require('./adpWorkerFetch');
const { bucketAdoRecords } = require('./workerRoleFormatter');
const { getAllCompanies, getCompanyById } = require('./hubspotRead');
const { updateCompanyAdoFields, deleteSingleDropdownOption, addSingleDropdownOption } = require('./hubspotWrite');
const { HUBSPOT_PROPERTIES } = require('./config');
const { logger } = require('./logger');

const ADO_PROPERTIES = HUBSPOT_PROPERTIES.ado;

/*
    Builds the { knownAssociateIds, nameToId } index used to classify a
    company's current ard value, from this run's ADP data (cached - see
    adpWorkerFetch.js - so calling this repeatedly while testing doesn't
    re-pull ADP every time).
*/
async function buildAdoIndex(numrecords=99999) {
    const { activeWorkers, terminatedWorkers } = await getAllADPWorkers(numrecords);
    const buckets = bucketAdoRecords(activeWorkers, terminatedWorkers);

    const knownAssociateIds = new Set([
        ...buckets.ado.active.map(r => r.associateId),
        ...buckets.ado.terminated.map(r => r.associateId)
    ]);
    // Active wins if a name collides between an active and terminated record.
    const nameToId = { ...buckets.ado.terminatedLookup, ...buckets.ado.activeLookup };

    console.log('--- ADO bucket: active ---');
    console.table(buckets.ado.active.map(r => ({ fullName: r.fullName, associateId: r.associateId })));
    console.log('--- ADO bucket: terminated ---');
    console.table(buckets.ado.terminated.map(r => ({ fullName: r.fullName, associateId: r.associateId })));

    return { knownAssociateIds, nameToId };
}

/*
    Classifies one company's current ard/ado_adp_id value against the ADO
    index - no writes, just the status this company would end up with.
*/
function classifyCompanyAdoValue(company, { knownAssociateIds, nameToId }) {
    const currentArd = company.properties[ADO_PROPERTIES.dropdown] || null;
    const currentAssociateId = company.properties[ADO_PROPERTIES.associateId] || null;

    let proposedArd = currentArd;
    let status;

    if (!currentArd) {
        status = 'no_ado_assigned';
    } else if (knownAssociateIds.has(currentArd)) {
        status = 'already_correct';
    } else if (nameToId[currentArd]) {
        proposedArd = nameToId[currentArd];
        status = 'would_migrate';
    } else {
        status = 'no_match_found';
    }

    return {
        companyId: company.id,
        companyName: company.properties.name,
        currentArd,
        currentAssociateId,
        proposedArd,
        proposedAssociateId: status === 'no_ado_assigned' ? null : proposedArd,
        status
    };
}

/*
    READ-ONLY dry run across every in-scope company - makes no PATCH/POST
    calls to HubSpot. Prints current vs. proposed ard/ado_adp_id values so
    this can be reviewed before migrateLegacyAdoOptions.js or
    syncOrchestrator.js actually write anything.
*/
async function dryRunAdoMigration() {
    logger.info('Starting ADO migration dry run (no writes)');

    const adoIndex = await buildAdoIndex();
    const companies = await getAllCompanies(['name', ADO_PROPERTIES.dropdown, ADO_PROPERTIES.associateId]);
    const rows = companies.map(company => classifyCompanyAdoValue(company, adoIndex));

    console.table(rows.map(r => ({
        companyId: r.companyId,
        companyName: r.companyName,
        currentArd: r.currentArd,
        proposedArd: r.proposedArd,
        status: r.status
    })));

    const summary = rows.reduce((acc, row) => {
        acc[row.status] = (acc[row.status] || 0) + 1;
        return acc;
    }, {});
    logger.info('Finished ADO migration dry run', summary);

    return rows;
}

/*
    LIVE - actually writes. Classifies one company's current ard/ado_adp_id
    value exactly like dryRunAdoMigration, then, if the classification is
    'would_migrate', PATCHes the company to the correct associateId-keyed
    value. 'already_correct'/'no_match_found'/'no_ado_assigned' are left
    untouched and just logged.

    Does NOT clean up the legacy option here - that check reads from
    HubSpot's search index, which is eventually consistent and can briefly
    still show this exact write as "still in use" if checked immediately.
    Run cleanupLegacyOptions() once, after all the single-company updates
    you're doing in this session, instead of checking right after each one.
*/
async function dryRunSingleCompany(companyId) {
    const adoIndex = await buildAdoIndex();
    const company = await getCompanyById(companyId, ['name', ADO_PROPERTIES.dropdown, ADO_PROPERTIES.associateId]);
    const row = classifyCompanyAdoValue(company, adoIndex);

    console.log(JSON.stringify(row, null, 2));

    if (row.status === 'would_migrate') {
        await updateCompanyAdoFields(row.companyId, row.proposedArd, ADO_PROPERTIES.dropdown, ADO_PROPERTIES.associateId);
        console.log(`Updated company ${row.companyId} -> ${ADO_PROPERTIES.dropdown}/${ADO_PROPERTIES.associateId} = ${row.proposedArd}`);
    } else {
        console.log(`No write performed - status was "${row.status}"`);
    }

    return row;
}

// HubSpot's search index (what anyCompanyHasPropertyValue reads from) is
// eventually consistent - one pause here before checking, not per-record
// retries, so a single-company test still gets a real chance to settle.
const SEARCH_INDEX_SETTLE_MS = 20000;

/*
    Call once, after you're done running dryRunSingleCompany for however many
    companies in this session. Checks each given legacy value and deletes it
    if nothing references it anymore anywhere in the portal.
*/
async function cleanupLegacyOptions(legacyValues) {
    await new Promise(resolve => setTimeout(resolve, SEARCH_INDEX_SETTLE_MS));

    for (const legacyValue of legacyValues) {
        const deleted = await deleteSingleDropdownOption(ADO_PROPERTIES.dropdown, legacyValue);
        console.log(deleted
            ? `Deleted now-orphaned legacy option: ${legacyValue}`
            : `Legacy option "${legacyValue}" still referenced by another company - left as-is`);
    }
}

module.exports = { dryRunAdoMigration, dryRunSingleCompany, cleanupLegacyOptions, buildAdoIndex, classifyCompanyAdoValue };
