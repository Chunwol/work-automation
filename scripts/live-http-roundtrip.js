const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const request = require('supertest');
const { createApp } = require('../src/app');
const { PortalHttpClient } = require('../src/automation/portal-http-client');
const { querySnapshot } = require('../src/automation/portal');

const PRIMARY_KEYS = ['YEAR', 'SEQ', 'SCHO_CD', 'WORK_DEPT_CD', 'WORK_DT', 'STUDENT_NO'];

function deletionPayload(client, assignment, row, expected) {
    if (String(row.STUDENT_NO) !== client.identity.studentNo || String(row.CONFIRM_YN).toUpperCase() === 'Y'
        || row.REMARK !== expected.marker || String(row.WORK_DT) !== expected.date
        || String(row.ST_HHMI) !== expected.start || String(row.END_HHMI) !== expected.end
        || String(row.SCHO_CD) !== expected.scholarshipCode || String(row.WORK_DEPT_CD) !== expected.workDepartmentCode
        || client.identity.canUpdate !== 'Y') throw new Error('테스트 원본과 일치하는 본인 미승인 행이 아니므로 삭제하지 않았습니다.');
    const deleted = { ...row, sts: 'd' };
    for (const key of PRIMARY_KEYS) {
        if (!String(row[key] || '')) throw new Error('삭제할 테스트 행의 기본키가 없습니다.');
        deleted[`${key}__origin`] = String(row[key]);
    }
    return {
        param: {
            strCommand: ['Save'], strParentKeyValue9: [client.parentKey],
            _PATAM_AS_TABLE: ['subworkmaster,sub_work_master,dsListMain'],
            subworkmasterKEYVALUE: ['YEAR,SEQ,SCHO_CD,WORK_DEPT_CD,WORK_DT,STUDENT_NO'],
            subworkmasterKEYDATA: ['confirm_yn,confirm_dt,st_hhmi,end_hhmi,work_mi1,remark']
        }, data: { requestKey: assignment.requestKey, dsListMain: [deleted] }
    };
}

