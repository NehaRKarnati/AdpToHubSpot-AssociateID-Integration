const { getAllADPWorkers } = require('./adpWorkerFetch');
const { getAllCompanies, getCompanyProperty, hubspotClient } = require('./hubspotRead');
const { resolveLabelCollision } = require('./hubspotWrite');
const { sortWorkersIntoRoles } = require('./workerRoleFormatter');
const { LIST_DEFINITIONS } = require('./config');
const { readToken, writeToken } = require('./tokenStore');
const { logger } = require('./logger');

// Only the lists that actually have a "future" counterpart + a start-date
// field on the company record - cd_iii and regional_ops_coordinator have
// neither, so early promotion doesn't apply to them (they're only ever
// populated by real ADP classification, per LIST_DEFINITIONS).
const PROMOTION_LIST_MAP = {
    ard: { futureList: 'future_ado', startDateField: 'future_ado_start_date' },
    team_lead: { futureList: 'future_team_lead', startDateField: 'future_team_lead_start_date' },
    rvp: { futureList: 'future_rvp', startDateField: 'future_rvp_start_date' },
    dvp: { futureList: 'future_dvp', startDateField: 'future_dvp_start_date' },
    ops_coordinator: { futureList: 'future_ops_coordinator', startDateField: 'future_ops_coordinator_start_date' }
};

// Every company property promoteEarlyStarts needs - exported so main.js can
// build one combined property set (union with syncOrchestrator's own needs)
// for a single shared bulk company fetch, instead of two separate ones.
const PROMOTION_REQUIRED_PROPERTIES = new Set(['name']);
for (const { futureList, startDateField } of Object.values(PROMOTION_LIST_MAP)) {
    PROMOTION_REQUIRED_PROPERTIES.add(futureList);
    PROMOTION_REQUIRED_PROPERTIES.add(startDateField);
}

const EARLY_PROMOTION_WINDOW_DAYS = 5;
const IDLE_DELETE_DAYS = 45;
const TRACKING_TOKEN_KEY = 'promotionTracking';

function daysBetween(dateA, dateB) {
    return (dateA.getTime() - dateB.getTime()) / (1000 * 60 * 60 * 24);
}

async function readTracking() {
    const tracking = await readToken(TRACKING_TOKEN_KEY);
    return tracking || {};
}

async function writeTracking(tracking) {
    await writeToken(tracking, TRACKING_TOKEN_KEY);
}

