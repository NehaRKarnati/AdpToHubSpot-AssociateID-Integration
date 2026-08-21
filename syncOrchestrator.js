const { getAllADPWorkers } = require('./adpWorkerFetch');
const { buildAllDropdownLists } = require('./workerRoleFormatter');
const { getAllCompanies } = require('./hubspotRead');
const { syncDropdownOptions, updateCompanyAdoFields } = require('./hubspotWrite');
const { getProtectedAssociateIds } = require('./managePromotions');
const { LIST_DEFINITIONS } = require('./config');
const { logger, runStats, logRunBoundary } = require('./logger');

/*
    Groups one bulk company pull (see runSync) by a single-value dropdown
    property's value, so every list's company lookup is a plain in-memory Map
    read instead of a live search call per active person. Replaces what used
    to be one getCompaniesByPropertyValue call per person per list - with the
    lists having grown considerably (team_lead alone has 700+ active people),
    that was hundreds of redundant search calls per run.
*/
function buildCompanyIndex(companies, propertyName) {
    const index = new Map();
    for (const company of companies) {
        const value = company.properties[propertyName];
        if (!value) continue;
        if (!index.has(value)) index.set(value, []);
        index.get(value).push(company);
    }
    return index;
}

/*
    Runs the full ADP -> HubSpot sync for one dropdown list (e.g. 'ard',
    'future_rvp', 'cd_iii'): reconciles the dropdown's options against this
    list's eligible-role records, then, for every active person in the list,
    finds companies already pointing at their associate ID (via the
    pre-built companyIndex - see buildCompanyIndex) and rewrites the dropdown
    value (and the paired ID field, if this list has one - see
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
async function syncList(listName, listRecords, associateIdField, multiSelect, companyIndex, protectedKeys, dryRun = true) {
    const actions = await syncDropdownOptions(listName, listRecords.active, listRecords.terminated, dryRun, protectedKeys);
    const taggedActions = actions.map(a => ({ ...a, list: listName }));

    if (multiSelect) return taggedActions;

    for (const record of listRecords.active) {
        // In-memory lookup now, not an API call - companyIndex already has
        // every needed property (including associateIdField) from the one
        // bulk pull in runSync.
        const companies = companyIndex.get(record.associateId) || [];

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
            // Skip the PATCH entirely if there's nothing to fix - no ID field
            // on this list, or the ID field already matches. Avoids a
            // redundant re-write (and its 500ms throttle cost) for every
            // company that's already correct, which after a migration run is
            // the vast majority of them.
            const idFieldAlreadyCorrect = !associateIdField || company.properties[associateIdField] === record.associateId;
            if (idFieldAlreadyCorrect) {
                // Not in RunStats's initial counts object, but increment()
                // creates any missing key on first use - no logger.js change needed.
                runStats.increment('companiesUnchanged');
                runStats.addRecord({ ...record, list: listName, companyId: company.id, companyUpdateResult: 'unchanged' });
                continue;
            }

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

// Every company property syncList needs across all 13 lists - exported so
// main.js can build one combined property set (union with managePromotions's
// own needs) for a single shared bulk company fetch.
const SYNC_REQUIRED_PROPERTIES = new Set(['name']);
for (const [listName, definition] of Object.entries(LIST_DEFINITIONS)) {
    SYNC_REQUIRED_PROPERTIES.add(listName);
    if (definition.associateIdField) SYNC_REQUIRED_PROPERTIES.add(definition.associateIdField);
}

/*
    Pass { dryRun: true } to replicate a full production run - same ADP pull,
    same classification, same per-list option/company logic and logging -
    without writing anything to HubSpot. Useful for a final end-to-end check
    before letting a run actually touch production.

    Pass companies (already-fetched, with at least SYNC_REQUIRED_PROPERTIES on
    each) to reuse a bulk fetch the caller already did - e.g. main.js fetches
    once with the combined property set this and managePromotions both need,
    instead of two separate full-portal fetches. Fetches its own otherwise.

    forceRefresh defaults to true - every production run pulls current ADP
    data, never the getAllADPWorkers() disk cache. Pass forceRefresh: false
    for a quick local test run (dry run + cached data combo) that skips the
    full ADP pull entirely.
*/
async function runSync(numRecords = 99999, { dryRun = true, companies = null, forceRefresh = true } = {}) {
    runStats.reset();
    logRunBoundary(dryRun ? '[DRY RUN] SYNC RUN START' : 'SYNC RUN START');
    logger.info(dryRun ? '[DRY RUN] Starting ADP -> HubSpot sync run - no writes will be made' : 'Starting ADP -> HubSpot sync run');

    const { activeWorkers, terminatedWorkers } = await getAllADPWorkers(numRecords, { forceRefresh });
    const lists = buildAllDropdownLists(activeWorkers, terminatedWorkers);

    runStats.increment('adpRecordsProcessed', activeWorkers.length + terminatedWorkers.length);

    // One bulk company pull for the whole run, instead of one search call per
    // active person per list - see buildCompanyIndex.
    const resolvedCompanies = companies || await getAllCompanies(Array.from(SYNC_REQUIRED_PROPERTIES));
    logger.info('Fetched companies for sync run', { count: resolvedCompanies.length });

    // Anyone managePromotions early-created within the last 45 days (e.g. a
    // rehire ADP still shows as terminated until their real start date) -
    // syncDropdownOptions must never delete these via its terminated-cleanup,
    // no matter what ADP currently says about them. See getProtectedAssociateIds.
    const protectedKeys = await getProtectedAssociateIds();

    const allActions = [];
    for (const [listName, definition] of Object.entries(LIST_DEFINITIONS)) {
        const listRecords = lists[listName];
        runStats.increment('activeRecordsProcessed', listRecords.active.length);
        runStats.increment('terminatedRecordsProcessed', listRecords.terminated.length);
        const companyIndex = definition.multiSelect ? null : buildCompanyIndex(resolvedCompanies, listName);
        const actions = await syncList(listName, listRecords, definition.associateIdField, definition.multiSelect, companyIndex, protectedKeys, dryRun);
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

    // No email sent here anymore - main.js sends ONE consolidated email after
    // migrateLegacyOptions and managePromotions have also run, so a reader
    // sees the full picture (e.g. an option this step deleted that promotions
    // then recreated later in the same run) instead of just this step's
    // slice, which was actively misleading on its own.
    return { summary, optionChanges: notifiableActions };
}

if (require.main === module) {
    runSync().catch(error => {
        logger.error('Error during ADP -> HubSpot sync run', { error: error.message });
    });
}

module.exports = {
    runSync,
    syncList,
    SYNC_REQUIRED_PROPERTIES
};
