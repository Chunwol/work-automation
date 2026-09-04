const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const request = require('supertest');
const puppeteer = require('puppeteer');
const { createApp } = require('../src/app');

async function main() {
    const root = path.resolve(__dirname, '..');
    const artifacts = path.join(root, 'artifacts');
    fs.mkdirSync(artifacts, { recursive: true });
    const year = new Date().getFullYear();
    const month = new Date().getMonth() + 1;
    const prefix = `${year}${String(month).padStart(2, '0')}`;
    const assignments = [
        { scholarshipCode: '50086', scholarshipName: '국가근로장학금(교내)', workDepartmentCode: '21095', workDepartmentName: '화면 검증용 근무지' },
        { scholarshipCode: '50064', scholarshipName: '일반근로장학금', workDepartmentCode: '21096', workDepartmentName: '두 번째 화면 검증용 근무지' }
    ].map(item => ({ ...item, startDate: `${prefix}01`, endDate: `${prefix}${new Date(year, month, 0).getDate()}`, recordCount: 1 }));
    const record = { ...assignments[0], date: `${prefix}04`, start: '0900', end: '1100', sequence: '1', confirmed: false,
        content: '화면 검증용 근무내용입니다. 실제 학교 데이터가 아닙니다.' };
    const runtime = createApp({ databasePath: ':memory:', masterKey: crypto.randomBytes(32), publicDir: path.join(root, 'public'),
        cookieSecure: false, trustProxy: false, sessionTtlMs: 3600000, automationConcurrency: 1, nodeEnv: 'test' }, {
        calendar: async () => ({ holidays: [{ day: 15, name: '테스트 공휴일' }], source: 'test', error: null }),
        verifyPortalCredentials: async () => true,
        automation: {
            queryPortalRecords: async () => ({ year, month, assignments, records: [record], count: 1 }),
            runPortalAutomation: async () => { throw new Error('Unexpected portal write'); },
            mutatePortalRecord: async () => { throw new Error('Unexpected portal mutation'); }
        }
    });
    const agent = request.agent(runtime.app);
    let response = await agent.post('/api/setup').send({ username: 'modal-admin', displayName: '모달 검증', password: 'modal-test-password' });
    assert.equal(response.status, 201);
    const csrf = response.body.csrfToken;
    const userId = response.body.user.id;
    response = await agent.put('/api/portal-credentials').set('X-CSRF-Token', csrf).send({ portalId: 'fake-id', portalPassword: 'fake-password' });
    assert.equal(response.status, 200);
    response = await agent.put(`/api/schedules/${year}/${month}`).set('X-CSRF-Token', csrf).send({
        content: 'UI test', portalAssignment: assignments[0], regularRules: [{ day: 1, start: '0900', end: '1700' }],
        specialDates: { 1: { start: '1000', end: '1200' } }, vacationDates: [], extraHolidayDates: []
    });
    assert.equal(response.status, 200);
    response = await agent.post('/api/admin/users').set('X-CSRF-Token', csrf).send({ username: 'modal-member', displayName: '긴 이름과 작은 화면 확인용 사용자', password: 'modal-member-password', role: 'user' });
    assert.equal(response.status, 201);
    runtime.db.createJob({ id: 'fixture-query', userId, type: 'query', year, month });
    runtime.db.markJobRunning('fixture-query');
    runtime.db.completeJob('fixture-query', { year, month, assignments, records: [record], count: 1 });
    const server = runtime.app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    // Hosted Linux CI uses only this synthetic local app, never a real portal session.
    const browser = await puppeteer.launch({ headless: true,
        args: process.env.GITHUB_ACTIONS === 'true' && process.platform === 'linux' ? ['--no-sandbox'] : [] });
    const page = await browser.newPage();
    const errors = [];
    const nativeDialogs = [];
    const mutations = [];
    const results = [];
    let phase = 'login';
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', async dialog => { nativeDialogs.push(dialog.type()); await dialog.dismiss(); });
    page.on('request', req => {
        if (req.url().includes('/mutate') || (req.url().endsWith('/api/jobs') && req.postData()?.includes('submit'))) mutations.push(req.url());
    });
    const click = async selector => {
        await page.$eval(selector, el => el.scrollIntoView({ block: 'center' }));
        await page.tap(selector);
    };
    const closeAll = async () => {
        for (let index = 0; index < 4 && await page.$('dialog[open]'); index += 1) await page.keyboard.press('Escape');
        await page.waitForFunction(() => !document.querySelector('dialog[open]') && pendingConfirmation === null);
    };
    const waitForConfirmationClosed = () => page.waitForFunction(() =>
        !document.querySelector('#action-confirm-dialog').open && pendingConfirmation === null);
    const inspect = async id => {
        await page.waitForSelector(`#${id}[open]`);
        await page.$eval(`#${id}`, async el => { await Promise.all(el.getAnimations({ subtree: true }).map(animation => animation.finished)); });
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const issues = await page.$eval(`#${id}`, dialog => {
            const failures = [];
            const rect = dialog.getBoundingClientRect();
            if (rect.left < -1 || rect.right > innerWidth + 1 || rect.top < -1 || rect.bottom > innerHeight + 1) failures.push('outside viewport');
            if (dialog.scrollWidth > dialog.clientWidth + 1) failures.push('horizontal overflow');
            if (!document.getElementById(dialog.getAttribute('aria-labelledby'))) failures.push('missing accessible title');
            const controls = [...dialog.querySelectorAll('.modal-close, .modal-actions button')].filter(el => el.getClientRects().length);
            for (const el of controls) {
                const box = el.getBoundingClientRect();
                if (box.height < 43 || box.width < 43) failures.push(`small target: ${el.textContent.trim()}`);
                if (box.left < rect.left || box.right > rect.right + 1 || getComputedStyle(el).visibility !== 'visible') failures.push(`offscreen action: ${el.textContent.trim()}`);
                if (box.top < rect.top || box.bottom > Math.min(rect.bottom, innerHeight) + 1) failures.push(`hidden action: ${el.textContent.trim()}`);
                const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
                if (!el.contains(hit)) failures.push(`covered action: ${el.textContent.trim()}`);
            }
            if (innerWidth <= 760) for (const input of dialog.querySelectorAll('input:not([type="checkbox"]):not([type="radio"]), select, textarea')) {
                if (input.getClientRects().length && parseFloat(getComputedStyle(input).fontSize) < 16) failures.push('small input text');
            }
            return failures;
        });
        assert.deepEqual(issues, [], `${phase}: ${issues.join(', ')}`);
    };
    try {
        await page.setViewport({ width: 1440, height: 1050, hasTouch: true });
        await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'networkidle0' });
        await page.type('#username', 'modal-admin');
        await page.type('#password', 'modal-test-password');
        await click('#auth-submit');
        await page.waitForSelector('#dashboard-view:not([hidden])');
        await page.waitForSelector('[data-day="4"] .calendar-portal-record');
        const cases = [
            ['help', 'help-dialog', async () => { await click('#help-button'); await page.$$eval('#help-dialog details', els => els.forEach(el => { el.open = true; })); }],
            ['day', 'day-dialog', () => click('[data-day="1"]')],
            ['repeat', 'repeat-dialog', () => click('#repeat-settings-button')],
            ['credentials', 'portal-dialog', () => click('#portal-settings-button')],
            ['assignment', 'assignment-dialog', () => click('#assignment-settings-button')],
            ['run', 'run-dialog', () => click('#run-button')],
            ['record-update', 'portal-record-dialog', async () => { await click('[data-day="4"]'); await click('[data-portal-action="update"]'); }],
            ['record-delete', 'portal-record-dialog', async () => { await click('[data-day="4"]'); await click('[data-portal-action="delete"]'); }],
            ['password', 'password-dialog', async () => { await click('#user-menu-button'); await click('#change-password-button'); }],
            ['admin', 'admin-dialog', async () => { await click('#user-menu-button'); await click('#admin-menu-button'); await page.waitForSelector('.admin-user'); }],
            ['confirmation', 'action-confirm-dialog', async () => { await click('[data-day="1"]'); await click('#remove-day-button'); }]
        ];
        for (const [width, height] of [[320, 740], [390, 844], [768, 1024], [844, 390], [1440, 1050]]) {
            await page.setViewport({ width, height, hasTouch: true });
            for (const [name, id, open] of cases) {
                phase = `${width}x${height} ${name}`;
                await open();
                await inspect(id);
                await page.$eval(`#${id}`, el => { el.scrollTop = el.scrollHeight; });
                await inspect(id);
                if (width === 390 && ['confirmation', 'repeat', 'credentials', 'record-update'].includes(name)) {
                    await page.$eval(`#${id}`, el => { el.scrollTop = 0; });
                    await inspect(id);
                    await page.screenshot({ path: path.join(artifacts, `modal-mobile-${name}.png`) });
                }
                // Close buttons must work even when required inputs are empty.
                await click(`#${id} .modal-close`);
                await page.waitForSelector(`#${id}:not([open])`);
                await closeAll();
                results.push({ width, height, name, passed: true });
            }
        }
        phase = 'short viewport with focused input';
        await page.setViewport({ width: 390, height: 844, hasTouch: true });
        await click('#portal-settings-button');
        await page.type('#portal-password', 'typing-test-only');
        await page.setViewport({ width: 390, height: 360, hasTouch: true });
        await page.focus('#portal-password');
        await page.$eval('#portal-password', el => el.scrollIntoView({ block: 'center' }));
        await inspect('portal-dialog');
        assert.equal(await page.$eval('#portal-password', el => {
            const box = el.getBoundingClientRect();
            return el === document.elementFromPoint(box.left + box.width / 3, box.top + box.height / 2);
        }), true);
        assert.equal(await page.$eval('#portal-password', el => el.value), 'typing-test-only');
        await page.screenshot({ path: path.join(artifacts, 'modal-short-viewport.png') });
        await closeAll();
        await page.setViewport({ width: 390, height: 844, hasTouch: true });
        phase = 'safe default and stale confirmation';
        await click('[data-day="1"]');
        await click('#remove-day-button');
        await page.waitForSelector('#action-confirm-dialog[open]');
        assert.equal(await page.evaluate(() => document.activeElement.id), 'action-confirm-cancel');
        await page.keyboard.press('Enter');
        await waitForConfirmationClosed();
        assert.equal(await page.$eval('[data-day="1"]', el => el.classList.contains('work-day')), true);
        assert.equal(await page.$eval('#day-dialog', el => el.open), true);
        await closeAll();
        await page.evaluate(() => { void copyManualSchedule(manualCopySource(1), 15); });
        await page.waitForSelector('#action-confirm-dialog[open]');
        await page.evaluate(() => { state.schedule.specialDates['15'] = { start: '1300', end: '1500' }; });
        await click('#action-confirm-submit');
        await waitForConfirmationClosed();
        assert.deepEqual(await page.evaluate(() => state.schedule.specialDates['15']), { start: '1300', end: '1500' });
        phase = 'confirmation text escaping';
        await page.evaluate(() => { void confirmAction({ title: 'Test', message: '<img src=x onerror=alert(1)>', details: ['<script>alert(1)</script>'] }); });
        await page.waitForSelector('#action-confirm-dialog[open]');
        assert.equal(await page.$('#action-confirm-dialog img, #action-confirm-dialog script'), null);
        await page.keyboard.press('Escape');
        await waitForConfirmationClosed();
        phase = 'credential deletion modal';
        await click('#portal-settings-button');
        await click('#delete-portal-button');
        await page.waitForSelector('#action-confirm-dialog[open]');
        await click('#action-confirm-cancel');
        await waitForConfirmationClosed();
        assert.ok(runtime.db.getPortalCredential(userId));
        await click('#delete-portal-button');
        await page.waitForSelector('#action-confirm-dialog[open]');
        await click('#action-confirm-submit');
        await page.waitForSelector('#portal-dialog:not([open])');
        assert.equal(runtime.db.getPortalCredential(userId), null);
        assert.deepEqual(errors, []);
        assert.deepEqual(nativeDialogs, []);
        assert.deepEqual(mutations, []);
        const report = { ok: true, modalStates: cases.length, viewports: 5, checks: results.length, results,
            safeDefaultCancel: true, staleConfirmationBlocked: true, credentialDeletionModal: true, keyboardSizedViewport: true,
            physicalMobileDeviceTested: false, realPortalWrites: 0, nativeDialogs: 0, browserErrors: 0 };
        fs.writeFileSync(path.join(artifacts, 'modal-ui-smoke.json'), JSON.stringify(report, null, 2));
        console.log(JSON.stringify({ ...report, results: undefined }, null, 2));
    } catch (error) {
        console.error(JSON.stringify({ phase, errors }));
        console.error(JSON.stringify(await page.evaluate(() => {
            const dialog = [...document.querySelectorAll('dialog[open]')].at(-1);
            const rect = el => el ? { top: el.getBoundingClientRect().top, bottom: el.getBoundingClientRect().bottom, height: el.getBoundingClientRect().height } : null;
            return { viewportHeight: visualViewport.height, activeElement: document.activeElement.id,
                dialog: rect(dialog), scrollTop: dialog?.scrollTop, scrollHeight: dialog?.scrollHeight,
                header: rect(dialog?.querySelector('.modal-header')), footer: rect(dialog?.querySelector('.modal-actions')),
                focused: rect(document.activeElement) };
        })));
        await page.screenshot({ path: path.join(artifacts, 'modal-test-failure.png') });
        throw error;
    } finally {
        await browser.close();
        await new Promise(resolve => server.close(resolve));
        runtime.db.close();
    }
}
main().catch(error => { console.error(error.stack || error.message); process.exit(1); });
