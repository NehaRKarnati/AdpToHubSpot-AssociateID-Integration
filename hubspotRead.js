const axios = require('axios');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { logger } = require('./logger');
const { writeToken, readToken } = require('./tokenStore');

// Matches adpWorkerFetch.js's cache TTL. Only used by the *Cached variants
// below, which exist for read-only report generation - never use these for
// the actual write paths (syncDropdownOptions, migrateLegacyOptions), which
// must always read the freshest state right before a PATCH.
const HUBSPOT_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

const hubspotClient = axios.create({
    baseURL: 'https://api.hubapi.com',
    headers: {
        Authorization: `Bearer ${process.env.hubspot_api_key}`,
        'Content-Type': 'application/json'
    }
});

// Proactive throttle, on top of the reactive 429 retry below: every outgoing
// request (read or write, hubspotWrite.js reuses this same client) waits its
// turn in a chain so consecutive calls are always spaced at least this far
// apart, regardless of how tightly the calling code loops. Deliberately
// conservative (2 requests/sec) since HubSpot's "SECONDLY" search limit can
// be quite low - the goal is to avoid ever hitting 429 in the first place,
// not just recover from it.
const REQUEST_THROTTLE_MS = 500;
let requestChain = Promise.resolve();

hubspotClient.interceptors.request.use((config) => {
    const previous = requestChain;
    let releaseNext;
    requestChain = new Promise(resolve => { releaseNext = resolve; });

    return previous.then(() => new Promise(resolve => {
        setTimeout(() => {
            releaseNext();
            resolve(config);
        }, REQUEST_THROTTLE_MS);
    }));
});

// hubspotWrite.js reuses this same client instance, so this covers every
// read AND write call in the app - our code fires many sequential search
// calls in loops, which can exceed HubSpot's per-second rate limit even
// without doing anything wrong. On a 429, wait (honoring Retry-After if
// HubSpot sends one, else exponential backoff) and retry the same request,
// rather than failing the whole run.
const RATE_LIMIT_MAX_RETRIES = 5;
const RATE_LIMIT_BASE_DELAY_MS = 1000;

hubspotClient.interceptors.response.use(
    response => response,
    async (error) => {
        const config = error.config;
        const status = error.response && error.response.status;
        if (!config || status !== 429) return Promise.reject(error);

        config.__retryCount = (config.__retryCount || 0) + 1;
        if (config.__retryCount > RATE_LIMIT_MAX_RETRIES) {
            logger.error('Exhausted retries after repeated HubSpot rate limiting', { url: config.url });
            return Promise.reject(error);
        }

        const retryAfterHeader = error.response.headers && error.response.headers['retry-after'];
        const delayMs = retryAfterHeader
            ? Number(retryAfterHeader) * 1000
            : RATE_LIMIT_BASE_DELAY_MS * (2 ** (config.__retryCount - 1));

        logger.warn('HubSpot rate limit hit - retrying after delay', {
            url: config.url, attempt: config.__retryCount, delayMs
        });
        await new Promise(resolve => setTimeout(resolve, delayMs));
        return hubspotClient(config);
    }
);

// Only real, live clinic companies should ever be touched by this integration -
// applied to every company search so ard doesn't get read/written on non-clinic
// or prospect/lead records. REVERTED (2026-08-07): removing clinic_id earlier
// today caused lifecyclestage: customer alone to match thousands of unrelated
// companies (other senior living brands/competitors, likely customers of a
// different EmpowerMe business line) - confirmed live during dvp migration,
// which tried to reassign 527 companies to one DVP, most of them clearly not
// real EmpowerMe clinic locations. clinic_id HAS_PROPERTY is required again.
const BASE_COMPANY_FILTERS = [
    { propertyName: 'clinic_id', operator: 'HAS_PROPERTY' },
    { propertyName: 'lifecyclestage', operator: 'EQ', value: 'customer' }
];

/*
    Fetches a company property's definition, including its full options array
    (label, value, hidden, displayOrder) for enumeration/dropdown properties.
*/
async function getCompanyProperty(propertyName) {
    try {
        const response = await hubspotClient.get(`/crm/v3/properties/companies/${propertyName}`);
        return response.data;
    } catch (error) {
        logger.error('Failed to fetch HubSpot company property', { propertyName, error: error.message });
        throw error;
    }
}

