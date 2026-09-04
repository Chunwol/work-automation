const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const request = require('supertest');
const { createApp: createActualApp } = require('../src/app');
const createApp = (config, overrides = {}) => createActualApp(config, {
    calendar: async () => ({ holidays: [], source: 'test', error: null }),
    verifyPortalCredentials: async () => true, ...overrides
});

function testConfig() {
    return {
        databasePath: ':memory:',
        masterKey: crypto.randomBytes(32),
        publicDir: path.resolve(__dirname, '..', 'public'),
        cookieSecure: false,
        trustProxy: false,
        sessionTtlMs: 60 * 60 * 1000,
        automationConcurrency: 1,
        automationHeadless: true,
        nodeEnv: 'test'
    };
}

test('HTML and frontend assets revalidate on reload and use a release-specific asset URL', async t => {
    const runtime = createApp({ ...testConfig(), nodeEnv: 'production', revision: 'release-test-123' });
    t.after(() => runtime.db.close());
    const agent = request(runtime.app);
    for (const route of ['/', '/index.html', '/schedule']) {
        const response = await agent.get(route);
        assert.equal(response.status, 200);
        assert.equal(response.headers['cache-control'], 'no-cache');
        assert.match(response.text, /href="\/styles\.css\?v=release-test-123"/);
        assert.match(response.text, /src="\/app\.js\?v=release-test-123"/);
    }
    for (const route of ['/styles.css?v=release-test-123', '/app.js?v=release-test-123']) {
        const response = await agent.get(route);
        assert.equal(response.status, 200);
        assert.equal(response.headers['cache-control'], 'no-cache');
        assert.ok(response.headers.etag);
        const cached = await agent.get(route).set('If-None-Match', response.headers.etag);
        assert.equal(cached.status, 304);
    }
});

async function waitForJob(agent, jobId, timeoutMs = 2_000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        const response = await agent.get(`/api/jobs/${jobId}`);
        if (['succeeded', 'failed'].includes(response.body.job.status)) return response.body.job;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('job timeout');
}

test('deployment pause blocks new writes and reports in-flight portal work', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'worklog-deploy-test-'));
    const maintenanceFile = path.join(directory, '.deployment-pause');
    const runtime = createApp({ ...testConfig(), maintenanceFile, revision: 'verified-test-revision' });
    t.after(() => { runtime.db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
    const agent = request(runtime.app);
    assert.equal((await agent.get('/health')).body.revision, 'verified-test-revision');
    assert.equal((await agent.get('/internal/deployment')).body.busy, false);
    runtime.queue.running = 1;
    assert.equal((await agent.get('/internal/deployment')).body.busy, true);
    runtime.queue.running = 0;
    fs.writeFileSync(maintenanceFile, '');
    for (const endpoint of ['/api/jobs', '/api/signup', '/api/portal-records/2026/9/mutate']) {
        const response = await agent.post(endpoint).send({});
        assert.equal(response.status, 503);
        assert.equal(response.headers['retry-after'], '30');
    }
    assert.equal((await agent.get('/api/bootstrap')).status, 200);
    fs.unlinkSync(maintenanceFile);
    assert.equal((await agent.post('/api/jobs').send({})).status, 401);
});