function stableRecords(snapshot) {
    return snapshot.assignments.flatMap((assignment) => assignment.rawRecords.map((row) =>
        Object.fromEntries([...PRIMARY_KEYS, 'ST_HHMI', 'END_HHMI', 'REMARK', 'CONFIRM_YN', 'CONFIRM_DT'].map((key) => [key, String(row[key] || '')]))))
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

async function waitForJob(agent, id) {
    for (let index = 0; index < 120; index += 1) {
        const response = await agent.get(`/api/jobs/${id}`);
        assert.equal(response.status, 200);
        if (['succeeded', 'failed'].includes(response.body.job.status)) return response.body.job;
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error('테스트 저장 작업 완료를 확인하지 못했습니다.');
}

async function main() {
    if (!process.argv.includes('--confirm-live-write-and-delete')) throw new Error('실제 일지 1건 등록·삭제 승인이 필요합니다. --confirm-live-write-and-delete');
    const root = path.resolve(__dirname, '..');
    const account = JSON.parse(fs.readFileSync(path.join(root, 'users', 'LSH.json'), 'utf8'));
    const client = new PortalHttpClient();
    const target = { year: 2026, month: 9, date: '20260901', start: '1300', end: '1400',
        scholarshipCode: '50086', workDepartmentCode: '21095', marker: `API test DELETE ${crypto.randomBytes(8).toString('hex')}` };
    const artifact = path.join(root, 'artifacts', 'portal-http-roundtrip.json');
    const report = { ...target, status: 'preflight', portalInsertRequests: 0, portalDeleteRequests: 0, deleted: false };
    const checkpoint = () => {
        fs.mkdirSync(path.dirname(artifact), { recursive: true });
        fs.writeFileSync(artifact, JSON.stringify(report, null, 2));
    };
    let baseline;
    let runtime;
    let attempted = false;
    let failure;
    try {
        await client.login(account.id, account.password);
        baseline = await querySnapshot(client, target.year, target.month, target);
        if (baseline.allRecords.some((row) => row.date === target.date && row.start < target.end && target.start < row.end)) {
            throw new Error('테스트 시간에 기존 기록이 있어 저장하지 않았습니다.');
        }
        report.baselineCount = baseline.allRecords.length;
        checkpoint();
        runtime = createApp({ databasePath: ':memory:', masterKey: crypto.randomBytes(32),
            publicDir: path.join(root, 'public'), cookieSecure: false, trustProxy: false,
            sessionTtlMs: 3600000, automationConcurrency: 1, nodeEnv: 'test' });
        const agent = request.agent(runtime.app);
        const password = crypto.randomBytes(24).toString('base64url');
        let response = await agent.post('/api/signup').send({ username: 'roundtrip-test', displayName: 'API 점검', password, passwordConfirmation: password });
        assert.equal(response.status, 201);
        assert.equal(response.body.user.role, 'user');
        const csrf = response.body.csrfToken;
        response = await agent.put('/api/portal-credentials').set('X-CSRF-Token', csrf).send({ portalId: account.id, portalPassword: account.password });
        assert.equal(response.status, 200);
        response = await agent.put('/api/schedules/2026/9').set('X-CSRF-Token', csrf).send({
            content: target.marker, portalAssignment: target, regularRules: [],
            specialDates: { 1: { start: target.start, end: target.end } }, vacationDates: [], extraHolidayDates: []
        });
        assert.equal(response.status, 200);
        report.status = 'save-requested';
        attempted = true;
        checkpoint();
        response = await agent.post('/api/jobs').set('X-CSRF-Token', csrf).send({ type: 'submit', year: 2026, month: 9 });
        assert.equal(response.status, 202);
        const job = await waitForJob(agent, response.body.job.id);
        if (job.status !== 'succeeded') throw new Error(job.errorMessage || 'API 저장 테스트 실패');
        assert.equal(job.summary.insertedCount, 1);
        report.portalInsertRequests = 1;
        report.status = 'saved-and-verified';
        report.saveSummary = job.summary;
        checkpoint();
    } catch (error) {
        failure = error;
    } finally {
        if (attempted && baseline) {
            try {
                // Reauthenticate in case the web job replaced the school's SSO session.
                await client.close();
                await client.login(account.id, account.password);
                const snapshot = await querySnapshot(client, target.year, target.month, target);
                const matches = snapshot.selected.rawRecords.filter((row) => row.REMARK === target.marker);
                if (matches.length > 1) throw new Error('테스트 표식 행이 여러 개여서 자동 삭제하지 않았습니다.');
                if (matches.length === 1) {
                    report.sequence = String(matches[0].SEQ);
                    const payload = deletionPayload(client, snapshot.selected, matches[0], target);
                    report.status = 'delete-requested';
                    report.portalDeleteRequests += 1;
                    checkpoint();
                    try { await client.json('/sub.SubWorkSchoE.do', payload, 'Save'); } catch { /* Verify before deciding whether deletion failed. */ }
                }
                const after = await querySnapshot(client, target.year, target.month, target);
                if (after.allRecords.some((row) => row.content === target.marker)) throw new Error('테스트 기록 삭제를 확인하지 못했습니다.');
                assert.deepEqual(stableRecords(after), stableRecords(baseline), '기존 일지 상태가 테스트 전과 다릅니다.');
                report.deleted = true;
                report.finalCount = after.allRecords.length;
                report.existingRecordsUnchanged = true;
                report.status = failure ? 'test-failed-cleanup-verified' : 'passed-cleanup-verified';
                checkpoint();
            } catch (error) {
                report.status = 'cleanup-needs-attention';
                report.cleanupError = error.message;
                checkpoint();
                failure = new Error(`테스트 행 삭제 확인이 필요합니다: ${error.message}`);
            }
        }
        await client.close();
        runtime?.db.close();
    }
    console.log(JSON.stringify(report, null, 2));
    if (failure) throw failure;
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { deletionPayload };
