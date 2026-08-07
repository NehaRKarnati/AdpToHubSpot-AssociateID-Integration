const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const https = require('https');
const axios = require('axios');
const { writeToken, readToken } = require('./tokenStore');
const { logger } = require('./logger');

const TOKEN_TTL_MS = 3600000; // ADP bearer tokens are valid for 1 hour

const certPath = path.join(__dirname, 'certs', 'certificate.pem');
const keyPath = path.join(__dirname, 'certs', 'pvtkey.pem');

const adpAPIClient = axios.create({
    httpsAgent: new https.Agent({
        cert: fs.readFileSync(certPath, 'utf8'),
        key: fs.readFileSync(keyPath, 'utf8'),
        keepAlive: true
    }),
    headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
    }
});

const tokenRequestBody =
    `client_id=${encodeURIComponent(process.env.adp_client_id)}` +
    `&client_secret=${encodeURIComponent(process.env.adp_client_secret)}` +
    `&grant_type=${encodeURIComponent(process.env.grant_type)}`;

async function getBearerToken() {
    const cached = await readToken('adp');
    const isFresh = cached && (Date.now() - cached.timeStamp) < TOKEN_TTL_MS;
    if (isFresh) return cached.accessToken;

    try {
        const response = await adpAPIClient.post('https://api.adp.com/auth/oauth/v2/token', tokenRequestBody);
        logger.info('Obtained new ADP bearer token');
        await writeToken({ accessToken: response.data.access_token, timeStamp: Date.now() }, 'adp');
        return response.data.access_token;
    } catch (error) {
        logger.error('Failed to obtain ADP bearer token', { error: error.message });
        throw error;
    }
}

module.exports = {
    getBearerToken,
    adpAPIClient
};
