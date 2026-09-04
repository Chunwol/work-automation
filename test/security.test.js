const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const {
    decryptSecret,
    encryptSecret,
    hashPassword,
    hashToken,
    verifyPassword
} = require('../src/lib/security');

test('app passwords are salted and verifiable without being reversible', async () => {
    const first = await hashPassword('long-test-password');
    const second = await hashPassword('long-test-password');

    assert.notEqual(first, second);
    assert.equal(await verifyPassword('long-test-password', first), true);
    assert.equal(await verifyPassword('wrong-password', first), false);
    assert.equal(first.includes('long-test-password'), false);
});

test('portal credentials round-trip with AES-GCM and reject altered context', () => {
    const key = crypto.randomBytes(32);
    const encrypted = encryptSecret('portal-secret', key, 'portal:1:password');

    assert.equal(decryptSecret(encrypted, key, 'portal:1:password'), 'portal-secret');
    assert.equal(encrypted.includes('portal-secret'), false);
    assert.throws(() => decryptSecret(encrypted, key, 'portal:2:password'));
});

test('session tokens are stored as deterministic SHA-256 hashes', () => {
    assert.equal(hashToken('token-value'), hashToken('token-value'));
    assert.notEqual(hashToken('token-value'), hashToken('other-token'));
    assert.equal(hashToken('token-value').length, 64);
});
