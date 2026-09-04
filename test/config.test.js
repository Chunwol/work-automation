const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const { createConfig } = require('../src/config');

test('production requires both an encryption key and first-setup token', () => {
    const masterKey = crypto.randomBytes(32);
    assert.throws(
        () => createConfig({ nodeEnv: 'production', masterKey, setupToken: '' }),
        /SETUP_TOKEN/
    );

    const config = createConfig({
        nodeEnv: 'production',
        masterKey,
        setupToken: 'one-time-setup-token',
        dataDir: 'unused-in-test',
        databasePath: ':memory:'
    });
    assert.equal(config.nodeEnv, 'production');
    assert.equal(config.cookieSecure, true);
    assert.equal(config.setupToken, 'one-time-setup-token');
});
