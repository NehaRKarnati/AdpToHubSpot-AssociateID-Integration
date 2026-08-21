const { getAllADPWorkers } = require('./adpWorkerFetch');
const { buildAllDropdownLists } = require('./workerRoleFormatter');
const { getCompanyProperty, getCompaniesByPropertyValue, getCompaniesContainingToken, getValuesInUse, hubspotClient } = require('./hubspotRead');
const { updateCompanyAdoFields, replaceMultiSelectToken, resolveLabelCollision } = require('./hubspotWrite');
const { LIST_DEFINITIONS } = require('./config');
const { logger } = require('./logger');

const LEGACY_LABEL_SUFFIX = ' (legacy)';

// Placeholder option values that are never real people and should never be
// touched by migration/cleanup - no name match will ever exist for these, and
// they should stay exactly as-is (visible, not renamed/hidden/deleted)
// regardless of usage.
const PROTECTED_OPTION_VALUES = new Set(['Vacant']);

// One pause before the "is it still in use" pass, not per-record retries -
// HubSpot's search index is eventually consistent, so give it a moment to
// catch up with every reassignment PATCHed in phase 1 before phase 2 trusts it.
const SEARCH_INDEX_SETTLE_MS = 10000;

// Short pause after creating the new associateId-keyed options (property
// PATCH) before attempting any company reassignment onto them - a defensive
// buffer in case HubSpot's property-definition validation doesn't see a
// just-written option as immediately valid. Much shorter than
// SEARCH_INDEX_SETTLE_MS since this isn't waiting on the search index, just
// the property definition itself.
const OPTION_CREATE_SETTLE_MS = 3000;

