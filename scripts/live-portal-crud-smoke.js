const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const request = require('supertest');
const { createApp } = require('../src/app');
const { PortalHttpClient } = require('../src/automation/portal-http-client');
const portal = require('../src/automation/portal');

const PRIMARY_KEYS = ['YEAR', 'SEQ', 'SCHO_CD', 'WORK_DEPT_CD', 'WORK_DT', 'STUDENT_NO'];
const READ_COMMANDS = new Set(['MenuAuth', 'Onload', 'OnLoad', 'FindWork', 'Chgdeptcd', 'Bef', 'List', 'Checkweek', 'Vacation', 'Holi']);

function stableRecords(snapshot) {
    return snapshot.assignments.flatMap(assignment => assignment.rawRecords.map(row =>
        Object.fromEntries([...PRIMARY_KEYS, 'ST_HHMI', 'END_HHMI', 'REMARK', 'CONFIRM_YN', 'CONFIRM_DT']
            .map(key => [key, String(row[key] || '')]))))
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

async function waitForJob(agent, id) {
    for (let attempt = 0; attempt < 180; attempt += 1) {
        const response = await agent.get(`/api/jobs/${id}`);
        assert.equal(response.status, 200);
        if (['succeeded', 'failed'].includes(response.body.job.status)) return response.body.job;
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error('Job result remains unknown. Do not repeat the write.');
}

async function main() {
    if (!process.argv.includes('--confirm-september-write-update-delete')) {
        throw new Error('Explicit approval required: --confirm-september-write-update-delete');
    }
    const root = path.resolve(__dirname, '..');
    const account = JSON.parse(fs.readFileSync(path.join(root, 'users', 'LSH.json'), 'utf8'));
    const target = { year: 2026, month: 9, date: '20260901', start: '1300', end: '1400',
        scholarshipCode: '50086', workDepartmentCode: '21095' };
    const marker = `API TEST DELETE ${crypto.randomBytes(8).toString('hex')}`;
    const updatedMarker = `${marker} EDITED`;
    const report = { status: 'starting', targetDate: target.date, marker,
        portalWrites: { insert: 0, update: 0, delete: 0 }, augustWrites: 0, checks: {} };
    const artifact = path.join(root, 'artifacts', 'portal-crud-roundtrip.json');
    const checkpoint = (status) => {
        report.status = status;
        fs.mkdirSync(path.dirname(artifact), { recursive: true });
        fs.writeFileSync(artifact, JSON.stringify(report, null, 2));
        console.log(JSON.stringify({ status, portalWrites: report.portalWrites }));
    };
    let authenticatedStudent;
    let insertedSequence;
    const fetchImpl = async (url, options = {}) => {
        const body = typeof options.body === 'string' && options.body.startsWith('{') ? JSON.parse(options.body) : null;
        const command = body?.param?.strCommand?.[0];
        if (command && !READ_COMMANDS.has(command)) {
            assert.equal(command, 'Save', 'Unexpected non-read command blocked');
            assert.equal(new URL(url).pathname, '/sub.SubWorkSchoE.do');
            assert.equal(body.data?.dsListMain?.length, 1);
            const row = body.data.dsListMain[0];
            assert.equal(String(row.WORK_DT), target.date, 'All dates except September 1 are write-blocked');
            assert.equal(String(row.STUDENT_NO), authenticatedStudent);
            assert.equal(String(row.SCHO_CD), target.scholarshipCode);
            assert.equal(String(row.WORK_DEPT_CD), target.workDepartmentCode);
            assert.notEqual(String(row.CONFIRM_YN).toUpperCase(), 'Y');
            assert.ok(!row.CONFIRM_DT);
            assert.equal(String(row.ST_HHMI), target.start);
            assert.ok([target.end, '1500'].includes(String(row.END_HHMI)));
            assert.ok([marker, updatedMarker].includes(row.REMARK), 'Only the unique test marker may be changed');
            const kind = { i: 'insert', u: 'update', d: 'delete' }[row.sts];
            assert.ok(kind);
            assert.equal(report.portalWrites[kind], 0, 'Automatic write retries are blocked');
            if (row.sts === 'i') {
                assert.equal(row.REMARK, marker);
                insertedSequence = String(row.SEQ);
            } else {
                assert.equal(String(row.SEQ), insertedSequence);
                for (const key of PRIMARY_KEYS) assert.equal(String(row[`${key}__origin`]), String(row[key]));
            }
            report.portalWrites[kind] += 1;
            checkpoint(`${kind}-request`);
        }
        return globalThis.fetch(url, options);
    };
    const clientFactory = () => new PortalHttpClient({ fetchImpl });
    const readSnapshot = async (month, selection) => {
        const client = clientFactory();
        try {
            await client.login(account.id, account.password);
            if (authenticatedStudent) assert.equal(client.identity.studentNo, authenticatedStudent);
            authenticatedStudent = client.identity.studentNo;
            return await portal.querySnapshot(client, 2026, month, selection);
        } finally { await client.close(); }
    };
    let baseline;
    let augustBefore;
    let runtime;
    let agent;
    let csrf;
    let attempted = false;
    let failure;
    try {
        augustBefore = await readSnapshot(8);
        report.augustCount = augustBefore.allRecords.length;
        baseline = await readSnapshot(9, target);
        report.baselineCount = baseline.allRecords.length;
        assert.equal(baseline.allRecords.some(row => row.date === target.date && row.start < '1500' && target.start < row.end), false,
            'Existing records overlap the test window; no insertion allowed');
        const schedule = { year: 2026, month: 9, content: marker, portalAssignment: target, regularRules: [],
            specialDates: { 1: { start: target.start, end: target.end } }, vacationDates: [], extraHolidayDates: [] };
        const checked = await portal.runPortalAutomation({ portalId: account.id, portalPassword: account.password,
            schedule, dryRun: true, clientFactory });
        assert.equal(checked.pendingCount, 1);
        assert.equal(checked.portalWrites, 0);
        report.checks.zeroWritePreflight = true;
        checkpoint('preflight-passed');
        runtime = createApp({ databasePath: ':memory:', masterKey: crypto.randomBytes(32),
            publicDir: path.join(root, 'public'), cookieSecure: false, trustProxy: false,
            sessionTtlMs: 3600000, automationConcurrency: 1, nodeEnv: 'test' }, {
            automation: Object.fromEntries(['queryPortalRecords', 'runPortalAutomation', 'mutatePortalRecord']
                .map(name => [name, options => portal[name]({ ...options, clientFactory })]))
        });
        agent = request.agent(runtime.app);
        const password = crypto.randomBytes(24).toString('base64url');
        let response = await agent.post('/api/signup').send({ username: 'crud-test', displayName: 'API test', password, passwordConfirmation: password });
        assert.equal(response.status, 201);
        csrf = response.body.csrfToken;
        response = await agent.put('/api/portal-credentials').set('X-CSRF-Token', csrf)
            .send({ portalId: account.id, portalPassword: account.password });
        assert.equal(response.status, 200);
        assert.equal((await agent.post('/api/logout').set('X-CSRF-Token', csrf)).status, 204);
        response = await agent.post('/api/login').send({ username: 'crud-test', password });
        assert.equal(response.status, 200);
        csrf = response.body.csrfToken;
        report.checks.signupEncryptedCredentialsLogin = true;
        response = await agent.put('/api/schedules/2026/9').set('X-CSRF-Token', csrf).send(schedule);
        assert.equal(response.status, 200);
        const submit = async () => {
            const queued = await agent.post('/api/jobs').set('X-CSRF-Token', csrf).send({ type: 'submit', year: 2026, month: 9 });
            assert.equal(queued.status, 202);
            const job = await waitForJob(agent, queued.body.job.id);
            assert.equal(job.status, 'succeeded', job.errorMessage || 'Portal job failed');
            return job.summary;
        };
        attempted = true;
        const inserted = await submit();
        assert.equal(inserted.insertedCount, 1);
        const original = inserted.records.find(row => row.content === marker);
        assert.ok(original);
        assert.equal(original.confirmed, false);
        report.checks.insertAndRead = true;
        checkpoint('insert-verified');
        const duplicate = await submit();
        assert.equal(duplicate.insertedCount, 0);
        assert.equal(duplicate.skippedCount, 1);
        assert.equal(report.portalWrites.insert, 1);
        report.checks.duplicateSkipped = true;
        const changes = { start: target.start, end: '1500', content: updatedMarker };
        const mutationUrl = '/api/portal-records/2026/9/mutate';
        const payload = { operation: 'update', record: original, changes, confirmed: true };
        assert.equal((await agent.post(mutationUrl).send(payload)).status, 403);
        assert.equal((await agent.post(mutationUrl).set('X-CSRF-Token', csrf).send({ ...payload, confirmed: false })).status, 400);
        report.checks.csrfAndConsentProtected = true;
        response = await agent.post(mutationUrl).set('X-CSRF-Token', csrf).send(payload);
        assert.equal(response.status, 200, response.body.error || 'Update API failed');
        assert.equal(response.body.job.summary.verified, true);
        const edited = response.body.job.summary.records.find(row => row.content === updatedMarker);
        assert.equal(edited?.start, target.start);
        assert.equal(edited?.end, changes.end);
        assert.equal(edited?.sequence, original.sequence);
        report.checks.timeAndContentUpdate = true;
        checkpoint('update-verified');
        response = await agent.post(mutationUrl).set('X-CSRF-Token', csrf).send(payload);
        assert.equal(response.status, 422);
        assert.match(response.body.error, /조회 이후/);
        assert.equal(report.portalWrites.update, 1);
        report.checks.staleRecordProtected = true;
        response = await agent.get('/api/portal-records/2026/9');
        assert.equal(response.status, 200);
        assert.ok(response.body.snapshot.records.some(row => row.content === updatedMarker && row.end === changes.end));
        report.checks.calendarCacheUpdated = true;
    } catch (error) {
        failure = error;
        report.error = error.message;
    } finally {
        if (attempted && baseline) {
            try {
                const current = await readSnapshot(9, target);
                const matches = current.allRecords.filter(row => [marker, updatedMarker].includes(row.content));
                assert.ok(matches.length <= 1, 'Multiple marker records found; manual review required');
                if (matches.length === 1) {
                    const response = await agent.post('/api/portal-records/2026/9/mutate').set('X-CSRF-Token', csrf)
                        .send({ operation: 'delete', record: matches[0], confirmed: true });
                    assert.equal(response.status, 200, response.body.error || 'Delete API failed');
                    assert.equal(response.body.job.summary.verified, true);
                    report.checks.deleteAndRead = true;
                }
                const after = await readSnapshot(9, target);
                assert.deepEqual(stableRecords(after), stableRecords(baseline), 'September differs from baseline');
                report.finalCount = after.allRecords.length;
                report.checks.septemberRestored = true;
                const cached = await agent.get('/api/portal-records/2026/9');
                assert.ok(!cached.body.snapshot?.records.some(row => [marker, updatedMarker].includes(row.content)));
                report.checks.calendarCacheCleaned = true;
                checkpoint('cleanup-verified');
            } catch (error) {
                report.cleanupError = error.message;
                failure = new Error(`Test record cleanup needs attention: ${error.message}`);
            }
        }
        if (augustBefore) {
            try {
                const augustAfter = await readSnapshot(8);
                assert.deepEqual(stableRecords(augustAfter), stableRecords(augustBefore), 'August differs from read-only baseline');
                report.checks.augustReadOnlyUnchanged = true;
            } catch (error) { report.augustVerificationError = error.message; failure ||= error; }
        }
        runtime?.db.close();
        checkpoint(failure ? 'failed' : 'passed-cleanup-verified');
    }
    console.log(JSON.stringify(report, null, 2));
    if (failure) throw failure;
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
