const DAYS = ['일', '월', '화', '수', '목', '금', '토'];

function normalizeTime(value) {
    const digits = String(value ?? '').replace(/\D/g, '');
    if (digits.length !== 4) return null;
    const hour = Number(digits.slice(0, 2));
    const minute = Number(digits.slice(2, 4));
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
    if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
    return digits;
}

function timeToMinutes(value) {
    const normalized = normalizeTime(value);
    if (!normalized) return null;
    return Number(normalized.slice(0, 2)) * 60 + Number(normalized.slice(2, 4));
}

function validateTimeRange(start, end) {
    const startMinutes = timeToMinutes(start);
    const endMinutes = timeToMinutes(end);
    return startMinutes !== null && endMinutes !== null && endMinutes > startMinutes;
}

function validateSchedulePayload(payload, yearParam, monthParam) {
    const errors = [];
    const year = Number(yearParam ?? payload?.year);
    const month = Number(monthParam ?? payload?.month);
    const lastDay = Number.isInteger(year) && Number.isInteger(month) && month >= 1 && month <= 12
        ? new Date(year, month, 0).getDate()
        : 0;

    if (!Number.isInteger(year) || year < 2020 || year > 2100) errors.push('연도 범위가 올바르지 않습니다.');
    if (!Number.isInteger(month) || month < 1 || month > 12) errors.push('월 범위가 올바르지 않습니다.');

    const content = String(payload?.content || '').trim();
    if (!content || Buffer.byteLength(content, 'utf8') > 100) errors.push('근무내용은 UTF-8 기준 1~100바이트로 입력해주세요.');

    let portalAssignment = null;
    if (payload?.portalAssignment !== null && payload?.portalAssignment !== undefined) {
        const scholarshipCode = String(payload.portalAssignment?.scholarshipCode || '').trim();
        const workDepartmentCode = String(payload.portalAssignment?.workDepartmentCode || '').trim();
        const scholarshipName = String(payload.portalAssignment?.scholarshipName || '').trim();
        const workDepartmentName = String(payload.portalAssignment?.workDepartmentName || '').trim();
        if (!/^[A-Za-z0-9_-]{1,30}$/.test(scholarshipCode) || !/^[A-Za-z0-9_-]{1,30}$/.test(workDepartmentCode)) {
            errors.push('근로 배정 코드가 올바르지 않습니다. 포털에서 다시 조회해주세요.');
        } else if (scholarshipName.length > 120 || workDepartmentName.length > 120) {
            errors.push('근로 배정 이름이 너무 깁니다.');
        } else {
            portalAssignment = { scholarshipCode, workDepartmentCode, scholarshipName, workDepartmentName };
        }
    }

    const regularRules = Array.isArray(payload?.regularRules) ? payload.regularRules : [];
    const normalizedRules = [];
    const seenWeekdays = new Set();
    for (const rule of regularRules) {
        const day = Number(rule?.day);
        const start = normalizeTime(rule?.start);
        const end = normalizeTime(rule?.end);
        if (!Number.isInteger(day) || day < 0 || day > 6 || seenWeekdays.has(day)) {
            errors.push('요일별 반복 규칙이 중복되었거나 올바르지 않습니다.');
            continue;
        }
        if (!start || !end || !validateTimeRange(start, end)) {
            errors.push(`${DAYS[day] || '요일'} 반복 시간 범위가 올바르지 않습니다.`);
            continue;
        }
        seenWeekdays.add(day);
        normalizedRules.push({ day, week: DAYS[day], start, end });
    }

    const specialDates = payload?.specialDates && typeof payload.specialDates === 'object' && !Array.isArray(payload.specialDates)
        ? payload.specialDates
        : {};
    const normalizedSpecialDates = {};
    for (const [dayText, range] of Object.entries(specialDates)) {
        const day = Number(dayText);
        const start = normalizeTime(range?.start);
        const end = normalizeTime(range?.end);
        if (!Number.isInteger(day) || day < 1 || day > lastDay) {
            errors.push(`${dayText}일은 해당 월에 존재하지 않습니다.`);
            continue;
        }
        if (!start || !end || !validateTimeRange(start, end)) {
            errors.push(`${day}일의 근무시간 범위가 올바르지 않습니다.`);
            continue;
        }
        normalizedSpecialDates[String(day)] = { start, end };
    }

    const normalizeDayList = (value, label) => {
        const source = Array.isArray(value) ? value : [];
        const unique = [...new Set(source.map(Number))].sort((a, b) => a - b);
        if (unique.some((day) => !Number.isInteger(day) || day < 1 || day > lastDay)) {
            errors.push(`${label} 날짜에 올바르지 않은 값이 있습니다.`);
        }
        return unique.filter((day) => Number.isInteger(day) && day >= 1 && day <= lastDay);
    };

    const vacationDates = normalizeDayList(payload?.vacationDates, '휴가');
    const extraHolidayDates = normalizeDayList(payload?.extraHolidayDates, '추가 제외일');
    const holidayDates = normalizeDayList(payload?.holidayDates, '공휴일');
    const holidayWorkDates = normalizeDayList(payload?.holidayWorkDates, '공휴일 근무');

    return {
        ok: errors.length === 0,
        errors,
        value: {
            year,
            month,
            content,
            portalAssignment,
            regularRules: normalizedRules,
            specialDates: normalizedSpecialDates,
            vacationDates,
            extraHolidayDates,
            holidayDates,
            holidayWorkDates,
            cleanupUnexpectedRows: Boolean(payload?.cleanupUnexpectedRows)
        }
    };
}

