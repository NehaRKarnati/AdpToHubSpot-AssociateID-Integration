const fs = require('fs');
const path = require('path');
const { getAllADPWorkers } = require('./adpWorkerFetch');
const { buildAllDropdownLists } = require('./workerRoleFormatter');
const { getCompanyPropertyCached, getAllCompaniesCached } = require('./hubspotRead');
const { LIST_DEFINITIONS } = require('./config');
const { logger } = require('./logger');
const { rowsToCsv } = require('./csvUtils');

/*
    READ-ONLY, across all 13 lists - makes no PATCH/POST calls to HubSpot.
    Produces two CSVs for manual validation before anything runs against
    production: every dropdown option change, and every company field change,
    with labels shown alongside internal values (associate IDs) throughout.

    Every in-scope company (clinic_id + customer lifecycle) is fetched ONCE,
    with every dropdown/ID property, then cached (getAllCompaniesCached, 6hr
    TTL) and indexed in memory (buildCompanyValueIndex) - "which companies
    currently have this value" becomes a plain object lookup instead of a
    HubSpot search call, for every option and every legacy value across all
    13 lists. This is the single most expensive part of the old approach
    (hundreds of individual/batched search calls) replaced with one fetch.
*/

const LEGACY_LABEL_SUFFIX = ' (legacy)';

// Every property this report ever needs to read, across all 13 lists -
// fetched in the one company pull that everything else is indexed from.
function allReportPropertyNames() {
    const propertyNames = new Set(['name']);
    for (const [listName, definition] of Object.entries(LIST_DEFINITIONS)) {
        propertyNames.add(listName);
        if (definition.associateIdField) propertyNames.add(definition.associateIdField);
    }
    return Array.from(propertyNames);
}

/*
    Builds, per list, a Map from value -> array of companies currently holding
    that value. multiSelect lists get split into individual tokens first, so
    a lookup by one name works the same way as for single-value lists.
*/
function buildCompanyValueIndex(companies) {
    const index = {};
    for (const listName of Object.keys(LIST_DEFINITIONS)) {
        index[listName] = new Map();
    }

    for (const company of companies) {
        for (const [listName, definition] of Object.entries(LIST_DEFINITIONS)) {
            const rawValue = company.properties[listName];
            if (!rawValue) continue;

            const tokens = definition.multiSelect
                ? rawValue.split(';').map(s => s.trim()).filter(Boolean)
                : [rawValue];

            for (const token of tokens) {
                const map = index[listName];
                if (!map.has(token)) map.set(token, []);
                map.get(token).push(company);
            }
        }
    }

    return index;
}

