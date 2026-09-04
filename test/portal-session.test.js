const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');
const path = require('node:path');
const request = require('supertest');
const { createApp } = require('../src/app');
const { PortalSessionPool } = require('../src/automation/session-pool');
const { PortalHttpClient } = require('../src/automation/portal-http-client');
const { verifyPortalCredentials } = require('../src/automation/portal');

const expired = () => Object.assign(new Error('Expired'), { code: 'PORTAL_AUTH_EXPIRED' });
const options = { portalId: 'fake', portalPassword: 'not-real' };

function fixture(overrides = {}) {
    const clients = [];
    const clientFactory = () => {
        const client = {
            identity: null, logins: 0, refreshes: 0, closes: 0, refreshError: null,
            async login() { this.logins++; this.identity = { studentNo: 'test', name: 'Test' }; },
            async refreshSession() { this.refreshes++; if (this.refreshError) throw this.refreshError; },
            async close() { this.closes++; this.identity = null; }
        };
        clients.push(client);
        return client;
    };
    return { clients, clientFactory, pool: new PortalSessionPool({ clientFactory, ...overrides }) };
}

test('valid sessions reuse authentication and expired sessions reauthenticate before any operation', async () => {
    const { pool, clients } = fixture();
    const operation = client => client.identity.studentNo;
    assert.equal(await pool.use('1:v1', options, operation), 'test');
    assert.equal(await pool.use('1:v1', options, operation), 'test');
    assert.equal(clients.length, 1);
    assert.equal(clients[0].logins, 1);
    assert.equal(clients[0].refreshes, 1);
    assert.equal(clients[0].closes, 0);
    clients[0].refreshError = expired();
    assert.equal(await pool.use('1:v1', options, operation), 'test');
    assert.equal(clients.length, 2);
    assert.equal(clients[0].closes, 1);
    assert.equal(clients[1].logins, 1);
    await pool.close();
});

test('only read-only authentication failures retry once; writes and unknown errors never replay', async () => {
    for (const readOnly of [true, false]) {
        const { pool, clients } = fixture();
        let operations = 0;
        await assert.rejects(pool.use('1:v1', options, () => { operations++; throw expired(); }, { readOnly }), /Expired/);
        assert.equal(operations, readOnly ? 2 : 1);
        assert.equal(clients.length, readOnly ? 2 : 1);
        assert.equal(pool.entries.size, 0);
        assert.ok(clients.every(client => client.closes === 1));
        await pool.close();
    }
    const { pool, clients } = fixture();
    await pool.use('1:v1', options, () => {});
    clients[0].refreshError = new Error('Schema changed');
    await assert.rejects(pool.use('1:v1', options, () => assert.fail('must not execute'), { readOnly: true }), /Schema changed/);
    assert.equal(clients.length, 1);
    await pool.close();
});

test('sessions are account/credential scoped, bounded in memory, expire, and exclude concurrent leases', async () => {
    let now = 0;
    const { pool, clients } = fixture({ now: () => now, idleTtlMs: 100, maxAgeMs: 500, maxEntries: 2 });
    await pool.use('1:v1', options, () => {});
    await pool.use('11:v1', options, () => {});
    await pool.invalidateUser(1);
    assert.equal(pool.entries.has('1:v1'), false);
    assert.equal(pool.entries.has('11:v1'), true);
    now = 101;
    await pool.prune();
    assert.equal(pool.entries.size, 0);
    assert.ok(clients.every(client => client.closes === 1));
    await pool.use('1:v2', options, () => {});
    let release;
    let started;
    const entered = new Promise(resolve => { started = resolve; });
    const held = pool.use('1:v2', options, async () => { started(); await new Promise(resolve => { release = resolve; }); });
    await entered;
    await assert.rejects(pool.use('1:v2', options, () => {}), /진행 중/);
    await pool.invalidateUser(1);
    assert.equal(clients.at(-1).closes, 0);
    release();
    await held;
    assert.equal(clients.at(-1).closes, 1);
    await pool.close();
});

