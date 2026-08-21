const { runSync, SYNC_REQUIRED_PROPERTIES } = require('./syncOrchestrator');
const { migrateLegacyOptions } = require('./migrateLegacyOptions');
const { run: runPromotions, PROMOTION_REQUIRED_PROPERTIES } = require('./managePromotions');
const { getAllCompanies } = require('./hubspotRead');
const { sendSyncChangeNotification } = require('./notifier');
const { logger } = require('./logger');

// Action types worth showing in the consolidated email, per source - keeps
// the email focused on real option-level changes, same as before this
// consolidation (excludes company-field changes and pure bookkeeping like
// "already existed" or "stopped tracking, nothing changed").
const MIGRATION_EMAIL_ACTIONS = new Set([
    'option_created', 'would_create_option',
    'deleted', 'would_delete',
    'renamed_and_hidden', 'would_rename_and_hide'
]);
const PROMOTION_EMAIL_ACTIONS = new Set(['created_early', 'would_create_early', 'deleted_idle', 'would_delete_idle']);

/*
    Normalizes migrateLegacyOptions/managePromotions result shapes to match
    syncOrchestrator's { list, associateId, fullName, action } - so all three
    steps' changes can go into ONE consolidated email table instead of three
    different shapes.
*/
function normalizeMigrationResults(results) {
    return results
        .filter(r => MIGRATION_EMAIL_ACTIONS.has(r.action))
        .map(r => ({
            list: r.list,
            associateId: r.newAssociateId || r.legacyValue,
            fullName: r.label,
            action: r.action
        }));
}

function normalizePromotionResults(results) {
    return results
        .filter(r => PROMOTION_EMAIL_ACTIONS.has(r.action))
        .map(r => ({ list: r.list, associateId: r.associateId, fullName: r.fullName, action: r.action }));
}

// Gap between sync and migration - lets HubSpot's search index settle on
// everything sync just wrote, so migration's usage checks (which decide
// delete vs. hide for leftover legacy options) read accurate, caught-up data
// rather than racing the writes that just happened.
const MIGRATION_DELAY_MS = 2 * 60 * 1000;

/*
    Entry point for a single scheduled run. Scheduling (cron) is handled on
    the VM, not in-process - this just runs once and exits.

    Three steps, always in this order:
      1. runSync() - the everyday reconciliation (option create/update/hide/
         delete for active/terminated ADP people, company field refresh).
         This never touches legacy name-valued options at all.
      2. migrateLegacyOptions() - runs every day (not just once/on-demand) so
         anyone who just became newly eligible for a list (e.g. promoted to
         ADO) automatically gets matched by name and has their still-legacy-
         valued companies reassigned - without this, someone whose HubSpot
         option is still name-keyed would sit there forever, since runSync's
         company-reassignment step only searches by associateId, never by
         the old name string. Safe to run every day - it's a no-op for any
         list with zero legacy options left (the common case once fully
         migrated), and idempotent otherwise.
      3. managePromotions run() - creates the current-list option 5 days
         ahead of a manually-staged future-list promotion's start date, and
         cleans up any early-created option that sat 45+ days without ever
         getting a company assignment. Doesn't depend on step 2's writes
         being search-indexed (it reads HubSpot fresh itself), so no extra
         settle delay before this one.

    The notification email is sent ONCE, here, after all three steps -
    NOT inside runSync itself. Sending it right after step 1 used to mean a
    reader only ever saw that step's slice, with zero visibility into
    anything migration or promotions did afterward in the same run - e.g. an
    option step 1 deleted (terminated, unreferenced) that step 3 then
    recreated moments later (a rehire manually staged in a future list,
    still showing as terminated in ADP until their real start date) looked
    like an unexplained flip-flop day over day, with no way to tell from the
    email alone that promotions was the one recreating it.
*/
async function main() {
    try {
        // One bulk company fetch, shared by runSync and managePromotions -
        // the union of what each needs, instead of two separate full-portal
        // fetches. Safe to reuse for both: the future-list/start-date
        // properties managePromotions reads are never touched by runSync or
        // migrateLegacyOptions, so nothing it needs goes stale between here
        // and when it actually runs (step 3, after the settle delay).
        const companyProperties = new Set([...SYNC_REQUIRED_PROPERTIES, ...PROMOTION_REQUIRED_PROPERTIES]);
        const companies = await getAllCompanies(Array.from(companyProperties));
        logger.info('Fetched companies for this run', { count: companies.length });

        // dryRun explicitly false - this is the real production entry point.
        // runSync()'s own default is dryRun: true precisely so a bare/careless
        // call anywhere else never accidentally writes to HubSpot; main() has
        // to opt into a real run on purpose, here.
        const { summary: syncSummary, optionChanges: syncOptionChanges } = await runSync(99999, { dryRun: false, companies });
        logger.info('Sync run complete', syncSummary);

        await new Promise(resolve => setTimeout(resolve, MIGRATION_DELAY_MS));

        const migrationResults = await migrateLegacyOptions(99999, { dryRun: false });
        logger.info('Legacy option migration/cleanup complete', { actionCount: migrationResults.length });

        const promotionResults = await runPromotions({ dryRun: false, companies });
        logger.info('Promotion/demotion management complete', {
            promoted: promotionResults.promoted.length,
            cleaned: promotionResults.cleaned.length
        });

        // One consolidated email, here, after all three steps - see the
        // block comment above main() for why this moved off of runSync.
        const allOptionChanges = [
            ...syncOptionChanges,
            ...normalizeMigrationResults(migrationResults),
            ...normalizePromotionResults(promotionResults.promoted),
            ...normalizePromotionResults(promotionResults.cleaned)
        ];
        await sendSyncChangeNotification(allOptionChanges, false);

        process.exitCode = 0;
    } catch (error) {
        logger.error('Scheduled run failed', { error: error.message });
        process.exitCode = 1;
    }
}

if (require.main === module) {
    main();
}
