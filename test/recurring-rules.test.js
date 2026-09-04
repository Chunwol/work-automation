const assert = require('node:assert/strict');
const test = require('node:test');
const { createDatabase } = require('../src/lib/database');
const { validateSchedulePayload } = require('../src/lib/schedule');

const rules = [{ day: 1, start: '0900', end: '1200' }, { day: 1, start: '1300', end: '1700' }];
const schedule = (month, regularRules = rules, year = 2026) => validateSchedulePayload({ regularRules }, year, month).value;

test('blank content is valid; recurring rules continue across years without inheriting monthly exceptions', t => {
    const db = createDatabase(':memory:');
    t.after(() => db.close());
    const user = db.createUser({ username: 'first', displayName: 'Test', passwordHash: 'test' });
    const other = db.createUser({ username: 'second', displayName: 'Other', passwordHash: 'test' });
    const saved = db.saveSchedule(user.id, { ...schedule(9), specialDates: { 1: { start: '1000', end: '1100' } }, vacationDates: [2] });
    assert.equal(saved.content, '');
    assert.deepEqual(db.getRecurringRules(user.id, 2027, 1).regularRules, saved.regularRules);
    assert.deepEqual(db.getRecurringRules(other.id, 2027, 1).regularRules, []);
    assert.deepEqual(db.getRecurringRules(user.id, 2026, 8).regularRules, []);
    const october = db.saveSchedule(user.id, schedule(10), saved.recurringRuleRevision);
    assert.deepEqual(october.specialDates, {});
    assert.deepEqual(october.vacationDates, []);
    assert.equal(october.portalAssignment, null);
    assert.equal(db.raw.prepare('SELECT COUNT(*) AS count FROM recurring_rules').get().count, 1);
    const changed = db.saveSchedule(user.id, schedule(9, [rules[0]]), saved.recurringRuleRevision);
    assert.deepEqual(db.getSchedule(user.id, 2026, 10).regularRules, changed.regularRules);
    assert.throws(() => db.saveSchedule(user.id, schedule(10), october.recurringRuleRevision), { code: 'RECURRING_RULE_CONFLICT' });
    assert.deepEqual(db.getSchedule(user.id, 2026, 10).regularRules, changed.regularRules);
    db.saveSchedule(user.id, schedule(11, []));
    assert.deepEqual(db.getRecurringRules(user.id, 2028, 1).regularRules, []);
    db.saveSchedule(user.id, schedule(10, [rules[1]]));
    assert.deepEqual(db.getRecurringRules(user.id, 2028, 1).regularRules, []);
    assert.equal(validateSchedulePayload({ content: 'a'.repeat(101) }, 2026, 9).ok, false);
    assert.equal(validateSchedulePayload({ content: ' '.repeat(12) }, 2026, 9).value.content, '');
});