/*
    ONE-TIME migration - not part of the recurring sync (syncOrchestrator.js).
    Safe to run multiple times and in either order relative to the sync -
    every step here is idempotent. Runs across all 13 lists in LIST_DEFINITIONS,
    not just ard.

    Every dropdown property may have options whose internal value is the
    person's NAME (from before this integration existed for that list), not
    their ADP associate ID. The recurring sync only ever touches associateId-
    keyed options, so those legacy name-keyed options would otherwise sit
    there untouched forever, and any company still pointing at one of them
    would never get picked up by getCompaniesByPropertyValue (which searches
    by associateId).

    Per list:

    Phase 1a - for every legacy option that matches a current ADP record,
    build the correct associateId-keyed option (clean label, hidden: false)
    IN MEMORY, then PATCH the property once with all of them added. This has
    to happen and be written to HubSpot BEFORE any company reassignment is
    attempted - HubSpot rejects (400) a company PATCH that sets an enum
    property to a value not already among that property's defined options,
    and the new associateId value obviously isn't yet until this PATCH lands.

    Phase 1b - now that the new options actually exist on the property,
    reassign every company currently on each matched legacy value over to the
    new associateId-keyed value (writing the paired ID field too, if this
    list has one). Legacy options with no ADP match are left alone here -
    there's no correct value to reassign their companies to.

    Phase 2 - only after every phase-1b write for this list is done (and a
    short settle delay), batch-check (getValuesInUse) whether each legacy
    value is now truly unreferenced anywhere in the portal. If so, delete the
    option outright. If something still holds it - an unmatched legacy option,
    a reassignment that failed, or a company outside our search scope - hide
    +rename it instead of deleting, so nothing ends up pointing at a value
    that no longer exists.

    Pass dryRun: true to compute and log every decision (option creates,
    company reassignments, deletes/hides) exactly as normal, but skip every
    actual write - both property PATCHes and every company PATCH.

    multiSelect lists (ados_in_20_min_drive) store a semicolon-delimited list
    of values - reassignment there uses CONTAINS_TOKEN search + a token
    replace that preserves the other selected names, instead of the EQ
    search + whole-value overwrite used for single-value lists.
*/
async function migrateLegacyOptionsForList(listName, associateIdField, listRecords, multiSelect, dryRun = false) {
    const tag = dryRun ? '[DRY RUN] ' : '';
    const knownAssociateIds = new Set([
        ...listRecords.active.map(r => r.associateId),
        ...listRecords.terminated.map(r => r.associateId)
    ]);
    // Active wins if a name collides between an active and terminated record.
    const nameToId = { ...listRecords.terminatedLookup, ...listRecords.activeLookup };

    const property = await getCompanyProperty(listName);
    const allOptions = property.options || [];
    const legacyOptions = allOptions.filter(opt => !knownAssociateIds.has(opt.value) && !PROTECTED_OPTION_VALUES.has(opt.value));

    logger.info('Found legacy options for list', { list: listName, count: legacyOptions.length });
    if (legacyOptions.length === 0) return { results: [], finalOptions: allOptions };

    const results = [];
    const optionsByValue = new Map(allOptions.map(opt => [opt.value, opt]));
    const pendingCleanup = []; // { legacyValue, label, cleanLabel, newAssociateId }
    const matchedOptions = []; // legacy options with an ADP match - need company reassignment in phase 1b

    // Phase 1a: figure out which legacy options match a current ADP record,
    // and build the new associateId-keyed option for each - in memory only,
    // no company reassignment yet.
    for (const option of legacyOptions) {
        const cleanLabel = option.label.endsWith(LEGACY_LABEL_SUFFIX)
            ? option.label.slice(0, -LEGACY_LABEL_SUFFIX.length)
            : option.label;
        const newAssociateId = nameToId[cleanLabel];

        if (!newAssociateId) {
            logger.warn('No matching ADP associate ID found for legacy option - checking if it can be deleted', {
                list: listName, label: option.label, value: option.value
            });
            pendingCleanup.push({ legacyValue: option.value, label: option.label, cleanLabel: null, newAssociateId: null });
            continue;
        }

        // If the replacement option was already created correctly on a prior
        // run, skip re-creating/re-reporting it - otherwise a legacy option
        // that can never actually be deleted (e.g. only referenced by a
        // company missing clinic_id, so it's invisible to the reassignment
        // search below and permanently stuck "still in use") would re-log
        // "option_created" every single day forever, even though nothing
        // about the real option has changed since the day it was made.
        const existingReplacement = optionsByValue.get(newAssociateId);
        const alreadyCorrect = existingReplacement
            && existingReplacement.label === cleanLabel
            && existingReplacement.hidden !== true;

        if (!alreadyCorrect) {
            // Must happen before setting the new option below: the legacy option
            // being replaced almost always has this exact label already (that's
            // how the name match worked in the first place) - without renaming
            // it out of the way here, the upcoming early PATCH would send two
            // options with the same label in one request and HubSpot would
            // reject the whole PATCH (NON_UNIQUE_OPTION_LABELS).
            resolveLabelCollision(optionsByValue, cleanLabel, newAssociateId);

            optionsByValue.set(newAssociateId, {
                ...existingReplacement,
                label: cleanLabel,
                value: newAssociateId,
                hidden: false
            });
            results.push({ list: listName, legacyValue: option.value, label: option.label, newAssociateId, action: dryRun ? 'would_create_option' : 'option_created' });
        }

        // Still attempt reassignment every run, regardless of alreadyCorrect -
        // the replacement option existing doesn't mean every company still
        // holding the legacy string value has actually been switched over yet
        // (see the clinic_id gap above).
        matchedOptions.push({ option, cleanLabel, newAssociateId });
    }

    // Write the new options to HubSpot NOW, before any company reassignment
    // is attempted against them - see the phase 1a/1b split explained above.
    if (matchedOptions.length > 0) {
        if (dryRun) {
            logger.info(`${tag}Would create new associateId-keyed options before reassigning companies - no write performed`, {
                dropdown: listName, optionsToCreate: matchedOptions.length
            });
        } else {
            try {
                await hubspotClient.patch(`/crm/v3/properties/companies/${listName}`, {
                    options: Array.from(optionsByValue.values())
                });
                logger.info('Created new associateId-keyed options ahead of company reassignment', {
                    dropdown: listName, optionsCreated: matchedOptions.length
                });
                await new Promise(resolve => setTimeout(resolve, OPTION_CREATE_SETTLE_MS));
            } catch (error) {
                logger.error('Failed to create new options before reassignment - aborting reassignment for this list', {
                    dropdown: listName, error: error.message
                });
                throw error;
            }
        }
    }

    // Phase 1b: now that the new options are real (or this is a dry run),
    // reassign companies off each matched legacy value.
    for (const { option, cleanLabel, newAssociateId } of matchedOptions) {
        let companies;
        try {
            companies = multiSelect
                ? await getCompaniesContainingToken(listName, option.value)
                : await getCompaniesByPropertyValue(listName, option.value);
        } catch (error) {
            results.push({ list: listName, legacyValue: option.value, label: option.label, action: 'search_failed', error: error.message });
            pendingCleanup.push({ legacyValue: option.value, label: option.label, cleanLabel, newAssociateId });
            continue;
        }

        logger.info('Companies found for legacy option', {
            dropdown: listName,
            employee: cleanLabel,
            legacyValue: option.value,
            newAssociateId,
            companyCount: companies.length,
            companies: companies.map(c => ({ id: c.id, name: c.properties.name }))
        });

        for (const company of companies) {
            try {
                if (multiSelect) {
                    await replaceMultiSelectToken(company.id, listName, company.properties[listName], option.value, newAssociateId, dryRun);
                } else {
                    await updateCompanyAdoFields(company.id, newAssociateId, listName, associateIdField, dryRun);
                }
                results.push({
                    list: listName, legacyValue: option.value, label: option.label,
                    newAssociateId, companyId: company.id, action: dryRun ? 'would_reassign' : 'reassigned'
                });
            } catch (error) {
                results.push({
                    list: listName, legacyValue: option.value, label: option.label,
                    companyId: company.id, action: 'reassign_failed', error: error.message
                });
            }
        }

        pendingCleanup.push({ legacyValue: option.value, label: option.label, cleanLabel, newAssociateId });
    }

    // Phase 2: now that every reassignment for this list has been written,
    // check delete vs. hide+rename for every legacy value.
    if (pendingCleanup.length > 0) {
        await new Promise(resolve => setTimeout(resolve, SEARCH_INDEX_SETTLE_MS));

        // getValuesInUse's IN operator matches whole values, not tokens inside
        // a multi-select value - for multiSelect lists, check each legacy value
        // individually with CONTAINS_TOKEN instead of one batched IN call.
        let valuesInUse = new Set();
        try {
            if (multiSelect) {
                for (const { legacyValue } of pendingCleanup) {
                    const matches = await getCompaniesContainingToken(listName, legacyValue);
                    if (matches.length > 0) valuesInUse.add(legacyValue);
                }
            } else {
                valuesInUse = await getValuesInUse(listName, pendingCleanup.map(p => p.legacyValue));
            }
        } catch (error) {
            logger.error('Failed to check legacy option usage - leaving all as-is this run', {
                list: listName, error: error.message
            });
            pendingCleanup.length = 0;
        }

        for (const { legacyValue, label, cleanLabel, newAssociateId } of pendingCleanup) {
            const stillInUse = valuesInUse.has(legacyValue);

            if (!stillInUse) {
                optionsByValue.delete(legacyValue);
                results.push({ list: listName, legacyValue, label, action: dryRun ? 'would_delete' : 'deleted' });
                continue;
            }

            const existing = optionsByValue.get(legacyValue);

            // Already renamed+hidden from a prior run and nothing left to do
            // for it - skip silently instead of re-reporting the same
            // no-op "change" every single day it stays stuck in this
            // still-referenced-so-can't-delete state. Same idempotency check
            // cleanupLegacyOptionsForList already has, just missing here.
            if (existing.label.endsWith(LEGACY_LABEL_SUFFIX) && existing.hidden === true) continue;

            logger.warn('Legacy option still referenced by a company - hiding instead of deleting', {
                list: listName, label, value: legacyValue
            });
            const renamedLabel = existing.label.endsWith(LEGACY_LABEL_SUFFIX)
                ? existing.label
                : `${existing.label}${LEGACY_LABEL_SUFFIX}`;
            if (newAssociateId) {
                // A replacement option is being created with cleanLabel - free that
                // label up first rather than colliding with this hidden legacy one.
                resolveLabelCollision(optionsByValue, cleanLabel, newAssociateId);
            } else {
                // No ADP match, so no replacement option and nothing to free the
                // label for - just rename+hide this option in place.
                optionsByValue.set(legacyValue, { ...existing, label: renamedLabel, hidden: true });
            }
            results.push({ list: listName, legacyValue, label: renamedLabel, action: dryRun ? 'would_rename_and_hide' : 'renamed_and_hidden' });
        }

        if (dryRun) {
            logger.info(`${tag}Would update dropdown options during migration - no write performed`, {
                dropdown: listName, legacyOptionsProcessed: legacyOptions.length
            });
        } else {
            try {
                await hubspotClient.patch(`/crm/v3/properties/companies/${listName}`, {
                    options: Array.from(optionsByValue.values())
                });
                logger.info('Updated dropdown options during migration', { dropdown: listName, legacyOptionsProcessed: legacyOptions.length });
            } catch (error) {
                logger.error('Failed to PATCH dropdown options during migration', { dropdown: listName, error: error.message });
                throw error;
            }
        }
    }

    return { results, finalOptions: Array.from(optionsByValue.values()) };
}

