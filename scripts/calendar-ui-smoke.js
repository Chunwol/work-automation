const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer');
const { createApp } = require('../src/app');

async function main() {
    const root = path.resolve(__dirname, '..');
    const artifacts = path.join(root, 'artifacts');
    fs.mkdirSync(artifacts, { recursive: true });
    const nationalDays = [3, 4, 5, 6, 7, 10, 11, 12, 13, 14, 18, 19, 20, 21, 24];
    let records = [...nationalDays, 25, 26, 27, 28].map((day) => ({ date: `202608${String(day).padStart(2, '0')}`,
        start: '0800', end: '1600', content: '화면 테스트용 기록', sequence: '1', confirmed: day !== 25,
        scholarshipCode: day <= 24 ? '50086' : '50064', scholarshipName: day <= 24 ? '국가근로장학금(교내)' : '일반근로장학금',
        workDepartmentCode: '21095', workDepartmentName: '컴퓨터공학부' }));
    const assignments = [{ scholarshipCode: '50086', workDepartmentCode: '21095', scholarshipName: '국가근로장학금(교내)', workDepartmentName: '컴퓨터공학부', startDate: '20260801', endDate: '20260824' },
        { scholarshipCode: '50064', workDepartmentCode: '21095', scholarshipName: '일반근로장학금', workDepartmentName: '컴퓨터공학부', startDate: '20260801', endDate: '20260831' }];
    const mutations = [];
    let credentialChecks = 0;
    let releaseCredentialCheck;
    let calendarError = null;
    const runtime = createApp({ databasePath: ':memory:', masterKey: crypto.randomBytes(32), publicDir: path.join(root, 'public'),
        cookieSecure: false, trustProxy: false, sessionTtlMs: 3600000, automationConcurrency: 1, nodeEnv: 'test' }, {
        calendar: async (year, month) => ({ holidays: year === 2026 && month === 8 ? [{ day: 15, name: '광복절' }, { day: 17, name: '대체공휴일' }] : [], source: 'test', error: calendarError }),
        verifyPortalCredentials: async ({ portalPassword }) => {
            credentialChecks += 1;
            if (portalPassword !== 'fake-test-password') throw new Error('Synthetic login rejected');
            await new Promise(resolve => { releaseCredentialCheck = resolve; });
            return true;
        },
        automation: {
            queryPortalRecords: async ({ year, month }) => ({ year, month, records: structuredClone(records), assignments, count: records.length }),
            runPortalAutomation: async () => { throw new Error('Unexpected school submit'); },
            mutatePortalRecord: async (options) => {
                const index = records.findIndex(row => row.date === options.record.date && row.sequence === options.record.sequence);
                assert.ok(index >= 0);
                assert.equal(records[index].confirmed, false);
                mutations.push(options.operation);
                if (options.operation === 'delete') records.splice(index, 1);
                else records[index] = { ...records[index], ...options.changes };
                return { operation: options.operation, date: options.record.date, verified: true, year: options.year, month: options.month,
                    records: structuredClone(records), assignments };
            }
        }
    });
    const server = runtime.app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    // Hosted Linux CI uses only this synthetic local app, never a real portal session.
    const browser = await puppeteer.launch({ headless: true,
        args: process.env.GITHUB_ACTIONS === 'true' && process.platform === 'linux' ? ['--no-sandbox'] : [] });
    const page = await browser.newPage();
    const errors = [];
    const nativeDialogs = [];
    page.on('dialog', async dialog => { nativeDialogs.push(dialog.type()); await dialog.dismiss(); });
    let phase = 'initial checks';
    page.on('pageerror', error => errors.push(error.message));
    const workDay = day => `[data-day="${day}"].work-day`;
    const goToAugust = async () => {
        const now = new Date();
        const offset = (now.getFullYear() - 2026) * 12 + now.getMonth() - 7;
        for (let i = 0; i < Math.abs(offset); i++) {
            const response = page.waitForResponse(res => res.url().includes('/api/schedules/') && res.request().method() === 'GET');
            await page.click(offset > 0 ? '#previous-month' : '#next-month');
            await response;
        }
        await page.waitForFunction(() => document.querySelector('#month-label').textContent === '2026. 08');
    };
    const applyDay = async () => {
        await page.click('#day-form button[type="submit"]');
        await page.waitForSelector('#day-dialog:not([open])');
    };
    const confirmModal = async (accept, messagePattern) => {
        await page.waitForSelector('#action-confirm-dialog[open]');
        if (messagePattern) assert.match(await page.$eval('#action-confirm-dialog', el => el.textContent), messagePattern);
        await page.click(accept ? '#action-confirm-submit' : '#action-confirm-cancel');
        await page.waitForSelector('#action-confirm-dialog:not([open])');
    };
    try {
        await page.setViewport({ width: 1440, height: 1050 });
        await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'networkidle0' });
        await page.click('#signup-tab');
        assert.equal(await page.$eval('#display-name', el => el.placeholder), '표시할 이름 입력');
        for (const [id, value] of [['display-name', '화면 검증'], ['username', 'calendar-ui'], ['password', 'calendar-ui-password'], ['password-confirm', 'calendar-ui-password']]) await page.type(`#${id}`, value);
        await page.click('#auth-submit');
        await page.waitForSelector('#dashboard-view:not([hidden])');
        await goToAugust();
        await page.waitForSelector('[data-day="17"].holiday-day');
        phase = 'help and uncluttered dashboard';
        assert.equal(await page.$('#calendar-copy-note'), null);
        assert.equal(await page.$('#assignment-note'), null);
        assert.equal(await page.$('.run-steps'), null);
        assert.equal(await page.$eval('#holiday-calendar-note', el => el.hidden), true);
        const helpWrites = [];
        const watchHelpWrites = req => { if (req.method() !== 'GET' && new URL(req.url()).pathname.startsWith('/api/')) helpWrites.push(req.url()); };
        page.on('request', watchHelpWrites);
        await page.focus('#help-button');
        await page.keyboard.press('Enter');
        await page.waitForSelector('#help-dialog[open]');
        assert.equal(await page.$eval('#help-dialog', el => el.getAttribute('aria-labelledby')), 'help-title');
        assert.equal(await page.$$eval('#help-dialog details', els => els.length), 6);
        await page.keyboard.press('Tab');
        assert.equal(await page.evaluate(() => document.activeElement.tagName), 'SUMMARY');
        await page.keyboard.press('Enter');
        assert.equal(await page.$eval('#help-dialog details', el => el.open), true);
        await page.keyboard.press('Escape');
        await page.waitForSelector('#help-dialog:not([open])');
        assert.equal(await page.evaluate(() => document.activeElement.id), 'help-button');
        await page.click('#help-button');
        await page.click('#help-dialog details:first-child summary');
        await page.click('#help-dialog details:nth-child(2) summary');
        assert.match(await page.$eval('#help-dialog', el => el.textContent), /자동 분리하는 기능은 아직 지원하지 않습니다/);
        await page.$eval('#help-dialog', async el => { await Promise.all(el.getAnimations({ subtree: true }).map(animation => animation.finished)); });
        await page.screenshot({ path: path.join(artifacts, 'help-desktop.png') });
        await page.click('[data-close-dialog="help-dialog"]');
        await page.setViewport({ width: 390, height: 844 });
        await page.click('#help-button');
        await page.waitForSelector('#help-dialog[open]');
        await page.$eval('#help-dialog', async el => { await Promise.all(el.getAnimations({ subtree: true }).map(animation => animation.finished)); });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        await page.screenshot({ path: path.join(artifacts, 'help-mobile.png') });
        await page.setViewport({ width: 320, height: 740 });
        await page.waitForFunction(() => {
            const rect = document.querySelector('#help-dialog').getBoundingClientRect();
            return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight;
        });
        assert.equal(await page.$eval('#help-dialog', el => { const rect = el.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight; }), true);
        await page.click('[data-close-dialog="help-dialog"]');
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        page.off('request', watchHelpWrites);
        assert.deepEqual(helpWrites, []);
        await page.setViewport({ width: 1440, height: 1050 });
        phase = 'calendar regression';
        await page.click('#repeat-settings-button');
        await page.click('[data-repeat-day="1"] input[type="checkbox"]');
        for (const [selector, value] of [['.repeat-start', '08:00'], ['.repeat-end', '16:00']]) await page.$eval(`[data-repeat-day="1"] ${selector}`, (el, text) => { el.value = text; }, value);
        await page.click('#repeat-form button[type="submit"]');
        await confirmModal(false, /2026년 8월/);
        assert.equal(await page.$$eval('#calendar .work-day', nodes => nodes.length), 0);
        await page.click('#repeat-form button[type="submit"]');
        await confirmModal(true);
        await page.waitForSelector('#repeat-dialog:not([open])');
        assert.equal(await page.$$eval('#calendar .work-day', nodes => nodes.length), 4);
        assert.equal(await page.$(workDay(17)), null);
        await page.click('[data-day="17"]');
        await page.click('#day-holiday-work');
        await applyDay();
        assert.ok(await page.$(workDay(17)));
        assert.equal(await page.$('[data-day="17"].holiday-day'), null);
        const saved = page.waitForResponse(res => res.url().endsWith('/api/schedules/2026/8') && res.request().method() === 'PUT');
        await page.click('#save-schedule-button');
        assert.equal((await saved).status(), 200);
        await page.reload({ waitUntil: 'networkidle0' });
        await goToAugust();
        await page.waitForSelector(workDay(17));
        await page.click('[data-day="17"]');
        assert.equal(await page.$eval('#day-holiday-work', el => el.checked), true);
        await page.click('#remove-day-button');
        await confirmModal(true, /반복 일정으로/);
        await page.waitForSelector('#day-dialog:not([open])');
        assert.ok(await page.$('[data-day="17"].work-day:not(.override-day):not(.excluded-day)'));
        assert.equal(await page.evaluate(() => state.schedule.holidayWorkDates.includes(17)), true);
        await page.click('[data-day="17"]');
        await applyDay();
        await page.click('[data-day="17"]');
        await page.click('#day-holiday-work');
        await applyDay();
        assert.equal(await page.$(workDay(17)), null);
        await page.click('[data-day="17"]');
        await page.click('#remove-day-button');
        await confirmModal(true, /반복 일정으로/);
        await page.waitForSelector('#day-dialog:not([open])');
        assert.equal(await page.$(workDay(17)), null, 'restoring rules does not enable unapproved holiday work');
        assert.equal(await page.evaluate(() => state.schedule.holidayWorkDates.includes(17)), false);
        await page.click('[data-day="10"]');
        await page.click('#remove-day-button');
        await confirmModal(false);
        assert.ok(await page.$(workDay(10)));
        await page.click('#remove-day-button');
        await confirmModal(true);
        await page.waitForSelector('#day-dialog:not([open])');
        assert.equal(await page.$(workDay(10)), null);
        assert.ok(await page.$(workDay(24)));
        await page.click('#portal-settings-button');
        await page.type('#portal-id', 'fake-test-id');
        await page.type('#portal-password', 'wrong-test-password');
        await page.click('#portal-form button[type="submit"]');
        await page.waitForSelector('#portal-error:not([hidden])');
        assert.match(await page.$eval('#portal-error', el => el.textContent), /저장하지 않았습니다/);
        assert.equal(runtime.db.raw.prepare('SELECT COUNT(*) n FROM portal_credentials').get().n, 0);
        await page.$eval('#portal-password', el => { el.value = ''; });
        await page.type('#portal-password', 'fake-test-password');
        await page.click('#portal-save-button');
        assert.equal(await page.$eval('#portal-save-button', el => el.disabled), true);
        await page.keyboard.press('Escape');
        assert.ok(await page.$('#portal-dialog[open]'));
        releaseCredentialCheck();
        await page.waitForSelector('#portal-dialog:not([open])');
        assert.equal(credentialChecks, 2);
        assert.equal(runtime.db.raw.prepare('SELECT COUNT(*) n FROM portal_credentials').get().n, 1);
        await page.click('#query-button');
        await page.waitForFunction(() => document.querySelector('#portal-calendar-summary').textContent.includes('19건'));
        assert.equal(await page.$$eval('.calendar-portal-record', nodes => nodes.length), 19);
        assert.ok(await page.$('[data-day="24"] .portal-national'));
        assert.ok(await page.$('[data-day="25"] .portal-general'));
        await page.click('[data-day="24"]');
        assert.equal(await page.$eval('[data-portal-action="delete"]', button => button.disabled), true);
        await page.click('#day-dialog .modal-close');
        await page.waitForFunction(() => document.querySelector('#toast-region').children.length === 0);
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({ path: path.join(artifacts, 'calendar-records-desktop.png'), fullPage: true });
        await page.setViewport({ width: 390, height: 844 });
        await page.evaluate(() => window.scrollTo(0, 0));
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        await page.screenshot({ path: path.join(artifacts, 'calendar-records-mobile.png'), fullPage: true });
        await page.click('[data-day="25"]');
        await page.click('[data-portal-action="update"]');
        await page.waitForSelector('#portal-record-dialog[open]');
        assert.equal(await page.$eval('#portal-record-submit', el => el.disabled), true);
        await page.click('#portal-record-end');
        await page.keyboard.type('15');
        await page.keyboard.press('Tab');
        assert.equal(await page.$eval('#portal-record-end', el => el.value), '15:00');
        await page.$eval('#portal-record-content', el => { el.value = '<img src=x onerror=alert(1)>'; });
        await page.click('#portal-record-confirm');
        await page.click('#portal-record-submit');
        await page.waitForSelector('#portal-record-dialog:not([open])');
        await page.waitForFunction(() => document.querySelector('#day-portal-records').textContent.includes('15:00'));
        assert.equal(await page.$('#day-portal-records img'), null);
        await page.click('[data-portal-action="delete"]');
        await page.waitForSelector('#portal-record-dialog[open]');
        await page.screenshot({ path: path.join(artifacts, 'portal-delete-confirm-mobile.png') });
        await page.click('#portal-record-confirm');
        await page.click('#portal-record-submit');
        await page.waitForSelector('#portal-record-dialog:not([open])');
        await page.waitForFunction(() => document.querySelector('#portal-calendar-summary').textContent.includes('18건'));
        assert.equal(await page.$('[data-day="25"] .calendar-portal-record'), null);
        await page.click('#day-dialog .modal-close');
        await page.reload({ waitUntil: 'networkidle0' });
        await goToAugust();
        await page.waitForFunction(() => document.querySelector('#portal-calendar-summary').textContent.includes('18건'));
        const userId = runtime.db.listUsers()[0].id;
        const schedule = runtime.db.getSchedule(userId, 2026, 8);
        runtime.db.saveSchedule(userId, { ...schedule, portalAssignment: assignments[0], holidayDates: [] });
        await page.reload({ waitUntil: 'networkidle0' });
        await goToAugust();
        await page.waitForSelector('[data-day="15"].holiday-day');
        assert.deepEqual(runtime.db.getSchedule(userId, 2026, 8).holidayDates, []);
        await page.click('#run-button');
        await page.waitForSelector('#run-dialog[open]');
        assert.deepEqual(runtime.db.getSchedule(userId, 2026, 8).holidayDates, [15, 17]);
        await page.click('#run-dialog button[value="cancel"]');
        await page.setViewport({ width: 1440, height: 1100 });
        phase = 'desktop drag copy';
        await page.click('[data-day="1"]');
        await page.$eval('#day-start', el => { el.value = '10:00'; });
        await page.$eval('#day-end', el => { el.value = '12:00'; });
        await applyDay();
        assert.equal(await page.$eval('[data-day="1"]', el => el.draggable), false);
        assert.equal(await page.$('.day-copy-hint'), null);
        assert.equal(await page.$eval('#calendar', el => el.textContent.includes('끌어 복사')), false);
        assert.equal(await page.$eval('[data-day="6"]', el => el.draggable), false);
        const unexpectedPortalCalls = [];
        page.on('request', req => {
            if (req.method() === 'POST' && /\/api\/(jobs|portal-records\/.*\/mutate)/.test(req.url())) unexpectedPortalCalls.push(req.url());
        });
        const dragCopy = async (from, to, accept, messagePattern) => {
            const source = await page.$(`[data-day="${from}"]`);
            const destination = await page.$(`[data-day="${to}"]`);
            await source.scrollIntoView();
            const start = await source.boundingBox();
            const end = await destination.boundingBox();
            await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
            await page.mouse.down();
            await page.mouse.move(start.x + start.width / 2 + 16, start.y + start.height / 2, { steps: 3 });
            await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 12 });
            await page.mouse.up();
            if (messagePattern) await confirmModal(accept, messagePattern);
            else assert.equal(await page.$eval('#action-confirm-dialog', el => el.open), false);
            await new Promise(resolve => setTimeout(resolve, 350));
        };
        await dragCopy(1, 2, true);
        assert.ok(await page.$(workDay(1)));
        assert.ok(await page.$(workDay(2)));
        await dragCopy(1, 2, false);
        await dragCopy(1, 1, false);
        await dragCopy(1, 3, false, /기존 예정 시간/);
        assert.equal(await page.$eval('[data-day="3"]', el => el.draggable), false);
        await dragCopy(1, 3, true, /이미 포털 기록 1건/);
        assert.match(await page.$eval('[data-day="3"] .day-time', el => el.textContent), /10:00/);
        assert.match(await page.$eval('[data-day="3"] .portal-record-time', el => el.textContent), /08:00/);
        await dragCopy(1, 15, true, /공휴일 근무 예외/);
        assert.ok(await page.$(workDay(15)));
        assert.equal(await page.$('[data-day="15"].holiday-day'), null);
        await page.evaluate(() => {
            const dataTransfer = new DataTransfer();
            dataTransfer.setData('text/plain', 'external schedule');
            document.querySelector('[data-day="6"]').dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer }));
        });
        assert.equal(await page.$(workDay(6)), null);
        await page.setViewport({ width: 390, height: 844 });
        phase = 'mobile copy';
        await page.click('[data-day="1"]');
        await page.waitForSelector('#day-dialog[open]');
        await page.select('#day-copy-target', '4');
        await page.$eval('#day-dialog', async el => { await Promise.all(el.getAnimations({ subtree: true }).map(animation => animation.finished)); });
        await page.screenshot({ path: path.join(artifacts, 'schedule-copy-mobile.png') });
        await page.click('#copy-day-button');
        await confirmModal(true, /이미 포털 기록/);
        await page.waitForSelector('#day-dialog:not([open])');
        assert.ok(await page.$(workDay(4)));
        phase = 'save copied schedule';
        const copiesSaved = page.waitForResponse(res => res.url().endsWith('/api/schedules/2026/8') && res.request().method() === 'PUT');
        await page.$eval('#save-schedule-button', el => el.scrollIntoView({ block: 'center' }));
        await page.click('#save-schedule-button');
        assert.equal((await copiesSaved).status(), 200);
        phase = 'reload copied schedule';
        await page.reload({ waitUntil: 'networkidle0' });
        await goToAugust();
        await page.waitForSelector(workDay(4));
        const copiedSchedule = runtime.db.getSchedule(userId, 2026, 8);
        for (const day of [1, 2, 3, 4, 15]) assert.deepEqual(copiedSchedule.specialDates[day], { start: '1000', end: '1200' });
        assert.ok(copiedSchedule.holidayWorkDates.includes(15));
        assert.equal(await page.$eval('[data-day="1"] .date-number', el => getComputedStyle(el).color !== getComputedStyle(el).backgroundColor), true);
        assert.deepEqual(unexpectedPortalCalls, []);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        phase = 'calendar warning retained';
        calendarError = '공휴일 정보를 불러오지 못했습니다. 저장된 공휴일을 사용합니다.';
        await page.reload({ waitUntil: 'networkidle0' });
        await goToAugust();
        await page.waitForFunction(() => !document.querySelector('#holiday-calendar-note').hidden);
        assert.equal(await page.$eval('#holiday-calendar-note', el => el.textContent), calendarError);
        calendarError = null;
        await page.reload({ waitUntil: 'networkidle0' });
        await goToAugust();
        await page.waitForSelector(workDay(4));
        assert.equal(await page.$eval('#holiday-calendar-note', el => el.hidden), true);
        await page.setViewport({ width: 1440, height: 1100 });
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({ path: path.join(artifacts, 'schedule-copy-desktop.png'), fullPage: true });
        assert.deepEqual(mutations, ['update', 'delete']);
        assert.deepEqual(errors, []);
        assert.deepEqual(nativeDialogs, []);
        console.log(JSON.stringify({ ok: true, repeatConfirmation: true, holidayOverridePersisted: true, localSingleDayDeletion: true,
            calendarRecords: true, confirmedRecordProtected: true, portalUpdateDeleteUi: true, reloadPersisted: true,
            holidayPreviewPersisted: true, anonymousNameExample: true,
            dragCopyOriginalPreserved: true, copyConflictAndHolidayConfirmed: true, mobileCopyPersisted: true, copyPortalWrites: 0,
            helpDesktopMobileKeyboard: true, helpReadOnly: true, clutterRemoved: true, criticalWarningsRetained: true,
            emptyDropWithoutConfirmation: true, nativeDialogs: nativeDialogs.length,
            realPortalWrites: 0, backend: 'mock', browserErrors: errors.length }, null, 2));
    } catch (error) {
        console.error(JSON.stringify({ phase, browserErrors: errors, openDialogs: await page.$$eval('dialog[open]', els => els.map(el => el.id)) }));
        await page.screenshot({ path: path.join(artifacts, 'calendar-test-failure.png'), fullPage: true });
        throw error;
    } finally {
        await browser.close();
        await new Promise(resolve => server.close(resolve));
        runtime.db.close();
    }
}
main().catch(error => { console.error(error.stack || error.message); process.exit(1); });