test('public signup is isolated, never grants admin, and permits a later protected admin setup', async (t) => {
    const runtime = createApp({ ...testConfig(), setupToken: 'server-only-token' });
    t.after(() => runtime.db.close());
    const user = request.agent(runtime.app);
    const payload = { username: 'new-user', displayName: '신규 사용자', password: 'signup-password-123', passwordConfirmation: 'signup-password-123', role: 'admin' };
    let response = await user.post('/api/signup').set('Origin', 'https://untrusted.example').send(payload);
    assert.equal(response.status, 403);
    response = await user.post('/api/signup').send({ ...payload, passwordConfirmation: 'different' });
    assert.equal(response.status, 400);
    response = await user.post('/api/signup').send(payload);
    assert.equal(response.status, 201);
    assert.equal(response.body.user.role, 'user');
    assert.ok(response.body.csrfToken);
    assert.equal(response.body.portalCredential.configured, false);
    response = await user.get('/api/bootstrap');
    assert.equal(response.body.authenticated, true);
    assert.equal(response.body.setupRequired, true);
    response = await user.get('/api/admin/users');
    assert.equal(response.status, 403);
    response = await request(runtime.app).post('/api/signup').send({ ...payload, username: 'NEW-USER' });
    assert.equal(response.status, 409);
    response = await request(runtime.app).post('/api/setup').send({ ...payload, username: 'owner' });
    assert.equal(response.status, 403);
    response = await request(runtime.app).post('/api/setup').send({ ...payload, username: 'owner', setupToken: 'server-only-token' });
    assert.equal(response.status, 201);
    assert.equal(response.body.user.role, 'admin');
    response = await user.get('/api/bootstrap');
    assert.equal(response.body.setupRequired, false);
    assert.equal(response.body.user.role, 'user');
    assert.equal(runtime.db.countUsers(), 2);
});

test('signup requests are rate limited', async (t) => {
    const runtime = createApp(testConfig());
    t.after(() => runtime.db.close());
    for (let index = 0; index < 5; index += 1) {
        assert.equal((await request(runtime.app).post('/api/signup').send({})).status, 400);
    }
    const response = await request(runtime.app).post('/api/signup').send({});
    assert.equal(response.status, 429);
    assert.ok(response.headers['retry-after']);
});

