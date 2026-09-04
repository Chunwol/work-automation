const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const request = require('supertest');
const puppeteer = require('puppeteer');
const { createApp } = require('../src/app');

async function main() {
    let now = new Date('2026-09-04T00:00:00Z');
    const calls = [];
    const assignment = { scholarshipCode: '50086', workDepartmentCode: '21095', scholarshipName: '국가근로장학금', workDepartmentName: '컴퓨터공학부' };
    const runtime = createApp({ databasePath: ':memory:', masterKey: crypto.randomBytes(32), publicDir: path.resolve(__dirname, '../public'),
        cookieSecure: false, trustProxy: false, sessionTtlMs: 3600000, automationConcurrency: 1, nodeEnv: 'test' }, {
        now: () => now, calendar: async () => ({ holidays: [], error: null }), verifyPortalCredentials: async () => true,
        automation: {
            queryPortalRecords: async () => ({ records: [], assignments: [assignment] }),
            runPortalAutomation: async options => { calls.push(options.schedule); return { insertedCount: 1, records: [], assignments: [assignment] }; },
            mutatePortalRecord: async () => { throw new Error('Unexpected mutation'); }
        }
    });
    const agent = request.agent(runtime.app);
    const setup = await agent.post('/api/setup').send({ username: 'monthly-ui', displayName: '예약 검증', password: 'synthetic-password' });
    const { csrfToken: csrf, user } = setup.body;
    await agent.put('/api/portal-credentials').set('X-CSRF-Token', csrf).send({ portalId: 'fake', portalPassword: 'fake' });
    await agent.put('/api/schedules/2026/8').set('X-CSRF-Token', csrf).send({ content: 'Previous month', portalAssignment: assignment,
        regularRules: [], specialDates: { 4: [{ start: '0900', end: '1200' }, { start: '1300', end: '1500' }], 31: { start: '0900', end: '1000' } }, vacationDates: [] });
    await agent.put('/api/schedules/2026/9').set('X-CSRF-Token', csrf).send({ content: '', portalAssignment: assignment,
        regularRules: [{ day: 1, start: '0900', end: '1200' }], specialDates: {}, vacationDates: [] });
    runtime.db.createJob({ id: 'fixture', userId: user.id, type: 'query', year: 2026, month: 9 });
    runtime.db.completeJob('fixture', { records: [], assignments: [assignment] });
    const server = runtime.app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const browser = await puppeteer.launch({ headless: true,
        args: process.env.GITHUB_ACTIONS === 'true' && process.platform === 'linux' ? ['--no-sandbox'] : [] });
    const page = await browser.newPage();
    const errors = [];
    const nativeDialogs = [];
    let browserClosed = false;
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', async dialog => { nativeDialogs.push(dialog.type()); await dialog.dismiss(); });
    const click = selector => page.locator(selector).click();
    const open = async () => { await click('#monthly-settings-button'); await page.waitForSelector('#monthly-dialog[open]'); };
    const confirm = async accept => {
        await page.waitForSelector('#action-confirm-dialog[open]');
        await click(accept ? '#action-confirm-submit' : '#action-confirm-cancel');
        await page.waitForFunction(() => !document.querySelector('#action-confirm-dialog').open && !pendingConfirmation);
    };
    try {
        await page.setViewport({ width: 1440, height: 1000 });
        await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'networkidle0' });
        await page.evaluate(() => { state.year = 2026; state.month = 9; });
        await page.type('#username', 'monthly-ui');
        await page.type('#password', 'synthetic-password');
        await click('#auth-submit');
        await page.waitForFunction(() => state.schedule?.year === 2026 && state.schedule?.month === 9 && state.monthlyAutomation);
        const recurringBefore = runtime.db.getRecurringRules(user.id, 2026, 10).regularRules;
        await click('#previous-month-button');
        await confirm(false);
        assert.deepEqual(runtime.db.getSchedule(user.id, 2026, 9).specialDates, {});
        await click('#previous-month-button');
        await confirm(true);
        await page.waitForFunction(() => !state.dirty && state.schedule.specialDates[4]);
        const copied = runtime.db.getSchedule(user.id, 2026, 9);
        assert.equal(copied.specialDates[4].length, 2);
        assert.equal(copied.specialDates[31], undefined);
        assert.ok(copied.vacationDates.includes(7));
        assert.equal(copied.content, '');
        assert.deepEqual(runtime.db.getRecurringRules(user.id, 2026, 10).regularRules, recurringBefore);
        assert.equal(calls.length, 0);
        await page.reload({ waitUntil: 'networkidle0' });
        await page.waitForFunction(() => state.schedule?.specialDates[4] && state.monthlyAutomation);
        // Enter in a regular password field submits Save, not the header's Cancel button.
        await click('#portal-settings-button');
        await page.waitForSelector('#portal-dialog[open]');
        await page.type('#portal-id', 'fake');
        // A unique credential avoids browser-owned weak-password UI in the test profile.
        await page.type('#portal-password', `SyntheticOnly-${crypto.randomUUID()}`);
        const credentialSaved = page.waitForResponse(response => response.url().includes('/api/portal-credentials') && response.request().method() === 'PUT');
        await page.keyboard.press('Enter');
        assert.equal((await credentialSaved).status(), 200);
        await page.waitForSelector('#portal-dialog:not([open])');
        await page.waitForFunction(() => state.portalSnapshot?.jobId && state.portalSnapshot.jobId !== 'fixture');
        await page.waitForFunction(() => !state.portalCredentialSaving && !jobRequestBusy);
        await page.waitForNetworkIdle({ idleTime: 500, timeout: 10000 });
        await click('#portal-settings-button');
        await page.waitForSelector('#portal-dialog[open]', { timeout: 3000 });
        await page.keyboard.press('Escape');
        await page.waitForSelector('#portal-dialog:not([open])', { timeout: 3000 });
        await open();
        assert.equal(await page.$eval('#monthly-enabled', el => el.checked), false);
        assert.equal(await page.$eval('#monthly-time', el => el.disabled), true);
        await click('#monthly-enabled');
        await page.select('#monthly-day', '5');
        await page.focus('#monthly-time');
        await page.keyboard.press('Enter');
        await confirm(false);
        assert.equal(runtime.db.getMonthlyAutomation(user.id).enabled, false);
        assert.equal(calls.length, 0);
        await page.waitForFunction(() => !state.monthlySaving);
        await click('#monthly-save-button');
        await confirm(true);
        await page.waitForSelector('#monthly-dialog:not([open])');
        assert.equal(runtime.db.getMonthlyAutomation(user.id).nextRunAt, '2026-09-05T00:00:00.000Z');
        assert.equal(calls.length, 0);
        fs.mkdirSync(path.resolve(__dirname, '../artifacts'), { recursive: true });
        for (const [width, height] of [[1440, 1000], [390, 844], [320, 640], [844, 390]]) {
            await page.setViewport({ width, height });
            await open();
            await page.$eval('#monthly-dialog', async el => { await Promise.all(el.getAnimations({ subtree: true }).map(animation => animation.finished)); });
            const issues = await page.$eval('#monthly-dialog', dialog => {
                const issues = [];
                const box = dialog.getBoundingClientRect();
                if (box.left < -1 || box.right > innerWidth + 1 || box.top < -1 || box.bottom > innerHeight + 1) issues.push('outside viewport');
                if (dialog.scrollWidth > dialog.clientWidth + 1) issues.push('horizontal overflow');
                if (!dialog.getAttribute('aria-labelledby')) issues.push('missing title');
                for (const control of dialog.querySelectorAll('button, select, .time-input')) {
                    if (control.getBoundingClientRect().height < 44) issues.push('small target');
                }
                return issues;
            });
            assert.deepEqual(issues, [], `${width}x${height}`);
            await page.screenshot({ path: path.resolve(__dirname, `../artifacts/monthly-${width}.png`) });
            if (width === 390) {
                await page.mouse.click(3, 3);
                await page.waitForSelector('#monthly-dialog:not([open])');
            } else { await page.keyboard.press('Escape'); await page.waitForSelector('#monthly-dialog:not([open])'); }
        }
        await page.setViewport({ width: 1440, height: 1000 });
        await open();
        await click('#monthly-enabled');
        await click('#monthly-save-button');
        await page.waitForSelector('#monthly-dialog:not([open])');
        assert.equal(runtime.db.getMonthlyAutomation(user.id).enabled, false);
        assert.equal(await page.$('#action-confirm-dialog[open]'), null);
        await open();
        await click('#monthly-enabled');
        await page.select('#monthly-target', 'current');
        await click('#monthly-save-button');
        await confirm(true);
        await page.waitForSelector('#monthly-dialog:not([open])');
        assert.equal(calls.length, 0);
        assert.deepEqual(errors, []);
        assert.deepEqual(nativeDialogs, []);
        await browser.close();
        browserClosed = true;
        now = new Date('2026-09-05T00:00:01Z');
        await runtime.scheduler.tick();
        for (let i = 0; i < 100 && runtime.queue.running; i++) await new Promise(resolve => setTimeout(resolve, 5));
        assert.equal(calls.length, 1);
        assert.equal(calls[0].month, 9);
        assert.equal(runtime.db.getMonthlyAutomation(user.id).lastRun.status, 'succeeded');
        await runtime.scheduler.tick();
        assert.equal(calls.length, 1);
        console.log(JSON.stringify({ passed: true, defaultDisabled: true, confirmationRequired: true, mobileLayouts: true,
            backdropCancel: true, enterSubmitsNotCancels: true, previousMonthDraftPersisted: true, recurringRulesUnchanged: true,
            browserClosedExecution: true, duplicateRuns: 0, realPortalWrites: 0, backend: 'mock' }));
    } catch (error) {
        if (!browserClosed) {
            console.error(JSON.stringify(await page.evaluate(() => ({ openDialogs: [...document.querySelectorAll('dialog[open]')].map(el => el.id),
                monthlySaving: state.monthlySaving, monthlyLoaded: Boolean(state.monthlyAutomation),
                buttonDisabled: document.querySelector('#monthly-settings-button').disabled,
                errors: [...document.querySelectorAll('.form-error:not([hidden]), .toast')].map(el => el.textContent) }))));
            fs.mkdirSync(path.resolve(__dirname, '../artifacts'), { recursive: true });
            await page.screenshot({ path: path.resolve(__dirname, '../artifacts/monthly-error.png') });
        }
        throw error;
    } finally {
        if (!browserClosed) await browser.close();
        await runtime.scheduler.stop();
        await new Promise(resolve => server.close(resolve));
        runtime.db.close();
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
