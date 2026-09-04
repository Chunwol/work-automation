const assert = require('node:assert/strict');
const test = require('node:test');
const { PortalHttpClient, checkedUrl } = require('../src/automation/portal-http-client');
const { runPortalAutomation, queryPortalRecords, portalMinutes, mutatePortalRecord, mapPortalRecord } = require('../src/automation/portal');
const { deletionPayload } = require('../scripts/live-http-roundtrip');

class FakePortal extends PortalHttpClient {
    constructor() {
        super();
        this.identity = { studentNo: 'test-student', name: 'Test', canUpdate: 'Y' };
        this.catalog = {
            listSchoCd: [{ SCHO_CD: '50086', SCHO_NM: 'National' }, { SCHO_CD: '50064', SCHO_NM: 'General' }],
            listWorkDeptCd: [{ DEPT_CD: '21095', DEPT_NM: 'Computing' }, { DEPT_CD: '31001', DEPT_NM: 'Library' }]
        };
        this.approved = [{ SCHO_CD: '50086', WORK_DEPT_CD: '21095', ST_DT: '20260901', END_DT: '20260930' }];
        this.records = [];
        this.before = { limit_yn: 'N', sumwork_smtcd: '0', sumwork2_smtcd: '0', bef: '0000', befcnt: '26' };
        this.calls = [];
        this.saves = [];
        this.changes = [];
        this.vacation = 'Y';
        this.holidays = [];
        this.mode = 'ok';
    }
    async login() { return this; }
    async close() { this.closed = true; }
    async command(command, key) {
        this.calls.push(command);
        if (command === 'FindWork') return { listStdno: structuredClone(this.approved) };
        if (command === 'Chgdeptcd') return this.catalog;
        if (command === 'Bef') return { dmMain: this.before };
        if (command === 'List') {
            if (this.mode === 'malformed') return {};
            return { listMain: structuredClone(this.records.filter((row) => row.SCHO_CD === key.strSchoCd && row.WORK_DEPT_CD === key.strWorkDeptCd)),
                listStdt: [{ STUDENT_NO: 'test-student', STUDENT_YEAR: '2', DAN_CD: '1', DEPT_CD: 'C' }] };
        }
        if (command === 'Checkweek') return { dmMain: { week_cnt: '27', CheckDate: '3' } };
        if (command === 'Vacation') return { dmMain: { strRemark: this.vacation } };
        if (command === 'Holi') return { listHoliday: this.holidays.map((date) => ({ HOLIDAY: date })) };
        throw new Error(`unexpected ${command}`);
    }
    async save(key, row) {
        this.saves.push({ key, row });
        if (this.mode !== 'reject') this.records.push({ ...row, REMARK: this.mode === 'wrong-content' ? 'changed' : row.REMARK });
        if (this.mode === 'timeout' || this.mode === 'reject') throw new Error('timeout');
        return { dmMain: {} };
    }
    async change(key, row) {
        this.changes.push({ key, row });
        if (this.mode === 'reject') throw new Error('denied');
        const index = this.records.findIndex((item) => item.WORK_DT === row.WORK_DT && item.SEQ === row.SEQ && item.SCHO_CD === row.SCHO_CD);
        if (row.sts === 'd') this.records.splice(index, 1);
        else this.records[index] = { ...row };
        if (this.mode === 'timeout') throw new Error('timeout');
        return {};
    }
}

function options(client, overrides = {}) {
    return { portalId: 'test', portalPassword: 'not-a-real-password', clientFactory: () => client,
        schedule: { year: 2026, month: 9, content: '실습실 점검', portalAssignment: { scholarshipCode: '50086', workDepartmentCode: '21095' },
            regularRules: [], specialDates: { 1: { start: '1300', end: '1700' } }, vacationDates: [], extraHolidayDates: [] }, ...overrides };
}