test('full account, encrypted credential, schedule, and isolated job flow', async (t) => {
    const calls = [];
    const automation = {
        async queryPortalRecords(options) {
            calls.push({ type: 'query', portalId: options.portalId, portalPassword: options.portalPassword });
            options.onEvent({ level: 'info', message: 'mock query', progress: 60 });
            return { records: [], count: 0, year: options.year, month: options.month };
        },
        async runPortalAutomation(options) {
            calls.push({ type: 'submit', portalId: options.portalId, portalPassword: options.portalPassword });
            options.onEvent({ level: 'success', message: 'mock submit', progress: 100 });
            return { insertedCount: 1, verifiedCount: 1 };
        }
    };
    const runtime = createApp(testConfig(), { automation });
    t.after(() => runtime.db.close());
    const admin = request.agent(runtime.app);

    let response = await admin.get('/api/bootstrap');
    assert.equal(response.status, 200);
    assert.equal(response.body.setupRequired, true);

    response = await admin.post('/api/setup').send({ username: 'admin', displayName: '관리자', password: 'admin-password-123' });
    assert.equal(response.status, 201);
    const adminCsrf = response.body.csrfToken;
    assert.equal(response.body.user.role, 'admin');

    response = await admin.put('/api/portal-credentials').send({ portalId: 'plain-id', portalPassword: 'plain-password' });
    assert.equal(response.status, 403);

    response = await admin.put('/api/portal-credentials')
        .set('X-CSRF-Token', adminCsrf)
        .send({ portalId: 'plain-id', portalPassword: 'plain-password' });
    assert.equal(response.status, 200);
    assert.equal(response.body.configured, true);
    assert.equal(response.body.maskedId.includes('plain-id'), false);

    const storedCredential = runtime.db.raw.prepare('SELECT * FROM portal_credentials').get();
    assert.equal(storedCredential.portal_id_encrypted.includes('plain-id'), false);
    assert.equal(storedCredential.portal_password_encrypted.includes('plain-password'), false);

    const schedule = {
        content: '실습실 점검',
        regularRules: [],
        specialDates: { 1: { start: '1300', end: '1700' } },
        vacationDates: [],
        extraHolidayDates: [],
        cleanupUnexpectedRows: false
    };
    response = await admin.put('/api/schedules/2026/6').set('X-CSRF-Token', adminCsrf).send(schedule);
    assert.equal(response.status, 200);
    assert.equal(response.body.preview.totalMinutes, 240);

    response = await admin.post('/api/jobs').set('X-CSRF-Token', adminCsrf).send({ type: 'query', year: 2026, month: 6 });
    assert.equal(response.status, 202);
    const completedQuery = await waitForJob(admin, response.body.job.id);
    assert.equal(completedQuery.status, 'succeeded');
    assert.deepEqual(calls[0], { type: 'query', portalId: 'plain-id', portalPassword: 'plain-password' });

    response = await admin.post('/api/jobs').set('X-CSRF-Token', adminCsrf).send({ type: 'submit', year: 2026, month: 6 });
    assert.equal(response.status, 400);
    assert.match(response.body.error, /장학 유형과 근무지/);

    schedule.portalAssignment = {
        scholarshipCode: '50086',
        scholarshipName: '국가근로장학금(교내)',
        workDepartmentCode: '21095',
        workDepartmentName: '컴퓨터공학부'
    };
    response = await admin.put('/api/schedules/2026/6').set('X-CSRF-Token', adminCsrf).send(schedule);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.schedule.portalAssignment, schedule.portalAssignment);

    response = await admin.post('/api/jobs').set('X-CSRF-Token', adminCsrf).send({ type: 'submit', year: 2026, month: 6 });
    assert.equal(response.status, 202);
    const completedSubmit = await waitForJob(admin, response.body.job.id);
    assert.equal(completedSubmit.status, 'succeeded');
    assert.equal(calls[1].type, 'submit');

    response = await admin.post('/api/admin/users').set('X-CSRF-Token', adminCsrf).send({
        username: 'worker', displayName: '근로자', password: 'worker-password-123', role: 'user'
    });
    assert.equal(response.status, 201);

    const worker = request.agent(runtime.app);
    response = await worker.post('/api/login').send({ username: 'worker', password: 'worker-password-123' });
    assert.equal(response.status, 200);
    const workerCsrf = response.body.csrfToken;

    response = await worker.get('/api/schedules/2026/6');
    assert.equal(response.status, 200);
    assert.equal(response.body.preview.count, 0);

    response = await worker.get('/api/admin/users');
    assert.equal(response.status, 403);

    response = await worker.post('/api/jobs').set('X-CSRF-Token', workerCsrf).send({ type: 'query', year: 2026, month: 6 });
    assert.equal(response.status, 400);
    assert.match(response.body.error, /포털 계정/);
});

test('login is generic on failure and sessions are invalidated on password change', async (t) => {
    const runtime = createApp(testConfig(), {
        automation: {
            queryPortalRecords: async () => ({}),
            runPortalAutomation: async () => ({})
        }
    });
    t.after(() => runtime.db.close());
    const agent = request.agent(runtime.app);

    let response = await agent.post('/api/setup').send({ username: 'admin', displayName: '관리자', password: 'admin-password-123' });
    const csrf = response.body.csrfToken;

    response = await request(runtime.app).post('/api/login').send({ username: 'missing', password: 'bad-password' });
    assert.equal(response.status, 401);
    assert.equal(response.body.error, '아이디 또는 비밀번호를 확인해주세요.');

    response = await agent.put('/api/me/password').set('X-CSRF-Token', csrf).send({
        currentPassword: 'admin-password-123', newPassword: 'new-admin-password-123'
    });
    assert.equal(response.status, 200);
    assert.ok(response.body.csrfToken);

    response = await request(runtime.app).post('/api/login').send({ username: 'admin', password: 'admin-password-123' });
    assert.equal(response.status, 401);
    response = await request(runtime.app).post('/api/login').send({ username: 'admin', password: 'new-admin-password-123' });
    assert.equal(response.status, 200);
});