/*
    Builds a lookup of a dropdown property's current options, keyed by internal
    value (the ADP associate ID).
*/
async function getOptionsByAssociateId(propertyName) {
    const property = await getCompanyProperty(propertyName);
    const options = property.options || [];
    const lookup = {};
    for (const option of options) {
        lookup[option.value] = option;
    }
    return lookup;
}

/*
    Finds every company currently assigned to a given associate ID via the
    dropdown property - no name matching involved, since the dropdown's
    internal value already is the associate ID.

    extraProperties: additional property names to pull back alongside name/
    propertyName - e.g. the paired ID field, so a caller can check whether
    that field is already correct before deciding to PATCH at all.
*/
async function getCompaniesByPropertyValue(propertyName, associateId, extraProperties = []) {
    const companies = [];
    let after = undefined;

    try {
        do {
            const response = await hubspotClient.post('/crm/v3/objects/companies/search', {
                filterGroups: [{
                    filters: [...BASE_COMPANY_FILTERS, { propertyName, operator: 'EQ', value: associateId }]
                }],
                properties: ['name', propertyName, ...extraProperties],
                limit: 100,
                after
            });
            companies.push(...response.data.results);
            after = response.data.paging && response.data.paging.next
                ? response.data.paging.next.after
                : undefined;
        } while (after);
    } catch (error) {
        logger.error('Failed to search HubSpot companies by property value', {
            propertyName, associateId, error: error.message
        });
        throw error;
    }

    return companies;
}

/*
    Finds companies where a multi-select (semicolon-delimited) property
    contains this exact value as one of its selected tokens - e.g.
    ados_in_20_min_drive stores "Bridget Lanigan;Cassandra Favrow", and EQ
    would never match a single name inside that string. CONTAINS_TOKEN is
    HubSpot's documented way to match one token within a multi-select value.
*/
async function getCompaniesContainingToken(propertyName, value) {
    const companies = [];
    let after = undefined;

    try {
        do {
            const response = await hubspotClient.post('/crm/v3/objects/companies/search', {
                filterGroups: [{
                    filters: [...BASE_COMPANY_FILTERS, { propertyName, operator: 'CONTAINS_TOKEN', value }]
                }],
                properties: ['name', propertyName],
                limit: 100,
                after
            });
            companies.push(...response.data.results);
            after = response.data.paging && response.data.paging.next
                ? response.data.paging.next.after
                : undefined;
        } while (after);
    } catch (error) {
        logger.error('Failed to search HubSpot companies by multi-select token', {
            propertyName, value, error: error.message
        });
        throw error;
    }

    return companies;
}

/*
    Checks whether ANY company in the portal - regardless of BASE_COMPANY_FILTERS
    scope (clinic_id/lifecyclestage) - currently holds this property value.
    Used as a safety check before deleting a dropdown option outright: deleting
    an option that's still referenced anywhere, in or out of scope, would leave
    that company pointing at a value that no longer exists on the property.
*/
async function anyCompanyHasPropertyValue(propertyName, value) {
    try {
        const response = await hubspotClient.post('/crm/v3/objects/companies/search', {
            filterGroups: [{
                filters: [{ propertyName, operator: 'EQ', value }]
            }],
            properties: ['name', propertyName],
            limit: 1
        });
       return response.data.total > 0;
       //return response.data
    } catch (error) {
        logger.error('Failed to check for any company with property value', { propertyName, value, error: error.message });
        throw error;
    }
}

/*
    Checks a whole batch of values at once (HubSpot Search API's IN operator)
    instead of one anyCompanyHasPropertyValue call per value - e.g. checking
    460 terminated team_lead associate IDs individually is 460 calls; batched
    100 at a time it's ~5. Returns the subset of `values` that are actually
    referenced by at least one company anywhere (unfiltered, same scope as
    anyCompanyHasPropertyValue).
*/
async function getValuesInUse(propertyName, values) {
    const BATCH_SIZE = 100;
    const valuesInUse = new Set();

    for (let i = 0; i < values.length; i += BATCH_SIZE) {
        const batch = values.slice(i, i + BATCH_SIZE);
        if (batch.length === 0) continue;

        let after = undefined;
        try {
            do {
                const response = await hubspotClient.post('/crm/v3/objects/companies/search', {
                    filterGroups: [{
                        filters: [{ propertyName, operator: 'IN', values: batch }]
                    }],
                    properties: ['name', propertyName],
                    limit: 100,
                    after
                });

                for (const company of response.data.results) {
                    const value = company.properties[propertyName];
                    if (value) valuesInUse.add(value);
                }
                after = response.data.paging && response.data.paging.next
                    ? response.data.paging.next.after
                    : undefined;
            } while (after);
        } catch (error) {
            logger.error('Failed to batch-check property values in use', {
                propertyName, batchSize: batch.length, error: error.message
            });
            throw error;
        }
    }

    return valuesInUse;
}

