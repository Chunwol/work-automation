const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const { createDatabase } = require('./lib/database');
const { JobQueue } = require('./lib/job-queue');
const {
    createCsrfToken,
    createSessionToken,
    decryptSecret,
    encryptSecret,
    hashPassword,
    hashToken,
    verifyPassword
} = require('./lib/security');
const { previewSchedule, validateSchedulePayload } = require('./lib/schedule');
const { getCalendar } = require('./lib/calendar');
const { queryPortalRecords, runPortalAutomation, mutatePortalRecord, verifyPortalCredentials } = require('./automation/portal');
const { PortalHttpClient } = require('./automation/portal-http-client');
const { PortalRequestGate } = require('./automation/request-gate');

const SESSION_COOKIE = 'worklog_session';

function parseCookies(header) {
    const cookies = {};
    for (const part of String(header || '').split(';')) {
        const separator = part.indexOf('=');
        if (separator < 1) continue;
        const key = part.slice(0, separator).trim();
        const value = part.slice(separator + 1).trim();
        try {
            cookies[key] = decodeURIComponent(value);
        } catch {
            cookies[key] = value;
        }
    }
    return cookies;
}

function maskPortalId(portalId) {
    const text = String(portalId || '');
    if (text.length <= 4) return text.length ? `${text.slice(0, 1)}${'*'.repeat(text.length - 1)}` : '';
    return `${text.slice(0, 2)}${'*'.repeat(Math.max(2, text.length - 4))}${text.slice(-2)}`;
}

function validateAccountInput(payload, { passwordRequired = true } = {}) {
    const username = String(payload?.username || '').trim();
    const displayName = String(payload?.displayName || '').trim();
    const password = String(payload?.password || '');
    const errors = [];
    if (!/^[\p{L}\p{N}._-]{2,32}$/u.test(username)) {
        errors.push('아이디는 한글·영문·숫자·점·밑줄·하이픈으로 2~32자여야 합니다.');
    }
    if (displayName.length < 1 || displayName.length > 40) errors.push('표시 이름은 1~40자로 입력해주세요.');
    if (passwordRequired && (password.length < 10 || password.length > 128)) {
        errors.push('비밀번호는 10~128자로 입력해주세요.');
    }
    return { ok: errors.length === 0, errors, value: { username, displayName, password } };
}

function createFixedWindowLimiter({ windowMs, limit }) {
    const buckets = new Map();
    return (key) => {
        const now = Date.now();
        const current = buckets.get(key);
        if (!current || current.resetAt <= now) {
            buckets.set(key, { count: 1, resetAt: now + windowMs });
            return { allowed: true, retryAfter: 0 };
        }
        current.count += 1;
        return {
            allowed: current.count <= limit,
            retryAfter: Math.max(1, Math.ceil((current.resetAt - now) / 1000))
        };
    };
}

