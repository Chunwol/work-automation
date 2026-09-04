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

test('portal request spacing defaults to 500ms and cannot be configured below it', () => {
    const previous = process.env.PORTAL_REQUEST_INTERVAL_MS;
    try {
        for (const [value, expected] of [['', 500], ['100', 500], ['1500', 1500]]) {
            process.env.PORTAL_REQUEST_INTERVAL_MS = value;
            const config = createConfig({ nodeEnv: 'test', masterKey: crypto.randomBytes(32), dataDir: 'unused-in-test' });
            assert.equal(config.portalRequestIntervalMs, expected);
        }
    } finally {
        if (previous === undefined) delete process.env.PORTAL_REQUEST_INTERVAL_MS;
        else process.env.PORTAL_REQUEST_INTERVAL_MS = previous;
    }
});
