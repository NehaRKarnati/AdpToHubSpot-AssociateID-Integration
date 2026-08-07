const fsAsync = require('fs/promises');
const path = require('path');

function tokenPath(keyType) {
    return path.join(__dirname, 'tokens', `${keyType}.json`);
}

async function writeToken(token, keyType) {
    const filePath = tokenPath(keyType);
    await fsAsync.writeFile(filePath, JSON.stringify(token));
}

async function readToken(keyType) {
    try {
        const data = await fsAsync.readFile(tokenPath(keyType));
        return JSON.parse(data);
    } catch (error) {
        return null;
    }
}

module.exports = {
    writeToken,
    readToken
};
