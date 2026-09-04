const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const request = require('supertest');
const { createApp } = require('../src/app');
const { calculateTotalWorkMinutes, formatMinutes } = require('../src/lib/schedule');

const rootDir = path.resolve(__dirname, '..');
const credentialPath = path.join(rootDir, 'users', 'LSH.json');

async function waitForJob(agent, jobId, timeoutMs = 60_000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        const response = await agent.get(`/api/jobs/${jobId}`);
        assert.equal(response.status, 200);
        if (['succeeded', 'failed'].includes(response.body.job.status)) return response.body.job;
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error('포털 조회 작업이 제한 시간 안에 끝나지 않았습니다.');
}

async function main() {
    if (!fs.existsSync(credentialPath)) throw new Error('users/LSH.json 파일이 없습니다.');
    const portal = JSON.parse(fs.readFileSync(credentialPath, 'utf8'));
    const config = {
        databasePath: ':memory:',
        masterKey: crypto.randomBytes(32),
        publicDir: path.join(rootDir, 'public'),
        cookieSecure: false,
        trustProxy: false,
        sessionTtlMs: 60 * 60 * 1000,
        automationConcurrency: 1,
        automationHeadless: true,
        nodeEnv: 'test'
    };
    const runtime = createApp(config);
    const agent = request.agent(runtime.app);

    try {
        const password = crypto.randomBytes(24).toString('base64url');
        let response = await agent.post('/api/signup').send({
            username: 'live-smoke-member',
            displayName: '조회 점검',
            password, passwordConfirmation: password
        });
        assert.equal(response.status, 201);
        const csrfToken = response.body.csrfToken;

        response = await agent.put('/api/portal-credentials').set('X-CSRF-Token', csrfToken).send({
            portalId: portal.id,
            portalPassword: portal.password
        });
        assert.equal(response.status, 200);
        assert.equal(response.body.configured, true);

        response = await agent.post('/api/jobs').set('X-CSRF-Token', csrfToken).send({
            type: 'query',
            year: 2026,
            month: 6
        });
        assert.equal(response.status, 202);

        const job = await waitForJob(agent, response.body.job.id);
        if (job.status !== 'succeeded') throw new Error(job.errorMessage || '포털 조회 작업 실패');
        assert.equal(job.summary.count, 17);
        assert.ok(Array.isArray(job.summary.assignments));
        assert.ok(job.summary.assignments.length >= 1);
        assert.ok(job.summary.assignments.every((assignment) => assignment.scholarshipCode && assignment.workDepartmentCode));
        assert.ok(job.summary.assignments.every((assignment) => ['Y', 'N', ''].includes(assignment.limitYn)));
        assert.equal(calculateTotalWorkMinutes(job.summary.records), 93 * 60);

        console.log(JSON.stringify({
            ok: true,
            flow: 'public signup -> encrypted credential -> job queue -> HTTP SSO -> List API',
            year: 2026,
            month: 6,
            count: job.summary.count,
            assignments: job.summary.assignments.map((assignment) => ({
                scholarshipCode: assignment.scholarshipCode,
                scholarshipName: assignment.scholarshipName,
                workDepartmentCode: assignment.workDepartmentCode,
                workDepartmentName: assignment.workDepartmentName,
                startDate: assignment.startDate,
                endDate: assignment.endDate,
                recordCount: assignment.recordCount,
                totalWorkTime: assignment.totalWorkTime,
                limitYn: assignment.limitYn
            })),
            total: formatMinutes(calculateTotalWorkMinutes(job.summary.records)),
            persistentCredentialStorage: false
        }, null, 2));
    } finally {
        runtime.db.close();
    }
}

main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});
