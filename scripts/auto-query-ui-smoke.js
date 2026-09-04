const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const request = require('supertest');
const puppeteer = require('puppeteer');
const { createApp } = require('../src/app');

async function main() {
    const calls = [];
    const pending = new Map();
    let writes = 0;
    const record = month => ({ date: `2026${String(month).padStart(2, '0')}01`, start: '0900', end: '1200',
        content: '', sequence: '1', confirmed: true, scholarshipCode: '50086', workDepartmentCode: '21095' });
    const assignments = [{ scholarshipCode: '50086', workDepartmentCode: '21095', scholarshipName: 'Test', workDepartmentName: 'Test' }];
    const runtime = createApp({ databasePath: ':memory:', masterKey: crypto.randomBytes(32), publicDir: path.resolve(__dirname, '../public'),
        cookieSecure: false, trustProxy: false, sessionTtlMs: 3600000, automationConcurrency: 1, nodeEnv: 'test' }, {
        calendar: async () => ({ holidays: [], error: null }), verifyPortalCredentials: async () => true,
        automation: {
            queryPortalRecords: async ({ year, month }) => {
                calls.push(month);
                await new Promise((resolve, reject) => pending.set(month, { resolve, reject }));
                pending.delete(month);
                return { year, month, records: [record(month)], assignments };
            },
            runPortalAutomation: async () => { writes++; throw new Error('Unexpected write'); },
            mutatePortalRecord: async () => { writes++; throw new Error('Unexpected mutation'); }
        }
    });
    const agent = request.agent(runtime.app);
    const setup = await agent.post('/api/setup').send({ username: 'auto-test', displayName: 'Test', password: 'synthetic-password' });
    const { csrfToken: csrf, user } = setup.body;
    assert.equal((await agent.put('/api/portal-credentials').set('X-CSRF-Token', csrf)
        .send({ portalId: 'fake', portalPassword: 'fake' })).status, 200);
    for (const month of [9, 10]) {
        const id = `fixture-${month}`;
        runtime.db.createJob({ id, userId: user.id, type: 'query', year: 2026, month });
        runtime.db.completeJob(id, { records: [record(month)], assignments });
        runtime.db.raw.prepare('UPDATE jobs SET finished_at = ? WHERE id = ?').run(new Date(Date.now() - 120000).toISOString(), id);
    }
    const server = runtime.app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const browser = await puppeteer.launch({ headless: true,
        args: process.env.GITHUB_ACTIONS === 'true' && process.platform === 'linux' ? ['--no-sandbox'] : [] });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const waitPending = async month => {
        const deadline = Date.now() + 5000;
        while (!pending.has(month) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 30));
        assert.ok(pending.has(month), `query ${month} started`);
    };
    try {
        await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'networkidle0' });
        await page.evaluate(() => { state.year = 2026; state.month = 9; });
        await page.type('#username', 'auto-test');
        await page.type('#password', 'synthetic-password');
        await page.click('#auth-submit');
        await waitPending(9);
        await page.waitForFunction(() => state.portalSnapshot?.jobId === 'fixture-9');
        assert.match(await page.$eval('#portal-calendar-summary', el => el.textContent), /갱신 중, 이전 기록/);
        // Other tabs reuse the same query without spending another portal request or rate-limit token.
        for (let i = 0; i < 6; i++) {
            const result = await agent.post('/api/jobs').set('X-CSRF-Token', csrf).send({ type: 'query', year: 2026, month: 9, automatic: true });
            assert.equal(result.status, 202);
            assert.equal(result.body.reused, true);
        }
        await page.evaluate(async () => { await changeMonth(1); await changeMonth(1); });
        await new Promise(resolve => setTimeout(resolve, 800));
        assert.deepEqual(calls, [9]);
        pending.get(9).resolve();
        await waitPending(11);
        assert.deepEqual(calls, [9, 11]);
        assert.equal(await page.evaluate(() => state.portalSnapshot), null);
        pending.get(11).resolve();
        await page.waitForFunction(() => state.portalSnapshot?.month === 11);
        assert.equal(await page.evaluate(() => state.portalAssignments.length), 1);
        assert.equal(await page.$('dialog[open]'), null);
        await page.evaluate(() => changeMonth(-1));
        await waitPending(10);
        assert.equal(await page.evaluate(() => state.portalSnapshot.jobId), 'fixture-10');
        pending.get(10).reject(new Error('Synthetic query failure'));
        await page.waitForFunction(() => state.portalSnapshotError.includes('Synthetic'));
        assert.equal(await page.evaluate(() => state.portalSnapshot.jobId), 'fixture-10');
        await page.evaluate(() => changeMonth(1));
        await new Promise(resolve => setTimeout(resolve, 900));
        assert.deepEqual(calls, [9, 11, 10]);
        // Saving before month navigation carries rules but not that month's manual exceptions.
        await page.evaluate(async () => {
            state.schedule.regularRules = [{ day: 1, start: '0900', end: '1200' }];
            state.schedule.specialDates = { 1: { start: '1000', end: '1100' } };
            setDirty();
            await changeMonth(1);
        });
        assert.deepEqual(await page.evaluate(() => state.schedule.regularRules.map(({ day, start, end }) => ({ day, start, end }))),
            [{ day: 1, start: '0900', end: '1200' }]);
        assert.deepEqual(await page.evaluate(() => state.schedule.specialDates), {});
        assert.equal(runtime.db.getSchedule(user.id, 2026, 11).content, '');
        assert.equal(writes, 0);
        assert.deepEqual(errors, []);
        console.log(JSON.stringify({ passed: true, automaticQueries: calls, portalWrites: writes,
            checks: ['initial DB-first display', 'active-query reuse', 'latest month only', 'failed refresh preserves cache',
                'fresh result reuse', 'assignment refresh without modal', 'save-before-navigation', 'blank content', 'continuous rules'] }));
    } finally {
        await browser.close();
        for (const job of pending.values()) job.resolve();
        await new Promise(resolve => setTimeout(resolve, 30));
        await new Promise(resolve => server.close(resolve));
        runtime.db.close();
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