/*
    For every list with a future counterpart: finds companies whose
    <list>_start_date is within EARLY_PROMOTION_WINDOW_DAYS (including
    already-past dates - a delayed run should still catch up, not skip them),
    and creates the same option (already associate-ID-keyed - see
    PROMOTION_LIST_MAP note) in the CURRENT list if it isn't already there.

    Company reassignment is NOT done here - a separate HubSpot workflow
    handles moving the company's current-list field once the option exists.
    This function's only job is making sure the option is there in time for
    that workflow (or a human) to use it.

    The future list's OWN option label is reused as-is when creating the
    matching current-list option, since Jacob creates future options keyed by
    associate ID with the correct display name already set - no ADP lookup
    needed.

    Pass companies (already-fetched, with at least PROMOTION_REQUIRED_PROPERTIES
    on each) to reuse a bulk fetch the caller already did - e.g. main.js fetches
    once with the combined property set runSync + this function both need,
    instead of two separate full-portal fetches. Fetches its own otherwise.
*/
async function promoteEarlyStarts({ dryRun = true, companies = null } = {}) {
    const tag = dryRun ? '[DRY RUN] ' : '';

    const resolvedCompanies = companies || await getAllCompanies(Array.from(PROMOTION_REQUIRED_PROPERTIES));
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const results = [];
    const tracking = await readTracking();

    for (const [currentList, { futureList, startDateField }] of Object.entries(PROMOTION_LIST_MAP)) {
        const dueAssociateIds = new Set();

        for (const company of resolvedCompanies) {
            const startDateRaw = company.properties[startDateField];
            if (!startDateRaw) continue;

            const startDate = new Date(startDateRaw);
            if (isNaN(startDate.getTime())) continue;
            if (daysBetween(startDate, today) > EARLY_PROMOTION_WINDOW_DAYS) continue; // more than 5 days away - not due yet

            const futureAssociateId = company.properties[futureList];
            if (!futureAssociateId) continue;

            dueAssociateIds.add(futureAssociateId);
        }

        if (dueAssociateIds.size === 0) continue;

        const [currentProperty, futureProperty] = await Promise.all([
            getCompanyProperty(currentList),
            getCompanyProperty(futureList)
        ]);
        const futureLabelByValue = new Map((futureProperty.options || []).map(opt => [opt.value, opt.label]));
        const optionsByValue = new Map((currentProperty.options || []).map(opt => [opt.value, opt]));

        let anyNewOption = false;
        for (const associateId of dueAssociateIds) {
            const existing = optionsByValue.get(associateId);
            if (existing && existing.hidden !== true) {
                results.push({ list: currentList, associateId, action: 'already_exists' });
                continue;
            }

            const fullName = futureLabelByValue.get(associateId) || associateId;
            resolveLabelCollision(optionsByValue, fullName, associateId);
            optionsByValue.set(associateId, { ...existing, label: fullName, value: associateId, hidden: false });
            anyNewOption = true;
            results.push({ list: currentList, associateId, fullName, action: dryRun ? 'would_create_early' : 'created_early' });

            const trackingKey = `${currentList}:${associateId}`;
            if (!dryRun && !tracking[trackingKey]) {
                tracking[trackingKey] = { fullName, firstCreatedAt: today.toISOString() };
            }
        }

        if (!anyNewOption) continue;

        // Log only the ones actually being created here, not every due
        // candidate (some of dueAssociateIds may already be real options).
        const newlyCreated = results.filter(r => r.list === currentList && (r.action === 'created_early' || r.action === 'would_create_early'));
        if (dryRun) {
            logger.info(`${tag}Would create early-promotion option(s)`, { list: currentList, options: newlyCreated.map(r => ({ associateId: r.associateId, fullName: r.fullName })) });
        } else {
            await hubspotClient.patch(`/crm/v3/properties/companies/${currentList}`, {
                options: Array.from(optionsByValue.values())
            });
            logger.info('Created early-promotion option(s)', { list: currentList, options: newlyCreated.map(r => ({ associateId: r.associateId, fullName: r.fullName })) });
        }
    }

    if (!dryRun) await writeTracking(tracking);
    logger.info(`${tag}Finished early-promotion pass`, {
        created: results.filter(r => r.action === 'created_early' || r.action === 'would_create_early').length,
        alreadyExisted: results.filter(r => r.action === 'already_exists').length
    });
    return results;
}

/*
    Every "list:associateId" pair currently within its 45-day grace period
    (tracked by promoteEarlyStarts, not yet IDLE_DELETE_DAYS old) - these must
    be protected from the regular sync's terminated-record cleanup
    (syncDropdownOptions in hubspotWrite.js), which otherwise has no idea an
    option was JUST created for someone ADP still shows as terminated (a
    rehire whose ADP record won't flip to active until their real start
    date). Without this, runSync would delete the option the very next day
    (terminated + unreferenced), and promoteEarlyStarts would recreate it the
    day after that - a daily create/delete loop, exactly like the Kelly
    Zufall incident.

    Returns a Set of "list:associateId" strings, matching tracking's own key
    format - syncOrchestrator.js checks membership per list, not just by
    associateId alone, so protection never accidentally leaks to a
    different list this same person also happens to be in.
*/
async function getProtectedAssociateIds() {
    const tracking = await readTracking();
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const protectedKeys = new Set();
    for (const [trackingKey, entry] of Object.entries(tracking)) {
        const ageDays = daysBetween(today, new Date(entry.firstCreatedAt));
        if (ageDays < IDLE_DELETE_DAYS) protectedKeys.add(trackingKey);
    }
    return protectedKeys;
}