test('session refresh checks identity and permissions without the portal login endpoint', async () => {
    const requests = [];
    let studentNo = 'self';
    const client = new PortalHttpClient({ fetchImpl: async (url, init) => {
        const command = JSON.parse(init.body).param.strCommand[0];
        requests.push(command);
        const body = command === 'Resettime' ? { dmMain: {} }
            : command === 'MenuAuth' ? { dmMain: { strParentKeyValue9: 'fresh-parent' } }
            : command === 'Onload' ? { systemInfo: [{ PGUSER_MEMBER_NO: studentNo, PGUSER_NM: 'Self' }] }
                : { listSchoCd: [], listWorkDeptCd: [], systemInfo: [{ PGAUTH_UPD_POSB_YN: 'N' }] };
        return new Response(JSON.stringify(body));
    } });
    client.identity = { studentNo, name: 'Self', canUpdate: 'Y' };
    await client.refreshSession();
    assert.deepEqual(requests, ['Resettime', 'MenuAuth', 'Onload', 'OnLoad']);
    assert.equal(client.identity.canUpdate, 'N');
    assert.equal(client.parentKey, 'fresh-parent');
    studentNo = 'other';
    await assert.rejects(client.refreshSession(), /학생 정보가 바뀌어/);
    await client.close();
});

test('explicit authentication signals differ from business rejection and credential verification never uses the pool', async () => {
    for (const response of [new Response('', { status: 401 }), new Response('<form id="loginFrm"></form>'),
        new Response(JSON.stringify({ dmMain: { strMessage: '세션이 만료되었습니다.' } }))]) {
        const client = new PortalHttpClient({ fetchImpl: async () => response });
        await assert.rejects(client.command('OnLoad'), { code: 'PORTAL_AUTH_EXPIRED' });
    }
    const business = new PortalHttpClient({ fetchImpl: async () => new Response(JSON.stringify({ dmMain: { errMessage: 'denied' } })) });
    await assert.rejects(business.command('OnLoad'), error => error.code !== 'PORTAL_AUTH_EXPIRED');
    const { clientFactory, clients } = fixture();
    await verifyPortalCredentials({ ...options, clientFactory, sessionKey: '1:v1', sessionPool: { use: () => assert.fail('credential verification must be fresh') } });
    assert.equal(clients[0].logins, 1);
    assert.equal(clients[0].closes, 1);
});

test('web query jobs reuse the pooled session and app logout invalidates it', async t => {
    const { clientFactory, clients } = fixture();
    const runtime = createApp({ databasePath: ':memory:', masterKey: crypto.randomBytes(32), publicDir: path.resolve(__dirname, '../public'),
        cookieSecure: false, trustProxy: false, sessionTtlMs: 3600000, automationConcurrency: 1, nodeEnv: 'test' }, {
        calendar: async () => ({ holidays: [], error: null }), verifyPortalCredentials: async () => true,
        portalClientFactory: () => Object.assign(clientFactory(), { requestKey: () => ({}), command: async () => ({ listStdno: [] }) })
    });
    t.after(async () => { await runtime.portalSessions.close(); runtime.db.close(); });
    const agent = request.agent(runtime.app);
    let response = await agent.post('/api/setup').send({ username: 'session-owner', displayName: 'Test', password: 'synthetic-password' });
    let csrf = response.body.csrfToken;
    await agent.put('/api/portal-credentials').set('X-CSRF-Token', csrf).send({ portalId: 'fake', portalPassword: 'fake' });
    const query = async () => {
        const response = await agent.post('/api/jobs').set('X-CSRF-Token', csrf).send({ type: 'query', year: 2026, month: 9 });
        assert.equal(response.status, 202);
        for (let i = 0; i < 100; i++) {
            const job = (await agent.get(`/api/jobs/${response.body.job.id}`)).body.job;
            if (job.status === 'succeeded') return job;
            assert.notEqual(job.status, 'failed');
            await new Promise(resolve => setTimeout(resolve, 5));
        }
        assert.fail('query did not finish');
    };
    await query();
    const reused = await query();
    assert.equal(clients.length, 1);
    assert.equal(clients[0].logins, 1);
    assert.equal(clients[0].refreshes, 1);
    assert.ok(reused.logs.some(log => log.message.includes('재사용')));
    assert.equal((await agent.post('/api/logout').set('X-CSRF-Token', csrf)).status, 204);
    assert.equal(runtime.portalSessions.entries.size, 0);
    assert.equal(clients[0].closes, 1);
    response = await agent.post('/api/login').send({ username: 'session-owner', password: 'synthetic-password' });
    csrf = response.body.csrfToken;
    await query();
    assert.equal(clients.length, 2);
    assert.equal(clients[1].logins, 1);
});
