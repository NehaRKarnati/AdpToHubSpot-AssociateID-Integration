const { createLogger, format, transports } = require('winston');
const fs = require('fs');
const path = require('path');

const { combine, timestamp, colorize, printf } = format;

// Separate log files from logger.js's (main ADP -> HubSpot sync) logs, so the
// OneLogin office location sync's activity is easy to review on its own,
// without being interleaved with the sync's much higher-volume logging.
function logPath(fileName) {
    return path.join(__dirname, 'logs', fileName);
}

const consoleFormat = printf(({ level, message, timestamp, ...meta }) => {
    const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    return `[${timestamp}] ${level}: ${message}${metaStr}`;
});

const fileFormat = printf((info) => {
    const json = info.level === 'debug' ? JSON.stringify(info) : JSON.stringify(info, null, 2);
    return `${json}\n`;
});

const todayLogFile = logPath('oneLoginToday.log');

// Same "cleared once per new day" behavior as logger.js's today.log.
function clearTodayLogIfStale() {
    const todayStr = new Date().toISOString().slice(0, 10);
    try {
        const lastModifiedStr = fs.statSync(todayLogFile).mtime.toISOString().slice(0, 10);
        if (lastModifiedStr !== todayStr) fs.writeFileSync(todayLogFile, '');
    } catch (error) {
        // File doesn't exist yet - nothing to clear, it'll be created fresh.
    }
}
clearTodayLogIfStale();

const oneLoginLogger = createLogger({
    level: 'debug',
    format: combine(
        timestamp(),
        fileFormat
    ),
    transports: [
        new transports.File({ filename: logPath('oneLoginError.log'), level: 'error' }),
        new transports.File({ filename: logPath('oneLoginWarn.log'), level: 'warn' }),
        new transports.File({ filename: logPath('oneLoginCombined.log') }), // full history, never cleared
        new transports.File({ filename: todayLogFile }), // today only, cleared daily
        new transports.Console({
            format: combine(colorize(), timestamp(), consoleFormat)
        })
    ]
});

/*
    Same plain-text divider as logger.js's logRunBoundary, written to
    oneLoginCombined.log specifically.
*/
function logRunBoundary(label) {
    const divider = `\n${'='.repeat(80)}\n${label} - ${new Date().toISOString()}\n${'='.repeat(80)}\n`;
    fs.appendFileSync(logPath('oneLoginCombined.log'), divider);
}

module.exports = {
    logger: oneLoginLogger,
    logRunBoundary
};
