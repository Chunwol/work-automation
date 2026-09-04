const assert = require('node:assert/strict');
const test = require('node:test');
const {
    calculateTotalWorkMinutes,
    generateSchedule,
    previewSchedule,
    validateSchedulePayload
} = require('../src/lib/schedule');

test('validates and normalizes a monthly schedule', () => {
    const result = validateSchedulePayload({
        content: '실습실 점검',
        portalAssignment: {
            scholarshipCode: '50086',
            scholarshipName: '국가근로장학금(교내)',
            workDepartmentCode: '21095',
            workDepartmentName: '컴퓨터공학부'
        },
        regularRules: [{ day: 1, start: '09:00', end: '17:00' }],
        specialDates: { 2: { start: '1300', end: '1700' } },
        vacationDates: [8, 8],
        extraHolidayDates: [15],
        cleanupUnexpectedRows: false
    }, 2026, 6);

    assert.equal(result.ok, true);
    assert.deepEqual(result.value.portalAssignment, {
        scholarshipCode: '50086',
        scholarshipName: '국가근로장학금(교내)',
        workDepartmentCode: '21095',
        workDepartmentName: '컴퓨터공학부'
    });
    assert.deepEqual(result.value.regularRules[0], { day: 1, week: '월', start: '0900', end: '1700' });
    assert.deepEqual(result.value.vacationDates, [8]);
});

test('rejects an invalid portal assignment code', () => {
    const result = validateSchedulePayload({
        content: '점검',
        portalAssignment: {
            scholarshipCode: '<script>',
            scholarshipName: '국가근로',
            workDepartmentCode: '21095',
            workDepartmentName: '컴퓨터공학부'
        }
    }, 2026, 6);

    assert.equal(result.ok, false);
    assert.match(result.errors[0], /근로 배정 코드/);
});

test('specific dates override recurring rules and excluded days win', () => {
    const schedule = {
        year: 2026,
        month: 6,
        content: '실습실 점검',
        regularRules: [{ day: 1, week: '월', start: '0900', end: '1700' }],
        specialDates: { 1: { start: '1300', end: '1700' }, 2: { start: '1700', end: '2300' } },
        vacationDates: [8],
        extraHolidayDates: []
    };

    const logs = generateSchedule(schedule, new Set([15]));
    assert.deepEqual(logs.find((log) => log.day === 1), {
        date: '20260601', day: 1, week: '월', start: '1300', end: '1700', content: '실습실 점검'
    });
    assert.equal(logs.some((log) => log.day === 8), false);
    assert.equal(logs.some((log) => log.day === 15), false);
    assert.equal(calculateTotalWorkMinutes(logs) > 0, true);
});

test('rejects invalid time ranges and impossible dates', () => {
    const result = validateSchedulePayload({
        content: '점검',
        regularRules: [],
        specialDates: {
            31: { start: '0900', end: '1700' },
            2: { start: '1800', end: '1700' }
        }
    }, 2026, 6);

    assert.equal(result.ok, false);
    assert.equal(result.errors.length, 2);
});

test('June 2026 LSH-style dates total 93 hours', () => {
    const specialDates = {
        1: { start: '1300', end: '1700' }, 2: { start: '1700', end: '2300' },
        5: { start: '1700', end: '2300' }, 8: { start: '1300', end: '1700' },
        9: { start: '1700', end: '2300' }, 10: { start: '0900', end: '1300' },
        12: { start: '1700', end: '2300' }, 15: { start: '1300', end: '1700' },
        16: { start: '1700', end: '2300' }, 17: { start: '0900', end: '1300' },
        19: { start: '1700', end: '2300' }, 22: { start: '1300', end: '1700' },
        23: { start: '0900', end: '1700' }, 25: { start: '0800', end: '1300' },
        26: { start: '0900', end: '1700' }, 29: { start: '0800', end: '1200' },
        30: { start: '0800', end: '1600' }
    };
    const preview = previewSchedule({
        year: 2026, month: 6, content: '실습실 점검', regularRules: [], specialDates,
        vacationDates: [], extraHolidayDates: []
    });

    assert.equal(preview.count, 17);
    assert.equal(preview.totalMinutes, 93 * 60);
});
