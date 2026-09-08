const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createErrorLog } = require('../src/lib/error-log');
const { JobQueue } = require('../src/lib/job-queue');

function tempDir(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worklog-errorlog-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

const readLines = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));

test('failures are appended as one readable line per error and mirrored to the server log', (t) => {
    const dir = tempDir(t);
    const filePath = path.join(dir, 'nested', 'error.log');
    const mirrored = [];
    const record = createErrorLog({ filePath, now: () => new Date('2026-09-08T10:11:12Z'), mirror: (line) => mirrored.push(line) });

    const error = Object.assign(new Error('20260908: 포털에 해당 연도 주차가 아직 생성되지 않았습니다.'), { code: 'PORTAL_WEEK' });
    record('job', error, { jobId: 'job-1', userId: 7, type: 'submit', year: 2026, month: 9 });
    record('request', new Error('두 번째 오류'), { method: 'POST', path: '/api/jobs' });

    const lines = readLines(filePath);
    assert.equal(lines.length, 2);
    assert.deepEqual(mirrored.map((line) => JSON.parse(line).message), lines.map((entry) => entry.message));
    assert.match(lines[0].message, /주차가 아직 생성되지/);
    assert.deepEqual([lines[0].time, lines[0].scope, lines[0].code, lines[0].jobId, lines[0].userId, lines[0].year, lines[0].month],
        ['2026-09-08T10:11:12.000Z', 'job', 'PORTAL_WEEK', 'job-1', 7, 2026, 9]);
    assert.ok(lines[0].stack.includes('error-log.test.js'));
    assert.equal(lines[1].scope, 'request');
    assert.equal(lines[1].path, '/api/jobs');
});

test('the log keeps one rotation and never fails the work that reported the error', (t) => {
    const dir = tempDir(t);
    const filePath = path.join(dir, 'error.log');
    const record = createErrorLog({ filePath, maxBytes: 300, mirror: () => {} });
    for (let index = 0; index < 12; index += 1) record('job', new Error(`오류 ${index}`), { jobId: `job-${index}` });
    assert.ok(fs.existsSync(`${filePath}.1`));
    assert.ok(fs.statSync(filePath).size <= 300 + 400);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['error.log', 'error.log.1']);
    assert.equal(readLines(filePath).at(-1).jobId, 'job-11');

    const warnings = [];
    const blocked = path.join(dir, 'blocked');
    fs.writeFileSync(blocked, 'not a directory');
    const broken = createErrorLog({ filePath: path.join(blocked, 'error.log'), mirror: (line) => warnings.push(line) });
    assert.equal(broken('job', new Error('디스크 오류에도 계속 진행')).message, '디스크 오류에도 계속 진행');
    assert.equal(broken('job', new Error('두 번째')).message, '두 번째');
    assert.equal(warnings.filter((line) => line.startsWith('error log write failed')).length, 1);

    const noFile = createErrorLog({ mirror: (line) => warnings.push(line) });
    assert.equal(noFile('job', new Error('파일 없이도 기록')).scope, 'job');
    assert.ok(warnings.some((line) => line.includes('파일 없이도 기록')));
});

test('a failed job writes the same message to the job log and the server error log', async (t) => {
    const dir = tempDir(t);
    const filePath = path.join(dir, 'error.log');
    const logs = [];
    const db = {
        markJobRunning: () => {}, updateJobProgress: () => {}, completeJob: () => {},
        getJob: (id) => ({ id }), failJob: (id, message) => logs.push(['failed', message]),
        addJobLog: (id, level, message) => logs.push([level, message])
    };
    const record = createErrorLog({ filePath, mirror: () => {} });
    let recorded;
    const written = new Promise((resolve) => { recorded = resolve; });
    const queue = new JobQueue({ db, logError: (...args) => { const entry = record(...args); recorded(); return entry; },
        executeJob: async () => { throw new Error('포털 방학 구분 값("")을 확인하지 못했습니다.'); } });
    queue.enqueue({ id: 'job-9', userId: 3, type: 'submit', year: 2026, month: 9 });
    await written;

    const entry = readLines(filePath).at(-1);
    assert.equal(entry.scope, 'job');
    assert.deepEqual([entry.jobId, entry.userId, entry.type, entry.year, entry.month, entry.scheduled],
        ['job-9', 3, 'submit', 2026, 9, false]);
    assert.ok(logs.some(([level, message]) => level === 'error' && message === entry.message));
});