/*
    Dry-run version of syncDropdownOptions's decision logic for one list -
    every existing option, whether it'd be created/updated/hidden/deleted/left
    unchanged, with labels shown for both current and proposed state.

    Options untouched by ID (legacy name-valued ones) get the same name-match
    check migrateLegacyOptions.js does: if the label matches a current ADP
    record, it's 'would_migrate_by_name' (migration will recreate it under the
    resolved associate ID). If truly unmatched, predicts the real outcome -
    'would_hide_no_match' if some company still references it, else
    'would_delete_no_match' - instead of a single generic "unmatched" bucket.

    companiesByValue is this list's slice of buildCompanyValueIndex's output -
    every usage check here is an in-memory lookup, no API calls.

    Deliberately kept as two separate concerns, never mixed in one row:
      - New/active-person options: would_create (doesn't exist yet, or exists
        but needs a label/visibility fix) or unchanged.
      - Existing legacy (name-valued) options: this row is ONLY ever about
        what happens to that OLD option itself - never "would_create", even
        when its name matches a current person (that person's new option is
        already covered by its own would_create row above). Outcome is
        purely usage-based: would_delete (nothing references it),
        would_rename (something still does - renamed to "(legacy)" and
        hidden, never deleted while in use), or unchanged (already renamed
        and hidden by a prior run - nothing left to do).
*/
async function buildOptionChangeRows(listName, listRecords, companiesByValue) {
    const nameToId = { ...listRecords.terminatedLookup, ...listRecords.activeLookup };
    const property = await getCompanyPropertyCached(listName);
    const options = property.options || [];
    const optionsByValue = new Map(options.map(o => [o.value, o]));
    const rows = [];
    const touchedValues = new Set();

    for (const record of listRecords.active) {
        touchedValues.add(record.associateId);
        const existing = optionsByValue.get(record.associateId);

        if (!existing) {
            rows.push({
                list: listName, associateId: record.associateId,
                currentLabel: '', currentHidden: '',
                proposedLabel: record.fullName, proposedHidden: false,
                companiesAffected: '', action: 'would_create'
            });
            continue;
        }

        const nameChanged = existing.label !== record.fullName;
        const wasHidden = existing.hidden === true;
        rows.push({
            list: listName, associateId: record.associateId,
            currentLabel: existing.label, currentHidden: wasHidden,
            proposedLabel: record.fullName, proposedHidden: false,
            companiesAffected: '', action: (nameChanged || wasHidden) ? 'would_create' : 'unchanged'
        });
    }

    for (const record of listRecords.terminated) {
        touchedValues.add(record.associateId);
        const existing = optionsByValue.get(record.associateId);
        if (!existing) continue;
        if (existing.hidden === true) {
            rows.push({
                list: listName, associateId: record.associateId,
                currentLabel: existing.label, currentHidden: true,
                proposedLabel: existing.label, proposedHidden: true,
                companiesAffected: '', action: 'unchanged'
            });
            continue;
        }

        const companyCount = (companiesByValue.get(record.associateId) || []).length;
        rows.push({
            list: listName, associateId: record.associateId,
            currentLabel: existing.label, currentHidden: false,
            proposedLabel: companyCount > 0 ? existing.label : '(would be deleted)',
            proposedHidden: companyCount > 0,
            companiesAffected: companyCount,
            action: companyCount > 0 ? 'would_hide' : 'would_delete'
        });
    }

    for (const option of options) {
        if (touchedValues.has(option.value)) continue;

        const alreadyProcessed = option.label.endsWith(LEGACY_LABEL_SUFFIX) && option.hidden === true;
        if (alreadyProcessed) {
            rows.push({
                list: listName, associateId: option.value,
                currentLabel: option.label, currentHidden: true,
                proposedLabel: option.label, proposedHidden: true,
                companiesAffected: '', action: 'unchanged'
            });
            continue;
        }

        const cleanLabel = option.label.endsWith(LEGACY_LABEL_SUFFIX)
            ? option.label.slice(0, -LEGACY_LABEL_SUFFIX.length)
            : option.label;

        // If this legacy option matches a TERMINATED person by name, a new
        // option still gets created for them by migration - but that person
        // never appears in the active-records loop above, so nothing else
        // would ever surface that creation. An active match doesn't need
        // this: the active-records loop already reported it.
        const isTerminatedOnlyMatch = !listRecords.activeLookup[cleanLabel] && !!listRecords.terminatedLookup[cleanLabel];
        if (isTerminatedOnlyMatch) {
            rows.push({
                list: listName, associateId: nameToId[cleanLabel],
                currentLabel: '', currentHidden: '',
                proposedLabel: cleanLabel, proposedHidden: false,
                companiesAffected: '', action: 'would_create'
            });
        }

        // This row is purely about the OLD option's own fate - if matched,
        // that person's new option is reported separately (above, or already
        // covered by the active-records loop for an active match).
        const companyCount = (companiesByValue.get(option.value) || []).length;

        rows.push({
            list: listName, associateId: option.value,
            currentLabel: option.label, currentHidden: option.hidden === true,
            proposedLabel: companyCount > 0 ? `${cleanLabel}${LEGACY_LABEL_SUFFIX}` : '(would be deleted)',
            proposedHidden: companyCount > 0,
            companiesAffected: companyCount,
            action: companyCount > 0 ? 'would_rename' : 'would_delete'
        });
    }

    return rows;
}

/*
    Classifies one atomic value (a single associate ID or legacy name) against
    a list's known-IDs/name-lookup - the single-value version of the logic
    multi-select fields need to run once per semicolon-separated part.
*/
function resolveSingleValue(value, knownAssociateIds, nameToId) {
    if (knownAssociateIds.has(value)) return { proposedValue: value, status: 'already_correct' };
    if (nameToId[value]) return { proposedValue: nameToId[value], status: 'would_migrate' };
    return { proposedValue: value, status: 'no_match_found' };
}

