const { createLogger, format, transports } = require('winston');
const fs = require('fs');
const path = require('path');

const { combine, timestamp, colorize, printf } = format;

function logPath(fileName) {
    return path.join(__dirname, 'logs', fileName);
}

const consoleFormat = printf(({ level, message, timestamp, ...meta }) => {
    const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    return `[${timestamp}] ${level}: ${message}${metaStr}`;
});

// Multi-line, indented JSON for real events (info/warn/error) so scrolling
// through the logs by eye is readable. debug entries (e.g. "fetched page
// N of ADP workers") are high-frequency and low-value - those stay compact
// single-line JSON so they don't dominate the file with pretty-printed noise.
const fileFormat = printf((info) => {
    const json = info.level === 'debug' ? JSON.stringify(info) : JSON.stringify(info, null, 2);
    return `${json}\n`;
});

const todayLogFile = logPath('today.log');

// today.log holds only the current day's logs - cleared the first time the
// app runs on a new day (checked against the file's own last-modified date,
// so no separate date-tracking file is needed). combined.log is untouched by
// this and keeps the full permanent history forever.
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

const logger = createLogger({
    level: 'debug',
    format: combine(
        timestamp(),
        fileFormat
    ),
    transports: [
        // File transports append to existing content by default (never
        // truncate) - each run's logs accumulate in the same files.
        new transports.File({ filename: logPath('error.log'), level: 'error' }),
        new transports.File({ filename: logPath('warn.log'), level: 'warn' }),
        new transports.File({ filename: logPath('combined.log') }), // full history, never cleared
        new transports.File({ filename: todayLogFile }), // today only, cleared daily
        new transports.Console({
            format: combine(colorize(), timestamp(), consoleFormat)
        })
    ]
});

/*
    Tracks per-run counters so main.js can build the end-of-run summary
    without re-deriving totals from the log files.
*/
class RunStats {
    constructor() {
        this.reset();
    }

    reset() {
        this.counts = {
            adpRecordsProcessed: 0,
            activeRecordsProcessed: 0,
            terminatedRecordsProcessed: 0,
            optionsCreated: 0,
            optionsUpdated: 0,
            optionsHidden: 0,
            optionsDeleted: 0,
            optionsUnchanged: 0,
            companiesUpdated: 0,
            companiesSkipped: 0,
            errors: 0
        };
        this.records = [];
    }

    increment(key, amount = 1) {
        if (!(key in this.counts)) this.counts[key] = 0;
        this.counts[key] += amount;
    }

    addRecord(record) {
        this.records.push(record);
    }

    summary() {
        return { ...this.counts };
    }
}

const runStats = new RunStats();

/*
    Writes a plain-text divider straight to combined.log (bypassing winston's
    JSON formatting) so each run is visually easy to spot when skimming the
    file by eye - a clear gap + dated header between one run's entries and the
    next, rather than just relying on timestamps buried inside JSON blocks.
*/
function logRunBoundary(label) {
    const divider = `\n${'='.repeat(80)}\n${label} - ${new Date().toISOString()}\n${'='.repeat(80)}\n`;
    fs.appendFileSync(logPath('combined.log'), divider);
}

module.exports = {
    logger,
    runStats,
    logRunBoundary
};
