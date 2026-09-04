const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT_DIR = path.resolve(__dirname, '..');

function loadDotEnv(filePath = path.join(ROOT_DIR, '.env')) {
    if (!fs.existsSync(filePath)) return;
    const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const separator = trimmed.indexOf('=');
        if (separator < 1) continue;
        const key = trimmed.slice(0, separator).trim();
        if (process.env[key] !== undefined) continue;
        let value = trimmed.slice(separator + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        process.env[key] = value;
    }
}

function parseBoolean(value, fallback = false) {
    if (value === undefined || value === '') return fallback;
    return /^(1|true|yes|on)$/i.test(String(value));
}

function parseInteger(value, fallback, min, max) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isInteger(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
}

function decodeMasterKey(raw) {
    const text = String(raw || '').trim();
    if (!text) return null;
    if (/^[0-9a-f]{64}$/i.test(text)) return Buffer.from(text, 'hex');
    const key = Buffer.from(text, 'base64');
    if (key.length !== 32) throw new Error('APP_MASTER_KEY는 32바이트 base64 또는 64자리 hex 값이어야 합니다.');
    return key;
}

function readSecret(name, env = process.env) {
    const direct = String(env[name] || '').trim();
    const file = String(env[`${name}_FILE`] || '').trim();
    if (direct && file) throw new Error(`${name} 또는 ${name}_FILE 중 하나만 설정해주세요.`);
    return file ? fs.readFileSync(file, 'utf8').trim() : direct;
}

function getOrCreateLocalMasterKey(dataDir) {
    const keyPath = path.join(dataDir, '.master-key');
    if (fs.existsSync(keyPath)) {
        const key = Buffer.from(fs.readFileSync(keyPath, 'utf8').trim(), 'base64');
        if (key.length !== 32) throw new Error('data/.master-key 파일 형식이 올바르지 않습니다.');
        return key;
    }

    const key = crypto.randomBytes(32);
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(keyPath, key.toString('base64'), { mode: 0o600, flag: 'wx' });
    try {
        fs.chmodSync(keyPath, 0o600);
    } catch {
        // Windows ACL is managed by the account running the application.
    }
    return key;
}

function createConfig(overrides = {}) {
    loadDotEnv();
    const dataDir = overrides.dataDir || process.env.DATA_DIR || path.join(ROOT_DIR, 'data');
    const isProduction = (overrides.nodeEnv || process.env.NODE_ENV || 'development') === 'production';
    const configuredKey = overrides.masterKey || decodeMasterKey(readSecret('APP_MASTER_KEY'));
    const setupToken = String(overrides.setupToken || readSecret('SETUP_TOKEN')).trim();

    if (isProduction && !configuredKey) {
        throw new Error('운영 환경에서는 APP_MASTER_KEY를 반드시 설정해야 합니다.');
    }
    if (isProduction && !setupToken) {
        throw new Error('운영 환경에서는 첫 관리자 보호를 위해 SETUP_TOKEN을 반드시 설정해야 합니다.');
    }

    return {
        rootDir: ROOT_DIR,
        revision: overrides.revision || process.env.APP_REVISION || 'development',
        dataDir,
        maintenanceFile: path.join(dataDir, '.deployment-pause'),
        databasePath: overrides.databasePath || process.env.DATABASE_PATH || path.join(dataDir, 'worklog.db'),
        masterKey: configuredKey || getOrCreateLocalMasterKey(dataDir),
        setupToken: setupToken || null,
        host: overrides.host || process.env.HOST || '127.0.0.1',
        port: overrides.port || parseInteger(process.env.PORT, 3210, 1, 65535),
        nodeEnv: isProduction ? 'production' : 'development',
        cookieSecure: overrides.cookieSecure ?? parseBoolean(process.env.COOKIE_SECURE, isProduction),
        trustProxy: overrides.trustProxy ?? parseBoolean(process.env.TRUST_PROXY, false),
        automationConcurrency: overrides.automationConcurrency
            || parseInteger(process.env.AUTOMATION_CONCURRENCY, 1, 1, 4),
        automationHeadless: overrides.automationHeadless
            ?? parseBoolean(process.env.AUTOMATION_HEADLESS, true),
        portalRequestIntervalMs: overrides.portalRequestIntervalMs
            ?? parseInteger(process.env.PORTAL_REQUEST_INTERVAL_MS, 1500, 500, 60000),
        sessionTtlMs: overrides.sessionTtlMs || 12 * 60 * 60 * 1000,
        publicDir: path.join(ROOT_DIR, 'public')
    };
}

module.exports = {
    ROOT_DIR,
    createConfig,
    decodeMasterKey,
    loadDotEnv,
    parseBoolean,
    readSecret
};