test('HTTP redirects carry scoped cookies but do not replay passwords across origins', async () => {
    const requests = [];
    const client = new PortalHttpClient({ fetchImpl: async (url, init) => {
        requests.push({ url, ...init });
        return requests.length === 1 ? new Response(null, { status: 302, headers: { location: 'https://sso.dongyang.ac.kr/next', 'set-cookie': 'local=secret; Secure; HttpOnly; Path=/' } })
            : new Response('ok');
    } });
    await client.request('https://portal.dongyang.ac.kr/login', { method: 'POST', body: 'password=secret' });
    assert.equal(requests[1].method, 'GET');
    assert.equal(requests[1].body, undefined);
    assert.equal(requests[1].headers.Cookie, undefined);
    assert.match(await client.jar.getCookieString('https://portal.dongyang.ac.kr/'), /local=secret/);
    const unsafe = new PortalHttpClient({ fetchImpl: async () => new Response(null, { status: 307, headers: { location: 'https://sso.dongyang.ac.kr/next' } }) });
    await assert.rejects(unsafe.request('https://portal.dongyang.ac.kr/login', { method: 'POST', body: 'secret' }), /재전송/);
    assert.throws(() => checkedUrl('https://evil.example/'), /허용되지/);
    assert.throws(() => checkedUrl('http://portal.dongyang.ac.kr/'), /허용되지/);
});

test('JSON error responses and unapproved command names fail closed', async () => {
    const client = new PortalHttpClient({ fetchImpl: async () => new Response(JSON.stringify({ dmMain: { errMessage: 'denied' } })) });
    await assert.rejects(client.command('List', {}), /거절/);
    await assert.rejects(client.command('Find', {}), /허용되지/);
    await assert.rejects(client.command('Save', {}), /허용되지/);
    await assert.rejects(client.save({}, { sts: 'd' }), /신규/);
});

test('Save payload matches official insert metadata and remains bound to the student', async () => {
    let sent;
    const client = new PortalHttpClient({ fetchImpl: async (url, init) => {
        sent = JSON.parse(init.body);
        return new Response('{}');
    } });
    client.identity = { studentNo: 'self', name: 'Self', canUpdate: 'Y' };
    await client.save({ strStudentNo: 'self' }, { STUDENT_NO: 'self', sts: 'i', CONFIRM_YN: '', CONFIRM_DT: '' });
    assert.deepEqual(sent.param.strCommand, ['Save']);
    assert.deepEqual(sent.param._PATAM_AS_TABLE, ['subworkmaster,sub_work_master,dsListMain']);
    assert.equal(sent.data.dsListMain.length, 1);
    await assert.rejects(client.save({ strStudentNo: 'other' }, { STUDENT_NO: 'self', sts: 'i' }), /본인/);
    await assert.rejects(client.save({ strStudentNo: 'self' }, { STUDENT_NO: 'self', sts: 'i', CONFIRM_YN: 'Y' }), /미승인/);
});

test('academic year and HHMM semester arithmetic use correct boundaries', () => {
    const client = new FakePortal();
    assert.equal(client.requestKey(2027, 1).strYear, '2026');
    assert.equal(client.requestKey(2026, 3).strYear, '2026');
    assert.equal(portalMinutes('63930'), 639 * 60 + 30);
    assert.throws(() => portalMinutes('63960'));
    assert.throws(() => portalMinutes(undefined));
});

test('temporary live-test cleanup only deletes the exact unconfirmed test record', () => {
    const client = new FakePortal();
    const expected = { marker: 'unique-test', date: '20260901', start: '1300', end: '1400', scholarshipCode: '50086', workDepartmentCode: '21095' };
    const row = { YEAR: '2026', SEQ: '1', STUDENT_NO: 'test-student', SCHO_CD: '50086', WORK_DEPT_CD: '21095',
        WORK_DT: '20260901', ST_HHMI: '1300', END_HHMI: '1400', REMARK: 'unique-test', CONFIRM_YN: 'N' };
    const result = deletionPayload(client, { requestKey: {} }, row, expected);
    assert.equal(result.data.dsListMain[0].sts, 'd');
    assert.equal(result.data.dsListMain[0].SEQ__origin, '1');
    for (const changes of [{ CONFIRM_YN: 'Y' }, { REMARK: 'existing work' }, { STUDENT_NO: 'other' }, { SEQ: '' }]) {
        assert.throws(() => deletionPayload(client, {}, { ...row, ...changes }, expected));
    }
});

