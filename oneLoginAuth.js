const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const axios = require('axios');
const { writeToken, readToken } = require('./tokenStore');
const { logger } = require('./logger');

// OneLogin access tokens are valid for 10 hours (36000s) - re-checking well
// before that, matching the conservative pattern in adpAuth.js.
const TOKEN_TTL_MS = 3600000;

// The OneLogin API domain is your account's own subdomain (the same one you
// log into OneLogin with), e.g. https://empowerme.onelogin.com - NOT a
// region-based api.<region>.onelogin.com host.
const ONELOGIN_API_BASE = process.env.onelogin_api_base;

const oneLoginClient = axios.create({
    baseURL: ONELOGIN_API_BASE,
    headers: { 'Content-Type': 'application/json' }
});

// Every resource call needs the current bearer token attached - rather than
// making every caller remember to pass Authorization, attach it here so
// oneLoginClient behaves like adpAPIClient/hubspotClient (call it, get an
// authenticated request).
oneLoginClient.interceptors.request.use(async (config) => {
    const token = await getBearerToken();
    config.headers = { ...config.headers, Authorization: `Bearer ${token}` };
    return config;
});

/*
    Basic Auth (client_id as username, client_secret as password) is only used
    to obtain the OAuth2 token itself - every actual resource API call after
    that uses the returned Bearer token, not Basic Auth directly.
*/
async function getBearerToken() {
    const cached = await readToken('onelogin');
    const isFresh = cached && (Date.now() - cached.timeStamp) < TOKEN_TTL_MS;
    if (isFresh) return cached.accessToken;

    try {
        const response = await axios.post(
            `${ONELOGIN_API_BASE}/auth/oauth2/v2/token`,
            { grant_type: 'client_credentials' },
            {
                auth: {
                    username: process.env.onelogin_client_id,
                    password: process.env.onelogin_client_secret
                }
            }
        );
        logger.info('Obtained new OneLogin bearer token');
        await writeToken({ accessToken: response.data.access_token, timeStamp: Date.now() }, 'onelogin');
        return response.data.access_token;
    } catch (error) {
        logger.error('Failed to obtain OneLogin bearer token', { error: error.message });
        throw error;
    }
}

module.exports = {
    getBearerToken,
    oneLoginClient
};
