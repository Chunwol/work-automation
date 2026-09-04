const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const crypto = require('node:crypto');
const { createApp } = require('../src/app');

const artifactDir = path.resolve(__dirname, '..', 'artifacts');
const testAccount = {
    displayName: '테스트 사용자',
    username: 'ui-member',
    password: 'ui-smoke-password-123'
};

async function waitForSchedule(page) {
    await page.waitForResponse((response) => response.url().includes('/api/schedules/') && response.request().method() === 'GET');
}

async function editDay(page, day, start, end) {
    await page.waitForSelector(`[data-day="${day}"]`);
    await page.click(`[data-day="${day}"]`);
    await page.waitForSelector('#day-dialog[open]');
    await page.$eval('#day-start', (input, value) => { input.value = value; }, start);
    await page.$eval('#day-end', (input, value) => { input.value = value; }, end);
    await page.click('#day-form button[type="submit"]');
    await page.waitForSelector('#day-dialog:not([open])');
}

async function inspectDesign(page, width) {
    await page.setViewport({ width, height: 900, deviceScaleFactor: 1 });
    const layout = await page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const clipped = [...document.querySelectorAll('.day-time, .portal-record-time')]
            .filter(el => el.getClientRects().length && el.scrollWidth > el.clientWidth + 1)
            .map(el => el.textContent);
        return {
            overflow: document.documentElement.scrollWidth > innerWidth,
            fontLoaded: [...document.fonts].some(font => font.family === 'SUIT Variable' && font.status === 'loaded'),
            headingFont: getComputedStyle(document.querySelector('.page-heading h1')).fontFamily,
            cells: document.querySelector('#calendar').children.length,
            actualDays: document.querySelectorAll('#calendar [data-day]').length,
            clipped
        };
    });
    assert.equal(layout.overflow, false, `${width}px page overflow`);
    assert.equal(layout.fontLoaded, true, 'Local SUIT webfont loaded');
    assert.match(layout.headingFont, /SUIT Variable/);
    assert.equal(layout.cells % 7, 0, 'Calendar includes complete week rows');
    assert.equal(layout.actualDays, 30, 'Blank cells do not create extra work dates');
    assert.deepEqual(layout.clipped, [], `${width}px clipped schedule times`);
}

