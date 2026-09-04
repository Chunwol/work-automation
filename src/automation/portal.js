const { PortalHttpClient, requireArray } = require('./portal-http-client');
const { previewSchedule, timeToMinutes, validateSchedulePayload } = require('../lib/schedule');

const API_PATH = '/sub.SubWorkSchoE.do';
const LOGIN_URL = 'https://portal.dongyang.ac.kr/login_real.jsp?targetId=DMIS&RelayState=/';
const NATIONAL = new Set(['50085', '50086', '50314', '50315']);
const HOLIDAY_RESTRICTED = new Set(['50086', '50064', '50319']);
const activePortalAccounts = new Set();

const normalizeDate = (value) => String(value || '').replace(/\D/g, '');
const normalizeTime = (value) => String(value || '').replace(/\D/g, '').slice(0, 4);
const assignmentKey = (value) => `${value.scholarshipCode}:${value.workDepartmentCode}`;
const buildLogKey = (date, start, end) => `${normalizeDate(date)}|${normalizeTime(start)}|${normalizeTime(end)}`;
const duration = (record) => timeToMinutes(record.end) - timeToMinutes(record.start);
const durationText = (minutes) => `${Math.floor(minutes / 60)}시간${String(minutes % 60).padStart(2, '0')}분`;
const durationDigits = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}${String(minutes % 60).padStart(2, '0')}`;

function portalMinutes(value) {
    const digits = String(value ?? '');
    if (!/^\d+$/.test(digits)) throw new Error('포털 누적 근로시간 형식을 확인하지 못했습니다.');
    const number = Number(digits);
    if (number % 100 >= 60 || !Number.isSafeInteger(number)) throw new Error('포털 누적 근로시간 형식이 올바르지 않습니다.');
    return Math.floor(number / 100) * 60 + number % 100;
}

function mapPortalRecord(record, assignment = {}) {
    return {
        date: normalizeDate(record.WORK_DT), start: normalizeTime(record.ST_HHMI), end: normalizeTime(record.END_HHMI),
        workTime: String(record.WORK_MI1 || ''), content: String(record.REMARK || ''),
        confirmed: String(record.CONFIRM_YN || '').toUpperCase() === 'Y',
        sequence: String(record.SEQ || ''),
        scholarshipCode: String(record.SCHO_CD || assignment.scholarshipCode || ''),
        scholarshipName: String(record.SCHO_NM || assignment.scholarshipName || ''),
        workDepartmentCode: String(record.WORK_DEPT_CD || assignment.workDepartmentCode || ''),
        workDepartmentName: String(record.WORK_DEPT_NM || assignment.workDepartmentName || '')
    };
}

function validateMonth(year, month) {
    if (!Number.isInteger(year) || year < 2020 || year > 2100 || !Number.isInteger(month) || month < 1 || month > 12) {
        throw new Error('조회 연월이 올바르지 않습니다.');
    }
}

function publicAssignment({ rawRecords, student, before, requestKey, ...assignment }) {
    return assignment;
}

async function querySnapshot(client, year, month, selection, onStep = () => {}) {
    validateMonth(year, month);
    onStep('승인된 근로 배정을 조회합니다.', 0);
    const approved = requireArray(await client.command('FindWork', client.requestKey(year, month)), 'listStdno', 'FindWork');
    const groups = new Map();
    for (const row of approved) {
        if (row.STUDENT_NO && String(row.STUDENT_NO) !== client.identity.studentNo) throw new Error('다른 학생의 배정 응답을 차단했습니다.');
        const scholarshipCode = String(row.SCHO_CD || '');
        const workDepartmentCode = String(row.WORK_DEPT_CD || '');
        const startDate = normalizeDate(row.ST_DT);
        const endDate = normalizeDate(row.END_DT);
        if (!scholarshipCode || !workDepartmentCode || !/^\d{8}$/.test(startDate) || !/^\d{8}$/.test(endDate) || startDate > endDate) {
            throw new Error('포털 승인 배정의 코드 또는 기간을 확인하지 못했습니다.');
        }
        const key = assignmentKey({ scholarshipCode, workDepartmentCode });
        if (!groups.has(key)) groups.set(key, { key, scholarshipCode, workDepartmentCode, periods: [] });
        groups.get(key).periods.push({ startDate, endDate });
    }
    const assignments = [];
    const allRecords = [];
    for (const group of groups.values()) {
        const step = (message, part) => onStep(`배정 ${assignments.length + 1}/${groups.size}: ${message}`, (assignments.length * 3 + part) / (groups.size * 3));
        const requestKey = client.requestKey(year, month, group);
        step('장학 유형·근무지 확인', 0);
        const catalog = await client.command('Chgdeptcd', requestKey);
        const scholarships = requireArray(catalog, 'listSchoCd', 'Chgdeptcd');
        const departments = requireArray(catalog, 'listWorkDeptCd', 'Chgdeptcd');
        const scholarship = scholarships.find((row) => String(row.SCHO_CD) === group.scholarshipCode)
            || client.catalog.listSchoCd.find((row) => String(row.SCHO_CD) === group.scholarshipCode);
        const department = departments.find((row) => String(row.DEPT_CD) === group.workDepartmentCode)
            || client.catalog.listWorkDeptCd.find((row) => String(row.DEPT_CD) === group.workDepartmentCode);
        if (!scholarship || !department) throw new Error('승인 배정이 포털 선택 목록에 없습니다.');
        requestKey.strnat = String(scholarship.NAT_AMT || '');
        if (!Number.isFinite(Number(requestKey.strnat))) throw new Error('장학 유형의 시간 제한 기준을 확인하지 못했습니다.');
        step('누적 근로시간·제한 확인', 1);
        const before = (await client.command('Bef', requestKey)).dmMain;
        if (!before || !['Y', 'N'].includes(before.limit_yn)) throw new Error('Bef 근로시간 제한 응답을 확인하지 못했습니다.');
        portalMinutes(before.sumwork_smtcd);
        portalMinutes(before.sumwork2_smtcd);
        step('등록된 근로일지 조회', 2);
        const listed = await client.command('List', requestKey);
        const rawRecords = requireArray(listed, 'listMain', 'List');
        const students = requireArray(listed, 'listStdt', 'List');
        if (students.length !== 1 || String(students[0].STUDENT_NO) !== client.identity.studentNo) {
            throw new Error('본인 학생 정보가 일치하지 않아 처리를 중단했습니다.');
        }
        const assignment = {
            ...group, scholarshipName: String(scholarship.SCHO_NM || group.scholarshipCode),
            workDepartmentName: String(department.DEPT_NM || group.workDepartmentCode),
            startDate: group.periods.map((period) => period.startDate).sort()[0],
            endDate: group.periods.map((period) => period.endDate).sort().at(-1),
            totalWorkTime: String(before.tot_work_time || ''), alternateTotalWorkTime: String(before.tot_work_time2 || ''),
            limitYn: before.limit_yn, recordCount: rawRecords.length, rawRecords, student: students[0], before, requestKey
        };
        for (const raw of rawRecords) {
            const record = mapPortalRecord(raw, assignment);
            if (String(raw.STUDENT_NO) !== client.identity.studentNo || assignmentKey(record) !== group.key
                || !record.date.startsWith(`${year}${String(month).padStart(2, '0')}`)
                || timeToMinutes(record.start) === null || timeToMinutes(record.end) === null || duration(record) <= 0) {
                throw new Error('포털 일지의 학생·배정·연월 또는 시간 범위가 일치하지 않습니다.');
            }
            allRecords.push(record);
        }
        assignments.push(assignment);
    }
    const selected = selection ? assignments.find((assignment) => assignment.key === assignmentKey(selection)) : null;
    if (selection && !selected) throw new Error('선택한 장학 유형과 근무지가 해당 연월의 승인 배정과 일치하지 않습니다.');
    const records = allRecords.filter((record) => !selection || assignmentKey(record) === assignmentKey(selection));
    records.sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start));
    onStep('배정과 근로일지 조회를 마쳤습니다.', 1);
    return { assignments, selected, records, allRecords };
}

async function dateRules(client, assignment, date) {
    const key = { ...assignment.requestKey, strCheckDate: date, strworkdt: date, strDt: date };
    const week = (await client.command('Checkweek', key)).dmMain;
    const vacation = (await client.command('Vacation', key)).dmMain;
    const holidays = requireArray(await client.command('Holi', key), 'listHoliday', 'Holi');
    if (!/^\d+$/.test(String(week?.week_cnt || '')) || !/^[1-7]$/.test(String(week?.CheckDate || ''))
        || !['Y', 'N'].includes(vacation?.strRemark)
        || holidays.some((row) => !/^\d{8}$/.test(String(row.HOLIDAY)))) {
        throw new Error('포털 주차·방학·공휴일 응답을 확인하지 못했습니다.');
    }
    return { week: String(week.week_cnt), weekday: '일월화수목금토'[Number(week.CheckDate) - 1],
        vacation: vacation.strRemark === 'Y', holiday: holidays.some((row) => row.HOLIDAY === date), key };
}

async function preflight(client, snapshot, logs, { dryRun, now, onStep = () => {} }) {
    const { selected: assignment } = snapshot;
    if (client.identity.canUpdate !== 'Y') throw new Error('학교 포털에서 일지 저장 권한을 확인하지 못했습니다.');
    const pending = logs.filter((log) => !snapshot.records.some((record) => buildLogKey(record.date, record.start, record.end) === buildLogKey(log.date, log.start, log.end)));
    const rules = new Map();
    const weeks = new Map();
    const sameAssignment = [...snapshot.records];
    const all = [...snapshot.allRecords];
    let added = 0;
    for (const [index, log] of pending.entries()) {
        onStep(`${log.date} ${log.start.slice(0, 2)}:${log.start.slice(2)} 근무 조건을 검증합니다.`, index / Math.max(1, pending.length));
        if (!assignment.periods.some((period) => log.date >= period.startDate && log.date <= period.endDate)) {
            throw new Error(`${log.date}: 승인된 근로 기간 밖입니다.`);
        }
        const minutes = duration(log);
        if (minutes < 60 || minutes % 30 !== 0) throw new Error(`${log.date}: 근무시간은 최소 1시간, 30분 단위여야 합니다.`);
        const increment = NATIONAL.has(assignment.scholarshipCode) ? 10 : assignment.scholarshipCode === '50064' ? 30 : 1;
        if (Number(log.start.slice(2)) % increment !== 0) throw new Error(`${log.date}: 시작시간은 ${increment}분 단위여야 합니다.`);
        if (!log.content.trim() || Buffer.byteLength(log.content, 'utf8') > 100) throw new Error('근무내용은 UTF-8 기준 1~100바이트여야 합니다.');
        const endAt = new Date(`${log.date.slice(0, 4)}-${log.date.slice(4, 6)}-${log.date.slice(6)}T${log.end.slice(0, 2)}:${log.end.slice(2)}:00+09:00`);
        if (!dryRun && endAt.getTime() > now.getTime()) throw new Error(`${log.date}: 아직 종료되지 않은 근무는 저장할 수 없습니다. 일정만 저장해주세요.`);
        const daily = all.filter((record) => record.date === log.date);
        if (daily.some((record) => log.start < record.end && record.start < log.end)) throw new Error(`${log.date}: 다른 배정을 포함하여 기존 근무시간과 겹칩니다.`);
        if (daily.reduce((sum, record) => sum + duration(record), minutes) > 480) throw new Error(`${log.date}: 하루 근로시간 8시간을 초과합니다.`);
        const rule = rules.get(log.date) || await dateRules(client, assignment, log.date);
        rules.set(log.date, rule);
        weeks.set(log.date, rule.week);
        if (rule.holiday && HOLIDAY_RESTRICTED.has(assignment.scholarshipCode)) throw new Error(`${log.date}: 포털 공휴일에는 해당 장학 유형을 입력할 수 없습니다.`);
        if (Number(assignment.requestKey.strnat) !== 0) {
            let weekMinutes = String(assignment.before.befcnt) === rule.week ? portalMinutes(assignment.before.bef) : 0;
            for (const record of sameAssignment) {
                if (!weeks.has(record.date)) {
                    // Existing records only need their week number, not holiday/vacation checks.
                    const week = (await client.command('Checkweek', { ...assignment.requestKey, strCheckDate: record.date, strworkdt: record.date, strDt: record.date })).dmMain;
                    if (!/^\d+$/.test(String(week?.week_cnt || '')) || !/^[1-7]$/.test(String(week?.CheckDate || ''))) {
                        throw new Error('포털 주차 응답을 확인하지 못했습니다.');
                    }
                    weeks.set(record.date, String(week.week_cnt));
                }
                if (weeks.get(record.date) === rule.week) weekMinutes += duration(record);
            }
            if (!['1', '2'].includes(String(assignment.student.DAN_CD))) throw new Error('주간/야간 학생 구분을 확인하지 못했습니다.');
            const dayTerm = !rule.vacation && String(assignment.student.DAN_CD) === '1';
            if (weekMinutes + minutes > (dayTerm ? 20 : 40) * 60) throw new Error(`${log.date}: 포털 주간 근로시간 한도를 초과합니다.`);
            if (sameAssignment.reduce((sum, record) => sum + duration(record), minutes) > (dayTerm ? 80 : 160) * 60) throw new Error('포털 월간 근로시간 한도를 초과합니다.');
        }
        added += minutes;
        const semesterField = assignment.scholarshipCode === '50064' ? 'sumwork2_smtcd' : 'sumwork_smtcd';
        // Y exempts the semester cap; it is not a refusal flag.
        if (assignment.limitYn !== 'Y' && (NATIONAL.has(assignment.scholarshipCode) || assignment.scholarshipCode === '50064')
            && portalMinutes(assignment.before[semesterField]) + added > 640 * 60) throw new Error('학기당 640시간 근로 한도를 초과합니다.');
        all.push(log);
        sameAssignment.push(log);
    }
    return { pending, rules, skippedCount: logs.length - pending.length };
}

function reportSteps(options, start, end) {
    return (message, fraction) => options.onEvent?.({ level: 'info', message,
        progress: Math.round(start + (end - start) * Math.max(0, Math.min(1, fraction))) });
}

function buildInsertRow(client, assignment, log, rule) {
    const columns = 'YEAR SCHO_CD SCHO_NM WORK_DEPT_CD WORK_DEPT_NM WORK_DT SEQ ST_HHMI END_HHMI WORK_MI REMARK NM STUDENT_YEAR DAN_CD DAN_NM DEPT_CD DEPT_NM STUDENT_NO WEEK SUMWORK CONFIRM_DT CONFIRM_YN WEEK_CNT BEF BEFCNT WORK_MI1 SUMWORK1 WEEK_CNT2 BEF1 TOT_WORK_TIME TOT_WORK_TIME2 SUMWORK_SMTCD SUMWORK2_SMTCD LIMIT_YN'.split(' ');
    const row = Object.fromEntries(columns.map((key) => [key, '']));
    for (const key of ['STUDENT_YEAR', 'DAN_CD', 'DAN_NM', 'DEPT_CD', 'DEPT_NM']) row[key] = String(assignment.student[key] || '');
    for (const key of ['BEF', 'BEFCNT', 'BEF1', 'TOT_WORK_TIME', 'TOT_WORK_TIME2', 'SUMWORK_SMTCD', 'SUMWORK2_SMTCD', 'LIMIT_YN']) row[key] = String(assignment.before[key.toLowerCase()] ?? '');
    const sequences = assignment.rawRecords.filter((record) => normalizeDate(record.WORK_DT) === log.date).map((record) => Number(record.SEQ));
    if (sequences.some((value) => !Number.isSafeInteger(value) || value < 1)) throw new Error('기존 일지 순번을 확인하지 못했습니다.');
    Object.assign(row, {
        YEAR: log.date.slice(0, 4), SCHO_CD: assignment.scholarshipCode, WORK_DEPT_CD: assignment.workDepartmentCode,
        STUDENT_NO: client.identity.studentNo, NM: client.identity.name, WORK_DT: log.date, SEQ: String(Math.max(0, ...sequences) + 1),
        ST_HHMI: log.start, END_HHMI: log.end, WORK_MI: durationDigits(duration(log)), WORK_MI1: durationText(duration(log)),
        REMARK: log.content, WEEK: rule.weekday, WEEK_CNT: rule.week, sts: 'i'
    });
    for (const key of ['YEAR', 'SEQ', 'SCHO_CD', 'WORK_DEPT_CD', 'WORK_DT', 'STUDENT_NO']) row[`${key}__origin`] = row[key];
    return row;
}

async function withSession(options, operation) {
    const client = options.clientFactory ? options.clientFactory() : new PortalHttpClient();
    try {
        options.onEvent?.({ level: 'info', message: 'HTTP로 학교 포털 로그인과 SSO 인증을 진행합니다.', progress: 1 });
        await client.login(options.portalId, options.portalPassword, (message, progress) => options.onEvent?.({ level: 'info', message, progress }));
        options.onEvent?.({ level: 'info', message: '포털 인증을 마쳤습니다.', progress: 20 });
        return await operation(client);
    } finally {
        await client.close();
    }
}

async function queryPortalRecords(options) {
    validateMonth(options.year, options.month);
    return withSession(options, async (client) => {
        const snapshot = await querySnapshot(client, options.year, options.month, null, reportSteps(options, 20, 95));
        options.onEvent?.({ level: 'success', message: `승인 배정 ${snapshot.assignments.length}건과 기록 ${snapshot.records.length}건을 조회했습니다.`, progress: 100 });
        return { assignments: snapshot.assignments.map(publicAssignment), records: snapshot.records, count: snapshot.records.length,
            year: options.year, month: options.month, transport: 'http' };
    });
}

async function verifyPortalCredentials(options) {
    return withSession(options, (client) => {
        if (!client.identity?.studentNo || !client.identity?.name) {
            throw new Error('포털 로그인 계정 정보를 확인하지 못했습니다.');
        }
        return true;
    });
}

async function runPortalAutomation(options) {
    const validated = validateSchedulePayload(options.schedule);
    if (!validated.ok) throw new Error(validated.errors.join(' '));
    const schedule = validated.value;
    if (!schedule.portalAssignment) throw new Error('자동입력 전에 장학 유형과 근무지를 선택해주세요.');
    const preview = previewSchedule(schedule, new Set(schedule.extraHolidayDates));
    const emit = (level, message, progress) => options.onEvent?.({ level, message, progress });
    return withSession(options, async (client) => {
        // Different web accounts may store the same school account. Lock the authenticated identity.
        const lock = client.identity.studentNo;
        if (activePortalAccounts.has(lock)) throw new Error('같은 학교 계정의 작업이 실행 중입니다. 완료 후 다시 시도해주세요.');
        activePortalAccounts.add(lock);
        let insertedCount = 0;
        try {
            let snapshot = await querySnapshot(client, schedule.year, schedule.month, schedule.portalAssignment, reportSteps(options, 20, 27));
            const checked = await preflight(client, snapshot, preview.logs, { dryRun: Boolean(options.dryRun), now: options.now || new Date(), onStep: reportSteps(options, 27, 34) });
            emit('info', `동일 일정 ${checked.skippedCount}건 제외, 신규 ${checked.pending.length}건 검증 완료`, 35);
            if (options.dryRun) return { mode: 'dry-run', transport: 'http', portalWrites: 0, plannedCount: preview.entryCount,
                pendingCount: checked.pending.length, skippedCount: checked.skippedCount, totalMinutes: preview.totalMinutes, existingRecords: snapshot.records };
            let skippedCount = checked.skippedCount;
            if (checked.pending.length) snapshot = null;
            for (const [index, log] of checked.pending.entries()) {
                const start = 35 + index / checked.pending.length * 60;
                const end = 35 + (index + 1) / checked.pending.length * 60;
                const report = reportSteps(options, start, end);
                // The preceding save's verified snapshot is already the next fresh pre-write read.
                // The first write (and an externally inserted duplicate) still forces a full refresh.
                if (!snapshot) snapshot = await querySnapshot(client, schedule.year, schedule.month, schedule.portalAssignment, (message, part) => report(message, part * .2));
                report(`${index + 1}/${checked.pending.length} · ${log.date} 저장 전 검증`, .2);
                const current = await preflight(client, snapshot, [log], { dryRun: false, now: options.now || new Date() });
                if (!current.pending.length) { skippedCount += 1; snapshot = null; continue; }
                const rule = current.rules.get(log.date);
                report(`${index + 1}/${checked.pending.length} · ${log.date} 포털에 저장 중`, .4);
                let saveFailed = false;
                try { await client.save(rule.key, buildInsertRow(client, snapshot.selected, log, rule)); }
                catch { saveFailed = true; }
                // A timeout can mean a committed write. Never retry Save without reading the result.
                let verified;
                try { verified = await querySnapshot(client, schedule.year, schedule.month, schedule.portalAssignment, (message, part) => report(`저장 결과 확인 · ${message}`, .5 + part * .45)); }
                catch { throw new Error(`${log.date}: 저장 요청 후 재조회에 실패했습니다. 결과가 불확실하므로 자동 재전송하지 않았습니다.`); }
                const matches = verified.records.filter((record) => buildLogKey(record.date, record.start, record.end) === buildLogKey(log.date, log.start, log.end)
                    && record.content.trim() === log.content.trim());
                if (matches.length !== 1) throw new Error(`${log.date}: 저장${saveFailed ? ' 응답 오류 및' : ' 후'} 검증에서 정확한 일지 1건을 확인하지 못했습니다. 재조회 후 확인해주세요.`);
                insertedCount += 1;
                snapshot = verified;
                emit('success', `${log.date} API 저장 및 재조회 검증 완료`, Math.round(end));
            }
            if (!snapshot) snapshot = await querySnapshot(client, schedule.year, schedule.month, schedule.portalAssignment, reportSteps(options, 95, 99));
            emit('success', `신규 ${insertedCount}건 저장, 기존 ${skippedCount}건 유지`, 100);
            return { mode: 'submit', transport: 'http', plannedCount: preview.entryCount, insertedCount, skippedCount,
                verifiedCount: snapshot.records.length, totalMinutes: preview.totalMinutes,
                year: schedule.year, month: schedule.month, records: snapshot.allRecords,
                assignments: snapshot.assignments.map(publicAssignment) };
        } catch (error) {
            if (insertedCount) throw new Error(`${insertedCount}건은 저장·검증 완료되었습니다. 나머지는 중단: ${error.message}`);
            throw error;
        } finally { activePortalAccounts.delete(lock); }
    });
}

async function mutatePortalRecord(options) {
    const { year, month, record, operation } = options;
    validateMonth(year, month);
    if (!['update', 'delete'].includes(operation) || !record || !/^\d+$/.test(String(record.sequence || ''))
        || !/^\d{8}$/.test(String(record.date || '')) || !record.date.startsWith(`${year}${String(month).padStart(2, '0')}`)) {
        throw new Error('수정·삭제할 일지 정보가 올바르지 않습니다. 다시 조회해주세요.');
    }
    return withSession(options, async (client) => {
        const lock = client.identity.studentNo;
        if (activePortalAccounts.has(lock)) throw new Error('같은 학교 계정의 작업이 실행 중입니다.');
        activePortalAccounts.add(lock);
        try {
            const snapshot = await querySnapshot(client, year, month, record);
            const assignment = snapshot.selected;
            const matches = assignment.rawRecords.filter((row) => normalizeDate(row.WORK_DT) === record.date && String(row.SEQ) === record.sequence);
            if (matches.length !== 1) throw new Error('원본 일지를 확인하지 못했습니다. 다시 조회해주세요.');
            const original = matches[0];
            const current = mapPortalRecord(original, assignment);
            if (current.confirmed || original.CONFIRM_DT) throw new Error('확인 완료된 일지는 수정·삭제할 수 없습니다. 학교 담당자에게 확인해주세요.');
            if (current.start !== record.start || current.end !== record.end || current.content !== record.content) {
                throw new Error('조회 이후 일지 내용이 변경되었습니다. 다시 조회한 뒤 진행해주세요.');
            }
            let row = { ...original, sts: operation === 'delete' ? 'd' : 'u' };
            let key = assignment.requestKey;
            if (operation === 'update') {
                const validation = validateSchedulePayload({ content: options.changes?.content, portalAssignment: record,
                    specialDates: { [Number(record.date.slice(6))]: { start: options.changes?.start, end: options.changes?.end } } }, year, month);
                if (!validation.ok) throw new Error(validation.errors.join(' '));
                const log = previewSchedule(validation.value).logs[0];
                if (log.start === current.start && log.end === current.end && log.content === current.content) throw new Error('변경된 내용이 없습니다.');
                const isTarget = (item) => item.date === current.date && item.sequence === current.sequence && assignmentKey(item) === assignment.key;
                const before = { ...assignment.before };
                const field = assignment.scholarshipCode === '50064' ? 'sumwork2_smtcd' : 'sumwork_smtcd';
                before[field] = durationDigits(Math.max(0, portalMinutes(before[field]) - duration(current)));
                const scoped = { ...snapshot, selected: { ...assignment, before },
                    records: snapshot.records.filter((item) => !isTarget(item)), allRecords: snapshot.allRecords.filter((item) => !isTarget(item)) };
                // Exclude only the original row while validating its replacement.
                const checked = await preflight(client, scoped, [log], { dryRun: false, now: options.now || new Date() });
                if (checked.pending.length !== 1) throw new Error('동일한 시간의 다른 일지가 이미 있습니다.');
                key = checked.rules.get(log.date).key;
                row = { ...row, ST_HHMI: log.start, END_HHMI: log.end, REMARK: log.content,
                    WORK_MI: durationDigits(duration(log)), WORK_MI1: durationText(duration(log)) };
            }
            for (const field of ['YEAR', 'SEQ', 'SCHO_CD', 'WORK_DEPT_CD', 'WORK_DT', 'STUDENT_NO']) row[`${field}__origin`] = String(original[field]);
            let requestFailed = false;
            try { await client.change(key, row); } catch { requestFailed = true; }
            let verified;
            try { verified = await querySnapshot(client, year, month, record); }
            catch { throw new Error('수정·삭제 요청 후 재조회에 실패했습니다. 결과가 불확실하므로 재전송하지 않았습니다.'); }
            const remaining = verified.selected.rawRecords.filter((item) => normalizeDate(item.WORK_DT) === record.date && String(item.SEQ) === record.sequence);
            const passed = operation === 'delete' ? remaining.length === 0
                : remaining.length === 1 && String(remaining[0].ST_HHMI) === row.ST_HHMI && String(remaining[0].END_HHMI) === row.END_HHMI && remaining[0].REMARK === row.REMARK;
            if (!passed) throw new Error(`${operation === 'delete' ? '삭제' : '수정'} 결과를 확인하지 못했습니다.${requestFailed ? ' 포털 요청 오류가 있었습니다.' : ''} 다시 조회해주세요.`);
            return { operation, mode: 'mutation', date: record.date, year, month, transport: 'http', verified: true,
                records: verified.allRecords, assignments: verified.assignments.map(publicAssignment), verifiedCount: verified.allRecords.length };
        } finally { activePortalAccounts.delete(lock); }
    });
}

module.exports = { API_PATH, LOGIN_URL, buildLogKey, mapPortalRecord, portalMinutes, querySnapshot, preflight, buildInsertRow,
    queryPortalRecords, runPortalAutomation, mutatePortalRecord, verifyPortalCredentials };