test('public query supports multiple approved assignments and strips internal identity data', async () => {
    const client = new FakePortal();
    client.approved.push({ SCHO_CD: '50064', WORK_DEPT_CD: '31001', ST_DT: '20260901', END_DT: '20260930' });
    const result = await queryPortalRecords({ ...options(client), year: 2026, month: 9 });
    assert.equal(result.assignments.length, 2);
    assert.equal(JSON.stringify(result).includes('test-student'), false);
    assert.equal(result.transport, 'http');
    assert.equal(client.closed, true);
});

test('dry-run consults all date rules and never calls Save', async () => {
    const client = new FakePortal();
    const result = await runPortalAutomation(options(client, { dryRun: true }));
    assert.equal(result.pendingCount, 1);
    assert.equal(result.portalWrites, 0);
    for (const name of ['FindWork', 'Chgdeptcd', 'Bef', 'List', 'Checkweek', 'Vacation', 'Holi']) assert.ok(client.calls.includes(name));
    assert.equal(client.saves.length, 0);
});

test('insert verifies actual saved content, and retry skips the exact existing time', async () => {
    const client = new FakePortal();
    let result = await runPortalAutomation(options(client));
    assert.equal(result.insertedCount, 1);
    assert.equal(client.saves[0].row.sts, 'i');
    assert.equal(client.saves[0].row.WORK_MI, '0400');
    assert.equal(client.saves[0].row.WORK_MI1, '4시간00분');
    assert.equal(client.saves[0].row.STUDENT_NO__origin, 'test-student');
    result = await runPortalAutomation(options(client));
    assert.equal(result.skippedCount, 1);
    assert.equal(client.saves.length, 1);
});

test('ambiguous write response is re-read, not blindly retried', async () => {
    const client = new FakePortal();
    client.mode = 'timeout';
    assert.equal((await runPortalAutomation(options(client))).insertedCount, 1);
    assert.equal(client.saves.length, 1);
    for (const mode of ['reject', 'wrong-content']) {
        const rejected = new FakePortal();
        rejected.mode = mode;
        await assert.rejects(runPortalAutomation(options(rejected)), /정확한 일지/);
        assert.equal(rejected.saves.length, 1);
    }
});

test('semester limit Y is an exemption, not a refusal', async () => {
    const client = new FakePortal();
    client.before.sumwork_smtcd = '63930';
    await assert.rejects(runPortalAutomation(options(client)), /640시간/);
    client.before.limit_yn = 'Y';
    assert.equal((await runPortalAutomation(options(client))).insertedCount, 1);
});

test('all pending dates are validated before the first write', async () => {
    const client = new FakePortal();
    const opts = options(client);
    opts.schedule.specialDates[2] = { start: '0900', end: '1800' };
    await assert.rejects(runPortalAutomation(opts), /8시간/);
    assert.equal(client.saves.length, 0);
});

test('split shifts save separately with unique sequence keys, exclude lunch and skip duplicates on retry', async () => {
    const client = new FakePortal();
    const opts = options(client);
    opts.schedule.specialDates[1] = [{ start: '0900', end: '1200' }, { start: '1300', end: '1600' }, { start: '2200', end: '2400' }];
    const result = await runPortalAutomation(opts);
    assert.equal(result.plannedCount, 3);
    assert.equal(result.insertedCount, 3);
    assert.deepEqual(client.saves.map(item => item.row.SEQ), ['1', '2', '3']);
    assert.deepEqual(client.saves.map(item => item.row.WORK_MI), ['0300', '0300', '0200']);
    assert.equal((await runPortalAutomation(opts)).skippedCount, 3);
    assert.equal(client.saves.length, 3);
});

