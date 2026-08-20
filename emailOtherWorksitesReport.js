const path = require('path');
const nodemailer = require('nodemailer');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { run: generateOtherWorksitesReport } = require('./exportOtherWorksites');
const { logger } = require('./logger');

const REPORT_PATH = path.join(__dirname, 'reports', 'otherWorksites.csv');

// Same Mandrill SMTP setup as notifier.js.
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

function formatDateMMDDYYYY(date) {
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    return `${mm}/${dd}/${date.getFullYear()}`;
}

/*
    Regenerates the other-worksites CSV fresh (see exportOtherWorksites.js)
    and emails it as an attachment.

    destinationOverride: pass an email address to send there instead of the
    configured other_worksites_report_destination - used for testing before
    this is scheduled against the real recipient.
*/
async function sendOtherWorksitesReport(destinationOverride) {
    await generateOtherWorksitesReport();

    const destination = destinationOverride || process.env.other_worksites_report_destination;
    if (!destination) {
        throw new Error('No destination configured - set other_worksites_report_destination in .env, or pass one explicitly for testing');
    }

    const subject = `Weekly Employee Primary and Other Worksite Report - ${formatDateMMDDYYYY(new Date())}`;
    const html = `
        <p>Hello,</p>
        <p>Please find attached the report containing all active and on leave employees' primary and other worksite information from ADP.</p>
        <p>Thank you!</p>
    `;

    try {
        const info = await transporter.sendMail({
            from: process.env.exchange_username,
            to: destination,
            subject,
            html,
            attachments: [{ filename: 'otherWorksites.csv', path: REPORT_PATH }]
        });
        logger.info('Sent other worksites report email', { destination, messageId: info.messageId });
    } catch (error) {
        logger.error('Failed to send other worksites report email', { destination, error: error.message });
        throw error;
    }
}

/*
    CLI usage:
      node emailOtherWorksitesReport.js                    - real destination (other_worksites_report_destination)
      node emailOtherWorksitesReport.js someone@empowerme.com - test override
*/
if (require.main === module) {
    const destinationOverride = process.argv[2];
    sendOtherWorksitesReport(destinationOverride).catch(error => {
        logger.error('Error running other worksites report email job', { error: error.message });
        process.exitCode = 1;
    });
}

module.exports = { sendOtherWorksitesReport };