function generateSchedule(schedule, excludedDays = new Set()) {
    const logs = [];
    const lastDay = new Date(schedule.year, schedule.month, 0).getDate();
    const vacationDays = new Set(schedule.vacationDates || []);
    const holidayDays = new Set(schedule.holidayDates || []);
    const holidayWorkDays = new Set(schedule.holidayWorkDates || []);

    for (let day = 1; day <= lastDay; day += 1) {
        const date = new Date(schedule.year, schedule.month - 1, day);
        const weekday = date.getDay();
        if (excludedDays.has(day) || vacationDays.has(day) || (holidayDays.has(day) && !holidayWorkDays.has(day))) continue;

        const specific = schedule.specialDates?.[String(day)];
        const recurring = (schedule.regularRules || []).find((rule) => rule.day === weekday);
        const selected = specific || recurring;
        if (!selected) continue;

        logs.push({
            date: `${schedule.year}${String(schedule.month).padStart(2, '0')}${String(day).padStart(2, '0')}`,
            day,
            week: DAYS[weekday],
            start: selected.start,
            end: selected.end,
            content: schedule.content
        });
    }
    return logs;
}

function calculateTotalWorkMinutes(logs) {
    return logs.reduce((sum, log) => {
        const start = timeToMinutes(log.start);
        const end = timeToMinutes(log.end);
        return start !== null && end !== null && end > start ? sum + end - start : sum;
    }, 0);
}

function formatMinutes(totalMinutes) {
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return `${hours}시간 ${minutes}분`;
}

function unfoldIcsLines(text) {
    return String(text || '').replace(/\r?\n[ \t]/g, '');
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 10_000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timeout);
    }
}

