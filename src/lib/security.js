const crypto = require('crypto');
const { promisify } = require('util');

const scryptAsync = promisify(crypto.scrypt);
const PASSWORD_KEY_LENGTH = 32;
const SCRYPT_OPTIONS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

async function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const derived = await scryptAsync(String(password), salt, PASSWORD_KEY_LENGTH, SCRYPT_OPTIONS);
    return [
        'scrypt',
        SCRYPT_OPTIONS.N,
        SCRYPT_OPTIONS.r,
        SCRYPT_OPTIONS.p,
        salt.toString('base64url'),
        Buffer.from(derived).toString('base64url')
    ].join('$');
}

async function verifyPassword(password, encoded) {
    const [algorithm, nText, rText, pText, saltText, hashText] = String(encoded || '').split('$');
    if (algorithm !== 'scrypt' || !saltText || !hashText) return false;
    const expected = Buffer.from(hashText, 'base64url');
    const actual = await scryptAsync(
        String(password),
        Buffer.from(saltText, 'base64url'),
        expected.length,
        {
            N: Number(nText),
            r: Number(rText),
            p: Number(pText),
            maxmem: 64 * 1024 * 1024
        }
    );
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function encryptSecret(plainText, masterKey, aad) {
    if (!Buffer.isBuffer(masterKey) || masterKey.length !== 32) {
        throw new Error('암호화 키는 32바이트여야 합니다.');
    }
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', masterKey, iv);
    cipher.setAAD(Buffer.from(String(aad), 'utf8'));
    const encrypted = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ['v1', iv.toString('base64url'), tag.toString('base64url'), encrypted.toString('base64url')].join(':');
}

function decryptSecret(payload, masterKey, aad) {
    const [version, ivText, tagText, encryptedText] = String(payload || '').split(':');
    if (version !== 'v1' || !ivText || !tagText || encryptedText === undefined) {
        throw new Error('저장된 암호문의 형식이 올바르지 않습니다.');
    }
    const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey, Buffer.from(ivText, 'base64url'));
    decipher.setAAD(Buffer.from(String(aad), 'utf8'));
    decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
    const decrypted = Buffer.concat([
        decipher.update(Buffer.from(encryptedText, 'base64url')),
        decipher.final()
    ]);
    return decrypted.toString('utf8');
}

function createSessionToken() {
    return crypto.randomBytes(32).toString('base64url');
}

function createCsrfToken() {
    return crypto.randomBytes(24).toString('base64url');
}

function hashToken(token) {
    return crypto.createHash('sha256').update(String(token)).digest('hex');
}

module.exports = {
    createCsrfToken,
    createSessionToken,
    decryptSecret,
    encryptSecret,
    hashPassword,
    hashToken,
    verifyPassword
};
