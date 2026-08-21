const nodemailer = require('nodemailer');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { logger } = require('./logger');

// Switched from O365/Exchange direct SMTP to Mandrill (Mailchimp
// Transactional Email) - the old exchange_username/exchange_password
// mailbox was disabled. host/Port/SMTP_Username/SMTP_Password are Mandrill's
// SMTP credentials; exchange_destination is unrelated to auth (just the
// "to" address) and is unaffected by this swap.
const transporter = nodemailer.createTransport({
    host: process.env.host,
    port: Number(process.env.Port),
    secure: false,
    requireTLS: true,
    auth: {
        user: process.env.SMTP_Username,
        pass: process.env.SMTP_Password
    }
});

/*
    Sends ONE consolidated email summarizing every dropdown option change from
    a sync run (create/update/hide/delete), grouped by list - skipped entirely
    if there were zero changes. Company ADP ID field changes are NOT included
    here (too noisy for email) - those are still logged in full in
    combined.log's consolidated per-run summary, just not emailed. Never
    called during the one-time migration (migrateLegacyOptions.js never calls
    syncDropdownOptions, so it can't trigger this). Sent for both real and dry
    runs - pass dryRun: true to tag the subject/body clearly so it's obvious
    nothing was actually written.
*/
// Maps raw internal action codes to plain-language labels for the email -
// never the raw code itself. Two things this fixes:
//   1. "deleted"/"created" alone don't say which step did it or why, and
//      "would_delete_idle" leaking into a real (non-dry-run) email would be
//      actively wrong - readers need the label to always match what
//      actually happened, real or hypothetical, never the internal name.
//   2. Every "would_*" dry-run code gets an explicit "(not actually done -
//      dry run)" suffix, so a dry-run report can never be misread as saying
//      something was deleted/created when it wasn't.
const NOT_ACTUALLY_DONE = ' - not actually done, dry run';
const ACTION_LABELS = {
    // Regular sync (syncDropdownOptions)
    created: 'Option created (new active person)',
    updated: 'Option name/visibility updated',
    hidden: 'Option hidden (terminated, still referenced by a company)',
    deleted: 'Option deleted (terminated, no longer in use)',
    would_create: `Option would be created (new active person)${NOT_ACTUALLY_DONE}`,
    would_update: `Option name/visibility would be updated${NOT_ACTUALLY_DONE}`,
    would_hide: `Option would be hidden (terminated, still referenced by a company)${NOT_ACTUALLY_DONE}`,
    would_delete: `Option would be deleted (terminated, no longer in use)${NOT_ACTUALLY_DONE}`,

    // Legacy migration/cleanup (migrateLegacyOptions)
    option_created: 'Option created (new person, from legacy name match)',
    renamed_and_hidden: 'Legacy option renamed and hidden (still referenced, replaced by new option)',
    would_create_option: `Option would be created (new person, from legacy name match)${NOT_ACTUALLY_DONE}`,
    would_rename_and_hide: `Legacy option would be renamed and hidden (still referenced, replaced by new option)${NOT_ACTUALLY_DONE}`,

    // Promotions/rehires (managePromotions)
    created_early: 'Option created early (upcoming promotion/rehire)',
    deleted_idle: 'Option deleted (created early, never assigned to a company within 45 days)',
    would_create_early: `Option would be created early (upcoming promotion/rehire)${NOT_ACTUALLY_DONE}`,
    would_delete_idle: `Option would be deleted (created early, never assigned to a company within 45 days)${NOT_ACTUALLY_DONE}`
};

function describeAction(action) {
    return ACTION_LABELS[action] || action;
}

async function sendSyncChangeNotification(optionChanges, dryRun = false) {
    if (optionChanges.length === 0) {
        logger.info('No option changes this run - skipping notification email');
        return;
    }

    const tag = dryRun ? '[DRY RUN] ' : '';

    const byList = {};
    for (const action of optionChanges) {
        if (!byList[action.list]) byList[action.list] = [];
        byList[action.list].push(action);
    }

    const summaryHtml = Object.entries(byList)
        .map(([list, items]) => `<li>${list}: ${items.length} change(s)</li>`)
        .join('');

    const tableRowsHtml = optionChanges
        .map(a => `<tr><td>${a.list}</td><td>${a.associateId}</td><td>${a.fullName}</td><td>${describeAction(a.action)}</td></tr>`)
        .join('');

    const html = `
        ${dryRun ? '<p><strong>DRY RUN - nothing below was actually written to HubSpot.</strong></p>' : ''}
        <p>Total option changes this run: ${optionChanges.length}</p>
        <ul>${summaryHtml}</ul>
        <table border="1" cellpadding="4" cellspacing="0">
            <tr><th>List</th><th>Associate ID</th><th>Name</th><th>Action</th></tr>
            ${tableRowsHtml}
        </table>
    `;

    try {
        await transporter.sendMail({
            from: process.env.exchange_username,
            to: process.env.exchange_destination,
            subject: `${tag}ADP -> HubSpot sync: ${optionChanges.length} dropdown option change(s)`,
            html
        });
        logger.info('Sent sync change notification email', { changeCount: optionChanges.length, dryRun });
    } catch (error) {
        logger.error('Failed to send sync change notification email', { error: error.message });
    }
}

module.exports = { sendSyncChangeNotification };