/*
    Fetches a single company by record ID. Pass propertyNames to control which
    properties come back (defaults to name + all ado dropdown/id properties).
*/
async function getCompanyById(companyId, propertyNames) {
    try {
        const response = await hubspotClient.get(`/crm/v3/objects/companies/${companyId}`, {
            params: propertyNames ? { properties: propertyNames.join(',') } : undefined
        });
        return response.data;
    } catch (error) {
        logger.error('Failed to fetch HubSpot company by ID', { companyId, error: error.message });
        throw error;
    }
}

/*
    Fetches every real clinic company (BASE_COMPANY_FILTERS) with the given
    properties, paginated. Used for dry runs and audits where we need to see
    every in-scope company's current value, including ones with no ADO
    assigned at all.
*/
async function getAllCompanies(propertyNames) {
    const companies = [];
    let after = undefined;

    try {
        do {
            const response = await hubspotClient.post('/crm/v3/objects/companies/search', {
                filterGroups: [{ filters: BASE_COMPANY_FILTERS }],
                properties: propertyNames,
                limit: 100,
                after
            });
            companies.push(...response.data.results);
            after = response.data.paging && response.data.paging.next
                ? response.data.paging.next.after
                : undefined;
        } while (after);
    } catch (error) {
        logger.error('Failed to fetch all HubSpot companies', { propertyNames, error: error.message });
        throw error;
    }

    return companies;
}

/*
    Cached wrapper for getAllCompanies - for read-only report generation
    (dryRunReport.js) only, never for the write paths. Caches to disk
    (tokens/hubspotCompaniesCache.json) for HUBSPOT_CACHE_TTL_MS, keyed loosely
    by which properties were requested - if a call asks for a property not in
    the cached set, it's treated as stale and refetched, so results are never
    missing columns a caller actually asked for. Pass { forceRefresh: true }
    to bypass the cache and pull fresh data.
*/
async function getAllCompaniesCached(propertyNames, { forceRefresh = false } = {}) {
    if (!forceRefresh) {
        const cached = await readToken('hubspotCompaniesCache');
        const isFresh = cached && (Date.now() - cached.timeStamp) < HUBSPOT_CACHE_TTL_MS;
        const hasAllProperties = cached && propertyNames.every(p => cached.propertyNames.includes(p));
        if (isFresh && hasAllProperties) {
            logger.info('Using cached HubSpot companies', { count: cached.companies.length });
            return cached.companies;
        }
    }

    const companies = await getAllCompanies(propertyNames);
    await writeToken({ companies, propertyNames, timeStamp: Date.now() }, 'hubspotCompaniesCache');
    return companies;
}

/*
    Cached wrapper for getCompanyProperty - same read-only-report-only caveat
    as getAllCompaniesCached. Cached per property name (tokens/hubspotProperty_
    <name>.json) since each list's property definition is independent.
*/
async function getCompanyPropertyCached(propertyName, { forceRefresh = false } = {}) {
    if (!forceRefresh) {
        const cached = await readToken(`hubspotProperty_${propertyName}`);
        const isFresh = cached && (Date.now() - cached.timeStamp) < HUBSPOT_CACHE_TTL_MS;
        if (isFresh) {
            logger.info('Using cached HubSpot property', { propertyName });
            return cached.property;
        }
    }

    const property = await getCompanyProperty(propertyName);
    await writeToken({ property, timeStamp: Date.now() }, `hubspotProperty_${propertyName}`);
    return property;
}

module.exports = {
    hubspotClient,
    getCompanyProperty,
    getOptionsByAssociateId,
    getCompaniesByPropertyValue,
    getCompaniesContainingToken,
    getCompanyById,
    getAllCompanies,
    getAllCompaniesCached,
    getCompanyPropertyCached,
    anyCompanyHasPropertyValue,
    getValuesInUse
};
