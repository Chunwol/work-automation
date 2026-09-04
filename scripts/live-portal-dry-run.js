const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { queryPortalRecords, runPortalAutomation } = require('../src/automation/portal');

const rootDir = path.resolve(__dirname, '..');
const credentialPath = path.join(rootDir, 'users', 'LSH.json');

async function main() {
    if (!fs.existsSync(credentialPath)) throw new Error('users/LSH.json 파일이 없습니다.');
    const portal = JSON.parse(fs.readFileSync(credentialPath, 'utf8'));
    const queried = await queryPortalRecords({
        portalId: portal.id,
        portalPassword: portal.password,
        year: 2026,
        month: 6,
        headless: true
    });
    assert.ok(queried.assignments.length >= 1);

    const result = await runPortalAutomation({
        portalId: portal.id,
        portalPassword: portal.password,
        headless: true,
        dryRun: true,
        schedule: {
            year: 2026,
            month: 6,
            content: '실습실 점검',
            portalAssignment: queried.assignments[0],
            regularRules: [],
            specialDates: { 1: { start: '1300', end: '1700' } },
            vacationDates: [],
            extraHolidayDates: [],
            cleanupUnexpectedRows: false
        }
    });

    assert.equal(result.mode, 'dry-run');
    assert.equal(result.plannedCount, 1);
    assert.equal(result.pendingCount, 0);
    assert.equal(result.skippedCount, 1);
    assert.equal(result.existingRecords.length, 17);
    console.log(JSON.stringify({
        ok: true,
        mode: result.mode,
        assignment: {
            scholarshipCode: queried.assignments[0].scholarshipCode,
            workDepartmentCode: queried.assignments[0].workDepartmentCode
        },
        plannedCount: result.plannedCount,
        pendingCount: result.pendingCount,
        skippedCount: result.skippedCount,
        existingRecordCount: result.existingRecords.length,
        portalWrites: 0
    }, null, 2));
}

main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});
