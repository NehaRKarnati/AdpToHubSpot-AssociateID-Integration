const { getAllADPWorkers } = require('./adpWorkerFetch');
const { buildAllDropdownLists } = require('./workerRoleFormatter');
const { getCompaniesByPropertyValue } = require('./hubspotRead');
const { syncDropdownOptions, updateCompanyAdoFields } = require('./hubspotWrite');
const { LIST_DEFINITIONS } = require('./config');
const { logger, runStats, logRunBoundary } = require('./logger');
const { sendSyncChangeNotification } = require('./notifier');

/*
    Runs the full ADP -> HubSpot sync for one dropdown list (e.g. 'ard',
    'future_rvp', 'cd_iii'): reconciles the dropdown's options against this
    list's eligible-role records, then, for every active person in the list,
    finds companies already pointing at their associate ID and rewrites the
    dropdown value (and the paired ID field, if this list has one - see
    LIST_DEFINITIONS) to keep it correct.

    Pass dryRun: true to run the exact same logic and logging, but skip every
    actual HubSpot write (option PATCH and company PATCH) - a full replica of
    a production run with nothing actually changed.

    multiSelect lists (ados_in_20_min_drive) are skipped for the company-level
    step entirely: there's no ID field to write, an EQ search would never
    match a value inside a semicolon-delimited field, and a naive overwrite
    would wipe out the other selected names. Moving a legacy name to the
    correct associate ID within a multi-select value is handled by
    migrateLegacyOptions.js (replaceMultiSelectToken), not the recurring sync.
*/
async function syncList(listName, listRecords, associateIdField, multiSelect, dryRun = true) {
    const actions = await syncDropdownOptions(listName, listRecords.active, listRecords.terminated, dryRun);
    const taggedActions = actions.map(a => ({ ...a, list: listName }));

    if (multiSelect) return taggedActions;

    for (const record of listRecords.active) {
        let companies;
        try {
            companies = await getCompaniesByPropertyValue(listName, record.associateId);
        } catch (error) {
            runStats.increment('errors');
            runStats.addRecord({ ...record, list: listName, companyUpdateResult: 'search_failed', error: error.message });
            continue;
        }

        logger.info('Companies found for employee', {
            dropdown: listName,
            employee: record.fullName,
            associateId: record.associateId,
            companyCount: companies.length,
            companies: companies.map(c => ({ id: c.id, name: c.properties.name }))
        });

        if (companies.length === 0) {
            runStats.increment('companiesSkipped');
            runStats.addRecord({ ...record, list: listName, companyUpdateResult: 'no_companies_assigned' });
            continue;
        }

        for (const company of companies) {
            try {
                await updateCompanyAdoFields(company.id, record.associateId, listName, associateIdField, dryRun);
                runStats.addRecord({ ...record, list: listName, companyId: company.id, companyUpdateResult: dryRun ? 'would_update' : 'updated' });
            } catch (error) {
                runStats.addRecord({ ...record, list: listName, companyId: company.id, companyUpdateResult: 'update_failed', error: error.message });
            }
        }
    }

    return taggedActions;
}

/*
    Pass { dryRun: true } to replicate a full production run - same ADP pull,
    same classification, same per-list option/company logic and logging -
    without writing anything to HubSpot. Useful for a final end-to-end check
    before letting a run actually touch production.
*/
async function runSync(numRecords = 99999, { dryRun = true } = {}) {
    runStats.reset();
    logRunBoundary(dryRun ? '[DRY RUN] SYNC RUN START' : 'SYNC RUN START');
    logger.info(dryRun ? '[DRY RUN] Starting ADP -> HubSpot sync run - no writes will be made' : 'Starting ADP -> HubSpot sync run');

    // forceRefresh: true - every run pulls current ADP data, never the
    // getAllADPWorkers() disk cache (that cache exists for ad-hoc/manual
    // testing scripts only, not for this recurring production entry point).
    const { activeWorkers, terminatedWorkers } = await getAllADPWorkers(numRecords, { forceRefresh: true });
    const lists = buildAllDropdownLists(activeWorkers, terminatedWorkers);

    runStats.increment('adpRecordsProcessed', activeWorkers.length + terminatedWorkers.length);

    const allActions = [];
    for (const [listName, definition] of Object.entries(LIST_DEFINITIONS)) {
        const listRecords = lists[listName];
        runStats.increment('activeRecordsProcessed', listRecords.active.length);
        runStats.increment('terminatedRecordsProcessed', listRecords.terminated.length);
        const actions = await syncList(listName, listRecords, definition.associateIdField, definition.multiSelect, dryRun);
        allActions.push(...actions);
    }

    const summary = runStats.summary();
    logger.info(dryRun ? '[DRY RUN] Finished ADP -> HubSpot sync run - nothing was written' : 'Finished ADP -> HubSpot sync run', summary);

    // The consolidated log entry keeps both option AND company changes (for
    // combined.log review) - 'unchanged'/'no_companies_assigned' are no-ops,
    // excluded from both. The email stays option-changes-only (see notifier.js)
    // since company-level changes can be numerous and would make it noisy.
    const notifiableActions = allActions.filter(a => a.action !== 'unchanged');
    const companyChanges = runStats.records.filter(r =>
        r.companyUpdateResult === 'updated' || r.companyUpdateResult === 'would_update'
    );

    logger.info('Consolidated changes for this run', {
        date: new Date().toISOString(),
        optionChanges: notifiableActions,
        companyChanges
    });
    logRunBoundary(dryRun ? '[DRY RUN] SYNC RUN END' : 'SYNC RUN END');

    await sendSyncChangeNotification(notifiableActions, dryRun);

    return summary;
}

if (require.main === module) {
    runSync().catch(error => {
        logger.error('Error during ADP -> HubSpot sync run', { error: error.message });
    });
}

module.exports = {
    runSync,
    syncList
};