async function main() {
    fs.mkdirSync(artifactDir, { recursive: true });
    const runtime = createApp({ databasePath: ':memory:', masterKey: crypto.randomBytes(32),
        publicDir: path.resolve(__dirname, '..', 'public'), cookieSecure: false, trustProxy: false,
        sessionTtlMs: 3600000, automationConcurrency: 1, nodeEnv: 'test' }, {
        calendar: async () => ({ holidays: [], source: 'UI fixture', error: null })
    });
    const server = runtime.app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    // Hosted Linux CI uses only this synthetic local app, never a real portal session.
    const browser = await puppeteer.launch({ headless: true,
        args: process.env.GITHUB_ACTIONS === 'true' && process.platform === 'linux' ? ['--no-sandbox'] : [] });
    const page = await browser.newPage();
    const errors = [];
    page.on('console', (message) => {
        if (message.type() === 'error') errors.push(`console: ${message.text()}`);
    });
    page.on('pageerror', (error) => errors.push(`page: ${error.message}`));
    page.on('requestfailed', (request) => errors.push(`request: ${request.url()} ${request.failure()?.errorText || ''}`));

    try {
        await page.setViewport({ width: 1440, height: 1050, deviceScaleFactor: 1 });
        await page.goto(baseUrl, { waitUntil: 'networkidle0' });
        await page.click('#signup-tab');
        await page.waitForSelector('#password-confirm-field:not([hidden])');
        await page.screenshot({ path: path.join(artifactDir, 'ui-signup-desktop.png'), fullPage: true });
        await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
        await page.screenshot({ path: path.join(artifactDir, 'ui-signup-mobile.png'), fullPage: true });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        await page.setViewport({ width: 1440, height: 1050, deviceScaleFactor: 1 });
        await page.type('#display-name', testAccount.displayName);
        await page.type('#username', testAccount.username);
        await page.type('#password', testAccount.password);
        await page.type('#password-confirm', testAccount.password);
        const signupResponse = page.waitForResponse((response) => response.url().endsWith('/api/signup'));
        await page.click('#auth-submit');
        assert.equal((await signupResponse).status(), 201);

        await page.waitForSelector('#dashboard-view:not([hidden])');
        const now = new Date();
        const monthsBack = (now.getFullYear() - 2026) * 12 + now.getMonth() - 5;
        for (let index = 0; index < monthsBack; index += 1) {
            const scheduleResponse = waitForSchedule(page);
            await page.click('#previous-month');
            await scheduleResponse;
        }
        assert.equal(await page.$eval('#month-label', (element) => element.textContent.trim()), '2026. 06');
        await page.waitForFunction(() => state.schedule?.year === 2026 && state.schedule?.month === 6);
        assert.equal(await page.$eval('#admin-button', (element) => element.hidden), true);
        assert.equal(await page.$eval('#admin-menu-button', (element) => element.hidden), true);

        await editDay(page, 1, '13:00', '17:00');
        await editDay(page, 2, '17:00', '23:00');
        await page.evaluate(() => handleAssignmentQueryResult([
            {
                scholarshipCode: '50086',
                scholarshipName: '국가근로장학금(교내)',
                workDepartmentCode: '21095',
                workDepartmentName: '컴퓨터공학부',
                startDate: '20260601',
                endDate: '20260630',
                recordCount: 17,
                totalWorkTime: '575시간00분'
            },
            {
                scholarshipCode: '50064',
                scholarshipName: '일반근로장학금',
                workDepartmentCode: '31001',
                workDepartmentName: '종합정보지원실',
                startDate: '20260601',
                endDate: '20260630',
                recordCount: 3,
                totalWorkTime: '20시간00분'
            }
        ]));
        await page.waitForSelector('#assignment-dialog[open]');
        await page.click('.assignment-option:nth-child(2)');
        await page.click('#assignment-form button[type="submit"]');
        await page.waitForSelector('#assignment-dialog:not([open])');
        assert.match(await page.$eval('#assignment-label', (element) => element.textContent), /일반근로장학금.*종합정보지원실/);

        const saveResponse = page.waitForResponse((response) => response.url().includes('/api/schedules/2026/6') && response.request().method() === 'PUT');
        await page.click('#save-schedule-button');
        assert.equal((await saveResponse).status(), 200);
        await page.waitForFunction(() => document.querySelector('#save-state')?.textContent.includes('저장 완료'));
        await page.waitForFunction(() => document.querySelector('#toast-region').children.length === 0);

        assert.match(await page.$eval('#total-hours', (element) => element.textContent), /10시간/);
        assert.match(await page.$eval('#work-days', (element) => element.textContent), /2일/);
        for (const width of [320, 390, 768, 1081, 1280, 1440]) await inspectDesign(page, width);
        await page.setViewport({ width: 1440, height: 1050, deviceScaleFactor: 1 });
        await page.screenshot({ path: path.join(artifactDir, 'ui-dashboard-desktop.png'), fullPage: true });

        await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
        await new Promise((resolve) => setTimeout(resolve, 300));
        await page.screenshot({ path: path.join(artifactDir, 'ui-dashboard-mobile.png'), fullPage: true });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        await page.reload({ waitUntil: 'networkidle0' });
        await page.waitForSelector('#dashboard-view:not([hidden])');
        for (let index = 0; index < monthsBack; index += 1) {
            const response = waitForSchedule(page);
            await page.click('#previous-month');
            await response;
        }
        await page.waitForFunction(() => state.schedule?.year === 2026 && state.schedule?.month === 6);
        assert.match(await page.$eval('#total-hours', (element) => element.textContent), /10시간/);
        assert.match(await page.$eval('#assignment-label', (element) => element.textContent), /일반근로장학금/);

        assert.deepEqual(errors, []);
        console.log(JSON.stringify({
            ok: true,
            signup: 'public user, auto-login, reload persistence',
            month: '2026-06',
            days: 2,
            hours: 10,
            assignment: '일반근로장학금 / 종합정보지원실',
            designViewports: [320, 390, 768, 1081, 1280, 1440],
            localWebfontLoaded: true,
            completeCalendarWeeks: true,
            scheduleTimesClipped: false,
            screenshots: ['artifacts/ui-dashboard-desktop.png', 'artifacts/ui-dashboard-mobile.png'],
            browserErrors: errors.length
        }, null, 2));
    } finally {
        await browser.close();
        await new Promise((resolve) => server.close(resolve));
        runtime.db.close();
    }
}

main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
});
