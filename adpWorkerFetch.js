const { getBearerToken, adpAPIClient } = require('./adpAuth');
const { writeToken, readToken } = require('./tokenStore');
const { logger } = require('./logger');

const WORKERS_URL = 'https://api.adp.com/hr/v2/workers';

// While testing, avoid re-pulling all ADP workers on every run - cache the
// raw active/terminated arrays to tokens/adpWorkersCache.json for this long.
// Delete that file (or call getAllADPWorkers(n, { forceRefresh: true })) to bypass it.
const ADP_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

/*
    Fetches one page of workers from ADP.
    code: 'A' = active, 'T' = terminated (matches workAssignments/assignmentStatus/statusCode/codeValue)
*/
async function getADPWorkersPage(skip = 0, top = 50, code = 'A') {
    const token = await getBearerToken();
    try {
        const response = await adpAPIClient.get(WORKERS_URL, {
            headers: { Authorization: `Bearer ${token}` },
            params: {
                $top: top,
                $skip: skip,
                $filter: `workers/workAssignments/assignmentStatus/statusCode/codeValue eq '${code}'`
            }
        });
        logger.debug('Fetched ADP worker page', { skip, top, code });
        return response.data;
    } catch (error) {
        logger.error('Failed to fetch ADP worker page', { skip, top, code, error: error.message });
        throw error;
    }
}

async function populateWorkerData(totalRecords, code = 'A') {
    let workerData = [];
    let skip = 0;
    let top = 50;
    const maxRetries = 5;
    let attempts = 0;

    while (totalRecords > 0) {
        if (totalRecords < top) top = totalRecords;
        let response;
        try {
            response = await getADPWorkersPage(skip, top, code);
            attempts = 0;
        } catch (error) {
            attempts++;
            if (attempts >= maxRetries) {
                logger.error('Exhausted retries fetching ADP workers', { skip, top, code });
                throw error;
            }
            await new Promise(resolve => setTimeout(resolve, 1000 * attempts));
            continue;
        }

        const page = response.workers || [];
        workerData = workerData.concat(page);
        skip += top;
        totalRecords -= top;

        if (page.length < top) break;
    }
    return workerData;
}

/*
    Pulls active, terminated, AND on-leave worker sets from ADP, merging
    leave ('L') workers into the returned activeWorkers array - workerRoleFormatter.js's
    isActive check already treats LEAVE the same as ACTIVE, but that only
    matters if these workers are actually fetched in the first place. Without
    also querying code 'L' here, anyone on leave (whose primary assignment
    status is 'L', not 'A' or 'T') is never pulled from ADP at all and would
    incorrectly show up as having no current ADP match anywhere downstream.

    Returns { activeWorkers, terminatedWorkers } - raw ADP worker objects, not yet filtered by job title.

    Caches the result to disk (see ADP_CACHE_TTL_MS) so repeated test runs don't
    re-pull the full worker list from ADP every time. Pass { forceRefresh: true }
    to bypass the cache and pull fresh data.
*/
async function getAllADPWorkers(numRecords = 99999, { forceRefresh = false } = {}) {
    if (!forceRefresh) {
        const cached = await readToken('adpWorkersCache');
        const isFresh = true  //cached && (Date.now() - cached.timeStamp) < ADP_CACHE_TTL_MS;
        if (isFresh) {
            logger.info('Using cached ADP workers', {
                active: cached.activeWorkers.length,
                terminated: cached.terminatedWorkers.length
            });
            return { activeWorkers: cached.activeWorkers, terminatedWorkers: cached.terminatedWorkers };
        }
    }

    const activeWorkers = await populateWorkerData(numRecords, 'A');
    const terminatedWorkers = await populateWorkerData(numRecords, 'T');
    const leaveWorkers = await populateWorkerData(numRecords, 'L');
    activeWorkers.push(...leaveWorkers);
    logger.info('Pulled ADP workers', {
        active: activeWorkers.length - leaveWorkers.length,
        onLeave: leaveWorkers.length,
        terminated: terminatedWorkers.length
    });

    await writeToken({ activeWorkers, terminatedWorkers, timeStamp: Date.now() }, 'adpWorkersCache');

    return { activeWorkers, terminatedWorkers };
}

getAllADPWorkers().catch(error => {
    logger.error('Error fetching ADP workers', { error: error.message });
});

module.exports = {
    populateWorkerData,
    getAllADPWorkers
};
