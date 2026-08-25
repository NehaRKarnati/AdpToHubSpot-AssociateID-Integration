// Read-only preview: shows exactly which tracking keys promoteEarlyStarts
// would add (current-list AND the new future-list protection) on its next
// live run, without writing anything to HubSpot or the tracking file.
const { getAllCompanies, getCompanyProperty } = require('./hubspotRead');
const { readToken } = require('./tokenStore');
const { PROMOTION_LIST_MAP, PROMOTION_REQUIRED_PROPERTIES, EARLY_PROMOTION_WINDOW_DAYS } = require('./managePromotions');

function daysBetween(dateA, dateB) {
    return (dateA.getTime() - dateB.getTime()) / (1000 * 60 * 60 * 24);
}

async function run() {
    const companies = await getAllCompanies(Array.from(PROMOTION_REQUIRED_PROPERTIES));
    const tracking = (await readToken('promotionTracking')) || {};
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const wouldAdd = [];

    for (const [currentList, { futureList, startDateField }] of Object.entries(PROMOTION_LIST_MAP)) {
        const startDateByAssociateId = new Map();
        for (const company of companies) {
            const startDateRaw = company.properties[startDateField];
            if (!startDateRaw) continue;
            const startDate = new Date(startDateRaw);
            if (isNaN(startDate.getTime())) continue;
            if (daysBetween(startDate, today) > EARLY_PROMOTION_WINDOW_DAYS) continue;
            const futureAssociateId = company.properties[futureList];
            if (!futureAssociateId) continue;
            startDateByAssociateId.set(futureAssociateId, startDateRaw);
        }
        if (startDateByAssociateId.size === 0) continue;

        const futureProperty = await getCompanyProperty(futureList);
        const futureLabelByValue = new Map((futureProperty.options || []).map(o => [o.value, o.label]));

        for (const [associateId, startDate] of startDateByAssociateId) {
            const fullName = futureLabelByValue.get(associateId) || associateId;

            const futureKey = `${futureList}:${associateId}`;
            if (!tracking[futureKey]) wouldAdd.push({ key: futureKey, fullName, startDate });

            const currentKey = `${currentList}:${associateId}`;
            if (!tracking[currentKey]) wouldAdd.push({ key: currentKey, fullName, startDate });
        }
    }

    if (wouldAdd.length === 0) {
        console.log('No new tracking entries would be added.');
        return;
    }
    console.log(`Would add ${wouldAdd.length} tracking entrie(s):`);
    for (const { key, fullName, startDate } of wouldAdd) {
        console.log(`  ${key} - ${fullName} (start date: ${startDate})`);
    }
}

run().catch(error => {
    console.error('Error:', error.message);
    process.exitCode = 1;
});
