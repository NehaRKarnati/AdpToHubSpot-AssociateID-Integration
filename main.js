const { runSync } = require('./syncOrchestrator');
const { migrateLegacyOptions } = require('./migrateLegacyOptions');
const { logger } = require('./logger');

// Gap between sync and migration - lets HubSpot's search index settle on
// everything sync just wrote, so migration's usage checks (which decide
// delete vs. hide for leftover legacy options) read accurate, caught-up data
// rather than racing the writes that just happened.
const MIGRATION_DELAY_MS = 2 * 60 * 1000;

/*
    Entry point for a single scheduled run. Scheduling (cron) is handled on
    the VM, not in-process - this just runs once and exits.

    Two steps, always in this order:
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
*/
async function main() {
    try {
        // dryRun explicitly false - this is the real production entry point.
        // runSync()'s own default is dryRun: true precisely so a bare/careless
        // call anywhere else never accidentally writes to HubSpot; main() has
        // to opt into a real run on purpose, here.
        const syncSummary = await runSync(99999, { dryRun: false });
        logger.info('Sync run complete', syncSummary);

        await new Promise(resolve => setTimeout(resolve, MIGRATION_DELAY_MS));

        const migrationResults = await migrateLegacyOptions(99999, { dryRun: false });
        logger.info('Legacy option migration/cleanup complete', { actionCount: migrationResults.length });

        process.exitCode = 0;
    } catch (error) {
        logger.error('Scheduled run failed', { error: error.message });
        process.exitCode = 1;
    }
}

if (require.main === module) {
    main();
}
