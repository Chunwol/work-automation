const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const request = require('supertest');
const { createDatabase } = require('../src/lib/database');
const { createApp } = require('../src/app');
const { JobQueue } = require('../src/lib/job-queue');
const { MonthlyScheduler, occurrence, nextOccurrence, targetMonth, validateMonthlySettings } = require('../src/lib/monthly-scheduler');
const { validateSchedulePayload } = require('../src/lib/schedule');

const assignment = { scholarshipCode: '50086', workDepartmentCode: '21095' };
const settings = { enabled: true, day: 5, time: '0900', targetMonth: 'current', assignment };
const initialNow = '2026-09-04T00:00:00.000Z';
const dueNow = '2026-09-05T00:00:00.000Z';
const calendar = async () => ({ holidays: [{ day: 7, name: 'Test holiday' }], error: null });
const validated = (year, month, payload = {}) => validateSchedulePayload({ regularRules: [{ day: 1, start: '0900', end: '1200' }], ...payload }, year, month).value;

async function idle(queue) {
    for (let i = 0; i < 100 && (queue.running || queue.pending.length); i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(queue.running, 0);
    assert.equal(queue.pending.length, 0);
}

test('monthly dates use KST, clamp short months, handle leap years, and never schedule immediately when enabling', () => {
    assert.equal(occurrence({ ...settings, day: 31, time: '0000' }, 2026, 2), '2026-02-27T15:00:00.000Z');
    assert.equal(occurrence({ ...settings, day: 0 }, 2028, 2), '2028-02-29T00:00:00.000Z');
    assert.equal(nextOccurrence(settings, dueNow), '2026-10-05T00:00:00.000Z');
    assert.equal(nextOccurrence(settings, initialNow, month => month === 202609), '2026-10-05T00:00:00.000Z');
    assert.deepEqual(targetMonth({ targetMonth: 'previous' }, '2026-12-31T15:00:00.000Z'), { year: 2026, month: 12 });
    for (const invalid of [{}, { ...settings }, { ...settings, confirmed: true, day: 32 },
        { ...settings, confirmed: true, time: '2400' }, { ...settings, confirmed: true, assignment: null }]) {
        assert.ok(validateMonthlySettings(invalid).error);
    }
    assert.ok(validateMonthlySettings({ ...settings, confirmed: true }).value);
    assert.deepEqual(validateMonthlySettings({ enabled: false }).value, { enabled: false });
});

test('scheduler claims once, honors monthly overrides and holidays, inherits future rules, and records failures without retry', async t => {
    const db = createDatabase(':memory:');
    t.after(() => db.close());
    const user = db.createUser({ username: 'worker', displayName: 'Test', passwordHash: 'fake' });
    db.savePortalCredential(user.id, 'fake', 'fake');
    const monthlyAssignment = { scholarshipCode: '50064', workDepartmentCode: '31001' };
    db.saveSchedule(user.id, validated(2026, 9, { portalAssignment: monthlyAssignment, specialDates: { 8: { start: '1300', end: '1500' } }, vacationDates: [14] }));
    db.saveMonthlyAutomation(user.id, settings, 0, initialNow);
    const calls = [];
    let fail = false;
    const queue = new JobQueue({ db, executeJob: async item => {
        calls.push(item);
        if (fail) throw new Error('Synthetic ambiguous write failure');
        return { insertedCount: 1, records: [], assignments: [] };
    } });
    let now = new Date(initialNow);
    let paused = false;
    let busy = false;
    const scheduler = new MonthlyScheduler({ db, queue, calendar, now: () => now, paused: () => paused, isBusy: () => busy });
    await scheduler.tick();
    assert.equal(calls.length, 0);
    now = new Date(dueNow);
    paused = true;
    await scheduler.tick();
    paused = false;
    busy = true;
    await scheduler.tick();
    assert.equal(db.listJobs(user.id).length, 0);
    busy = false;
    await Promise.all([scheduler.tick(), scheduler.tick()]);
    await idle(queue);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].schedule.portalAssignment, { ...monthlyAssignment, scholarshipName: '', workDepartmentName: '' });
    assert.deepEqual(calls[0].schedule.vacationDates, [14]);
    assert.deepEqual(calls[0].schedule.holidayDates, [7]);
    assert.equal(calls[0].scheduled, true);
    assert.equal(db.getMonthlyAutomation(user.id).lastRun.triggerSource, 'monthly');
    await scheduler.tick();
    assert.equal(calls.length, 1);
    // Changing the selected day after this month's attempt never creates a second monthly run.
    const current = db.getMonthlyAutomation(user.id);
    const changed = db.saveMonthlyAutomation(user.id, { ...settings, day: 10 }, current.revision, dueNow);
    assert.equal(changed.nextRunAt, '2026-10-10T00:00:00.000Z');
    now = new Date(changed.nextRunAt);
    fail = true;
    await scheduler.tick();
    await idle(queue);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].schedule.content, '');
    assert.deepEqual(calls[1].schedule.specialDates, {});
    assert.equal(calls[1].schedule.portalAssignment.scholarshipCode, assignment.scholarshipCode);
    assert.equal(db.getMonthlyAutomation(user.id).lastRun.status, 'failed');
    await scheduler.tick();
    assert.equal(calls.length, 2);
    assert.equal(db.raw.prepare('SELECT COUNT(*) AS count FROM monthly_runs').get().count, 2);
});