/*
    Runs migrateLegacyOptionsForList across every list in LIST_DEFINITIONS,
    pulling ADP data once and reusing it for all 13 lists.

    Pass { dryRun: true } to replicate the full migration - same logic,
    same logging - without writing anything to HubSpot.
*/
async function migrateLegacyOptions(numRecords = 99999, { dryRun = false } = {}) {
    logger.info(dryRun
        ? '[DRY RUN] Starting legacy options migration across all lists - no writes will be made'
        : 'Starting legacy options migration across all lists');

    const { activeWorkers, terminatedWorkers } = await getAllADPWorkers(numRecords);
    const lists = buildAllDropdownLists(activeWorkers, terminatedWorkers);

    const allResults = [];
    for (const [listName, definition] of Object.entries(LIST_DEFINITIONS)) {
        const { results } = await migrateLegacyOptionsForList(listName, definition.associateIdField, lists[listName], definition.multiSelect, dryRun);
        allResults.push(...results);
    }

    logger.info(dryRun ? '[DRY RUN] Finished legacy options migration across all lists - nothing was written' : 'Finished legacy options migration across all lists', {
        totalActions: allResults.length,
        optionsCreated: allResults.filter(r => r.action === 'option_created' || r.action === 'would_create_option').length,
        reassigned: allResults.filter(r => r.action === 'reassigned' || r.action === 'would_reassign').length,
        deleted: allResults.filter(r => r.action === 'deleted' || r.action === 'would_delete').length,
        renamedAndHidden: allResults.filter(r => r.action === 'renamed_and_hidden' || r.action === 'would_rename_and_hide').length,
        failed: allResults.filter(r => r.action === 'reassign_failed' || r.action === 'search_failed').length
    });

    return allResults;
}

