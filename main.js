const { runSync } = require('./syncOrchestrator');
const { cleanupLegacyOptions } = require('./migrateLegacyOptions');
const { logger } = require('./logger');

// Gap between sync and cleanup - lets HubSpot's search index settle on
// everything sync just wrote, so migration's usage checks (which decide
// delete vs. hide for leftover legacy options) read accurate, caught-up data
// rather than racing the writes that just happened.
const CLEANUP_DELAY_MS = 2 * 60 * 1000;

/*
    Entry point for a single scheduled run. Scheduling (cron) is handled on
    the VM, not in-process - this just runs once and exits.

    Two steps, always in this order:
      1. runSync() - the everyday reconciliation (option create/update/hide/
         delete for active/terminated ADP people, company field refresh).
         This never touches legacy name-valued options at all.
      2. cleanupLegacyOptions() - the lightweight recheck: for whatever
         legacy options are already left over (from a prior manual
         migrateLegacyOptions run), checks if anything still references them
         and deletes if not, else leaves them hidden+renamed. No name
         matching, no option creation, no company reassignment here - that
         heavier work only needs to happen once (or on demand) via
         migrateLegacyOptions(), not every single scheduled run.
*/
async function main() {
    try {
        // dryRun explicitly false - this is the real production entry point.
        // runSync()'s own default is dryRun: true precisely so a bare/careless
        // call anywhere else never accidentally writes to HubSpot; main() has
        // to opt into a real run on purpose, here.
        const syncSummary = await runSync(99999, { dryRun: false });
        logger.info('Sync run complete', syncSummary);

        await new Promise(resolve => setTimeout(resolve, CLEANUP_DELAY_MS));

        const cleanupResults = await cleanupLegacyOptions();
        logger.info('Legacy option cleanup complete', { actionCount: cleanupResults.length });

        process.exitCode = 0;
    } catch (error) {
        logger.error('Scheduled run failed', { error: error.message });
        process.exitCode = 1;
    }
}

if (require.main === module) {
    main();
}
