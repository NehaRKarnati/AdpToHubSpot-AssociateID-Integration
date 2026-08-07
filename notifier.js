const nodemailer = require('nodemailer');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { logger } = require('./logger');

const transporter = nodemailer.createTransport({
    host: 'smtp.office365.com',
    port: 587,
    secure: false,
    requireTLS: true,
    auth: {
        user: process.env.exchange_username,
        pass: process.env.exchange_password
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
        .map(a => `<tr><td>${a.list}</td><td>${a.associateId}</td><td>${a.fullName}</td><td>${a.action}</td></tr>`)
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