/*
    Lightweight companion to migrateLegacyOptionsForList - NO name matching,
    NO option creation, NO company reassignment. Just: for every legacy
    option still on this list (matched or not), check whether anything still
    references it and delete it if not, else leave it hidden+renamed as-is.

    This is what should run after every regular sync (see main.js) - the
    heavier match/create/reassign work in migrateLegacyOptionsForList only
    needs to happen once (or on demand), but re-checking "is this leftover
    legacy option finally safe to delete" is cheap and worth doing every run,
    since a company's field can be manually reselected at any time, quietly
    freeing up a legacy value that was still in use before.
*/
async function cleanupLegacyOptionsForList(listName, listRecords, multiSelect, dryRun = false) {
    const tag = dryRun ? '[DRY RUN] ' : '';
    const knownAssociateIds = new Set([
        ...listRecords.active.map(r => r.associateId),
        ...listRecords.terminated.map(r => r.associateId)
    ]);

    const property = await getCompanyProperty(listName);
    const allOptions = property.options || [];
    const legacyOptions = allOptions.filter(opt => !knownAssociateIds.has(opt.value) && !PROTECTED_OPTION_VALUES.has(opt.value));

    if (legacyOptions.length === 0) return [];

    const optionsByValue = new Map(allOptions.map(opt => [opt.value, opt]));
    const results = [];

    let valuesInUse = new Set();
    try {
        if (multiSelect) {
            for (const option of legacyOptions) {
                const matches = await getCompaniesContainingToken(listName, option.value);
                if (matches.length > 0) valuesInUse.add(option.value);
            }
        } else {
            valuesInUse = await getValuesInUse(listName, legacyOptions.map(o => o.value));
        }
    } catch (error) {
        logger.error('Failed to check legacy option usage during cleanup - leaving all as-is this run', {
            list: listName, error: error.message
        });
        return [];
    }

    let optionsChanged = false;
    for (const option of legacyOptions) {
        const stillInUse = valuesInUse.has(option.value);

        if (!stillInUse) {
            optionsByValue.delete(option.value);
            results.push({ list: listName, legacyValue: option.value, label: option.label, action: dryRun ? 'would_delete' : 'deleted' });
            optionsChanged = true;
            continue;
        }

        // Already renamed+hidden from a prior run - nothing left to do.
        if (option.label.endsWith(LEGACY_LABEL_SUFFIX) && option.hidden === true) continue;

        const renamedLabel = option.label.endsWith(LEGACY_LABEL_SUFFIX)
            ? option.label
            : `${option.label}${LEGACY_LABEL_SUFFIX}`;
        optionsByValue.set(option.value, { ...option, label: renamedLabel, hidden: true });
        results.push({ list: listName, legacyValue: option.value, label: renamedLabel, action: dryRun ? 'would_rename_and_hide' : 'renamed_and_hidden' });
        optionsChanged = true;
    }

    if (!optionsChanged) return results;

    if (dryRun) {
        logger.info(`${tag}Would update dropdown options during legacy cleanup - no write performed`, {
            dropdown: listName, legacyOptionsProcessed: legacyOptions.length
        });
        return results;
    }

    try {
        await hubspotClient.patch(`/crm/v3/properties/companies/${listName}`, {
            options: Array.from(optionsByValue.values())
        });
        logger.info('Updated dropdown options during legacy cleanup', { dropdown: listName, legacyOptionsProcessed: legacyOptions.length });
    } catch (error) {
        logger.error('Failed to PATCH dropdown options during legacy cleanup', { dropdown: listName, error: error.message });
        throw error;
    }

    return results;
}