test('ongoing and future work can be pre-entered, verified, edited and skipped on retry', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-04T10:00:00+09:00').getTime() });
    const client = new FakePortal();
    const opts = options(client);
    opts.schedule.specialDates = {
        4: [{ start: '0900', end: '1200' }, { start: '1300', end: '1700' }],
        8: [{ start: '0900', end: '1200' }, { start: '1300', end: '1700' }],
        30: { start: '2200', end: '2400' }
    };
    const dryRun = await runPortalAutomation({ ...opts, dryRun: true });
    assert.equal(dryRun.pendingCount, 5);
    assert.equal(dryRun.portalWrites, 0);
    assert.equal(client.saves.length, 0);
    const result = await runPortalAutomation(opts);
    assert.equal(result.insertedCount, 5);
    assert.equal(result.verifiedCount, 5);
    assert.deepEqual(client.saves.map(item => [item.row.WORK_DT, item.row.END_HHMI]), [
        ['20260904', '1200'], ['20260904', '1700'], ['20260908', '1200'], ['20260908', '1700'], ['20260930', '2400']
    ]);
    assert.equal((await runPortalAutomation(opts)).skippedCount, 5);
    assert.equal(client.saves.length, 5);
    const record = mapPortalRecord(client.records.find(row => row.WORK_DT === '20260908' && row.ST_HHMI === '1300'));
    const updated = await mutatePortalRecord({ ...opts, year: 2026, month: 9, record, operation: 'update',
        changes: { start: '1300', end: '1600', content: 'Updated planned work' } });
    assert.equal(updated.verified, true);
    assert.equal(client.changes.length, 1);
    assert.equal(client.changes[0].row.END_HHMI, '1600');
    for (const name of ['FindWork', 'Bef', 'List', 'Checkweek', 'Vacation', 'Holi']) assert.ok(client.calls.includes(name));
});

test('advance entries still honor approval periods, holidays and portal rejection without blind retry', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-04T10:00:00+09:00').getTime() });
    for (const [arrange, expected, writes] of [
        [client => { client.approved[0].END_DT = '20260907'; }, /기간 밖/, 0],
        [client => { client.holidays = ['20260908']; }, /공휴일/, 0],
        [client => { client.mode = 'reject'; }, /정확한 일지/, 1]
    ]) {
        const client = new FakePortal();
        const opts = options(client);
        opts.schedule.specialDates = { 8: { start: '0900', end: '1700' } };
        arrange(client);
        await assert.rejects(runPortalAutomation(opts), expected);
        assert.equal(client.saves.length, writes);
        assert.equal(client.records.length, 0);
    }
});

test('invalid rules, changed responses and approval gaps block writes', async () => {
    const cases = [
        [(c, o) => { o.schedule.specialDates[1] = { start: '1305', end: '1405' }; }, /10분/],
        [(c, o) => { o.schedule.specialDates[1] = { start: '1300', end: '1330' }; }, /최소 1시간/],
        [(c, o) => { o.schedule.specialDates[1] = { start: '1300', end: '1410' }; }, /30분/],
        [(c) => { c.holidays = ['20260901']; }, /공휴일/],
        [(c) => { c.mode = 'malformed'; }, /listMain/],
        [(c) => { c.approved[0].ST_DT = '20260902'; }, /기간 밖/],
        [(c) => { c.identity.canUpdate = 'N'; }, /저장 권한/],
        [(c, o) => { o.schedule.content = '가'.repeat(34); }, /100바이트/],
        [(c) => { c.approved[0].STUDENT_NO = 'other'; }, /다른 학생/],
        [(c) => { c.approved = []; }, /승인 배정/]
    ];
    for (const [arrange, expected] of cases) {
        const client = new FakePortal();
        const opts = options(client);
        arrange(client, opts);
        await assert.rejects(runPortalAutomation(opts), expected);
        assert.equal(client.saves.length, 0);
        if (client.calls.length) assert.equal(client.closed, true);
    }
});

