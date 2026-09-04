const test = require('node:test');
const assert = require('node:assert/strict');
const { parseGoogleHolidays, previewSchedule, validateSchedulePayload } = require('../src/lib/schedule');

test('Korean holidays parse substitute days but not observances, across folded ICS lines', () => {
    const ics = `BEGIN:VCALENDAR
BEGIN:VEVENT
DTSTART;VALUE=DATE:20260815
SUMMARY:광복절
DESCRIPTION:공휴일
END:VEVENT
BEGIN:VEVENT
DTSTART;VALUE=DATE:20260817
SUMMARY:광복절 대체
 공휴일
DESCRIPTION:공휴일
END:VEVENT
BEGIN:VEVENT
DTSTART;VALUE=DATE:20260822
SUMMARY:기념일
DESCRIPTION:기념일
END:VEVENT
END:VCALENDAR`;
    assert.deepEqual(parseGoogleHolidays(ics, 2026, 8), [{ day: 15, name: '광복절' }, { day: 17, name: '광복절 대체공휴일' }]);
    assert.deepEqual(parseGoogleHolidays(ics, 2026, 9), []);
    assert.throws(() => parseGoogleHolidays('<html>unavailable</html>', 2026, 8));
});

test('holiday work override restores one day, while explicit day deletion and manual exclusions still win', () => {
    const schedule = { year: 2026, month: 8, content: 'work', regularRules: [{ day: 1, start: '0800', end: '1600' }],
        specialDates: {}, vacationDates: [], extraHolidayDates: [], holidayDates: [15, 17], holidayWorkDates: [] };
    let preview = previewSchedule(schedule);
    assert.equal(preview.logs.some(log => log.day === 17), false);
    schedule.holidayWorkDates = [17];
    preview = previewSchedule(schedule);
    assert.equal(preview.logs.some(log => log.day === 17), true);
    schedule.vacationDates = [17];
    assert.equal(previewSchedule(schedule).logs.some(log => log.day === 17), false);
    schedule.vacationDates = [];
    assert.equal(previewSchedule(schedule, new Set([17])).logs.some(log => log.day === 17), false);
    assert.equal(validateSchedulePayload({ ...schedule, holidayWorkDates: [32] }).ok, false);
});
