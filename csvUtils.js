function toCsvValue(value) {
    if (value === null || value === undefined) return '';
    const str = String(value);
    if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
    return str;
}

function rowsToCsv(rows) {
    if (rows.length === 0) return '';
    const headers = Object.keys(rows[0]);
    const lines = [headers.join(',')];
    for (const row of rows) {
        lines.push(headers.map(h => toCsvValue(row[h])).join(','));
    }
    return lines.join('\n');
}

module.exports = { toCsvValue, rowsToCsv };