/*
    For everyone tracked as an early promotion (see promoteEarlyStarts) for
    at least IDLE_DELETE_DAYS:
      - if ADP now classifies them for real into that list's own eligible
        roles, tracking is just dropped - they're a normal permanent entry
        from here on, no cleanup needed.
      - else if ANY company still references them (current OR future field -
        the separate HubSpot workflow may have already reassigned the
        current field independent of this script), tracking is dropped - per
        the business rule, any assignment at all protects them permanently,
        not just within 45 days.
      - else (still not real, and truly never got assigned anywhere) - delete
        the option from BOTH the current and future list, and drop tracking.
*/
async function cleanupIdlePromotions({ dryRun = true } = {}) {
    const tag = dryRun ? '[DRY RUN] ' : '';
    const tracking = await readTracking();
    const trackedEntries = Object.entries(tracking);
    if (trackedEntries.length === 0) return [];

    // getAllADPWorkers's activeWorkers already merges active + on-leave, and
    // is cached to disk (unlike populateWorkerData, which always does a live
    // pull) - avoids a redundant full ADP fetch if this runs shortly after
    // another script already refreshed that cache.
    const { activeWorkers } = await getAllADPWorkers();
    const roleBuckets = sortWorkersIntoRoles(activeWorkers, []);

    const knownAssociateIdsByList = {};
    for (const [listName, definition] of Object.entries(LIST_DEFINITIONS)) {
        const ids = new Set();
        for (const role of definition.eligibleRoles) {
            const bucket = roleBuckets[role];
            if (!bucket) continue;
            for (const r of bucket.active) ids.add(r.associateId);
        }
        knownAssociateIdsByList[listName] = ids;
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const results = [];
    for (const [trackingKey, entry] of trackedEntries) {
        const [listName, associateId] = trackingKey.split(':');
        const promotion = PROMOTION_LIST_MAP[listName];
        if (!promotion) continue; // shouldn't happen, but don't crash on unknown data

        const ageDays = daysBetween(today, new Date(entry.firstCreatedAt));
        if (ageDays < IDLE_DELETE_DAYS) continue;

        if (knownAssociateIdsByList[listName] && knownAssociateIdsByList[listName].has(associateId)) {
            delete tracking[trackingKey];
            results.push({ list: listName, associateId, fullName: entry.fullName, action: 'now_real_stopped_tracking' });
            continue;
        }

        const stillReferenced = await anyCompanyStillReferences(listName, promotion.futureList, associateId);
        if (stillReferenced) {
            delete tracking[trackingKey];
            results.push({ list: listName, associateId, fullName: entry.fullName, action: 'has_assignment_stopped_tracking' });
            continue;
        }

        if (dryRun) {
            logger.info(`${tag}Would delete idle early-promotion option from both lists`, { list: listName, associateId, fullName: entry.fullName });
        } else {
            await deleteOptionFromList(listName, associateId);
            await deleteOptionFromList(promotion.futureList, associateId);
            delete tracking[trackingKey];
        }
        results.push({ list: listName, associateId, fullName: entry.fullName, action: dryRun ? 'would_delete_idle' : 'deleted_idle' });
    }

    if (!dryRun) await writeTracking(tracking);
    logger.info(`${tag}Finished idle early-promotion cleanup`, { actionCount: results.length });
    return results;
}

async function anyCompanyStillReferences(currentList, futureList, associateId) {
    for (const propertyName of [currentList, futureList]) {
        const response = await hubspotClient.post('/crm/v3/objects/companies/search', {
            filterGroups: [{ filters: [{ propertyName, operator: 'EQ', value: associateId }] }],
            properties: ['name'],
            limit: 1
        });
        if (response.data.total > 0) return true;
    }
    return false;
}

async function deleteOptionFromList(listName, associateId) {
    const property = await getCompanyProperty(listName);
    const options = (property.options || []).filter(opt => opt.value !== associateId);
    if (options.length === (property.options || []).length) return; // wasn't there, nothing to do
    await hubspotClient.patch(`/crm/v3/properties/companies/${listName}`, { options });
    logger.info('Deleted idle early-promotion option', { list: listName, associateId });
}

async function run({ dryRun = true, companies = null } = {}) {
    const promoted = await promoteEarlyStarts({ dryRun, companies });
    const cleaned = await cleanupIdlePromotions({ dryRun });
    return { promoted, cleaned };
}

if (require.main === module) {
    const mode = process.argv[2];
    run({ dryRun: mode === 'dry' }).catch(error => {
        logger.error('Error running promotion/demotion management', { error: error.message });
        process.exitCode = 1;
    });
}

module.exports = {
    run,
    promoteEarlyStarts,
    cleanupIdlePromotions,
    getProtectedAssociateIds,
    PROMOTION_LIST_MAP,
    PROMOTION_REQUIRED_PROPERTIES,
    EARLY_PROMOTION_WINDOW_DAYS,
    IDLE_DELETE_DAYS
};