test('overlapping work in another approved department is blocked', async () => {
    const client = new FakePortal();
    client.approved.push({ SCHO_CD: '50064', WORK_DEPT_CD: '31001', ST_DT: '20260901', END_DT: '20260930' });
    client.records.push({ STUDENT_NO: 'test-student', SCHO_CD: '50064', WORK_DEPT_CD: '31001', WORK_DT: '20260901', ST_HHMI: '1200', END_HHMI: '1400' });
    await assert.rejects(runPortalAutomation(options(client)), /겹칩니다/);
    assert.equal(client.saves.length, 0);
});

test('term weekly cap includes previous-month hours when configured by portal', async () => {
    const client = new FakePortal();
    client.catalog.listSchoCd[0].NAT_AMT = '1';
    client.vacation = 'N';
    client.before.befcnt = '27';
    client.before.bef = '1700';
    await assert.rejects(runPortalAutomation(options(client)), /주간 근로시간/);
    assert.equal(client.saves.length, 0);
});

test('HTTP update and delete transport requires original keys and unconfirmed ownership', async () => {
    const client = new PortalHttpClient({ fetchImpl: async () => new Response('{}') });
    client.identity = { studentNo: 'self', canUpdate: 'Y' };
    const row = { YEAR: '2026', SEQ: '1', SCHO_CD: '50086', WORK_DEPT_CD: '21095', WORK_DT: '20260901', STUDENT_NO: 'self', sts: 'd' };
    for (const key of Object.keys(row).filter(key => key !== 'sts')) row[`${key}__origin`] = row[key];
    const key = { strStudentNo: 'self', strSchoCd: '50086', strWorkDeptCd: '21095' };
    await client.change(key, row);
    await client.change(key, { ...row, sts: 'u' });
    await assert.rejects(client.change(key, { ...row, CONFIRM_YN: 'Y' }), /미확인/);
    await assert.rejects(client.change(key, { ...row, SEQ__origin: '2' }), /원본/);
    await assert.rejects(client.change(key, { ...row, WORK_DEPT_CD: 'other' }), /원본/);
});

test('update revalidates hours, subtracts the original semester duration and verifies; delete removes only that record', async () => {
    const client = new FakePortal();
    await runPortalAutomation(options(client));
    client.before.sumwork_smtcd = '64000';
    let record = mapPortalRecord(client.records[0]);
    let result = await mutatePortalRecord({ ...options(client), year: 2026, month: 9, record, operation: 'update',
        changes: { start: '1400', end: '1700', content: 'Changed work' } });
    assert.equal(result.verified, true);
    assert.equal(client.changes[0].row.sts, 'u');
    assert.equal(client.changes[0].row.WORK_MI, '0300');
    record = result.records[0];
    result = await mutatePortalRecord({ ...options(client), year: 2026, month: 9, record, operation: 'delete' });
    assert.equal(result.records.length, 0);
    assert.equal(client.changes.length, 2);
    assert.equal(client.changes[1].row.sts, 'd');
});

test('portal mutation rejects confirmed/stale records and verifies ambiguous deletes without retry', async () => {
    const client = new FakePortal();
    await runPortalAutomation(options(client));
    const record = mapPortalRecord(client.records[0]);
    const input = { ...options(client), year: 2026, month: 9, record, operation: 'delete' };
    client.records[0].CONFIRM_YN = 'Y';
    await assert.rejects(mutatePortalRecord(input), /확인 완료/);
    client.records[0].CONFIRM_YN = '';
    await assert.rejects(mutatePortalRecord({ ...input, record: { ...record, content: 'stale' } }), /변경되었습니다/);
    assert.equal(client.changes.length, 0);
    client.mode = 'reject';
    await assert.rejects(mutatePortalRecord(input), /결과를 확인하지/);
    client.mode = 'timeout';
    assert.equal((await mutatePortalRecord(input)).verified, true);
    assert.equal(client.changes.length, 2);
});