test('overdue, missing schedules, unavailable calendars and disabled users never call the portal', async t => {
    for (const mode of ['overdue', 'empty', 'calendar', 'disabled', 'credential']) {
        const db = createDatabase(':memory:');
        const user = db.createUser({ username: mode, displayName: 'Test', passwordHash: 'fake' });
        db.savePortalCredential(user.id, 'fake', 'fake');
        if (mode !== 'empty') db.saveSchedule(user.id, validated(2026, 9));
        db.saveMonthlyAutomation(user.id, settings, 0, initialNow);
        if (mode === 'disabled') db.updateUser(user.id, { displayName: 'Test', role: 'user', isActive: false });
        if (mode === 'credential') db.deletePortalCredential(user.id);
        let calls = 0;
        const queue = new JobQueue({ db, executeJob: async () => { calls++; } });
        const scheduler = new MonthlyScheduler({ db, queue,
            calendar: mode === 'calendar' ? async () => ({ error: 'offline' }) : calendar,
            now: () => new Date(mode === 'overdue' ? '2026-09-07T00:00:00Z' : dueNow) });
        await scheduler.tick();
        await idle(queue);
        assert.equal(calls, 0, mode);
        if (mode === 'empty') assert.equal(db.getMonthlyAutomation(user.id).lastRun.summary.skipped, true);
        if (['overdue', 'calendar'].includes(mode)) assert.equal(db.getMonthlyAutomation(user.id).lastRun.status, 'failed');
        if (['disabled', 'credential'].includes(mode)) assert.equal(db.getMonthlyAutomation(user.id).enabled, false);
        db.close();
    }
});

test('a claimed job survives restarts as failed, is not replayed, and settings remain persisted', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'worklog-monthly-'));
    const filename = path.join(directory, 'test.sqlite');
    let db = createDatabase(filename);
    try {
        const user = db.createUser({ username: 'restart', displayName: 'Test', passwordHash: 'fake' });
        db.savePortalCredential(user.id, 'fake', 'fake');
        const saved = db.saveMonthlyAutomation(user.id, settings, 0, initialNow);
        const run = { id: 'claimed', year: 2026, month: 9, runMonth: 202609, nextRunAt: '2026-10-05T00:00:00.000Z', now: dueNow };
        assert.ok(db.claimMonthlyRun(saved, run));
        assert.equal(db.claimMonthlyRun(saved, { ...run, id: 'duplicate' }), null);
        db.close();
        db = createDatabase(filename);
        assert.equal(db.getJob('claimed').status, 'failed');
        assert.equal(db.listDueMonthlyAutomations(dueNow).length, 0);
        assert.equal(db.getMonthlyAutomation(user.id).enabled, true);
        assert.equal(db.getMonthlyAutomation(user.id).nextRunAt, run.nextRunAt);
        assert.equal(db.listJobs(user.id).length, 1);
    } finally { db.close(); fs.rmSync(directory, { recursive: true }); }
});