/*
    Runs cleanupLegacyOptionsForList across every list - the lightweight
    "recheck leftover legacy options" pass meant to run after every regular
    sync (see main.js), not the full match/create/reassign migration.
*/
async function cleanupLegacyOptions(numRecords = 99999, { dryRun = false } = {}) {
    logger.info(dryRun
        ? '[DRY RUN] Starting legacy option cleanup across all lists - no writes will be made'
        : 'Starting legacy option cleanup across all lists');

    const { activeWorkers, terminatedWorkers } = await getAllADPWorkers(numRecords);
    const lists = buildAllDropdownLists(activeWorkers, terminatedWorkers);

    const allResults = [];
    for (const [listName, definition] of Object.entries(LIST_DEFINITIONS)) {
        const results = await cleanupLegacyOptionsForList(listName, lists[listName], definition.multiSelect, dryRun);
        allResults.push(...results);
    }

    logger.info(dryRun ? '[DRY RUN] Finished legacy option cleanup across all lists - nothing was written' : 'Finished legacy option cleanup across all lists', {
        totalActions: allResults.length,
        deleted: allResults.filter(r => r.action === 'deleted').length,
        renamedAndHidden: allResults.filter(r => r.action === 'renamed_and_hidden').length
    });

    return allResults;
}

module.exports = { migrateLegacyOptions, migrateLegacyOptionsForList, cleanupLegacyOptions, cleanupLegacyOptionsForList };