test('calendar API snapshots stay account/month scoped beyond recent job list and clear on credential replacement', async (t) => {
    const runtime = createApp(testConfig(), { calendar: async () => ({ holidays: [{ day: 17, name: '대체공휴일' }], error: null }) });
    t.after(() => runtime.db.close());
    const agent = request.agent(runtime.app);
    const signup = await agent.post('/api/signup').send({ username: 'calendar', displayName: 'calendar', password: 'calendar-password', passwordConfirmation: 'calendar-password' });
    const csrf = signup.body.csrfToken;
    const userId = signup.body.user.id;
    const url = '/api/portal-records/2026/8';
    assert.equal((await request(runtime.app).get(url)).status, 401);
    await agent.put('/api/portal-credentials').set('X-CSRF-Token', csrf).send({ portalId: 'calendar-id', portalPassword: 'portal-password' });
    runtime.db.createJob({ id: 'august', userId, type: 'query', year: 2026, month: 8 });
    runtime.db.completeJob('august', { records: [{ date: '20260825', start: '0800', end: '1600' }] });
    for (let index = 0; index < 25; index += 1) runtime.db.createJob({ id: `later-${index}`, userId, type: 'query', year: 2026, month: 9 });
    assert.equal((await agent.get(url)).body.snapshot.records.length, 1);
    assert.equal((await agent.get('/api/portal-records/2026/7')).body.snapshot, null);
    const other = runtime.db.createUser({ username: 'other', displayName: 'other', passwordHash: 'unused', role: 'user' });
    assert.equal(runtime.db.getPortalSnapshot(other.id, 2026, 8, ''), null);
    let response = await agent.put('/api/schedules/2026/8').set('X-CSRF-Token', csrf).send({ content: 'work',
        regularRules: [{ day: 1, start: '0800', end: '1600' }], holidayDates: [], holidayWorkDates: [17] });
    assert.deepEqual(response.body.schedule.holidayDates, [17]);
    assert.ok(response.body.preview.logs.some(log => log.day === 17));
    assert.deepEqual((await agent.get('/api/schedules/2026/8')).body.schedule.holidayWorkDates, [17]);
    runtime.db.raw.prepare("UPDATE jobs SET created_at = '2020-01-01T00:00:00.000Z' WHERE id = 'august'").run();
    assert.equal((await agent.get(url)).body.snapshot, null);
    await agent.delete('/api/portal-credentials').set('X-CSRF-Token', csrf);
    assert.equal((await agent.get(url)).body.snapshot, null);
});

test('portal mutations require CSRF, explicit confirmation and own credentials, and publish a new calendar snapshot', async (t) => {
    let calls = 0;
    const runtime = createApp(testConfig(), { automation: { mutatePortalRecord: async (options) => {
        calls += 1;
        assert.equal(options.portalId, 'own-portal');
        return { operation: options.operation, date: options.record.date, verified: true, records: [], assignments: [] };
    } } });
    t.after(() => runtime.db.close());
    const agent = request.agent(runtime.app);
    const signup = await agent.post('/api/signup').send({ username: 'editor', displayName: 'editor', password: 'editor-password', passwordConfirmation: 'editor-password' });
    const csrf = signup.body.csrfToken;
    await agent.put('/api/portal-credentials').set('X-CSRF-Token', csrf).send({ portalId: 'own-portal', portalPassword: 'portal-password' });
    const url = '/api/portal-records/2026/8/mutate';
    const payload = { operation: 'delete', record: { date: '20260825' }, confirmed: true, portalId: 'not-allowed' };
    assert.equal((await agent.post(url).send(payload)).status, 403);
    assert.equal((await agent.post(url).set('X-CSRF-Token', csrf).send({ ...payload, confirmed: false })).status, 400);
    assert.equal(calls, 0);
    assert.equal((await agent.post(url).set('X-CSRF-Token', csrf).send(payload)).status, 200);
    assert.equal(calls, 1);
    const response = await agent.get('/api/portal-records/2026/8');
    assert.deepEqual(response.body.snapshot.records, []);
});