test('monthly API requires owner, CSRF, explicit consent and revision; settings save performs no portal write', async t => {
    let writes = 0;
    const runtime = createApp({ databasePath: ':memory:', masterKey: crypto.randomBytes(32), publicDir: path.resolve(__dirname, '../public'),
        cookieSecure: false, trustProxy: false, sessionTtlMs: 3600000, automationConcurrency: 1, nodeEnv: 'test' }, {
        calendar, now: () => new Date(initialNow), verifyPortalCredentials: async () => true,
        automation: { queryPortalRecords: async () => ({}), runPortalAutomation: async () => { writes++; } }
    });
    t.after(() => runtime.db.close());
    const agent = request.agent(runtime.app);
    let result = await agent.post('/api/setup').send({ username: 'owner', displayName: 'Test', password: 'synthetic-password' });
    const csrf = result.body.csrfToken;
    assert.equal((await request(runtime.app).get('/api/monthly-automation')).status, 401);
    assert.equal((await agent.get('/api/monthly-automation')).body.automation.enabled, false);
    assert.equal((await agent.put('/api/monthly-automation').send({ ...settings, revision: 0, confirmed: true })).status, 403);
    assert.equal((await agent.put('/api/monthly-automation').set('X-CSRF-Token', csrf).send({ ...settings, revision: 0, confirmed: true })).status, 400);
    await agent.put('/api/portal-credentials').set('X-CSRF-Token', csrf).send({ portalId: 'fake', portalPassword: 'fake' });
    assert.equal((await agent.put('/api/monthly-automation').set('X-CSRF-Token', csrf).send({ ...settings, revision: 0 })).status, 400);
    result = await agent.put('/api/monthly-automation').set('X-CSRF-Token', csrf).send({ ...settings, revision: 0, confirmed: true });
    assert.equal(result.status, 200);
    assert.equal(result.body.automation.nextRunAt, dueNow);
    assert.equal(writes, 0);
    assert.equal((await agent.put('/api/monthly-automation').set('X-CSRF-Token', csrf).send({ enabled: false, revision: 0 })).status, 409);
    const other = request.agent(runtime.app);
    await other.post('/api/signup').send({ username: 'other', displayName: 'Other', password: 'synthetic-password', passwordConfirmation: 'synthetic-password' });
    assert.equal((await other.get('/api/monthly-automation')).body.automation.enabled, false);
    await agent.put('/api/portal-credentials').set('X-CSRF-Token', csrf).send({ portalId: 'replacement', portalPassword: 'fake' });
    assert.equal((await agent.get('/api/monthly-automation')).body.automation.enabled, false);
    assert.equal(writes, 0);
});