function safeTokenEqual(left, right) {
    const a = Buffer.from(String(left || ''));
    const b = Buffer.from(String(right || ''));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function createRuntime(config, overrides = {}) {
    const db = overrides.db || createDatabase(config.databasePath);
    const automation = overrides.automation || { queryPortalRecords, runPortalAutomation, mutatePortalRecord };
    const requestGate = new PortalRequestGate({ intervalMs: config.portalRequestIntervalMs });
    const clientFactory = () => new PortalHttpClient({ requestGate });

    const decryptCredentials = (userId) => {
        const credential = db.getPortalCredential(userId);
        if (!credential) throw new Error('학교 포털 계정이 등록되지 않았습니다.');
        return {
            portalId: decryptSecret(credential.portal_id_encrypted, config.masterKey, `portal:${userId}:id`),
            portalPassword: decryptSecret(credential.portal_password_encrypted, config.masterKey, `portal:${userId}:password`)
        };
    };

    const executeJob = async (item, onEvent) => {
        const credentials = decryptCredentials(item.userId);
        if (item.type === 'query') {
            return automation.queryPortalRecords({
                ...credentials,
                year: item.year,
                month: item.month,
                headless: config.automationHeadless,
                clientFactory,
                onEvent
            });
        }
        const schedule = item.schedule;
        if (!schedule) throw new Error('저장된 일정이 없습니다.');
        return automation.runPortalAutomation({
            ...credentials,
            schedule,
            headless: config.automationHeadless,
            clientFactory,
            onEvent
        });
    };

    const queue = overrides.queue || new JobQueue({
        db,
        executeJob,
        concurrency: config.automationConcurrency
    });
    return { db, queue,
        verifyCredentials: (credentials) => (overrides.verifyPortalCredentials || verifyPortalCredentials)({ ...credentials, clientFactory }),
        mutateRecord: (userId, options) => automation.mutatePortalRecord({ ...options, ...decryptCredentials(userId), clientFactory }) };
}

function createApp(config, overrides = {}) {
    const runtime = createRuntime(config, overrides);
    const { db, queue } = runtime;
    const calendarProvider = overrides.calendar || getCalendar;
    const activeMutations = new Set();
    const activeVerifications = new Set();
    const app = express();
    const loginLimiter = createFixedWindowLimiter({ windowMs: 15 * 60 * 1000, limit: 7 });
    const setupLimiter = createFixedWindowLimiter({ windowMs: 15 * 60 * 1000, limit: 5 });
    const signupLimiter = createFixedWindowLimiter({ windowMs: 15 * 60 * 1000, limit: 5 });
    const jobLimiter = createFixedWindowLimiter({ windowMs: 60 * 1000, limit: 5 });
    const credentialLimiter = createFixedWindowLimiter({ windowMs: 15 * 60 * 1000, limit: 5 });
    const credentialIpLimiter = createFixedWindowLimiter({ windowMs: 15 * 60 * 1000, limit: 10 });

    if (config.trustProxy) app.set('trust proxy', 1);
    app.disable('x-powered-by');
    app.use(helmet({
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                scriptSrc: ["'self'"],
                styleSrc: ["'self'"],
                imgSrc: ["'self'", 'data:'],
                connectSrc: ["'self'"],
                objectSrc: ["'none'"],
                frameAncestors: ["'none'"]
            }
        },
        crossOriginEmbedderPolicy: false
    }));
    app.use(express.json({ limit: '256kb' }));

    app.use('/api', (req, res, next) => {
        if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)
            && config.maintenanceFile && fs.existsSync(config.maintenanceFile)) {
            res.setHeader('Retry-After', '30');
            return res.status(503).json({ error: '업데이트 준비 중입니다. 잠시 후 다시 시도해주세요.' });
        }
        next();
    });

    app.use((req, res, next) => {
        res.setHeader('Cache-Control', req.path.startsWith('/api/') ? 'no-store' : 'no-cache');
        const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
        if (token) {
            req.sessionToken = token;
            req.auth = db.getSession(hashToken(token));
        }
        next();
    });

    const setSessionCookie = (res, token) => {
        res.cookie(SESSION_COOKIE, token, {
            httpOnly: true,
            secure: config.cookieSecure,
            sameSite: 'strict',
            path: '/',
            maxAge: config.sessionTtlMs
        });
    };

    const clearSessionCookie = (res) => {
        res.clearCookie(SESSION_COOKIE, {
            httpOnly: true,
            secure: config.cookieSecure,
            sameSite: 'strict',
            path: '/'
        });
    };

    const startSession = (res, userId) => {
        const token = createSessionToken();
        const csrfToken = createCsrfToken();
        const expiresAt = new Date(Date.now() + config.sessionTtlMs).toISOString();
        db.createSession({ tokenHash: hashToken(token), userId, csrfToken, expiresAt });
        setSessionCookie(res, token);
        return csrfToken;
    };

    const requireAuth = (req, res, next) => {
        if (!req.auth) return res.status(401).json({ error: '로그인이 필요합니다.' });
        next();
    };

    const requireAdmin = (req, res, next) => {
        if (req.auth?.user?.role !== 'admin') return res.status(403).json({ error: '관리자 권한이 필요합니다.' });
        next();
    };

    const requireCsrf = (req, res, next) => {
        const provided = req.get('x-csrf-token');
        if (!req.auth || !safeTokenEqual(provided, req.auth.csrfToken)) {
            return res.status(403).json({ error: '요청 검증 토큰이 올바르지 않습니다. 새로고침 후 다시 시도해주세요.' });
        }
        next();
    };

    const credentialSummary = (userId) => {
        const credential = db.getPortalCredential(userId);
        if (!credential) return { configured: false, maskedId: null, updatedAt: null };
        try {
            const portalId = decryptSecret(credential.portal_id_encrypted, config.masterKey, `portal:${userId}:id`);
            return { configured: true, maskedId: maskPortalId(portalId), updatedAt: credential.updated_at };
        } catch {
            return { configured: true, maskedId: '복호화 오류', updatedAt: credential.updated_at, needsReset: true };
        }
    };

    app.get('/health', (req, res) => {
        res.json({ ok: true, service: 'worklog-web', revision: config.revision || 'development' });
    });

    app.get('/internal/deployment', (req, res) => {
        if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) return res.sendStatus(404);
        res.json({ busy: queue.running > 0 || queue.pending.length > 0 || activeMutations.size > 0 || activeVerifications.size > 0 });
    });

    app.get('/api/bootstrap', (req, res) => {
        res.json({
            setupRequired: db.countAdmins() === 0,
            setupTokenRequired: db.countAdmins() === 0 && Boolean(config.setupToken),
            signupEnabled: true,
            authenticated: Boolean(req.auth),
            user: req.auth?.user || null,
            csrfToken: req.auth?.csrfToken || null,
            portalCredential: req.auth ? credentialSummary(req.auth.user.id) : null
        });
    });

    app.use(['/api/signup', '/api/login', '/api/setup'], (req, res, next) => {
        const origin = req.get('origin');
        if (req.get('sec-fetch-site') === 'cross-site'
            || (origin && origin !== `${req.protocol}://${req.get('host')}`)) {
            return res.status(403).json({ error: '다른 사이트에서 보낸 인증 요청은 허용하지 않습니다.' });
        }
        next();
    });

    app.post('/api/signup', async (req, res, next) => {
        try {
            const rate = signupLimiter(req.ip);
            if (!rate.allowed) {
                res.setHeader('Retry-After', rate.retryAfter);
                return res.status(429).json({ error: '회원가입 요청이 너무 많습니다. 잠시 후 다시 시도해주세요.' });
            }
            const validated = validateAccountInput(req.body);
            if (!validated.ok) return res.status(400).json({ error: validated.errors[0], errors: validated.errors });
            if (validated.value.password !== req.body?.passwordConfirmation) {
                return res.status(400).json({ error: '비밀번호 확인이 일치하지 않습니다.' });
            }
            const user = db.createUser({
                username: validated.value.username,
                displayName: validated.value.displayName,
                passwordHash: await hashPassword(validated.value.password),
                role: 'user'
            });
            const csrfToken = startSession(res, user.id);
            db.addAudit(user.id, 'signup_succeeded', {}, req.ip);
            res.status(201).json({ user, csrfToken, portalCredential: credentialSummary(user.id) });
        } catch (error) {
            if (String(error.code).startsWith('SQLITE_CONSTRAINT_UNIQUE')) {
                return res.status(409).json({ error: '이미 사용 중인 아이디입니다.' });
            }
            next(error);
        }
    });

    app.post('/api/setup', async (req, res, next) => {
        try {
            const rate = setupLimiter(req.ip);
            if (!rate.allowed) {
                res.setHeader('Retry-After', rate.retryAfter);
                return res.status(429).json({ error: '설정 요청이 너무 많습니다. 잠시 후 다시 시도해주세요.' });
            }
            if (db.countAdmins() > 0) return res.status(409).json({ error: '초기 설정이 이미 완료되었습니다.' });
            if (config.setupToken && !safeTokenEqual(req.body?.setupToken, config.setupToken)) {
                return res.status(403).json({ error: '초기 설정 보안 토큰이 올바르지 않습니다.' });
            }
            const validated = validateAccountInput(req.body);
            if (!validated.ok) return res.status(400).json({ error: validated.errors[0], errors: validated.errors });
            const passwordHash = await hashPassword(validated.value.password);
            if (db.countAdmins() > 0) return res.status(409).json({ error: '초기 설정이 이미 완료되었습니다.' });
            const user = db.createUser({
                username: validated.value.username,
                displayName: validated.value.displayName,
                passwordHash,
                role: 'admin'
            });
            const csrfToken = startSession(res, user.id);
            db.addAudit(user.id, 'initial_setup', {}, req.ip);
            return res.status(201).json({ user, csrfToken });
        } catch (error) {
            next(error);
        }
    });

    app.post('/api/login', async (req, res, next) => {
        try {
            const username = String(req.body?.username || '').trim();
            const rate = loginLimiter(`${req.ip}:${username.toLowerCase()}`);
            if (!rate.allowed) {
                res.setHeader('Retry-After', rate.retryAfter);
                return res.status(429).json({ error: '로그인 시도가 너무 많습니다. 잠시 후 다시 시도해주세요.' });
            }
            const userRow = db.findUserByUsername(username);
            const valid = userRow?.is_active && await verifyPassword(req.body?.password || '', userRow.password_hash);
            if (!valid) {
                db.addAudit(userRow?.id || null, 'login_failed', {}, req.ip);
                return res.status(401).json({ error: '아이디 또는 비밀번호를 확인해주세요.' });
            }
            db.touchLogin(userRow.id);
            const csrfToken = startSession(res, userRow.id);
            db.addAudit(userRow.id, 'login_succeeded', {}, req.ip);
            return res.json({ user: db.getPublicUser(userRow.id), csrfToken, portalCredential: credentialSummary(userRow.id) });
        } catch (error) {
            next(error);
        }
    });

    app.post('/api/logout', requireAuth, requireCsrf, (req, res) => {
        db.deleteSession(hashToken(req.sessionToken));
        db.addAudit(req.auth.user.id, 'logout', {}, req.ip);
        clearSessionCookie(res);
        res.status(204).end();
    });

    app.get('/api/me', requireAuth, (req, res) => {
        res.json({
            user: req.auth.user,
            csrfToken: req.auth.csrfToken,
            portalCredential: credentialSummary(req.auth.user.id)
        });
    });

    app.put('/api/me/password', requireAuth, requireCsrf, async (req, res, next) => {
        try {
            const currentPassword = String(req.body?.currentPassword || '');
            const newPassword = String(req.body?.newPassword || '');
            if (newPassword.length < 10 || newPassword.length > 128) {
                return res.status(400).json({ error: '새 비밀번호는 10~128자로 입력해주세요.' });
            }
            const userRow = db.findUserById(req.auth.user.id);
            if (!await verifyPassword(currentPassword, userRow.password_hash)) {
                return res.status(400).json({ error: '현재 비밀번호가 일치하지 않습니다.' });
            }
            db.updatePassword(userRow.id, await hashPassword(newPassword));
            const csrfToken = startSession(res, userRow.id);
            db.addAudit(userRow.id, 'password_changed', {}, req.ip);
            return res.json({ ok: true, csrfToken });
        } catch (error) {
            next(error);
        }
    });

    app.get('/api/portal-credentials', requireAuth, (req, res) => {
        res.json(credentialSummary(req.auth.user.id));
    });

    app.put('/api/portal-credentials', requireAuth, requireCsrf, async (req, res, next) => {
        const portalId = String(req.body?.portalId || '').trim();
        const portalPassword = String(req.body?.portalPassword || '');
        if (portalId.length < 2 || portalId.length > 80 || portalPassword.length < 4 || portalPassword.length > 200) {
            return res.status(400).json({ error: '포털 아이디 또는 비밀번호 형식을 확인해주세요.' });
        }
        const userId = req.auth.user.id;
        if (activeVerifications.has(userId) || activeMutations.has(userId) || queue.hasPendingForUser(userId)) {
            return res.status(409).json({ error: '진행 중인 포털 작업이 있습니다. 완료 후 다시 시도해주세요.' });
        }
        if (activeVerifications.size >= 2) {
            res.setHeader('Retry-After', '10');
            return res.status(503).json({ error: '다른 로그인 확인이 진행 중입니다. 잠시 후 다시 시도해주세요.' });
        }
        const rates = [credentialLimiter(`user:${userId}`), credentialLimiter(`portal:${hashToken(portalId.toLowerCase())}`), credentialIpLimiter(req.ip)];
        if (rates.some(rate => !rate.allowed)) {
            res.setHeader('Retry-After', String(Math.max(...rates.map(rate => rate.retryAfter))));
            return res.status(429).json({ error: '로그인 확인 요청이 너무 많습니다. 잠시 후 다시 시도해주세요.' });
        }
        activeVerifications.add(userId);
        try {
            try {
                if (await runtime.verifyCredentials({ portalId, portalPassword }) !== true) throw new Error('Unverified credentials');
            } catch {
                db.addAudit(userId, 'portal_credential_verification_failed', {}, req.ip);
                return res.status(422).json({ error: '학교 포털 로그인 또는 근로 일지 접근을 확인하지 못했습니다. 아이디·비밀번호와 포털 상태를 확인해주세요. 입력한 정보는 저장하지 않았습니다.' });
            }
            if (!db.getSession(hashToken(req.sessionToken))) {
                return res.status(401).json({ error: '로그인이 만료되어 저장하지 않았습니다. 다시 로그인해주세요.' });
            }
            db.savePortalCredential(
                userId,
                encryptSecret(portalId, config.masterKey, `portal:${userId}:id`),
                encryptSecret(portalPassword, config.masterKey, `portal:${userId}:password`)
            );
            db.addAudit(userId, 'portal_credential_saved', { verified: true }, req.ip);
            res.json(credentialSummary(userId));
        } catch (error) {
            next(error);
        } finally {
            activeVerifications.delete(userId);
        }
    });

    app.delete('/api/portal-credentials', requireAuth, requireCsrf, (req, res) => {
        if (activeVerifications.has(req.auth.user.id) || activeMutations.has(req.auth.user.id) || queue.hasPendingForUser(req.auth.user.id)) {
            return res.status(409).json({ error: '진행 중인 포털 작업이 있습니다. 완료 후 다시 시도해주세요.' });
        }
        db.deletePortalCredential(req.auth.user.id);
        db.addAudit(req.auth.user.id, 'portal_credential_deleted', {}, req.ip);
        res.status(204).end();
    });

    app.get('/api/portal-records/:year/:month', requireAuth, (req, res) => {
        const year = Number(req.params.year);
        const month = Number(req.params.month);
        if (!Number.isInteger(year) || year < 2020 || year > 2100 || !Number.isInteger(month) || month < 1 || month > 12) {
            return res.status(400).json({ error: '연월이 올바르지 않습니다.' });
        }
        const credential = db.getPortalCredential(req.auth.user.id);
        // Account replacement invalidates earlier snapshots, including jobs queued before the replacement.
        const snapshot = credential ? db.getPortalSnapshot(req.auth.user.id, year, month, credential.updated_at) : null;
        res.json({ snapshot });
    });

    app.post('/api/portal-records/:year/:month/mutate', requireAuth, requireCsrf, async (req, res) => {
        const year = Number(req.params.year);
        const month = Number(req.params.month);
        const { operation, record, changes, confirmed } = req.body || {};
        const userId = req.auth.user.id;
        if (!['update', 'delete'].includes(operation) || confirmed !== true || !record
            || !Number.isInteger(year) || year < 2020 || year > 2100 || !Number.isInteger(month) || month < 1 || month > 12) {
            return res.status(400).json({ error: '대상 일지와 작업 종류, 실제 변경 동의를 확인해주세요.' });
        }
        if (!db.getPortalCredential(userId)) return res.status(400).json({ error: '학교 포털 계정을 먼저 등록해주세요.' });
        if (activeMutations.has(userId) || activeVerifications.has(userId) || queue.hasPendingForUser(userId)) return res.status(409).json({ error: '진행 중인 작업이 있습니다. 완료 후 다시 시도해주세요.' });
        if (!jobLimiter(String(userId)).allowed) return res.status(429).json({ error: '작업 요청이 너무 많습니다. 잠시 후 다시 시도해주세요.' });
        const job = db.createJob({ id: crypto.randomUUID(), userId, type: 'submit', year, month });
        activeMutations.add(userId);
        try {
            db.markJobRunning(job.id);
            db.addAudit(userId, `portal_record_${operation}_requested`, { jobId: job.id, year, month, date: record.date }, req.ip);
            const summary = await runtime.mutateRecord(userId, { year, month, operation, record, changes,
                onEvent: ({ level, message }) => db.addJobLog(job.id, level || 'info', message) });
            db.completeJob(job.id, summary);
            db.addJobLog(job.id, 'success', `${operation === 'delete' ? '삭제' : '수정'} 후 포털 재조회 검증 완료`);
            db.addAudit(userId, `portal_record_${operation}_verified`, { jobId: job.id, date: record.date }, req.ip);
            res.json({ job: db.getJob(job.id, true) });
        } catch (error) {
            db.failJob(job.id, error.message);
            db.addJobLog(job.id, 'error', error.message);
            res.status(422).json({ error: error.message, job: db.getJob(job.id, true) });
        } finally { activeMutations.delete(userId); }
    });

    app.get('/api/schedules/:year/:month', requireAuth, async (req, res) => {
        const year = Number(req.params.year);
        const month = Number(req.params.month);
        if (!Number.isInteger(year) || year < 2020 || year > 2100 || !Number.isInteger(month) || month < 1 || month > 12) {
            return res.status(400).json({ error: '연월이 올바르지 않습니다.' });
        }
        const schedule = db.getSchedule(req.auth.user.id, year, month) || {
            year,
            month,
            content: '실습실 점검',
            portalAssignment: null,
            regularRules: [],
            specialDates: {},
            vacationDates: [],
            extraHolidayDates: [],
            holidayDates: [],
            holidayWorkDates: [],
            cleanupUnexpectedRows: false,
            updatedAt: null
        };
        const calendar = await calendarProvider(year, month);
        if (!calendar.error) schedule.holidayDates = calendar.holidays.map((holiday) => holiday.day);
        const preview = previewSchedule(schedule, new Set(schedule.extraHolidayDates));
        res.json({ schedule, preview, calendar });
    });

    app.put('/api/schedules/:year/:month', requireAuth, requireCsrf, async (req, res) => {
        const validated = validateSchedulePayload(req.body, req.params.year, req.params.month);
        if (!validated.ok) return res.status(400).json({ error: validated.errors[0], errors: validated.errors });
        const calendar = await calendarProvider(validated.value.year, validated.value.month);
        validated.value.holidayDates = calendar.error
            ? db.getSchedule(req.auth.user.id, validated.value.year, validated.value.month)?.holidayDates || []
            : calendar.holidays.map((holiday) => holiday.day);
        const schedule = db.saveSchedule(req.auth.user.id, validated.value);
        const preview = previewSchedule(schedule, new Set(schedule.extraHolidayDates));
        db.addAudit(req.auth.user.id, 'schedule_saved', { year: schedule.year, month: schedule.month, count: preview.count }, req.ip);
        res.json({ schedule, preview, calendar });
    });

    app.post('/api/jobs', requireAuth, requireCsrf, (req, res) => {
        const type = req.body?.type === 'query' ? 'query' : req.body?.type === 'submit' ? 'submit' : null;
        const year = Number(req.body?.year);
        const month = Number(req.body?.month);
        if (!type || !Number.isInteger(year) || year < 2020 || year > 2100 || !Number.isInteger(month) || month < 1 || month > 12) {
            return res.status(400).json({ error: '작업 종류 또는 연월이 올바르지 않습니다.' });
        }
        if (activeVerifications.has(req.auth.user.id)) {
            return res.status(409).json({ error: '포털 로그인 확인 중입니다. 완료 후 다시 시도해주세요.' });
        }
        const rate = jobLimiter(String(req.auth.user.id));
        if (!rate.allowed) return res.status(429).json({ error: '작업 요청이 너무 많습니다. 잠시 후 다시 시도해주세요.' });
        if (!db.getPortalCredential(req.auth.user.id)) return res.status(400).json({ error: '학교 포털 계정을 먼저 등록해주세요.' });
        let schedule = null;
        if (type === 'submit') {
            schedule = db.getSchedule(req.auth.user.id, year, month);
            if (!schedule) return res.status(400).json({ error: '먼저 해당 월의 일정을 저장해주세요.' });
            if (!schedule.portalAssignment) {
                return res.status(400).json({ error: '포털에서 해당 월의 장학 유형과 근무지를 조회하여 선택해주세요.' });
            }
            if (previewSchedule(schedule, new Set(schedule.extraHolidayDates)).count === 0) {
                return res.status(400).json({ error: '입력할 근무 일정이 없습니다.' });
            }
        }
        if (queue.hasPendingForUser(req.auth.user.id) || activeMutations.has(req.auth.user.id)) {
            return res.status(409).json({ error: '이미 대기 중이거나 실행 중인 작업이 있습니다.' });
        }

        const job = db.createJob({
            id: crypto.randomUUID(),
            userId: req.auth.user.id,
            type,
            year,
            month
        });
        queue.enqueue({ id: job.id, userId: job.userId, type, year, month, schedule });
        db.addAudit(req.auth.user.id, 'job_created', { jobId: job.id, type, year, month }, req.ip);
        res.status(202).json({ job });
    });

    app.get('/api/jobs', requireAuth, (req, res) => {
        res.json({ jobs: db.listJobs(req.auth.user.id, { limit: 20 }) });
    });

    app.get('/api/jobs/:id', requireAuth, (req, res) => {
        const job = db.getJob(req.params.id, true);
        if (!job || (job.userId !== req.auth.user.id && req.auth.user.role !== 'admin')) {
            return res.status(404).json({ error: '작업을 찾을 수 없습니다.' });
        }
        res.json({ job });
    });

    app.get('/api/jobs/:id/events', requireAuth, (req, res) => {
        const initial = db.getJob(req.params.id, true);
        if (!initial || (initial.userId !== req.auth.user.id && req.auth.user.role !== 'admin')) {
            return res.status(404).json({ error: '작업을 찾을 수 없습니다.' });
        }
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();

        const send = (job) => {
            res.write(`event: job\ndata: ${JSON.stringify(job)}\n\n`);
            if (['succeeded', 'failed', 'cancelled'].includes(job.status)) {
                setTimeout(() => res.end(), 100);
            }
        };
        send(initial);
        const unsubscribe = queue.subscribe(req.params.id, send);
        const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 20_000);
        req.on('close', () => {
            clearInterval(heartbeat);
            unsubscribe();
        });
    });

    app.get('/api/admin/users', requireAuth, requireAdmin, (req, res) => {
        res.json({ users: db.listUsers() });
    });

    app.post('/api/admin/users', requireAuth, requireAdmin, requireCsrf, async (req, res, next) => {
        try {
            const validated = validateAccountInput(req.body);
            if (!validated.ok) return res.status(400).json({ error: validated.errors[0], errors: validated.errors });
            const role = req.body?.role === 'admin' ? 'admin' : 'user';
            const user = db.createUser({
                username: validated.value.username,
                displayName: validated.value.displayName,
                passwordHash: await hashPassword(validated.value.password),
                role
            });
            db.addAudit(req.auth.user.id, 'user_created', { targetUserId: user.id, role }, req.ip);
            res.status(201).json({ user });
        } catch (error) {
            if (String(error.message).includes('UNIQUE constraint')) {
                return res.status(409).json({ error: '이미 사용 중인 아이디입니다.' });
            }
            next(error);
        }
    });

    app.patch('/api/admin/users/:id', requireAuth, requireAdmin, requireCsrf, (req, res) => {
        const userId = Number(req.params.id);
        const target = db.getPublicUser(userId);
        if (!target) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
        const displayName = String(req.body?.displayName ?? target.displayName).trim();
        const role = req.body?.role === undefined
            ? target.role
            : req.body.role === 'admin' ? 'admin' : 'user';
        const isActive = req.body?.isActive === undefined ? target.isActive : Boolean(req.body.isActive);
        if (!displayName || displayName.length > 40) return res.status(400).json({ error: '표시 이름을 확인해주세요.' });
        if (userId === req.auth.user.id && (!isActive || role !== 'admin')) {
            return res.status(400).json({ error: '현재 로그인한 관리자 계정은 비활성화하거나 일반 사용자로 변경할 수 없습니다.' });
        }
        const user = db.updateUser(userId, { displayName, role, isActive });
        db.addAudit(req.auth.user.id, 'user_updated', { targetUserId: userId, role, isActive }, req.ip);
        res.json({ user });
    });

    app.put('/api/admin/users/:id/password', requireAuth, requireAdmin, requireCsrf, async (req, res, next) => {
        try {
            const userId = Number(req.params.id);
            if (!db.getPublicUser(userId)) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
            const password = String(req.body?.password || '');
            if (password.length < 10 || password.length > 128) {
                return res.status(400).json({ error: '새 비밀번호는 10~128자로 입력해주세요.' });
            }
            db.updatePassword(userId, await hashPassword(password));
            db.addAudit(req.auth.user.id, 'user_password_reset', { targetUserId: userId }, req.ip);
            res.status(204).end();
        } catch (error) {
            next(error);
        }
    });

    app.use('/api', (req, res) => res.status(404).json({ error: '요청한 API를 찾을 수 없습니다.' }));
    const serveIndex = (req, res, next) => {
        fs.readFile(path.join(config.publicDir, 'index.html'), 'utf8', (error, html) => {
            if (error) return next(error);
            const revision = encodeURIComponent(config.revision || 'development');
            res.setHeader('Cache-Control', 'no-cache');
            res.type('html').send(html.replace('href="/styles.css"', `href="/styles.css?v=${revision}"`)
                .replace('src="/app.js"', `src="/app.js?v=${revision}"`));
        });
    };
    app.get(['/', '/index.html'], serveIndex);
    app.use(express.static(config.publicDir, { etag: true, maxAge: 0 }));
    app.get('/{*splat}', serveIndex);

    app.use((error, req, res, next) => {
        if (res.headersSent) return next(error);
        console.error(`[${new Date().toISOString()}] ${req.method} ${req.path}: ${error.message}`);
        res.status(500).json({ error: '서버 처리 중 오류가 발생했습니다.' });
    });

    return { app, ...runtime };
}

module.exports = {
    SESSION_COOKIE,
    createApp,
    createRuntime,
    maskPortalId,
    parseCookies,
    validateAccountInput
};
