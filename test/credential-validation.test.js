const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const test = require('node:test');
const request = require('supertest');
const { createApp } = require('../src/app');
const { decryptSecret } = require('../src/lib/security');
const { PortalHttpClient } = require('../src/automation/portal-http-client');
const { verifyPortalCredentials } = require('../src/automation/portal');

function setup(t, verify) {
    const masterKey = crypto.randomBytes(32);
    const runtime = createApp({ databasePath: ':memory:', masterKey, publicDir: path.resolve(__dirname, '../public'),
        cookieSecure: false, trustProxy: false, sessionTtlMs: 3600000, automationConcurrency: 1, nodeEnv: 'test' }, {
        verifyPortalCredentials: verify, calendar: async () => ({ holidays: [], error: null })
    });
    t.after(() => runtime.db.close());
    return { ...runtime, masterKey };
}

async function signup(runtime, name = 'tester') {
    const agent = request.agent(runtime.app);
    const response = await agent.post('/api/signup').send({ username: name, displayName: name,
        password: 'test-password-123', passwordConfirmation: 'test-password-123' });
    assert.equal(response.status, 201);
    return { agent, csrf: response.body.csrfToken, id: response.body.user.id };
}

test('credentials are verified before encryption; failed replacements preserve the old credential and redact errors', async t => {
    let mode = 'throw';
    let calls = 0;
    const runtime = setup(t, async options => {
        calls++;
        assert.equal(options.portalId, 'candidate-id');
        if (mode === 'throw') throw new Error('private-password-must-not-leak');
        return mode === 'success';
    });
    const { agent, csrf, id } = await signup(runtime);
    const save = () => agent.put('/api/portal-credentials').set('X-CSRF-Token', csrf)
        .send({ portalId: 'candidate-id', portalPassword: 'private-password-must-not-leak' });
    assert.equal((await request(runtime.app).put('/api/portal-credentials').send({})).status, 401);
    assert.equal((await agent.put('/api/portal-credentials').send({})).status, 403);
    assert.equal(calls, 0);
    assert.equal((await save()).status, 422);
    assert.equal(runtime.db.getPortalCredential(id), null);
    mode = 'success';
    const accepted = await save();
    assert.equal(accepted.status, 200);
    const stored = runtime.db.getPortalCredential(id);
    assert.equal(decryptSecret(stored.portal_password_encrypted, runtime.masterKey, `portal:${id}:password`), 'private-password-must-not-leak');
    mode = 'false';
    assert.equal((await save()).status, 422);
    assert.deepEqual(runtime.db.getPortalCredential(id), stored);
    mode = 'throw';
    const rejected = await save();
    assert.equal(rejected.status, 422);
    assert.deepEqual(runtime.db.getPortalCredential(id), stored);
    assert.equal(JSON.stringify([accepted.body, rejected.body, runtime.db.raw.prepare('SELECT * FROM audit_logs').all()]).includes('private-password-must-not-leak'), false);
});

test('pending verification prevents duplicate save/delete/jobs and cannot save after logout', async t => {
    let resolve;
    let entered;
    const started = new Promise(done => { entered = done; });
    const runtime = setup(t, () => { entered(); return new Promise(done => { resolve = done; }); });
    const { agent, csrf, id } = await signup(runtime);
    const save = () => agent.put('/api/portal-credentials').set('X-CSRF-Token', csrf).send({ portalId: 'test-id', portalPassword: 'test-password' });
    const first = save().then(response => response);
    await started;
    assert.equal((await agent.get('/internal/deployment')).body.busy, true);
    assert.equal(runtime.db.getPortalCredential(id), null);
    assert.equal((await save()).status, 409);
    assert.equal((await agent.delete('/api/portal-credentials').set('X-CSRF-Token', csrf)).status, 409);
    assert.equal((await agent.post('/api/jobs').set('X-CSRF-Token', csrf).send({ type: 'query', year: 2026, month: 9 })).status, 409);
    await agent.post('/api/logout').set('X-CSRF-Token', csrf);
    resolve(true);
    assert.equal((await first).status, 401);
    assert.equal(runtime.db.getPortalCredential(id), null);
    assert.equal((await request(runtime.app).get('/internal/deployment')).body.busy, false);
});

test('portal identity rate limit spans different app accounts', async t => {
    let calls = 0;
    const runtime = setup(t, async () => { calls++; return false; });
    const first = await signup(runtime, 'first-user');
    const second = await signup(runtime, 'second-user');
    const save = (user, portalId) => user.agent.put('/api/portal-credentials').set('X-CSRF-Token', user.csrf).send({ portalId, portalPassword: 'invalid-test-password' });
    for (let index = 0; index < 5; index++) assert.equal((await save(first, 'same-id')).status, 422);
    const limited = await save(second, 'SAME-ID');
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers['retry-after']) > 0);
    assert.equal(calls, 5);
});

test('real HTTP verification uses login and read-only initialization, then clears session cookies', async () => {
    const commands = [];
    const events = [];
    const client = new PortalHttpClient({ fetchImpl: async (url, init) => {
        const pathname = new URL(url).pathname;
        if (pathname === '/login_real.jsp') return new Response('<form id="loginFrm"><input name="user_id"><input name="user_password"></form>');
        if (pathname === '/proc/Login.do') return new Response('signed in', { headers: { 'set-cookie': 'sso=test; Secure; Path=/' } });
        const command = JSON.parse(init.body).param.strCommand[0];
        commands.push(command);
        if (pathname === '/sys.Main.do') return Response.json({ dmMain: { strParentKeyValue9: 'test' } });
        if (pathname === '/cmn.CmnAppHeader.do') return Response.json({ systemInfo: [{ PGUSER_MEMBER_NO: 'test-student', PGUSER_NM: 'Test' }] });
        assert.equal(command, 'OnLoad');
        return Response.json({ listSchoCd: [], listWorkDeptCd: [], systemInfo: [{ PGAUTH_UPD_POSB_YN: 'N' }] });
    } });
    assert.equal(await verifyPortalCredentials({ portalId: 'test', portalPassword: 'test-password', clientFactory: () => client, onEvent: event => events.push(event) }), true);
    assert.deepEqual(commands, ['MenuAuth', 'Onload', 'OnLoad']);
    assert.equal(await client.jar.getCookieString('https://portal.dongyang.ac.kr/'), '');
    assert.equal(client.identity, null);
    assert.deepEqual(events.map(event => event.progress), [1, 2, 5, 12, 15, 18, 20]);
    assert.equal(JSON.stringify(events).includes('test-password'), false);
});

test('login timeout fails closed and clears the temporary session', async () => {
    const keepAlive = setTimeout(() => {}, 1000);
    const client = new PortalHttpClient({ loginTimeoutMs: 20, fetchImpl: async (url, { signal }) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }) });
    try {
        await assert.rejects(verifyPortalCredentials({ portalId: 'test', portalPassword: 'test-password', clientFactory: () => client }), /완료되지/);
        assert.equal(client.identity, null);
        assert.equal(client.loginSignal, null);
    } finally { clearTimeout(keepAlive); }
});