/*
    Dry-run version of the company writeback logic, across all 13 lists in
    one pass over the shared company dataset. Only rows representing an
    actual proposed change are included - fully untouched companies (no
    value, or already correct with no ID field drift) are left out to keep
    the CSV focused.

    multiSelect lists (ados_in_20_min_drive) store a semicolon-delimited list
    of values, not one atomic value - each part is resolved independently,
    then rejoined with ';' for the proposed value/label columns.
*/
async function buildCompanyChangeRows(lists, companies) {
    const listIndexes = {};
    for (const [listName, listRecords] of Object.entries(lists)) {
        const knownAssociateIds = new Set([
            ...listRecords.active.map(r => r.associateId),
            ...listRecords.terminated.map(r => r.associateId)
        ]);
        const nameToId = { ...listRecords.terminatedLookup, ...listRecords.activeLookup };
        const property = await getCompanyPropertyCached(listName);
        const labelByValue = new Map((property.options || []).map(o => [o.value, o.label]));
        listIndexes[listName] = { knownAssociateIds, nameToId, labelByValue };
    }

    const rows = [];
    for (const company of companies) {
        for (const [listName, definition] of Object.entries(LIST_DEFINITIONS)) {
            const { knownAssociateIds, nameToId, labelByValue } = listIndexes[listName];
            const idField = definition.associateIdField;

            const currentValue = company.properties[listName] || null;
            const currentIdValue = idField ? (company.properties[idField] || null) : null;

            if (definition.multiSelect) {
                if (!currentValue) continue;

                const parts = currentValue.split(';').map(s => s.trim()).filter(Boolean);
                const resolved = parts.map(part => ({ part, ...resolveSingleValue(part, knownAssociateIds, nameToId) }));
                const anyChanged = resolved.some(r => r.status !== 'already_correct');
                if (!anyChanged) continue; // every part already correct, nothing to show

                rows.push({
                    list: listName,
                    companyId: company.id,
                    companyName: company.properties.name,
                    currentValue,
                    currentLabel: parts.map(part => labelByValue.get(part) || part).join(';'),
                    proposedValue: resolved.map(r => r.proposedValue).join(';'),
                    proposedLabel: resolved.map(r => labelByValue.get(r.proposedValue) || r.part).join(';'),
                    idField: '',
                    currentIdValue: '',
                    proposedIdValue: '',
                    idFieldChanged: false,
                    status: resolved.some(r => r.status === 'no_match_found') ? 'partial_no_match' : 'would_migrate'
                });
                continue;
            }

            let proposedValue = currentValue;
            let status;
            if (!currentValue) {
                status = 'no_value_assigned';
            } else if (knownAssociateIds.has(currentValue)) {
                status = 'already_correct';
            } else if (nameToId[currentValue]) {
                proposedValue = nameToId[currentValue];
                status = 'would_migrate';
            } else {
                status = 'no_match_found';
            }

            const proposedIdValue = idField && (status === 'already_correct' || status === 'would_migrate')
                ? proposedValue
                : currentIdValue;
            const idFieldChanged = idField ? currentIdValue !== proposedIdValue : false;

            if (status === 'no_value_assigned') continue;
            if (status === 'already_correct' && !idFieldChanged) continue;

            const currentLabel = currentValue ? (labelByValue.get(currentValue) || '(unknown/legacy)') : '';
            // The proposed option (keyed by the new associate ID) usually
            // doesn't exist in HubSpot yet - only created when migration/sync
            // actually runs. Fall back to currentValue, not currentLabel: for
            // 'would_migrate', currentValue matched a nameToId key exactly,
            // so it IS the correct name for the new option - no need to trust
            // a separate (possibly stale/edited) option-label lookup instead.
            const proposedLabel = proposedValue ? (labelByValue.get(proposedValue) || currentValue) : '';

            rows.push({
                list: listName,
                companyId: company.id,
                companyName: company.properties.name,
                currentValue: currentValue || '',
                currentLabel,
                proposedValue: proposedValue || '',
                proposedLabel,
                idField: idField || '',
                currentIdValue: currentIdValue || '',
                proposedIdValue: proposedIdValue || '',
                idFieldChanged,
                status
            });
        }
    }

    return rows;
}

async function runFullDryRunReport(numRecords = 99999) {
    logger.info('Starting full dry-run report across all lists (no writes)');

    const { activeWorkers, terminatedWorkers } = await getAllADPWorkers(numRecords);
    const lists = buildAllDropdownLists(activeWorkers, terminatedWorkers);

    const companies = await getAllCompaniesCached(allReportPropertyNames());
    logger.info('Fetched HubSpot companies for report', { count: companies.length });
    const companyValueIndex = buildCompanyValueIndex(companies);

    const optionRows = [];
    for (const [listName, listRecords] of Object.entries(lists)) {
        const rows = await buildOptionChangeRows(listName, listRecords, companyValueIndex[listName]);
        optionRows.push(...rows);
        logger.info('Built option change report for list', { list: listName, rowCount: rows.length });
    }

    const companyRows = await buildCompanyChangeRows(lists, companies);
    logger.info('Built company change report', { rowCount: companyRows.length });

    const optionsPath = path.join(__dirname, 'reports', 'optionChanges.csv');
    const companiesPath = path.join(__dirname, 'reports', 'companyChanges.csv');
    fs.writeFileSync(optionsPath, rowsToCsv(optionRows));
    fs.writeFileSync(companiesPath, rowsToCsv(companyRows));

    logger.info('Finished full dry-run report', {
        optionRows: optionRows.length,
        companyRows: companyRows.length,
        optionsPath,
        companiesPath
    });

    return { optionRows, companyRows, optionsPath, companiesPath };
}

runFullDryRunReport();

module.exports = {
    runFullDryRunReport,
    buildOptionChangeRows,
    buildCompanyChangeRows,
    rowsToCsv
};