function parseGoogleHolidays(ics, year, month) {
    const monthText = String(month).padStart(2, '0');
    const holidays = new Map();
    if (!String(ics).includes('BEGIN:VCALENDAR')) throw new Error('공휴일 달력 형식이 올바르지 않습니다.');
    for (const block of String(ics).match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g) || []) {
        const unfolded = unfoldIcsLines(block);
        const date = unfolded.match(/DTSTART(?:;VALUE=DATE)?:?(\d{8})/)?.[1];
        if (!date || date.slice(0, 4) !== String(year) || date.slice(4, 6) !== monthText) continue;
        const decode = (value) => String(value || '').replace(/\\,/g, ',').replace(/\\n/g, ' ').replace(/\\;/g, ';').trim();
        const description = decode(unfolded.match(/DESCRIPTION:([^\r\n]*)/)?.[1]);
        if (!description.includes('공휴일')) continue;
        const day = Number(date.slice(6));
        const name = decode(unfolded.match(/SUMMARY:([^\r\n]*)/)?.[1]) || '공휴일';
        holidays.set(day, { day, name });
    }
    return [...holidays.values()].sort((a, b) => a.day - b.day);
}

async function fetchGoogleHolidays(year, month) {
    const url = 'https://calendar.google.com/calendar/ical/ko.south_korea%23holiday%40group.v.calendar.google.com/public/basic.ics';
    const response = await fetchWithTimeout(url, { headers: { 'User-Agent': 'work-log-web/2.0' } });
    if (!response.ok) throw new Error(`Google 공휴일 HTTP ${response.status}`);
    return parseGoogleHolidays(await response.text(), year, month);
}

async function fetchGoogleHolidayDays(year, month) {
    return new Set((await fetchGoogleHolidays(year, month)).map((holiday) => holiday.day));
}

async function fetchDongyangExcludedDays(month) {
    const url = 'https://www.dongyang.ac.kr/dmu/4749/subview.do';
    const response = await fetchWithTimeout(url, { headers: { 'User-Agent': 'work-log-web/2.0' } });
    if (!response.ok) throw new Error(`학교 학사일정 HTTP ${response.status}`);
    const html = await response.text();
    const monthText = String(month).padStart(2, '0');
    const days = new Set();
    const add = (monthValue, dayValue) => {
        if (String(Number(monthValue)).padStart(2, '0') !== monthText) return;
        const day = Number(dayValue);
        if (Number.isInteger(day) && day >= 1 && day <= 31) days.add(day);
    };

    for (const match of html.matchAll(/(\d{2})\.(\d{2})[\s\S]{0,200}?(?:=>|⇒)\s*보강일/g)) {
        add(match[1], match[2]);
    }
    for (const match of html.matchAll(/\[(\d{1,2})\s*\/(\d{1,2})(?:\([^\]]*\))?\]/g)) {
        add(match[1], match[2]);
    }
    return days;
}

async function resolveExcludedDays(schedule) {
    const days = new Set(schedule.extraHolidayDates || []);
    const warnings = [];
    const sources = { google: [], dongyang: [], manual: [...days].sort((a, b) => a - b) };

    try {
        const google = await fetchGoogleHolidayDays(schedule.year, schedule.month);
        sources.google = [...google].sort((a, b) => a - b);
        for (const day of google) days.add(day);
    } catch (error) {
        warnings.push(error.message);
    }

    try {
        const dongyang = await fetchDongyangExcludedDays(schedule.month);
        sources.dongyang = [...dongyang].sort((a, b) => a - b);
        for (const day of dongyang) days.add(day);
    } catch (error) {
        warnings.push(error.message);
    }

    return { days, warnings, sources };
}

function previewSchedule(schedule, excludedDays = new Set()) {
    const logs = generateSchedule(schedule, excludedDays);
    const totalMinutes = calculateTotalWorkMinutes(logs);
    return {
        logs,
        count: logs.length,
        totalMinutes,
        totalText: formatMinutes(totalMinutes)
    };
}

module.exports = {
    DAYS,
    calculateTotalWorkMinutes,
    fetchDongyangExcludedDays,
    fetchGoogleHolidayDays,
    fetchGoogleHolidays,
    parseGoogleHolidays,
    formatMinutes,
    generateSchedule,
    normalizeTime,
    previewSchedule,
    resolveExcludedDays,
    timeToMinutes,
    validateSchedulePayload,
    validateTimeRange
};