test('only zero-write approval waits retry next day with the original target, once, until success', async t => {
    let now = new Date(initialNow);
    let mode = 'approval';
    const calls = [];
    const masterKey = crypto.randomBytes(32);
    const runtime = createApp({ databasePath: ':memory:', masterKey, publicDir: path.resolve(__dirname, '../public'),
        cookieSecure: false, trustProxy: false, sessionTtlMs: 3600000, automationConcurrency: 1, nodeEnv: 'test' }, {
        calendar, now: () => now, automation: { runPortalAutomation: async options => {
            calls.push(options.schedule);
            if (mode === 'approval') throw Object.assign(new Error('Approval pending'), { code: 'PORTAL_ASSIGNMENT_PENDING', portalWrites: 0 });
            if (mode === 'login') throw Object.assign(new Error('Login failed'), { code: 'PORTAL_AUTH_EXPIRED' });
            if (mode === 'ambiguous') throw Object.assign(new Error('Unknown result'), { code: 'PORTAL_ASSIGNMENT_PENDING' });
            return { records: [], insertedCount: 1 };
        } }
    });
    t.after(async () => { await runtime.scheduler.stop(); await runtime.portalSessions.close(); runtime.db.close(); });
    const { db, scheduler, queue } = runtime;
    const { encryptSecret } = require('../src/lib/security');
    const user = db.createUser({ username: 'retry', displayName: 'Test', passwordHash: 'fake' });
    db.savePortalCredential(user.id, encryptSecret('fake', masterKey, `portal:${user.id}:id`), encryptSecret('fake', masterKey, `portal:${user.id}:password`));
    db.saveSchedule(user.id, validated(2026, 8));
    db.saveMonthlyAutomation(user.id, { ...settings, targetMonth: 'previous' }, 0, initialNow);
    now = new Date(dueNow);
    await scheduler.tick(); await idle(queue);
    assert.equal(calls.length, 1);
    assert.equal(db.getMonthlyAutomation(user.id).retryAt, '2026-09-06T00:00:00.000Z');
    await scheduler.tick(); await idle(queue);
    assert.equal(calls.length, 1);
    now = new Date('2026-09-06T00:00:00Z');
    await Promise.all([scheduler.tick(), scheduler.tick()]); await idle(queue);
    assert.equal(calls.length, 2);
    assert.equal(db.getMonthlyAutomation(user.id).retryAt, '2026-09-07T00:00:00.000Z');
    mode = 'ok';
    now = new Date('2026-09-07T00:00:00Z');
    await scheduler.tick(); await idle(queue);
    assert.equal(calls.length, 3);
    assert.ok(calls.every(schedule => schedule.month === 8));
    assert.equal(db.getMonthlyAutomation(user.id).retryAt, null);
    assert.equal(db.getMonthlyAutomation(user.id).lastRun.status, 'succeeded');
    assert.equal(db.raw.prepare('SELECT attempt_count FROM monthly_runs').get().attempt_count, 3);
    for (const errorMode of ['login', 'ambiguous']) {
        mode = errorMode;
        now = new Date(db.getMonthlyAutomation(user.id).nextRunAt);
        await scheduler.tick(); await idle(queue);
        assert.equal(db.getMonthlyAutomation(user.id).lastRun.status, 'failed');
        assert.equal(db.getMonthlyAutomation(user.id).retryAt, null);
    }
});

test('approval retries persist across restart, are claimed once, and settings changes cancel them', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'worklog-retry-'));
    const filename = path.join(directory, 'test.sqlite');
    let db = createDatabase(filename);
    try {
        const user = db.createUser({ username: 'retry-restart', displayName: 'Test', passwordHash: 'fake' });
        db.savePortalCredential(user.id, 'fake', 'fake');
        const saved = db.saveMonthlyAutomation(user.id, settings, 0, initialNow);
        db.claimMonthlyRun(saved, { id: 'waiting', year: 2026, month: 9, runMonth: 202609, nextRunAt: '2026-10-05T00:00:00.000Z', now: dueNow });
        db.failJob('waiting', 'Approval pending');
        assert.equal(db.scheduleApprovalRetry('waiting', '2026-09-05T00:03:45Z'), '2026-09-06T00:00:00.000Z');
        db.close(); db = createDatabase(filename);
        const due = db.listDueApprovalRetries('2026-09-06T00:00:00.000Z')[0];
        assert.ok(due);
        assert.ok(db.claimApprovalRetry(due, 'retry-once', '2026-09-06T00:00:00.000Z'));
        assert.equal(db.claimApprovalRetry(due, 'duplicate', '2026-09-06T00:00:00.000Z'), null);
        db.failJob('retry-once', 'Approval pending');
        db.scheduleApprovalRetry('retry-once', '2026-09-06T00:00:00.000Z');
        const current = db.getMonthlyAutomation(user.id);
        db.saveMonthlyAutomation(user.id, settings, current.revision, '2026-09-06T01:00:00Z');
        assert.equal(db.getMonthlyAutomation(user.id).retryAt, null);
        assert.equal(db.listDueApprovalRetries('2026-09-07T00:00:00.000Z').length, 0);
    } finally {
        db.close();
        if (path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)) fs.rmSync(directory, { recursive: true });
    }
});