test('split shifts reuse the verified snapshot and deduplicate date rules within each validation pass', async () => {
    const client = new FakePortal();
    const events = [];
    const opts = options(client, { onEvent: event => events.push(event) });
    opts.schedule.specialDates[1] = [{ start: '0900', end: '1100' }, { start: '1200', end: '1400' }, { start: '1500', end: '1700' }];
    assert.equal((await runPortalAutomation(opts)).insertedCount, 3);
    assert.equal(client.calls.filter(name => name === 'FindWork').length, 5);
    for (const command of ['Checkweek', 'Vacation', 'Holi']) {
        assert.equal(client.calls.filter(name => name === command).length, 4);
    }
    assert.equal(client.calls.length + client.saves.length, 35);
    const progress = events.map(event => event.progress).filter(Number.isFinite);
    assert.deepEqual(progress, [...progress].sort((a, b) => a - b));
    assert.equal(progress.at(-1), 100);
    assert.ok(events.some(event => event.message.includes('3/3')));
});

test('live assignment, duplicate and semester-limit changes still stop later writes', async () => {
    for (const change of ['assignment', 'overlap', 'semester', 'holiday']) {
        const client = new FakePortal();
        const save = client.save.bind(client);
        client.save = async (key, row) => {
            await save(key, row);
            if (change === 'assignment') client.approved[0].END_DT = '20260901';
            if (change === 'overlap') client.records.push({ ...row, WORK_DT: '20260902', ST_HHMI: '1200', END_HHMI: '1500' });
            if (change === 'semester') client.before.sumwork_smtcd = '64000';
            if (change === 'holiday') client.holidays = ['20260902'];
        };
        const opts = options(client);
        opts.schedule.specialDates[2] = { start: '1300', end: '1700' };
        await assert.rejects(runPortalAutomation(opts), /1건은 저장.*나머지는 중단/);
        assert.equal(client.saves.length, 1, change);
    }
});

test('preflight refreshes live data after the initial full validation and skips external duplicates safely', async () => {
    const client = new FakePortal();
    const opts = options(client, { onEvent: event => {
        if (event.progress === 35 && event.message.includes('검증 완료')) {
            client.records.push({ STUDENT_NO: 'test-student', SCHO_CD: '50086', WORK_DEPT_CD: '21095',
                WORK_DT: '20260901', SEQ: '1', ST_HHMI: '1300', END_HHMI: '1700', REMARK: 'Already saved' });
        }
    } });
    const result = await runPortalAutomation(opts);
    assert.equal(result.insertedCount, 0);
    assert.equal(result.skippedCount, 1);
    assert.equal(result.records.length, 1);
    assert.equal(client.saves.length, 0);
});

test('existing records need only week lookup, while new dates still verify vacation and holidays', async () => {
    const client = new FakePortal();
    client.catalog.listSchoCd[0].NAT_AMT = '1';
    client.records.push({ STUDENT_NO: 'test-student', SCHO_CD: '50086', WORK_DEPT_CD: '21095',
        WORK_DT: '20260902', SEQ: '1', ST_HHMI: '1300', END_HHMI: '1400' });
    await runPortalAutomation(options(client, { dryRun: true }));
    assert.equal(client.calls.filter(name => name === 'Checkweek').length, 2);
    assert.equal(client.calls.filter(name => name === 'Vacation').length, 1);
    assert.equal(client.calls.filter(name => name === 'Holi').length, 1);
});

test('query reports real intermediate stages and performs no writes', async () => {
    const client = new FakePortal();
    const events = [];
    await queryPortalRecords({ ...options(client), year: 2026, month: 9, onEvent: event => events.push(event) });
    assert.ok(events.some(event => event.progress > 20 && event.progress < 95));
    assert.ok(events.some(event => event.message.includes('누적 근로시간')));
    assert.equal(events.at(-1).progress, 100);
    assert.equal(client.saves.length, 0);
});
