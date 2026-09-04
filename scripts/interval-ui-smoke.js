const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer');
const { createApp } = require('../src/app');

async function main() {
    const root = path.resolve(__dirname, '..');
    fs.mkdirSync(path.join(root, 'artifacts'), { recursive: true });
    const runtime = createApp({ databasePath: ':memory:', masterKey: crypto.randomBytes(32), publicDir: path.join(root, 'public'),
        cookieSecure: false, trustProxy: false, sessionTtlMs: 3600000, automationConcurrency: 1, nodeEnv: 'test' }, {
        calendar: async () => ({ holidays: [], error: null }),
        verifyPortalCredentials: async () => { throw new Error('Unexpected credential request'); }
    });
    const server = runtime.app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const browser = await puppeteer.launch({ headless: true,
        args: process.env.GITHUB_ACTIONS === 'true' && process.platform === 'linux' ? ['--no-sandbox'] : [] });
    const page = await browser.newPage();
    const errors = [];
    let phase = 'signup';
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', async dialog => { errors.push(`Unexpected native ${dialog.type()}`); await dialog.dismiss(); });
    const click = async selector => {
        await page.$eval(selector, el => el.scrollIntoView({ block: 'center' }));
        await page.click(selector);
    };
    const editRange = async (editor, index, start, end) => {
        await page.$$eval(`${editor} .work-range`, (rows, index, start, end) => {
            rows[index].querySelector('.range-start').value = start;
            rows[index].querySelector('.range-end').value = end;
        }, index, start, end);
    };
    const applyDay = async () => {
        await click('#day-form button[type="submit"]');
        await page.waitForSelector('#day-dialog:not([open])');
    };
    const confirm = async () => {
        await page.waitForSelector('#action-confirm-dialog[open]');
        await click('#action-confirm-submit');
        await page.waitForFunction(() => !document.querySelector('#action-confirm-dialog').open && pendingConfirmation === null);
    };
    const save = async () => {
        const response = page.waitForResponse(r => r.request().method() === 'PUT' && r.url().includes('/api/schedules/'));
        await click('#save-schedule-button');
        assert.equal((await response).status(), 200);
    };
    try {
        await page.setViewport({ width: 1440, height: 1100 });
        await page.goto(base, { waitUntil: 'networkidle0' });
        await click('#signup-tab');
        for (const [id, value] of [['display-name', 'Interval test'], ['username', 'interval-test'], ['password', 'interval-test-password'], ['password-confirm', 'interval-test-password']]) {
            await page.type(`#${id}`, value);
        }
        await click('#auth-submit');
        await page.waitForSelector('#dashboard-view:not([hidden])');
        await page.waitForSelector('[data-day="1"]');
        phase = 'three intervals and 24-hour inputs';
        await click('[data-day="1"]');
        await click('#day-start');
        assert.deepEqual(await page.$eval('#day-start', el => [el.selectionStart, el.selectionEnd]), [0, 5]);
        await page.keyboard.type('930');
        await page.keyboard.press('Tab');
        assert.equal(await page.$eval('#day-start', el => el.value), '09:30');
        await page.keyboard.type('12');
        await page.keyboard.press('Tab');
        assert.equal(await page.$eval('#day-end', el => el.value), '12:00');
        await click('#day-start');
        await page.keyboard.type('9');
        await page.keyboard.press('Enter');
        await page.waitForSelector('#day-dialog:not([open])');
        assert.match(await page.$eval('[data-day="1"]', el => el.textContent), /09:00/);
        await click('[data-day="1"]');
        await editRange('#day-range-editor', 0, '0900', '1200');
        await click('#day-range-editor [data-add-range]');
        await editRange('#day-range-editor', 1, '1300', '1600');
        await click('#day-range-editor [data-add-range]');
        await editRange('#day-range-editor', 2, '1500', '2400');
        await click('#day-form button[type="submit"]');
        await page.waitForSelector('#day-error:not([hidden])');
        assert.match(await page.$eval('#day-error', el => el.textContent), /겹칩니다/);
        await editRange('#day-range-editor', 2, '2200', '2400');
        assert.equal(await page.$$eval('#day-range-editor input', inputs => inputs.every(input => input.type === 'text' && input.inputMode === 'numeric')), true);
        for (const width of [320, 390, 768, 1440]) {
            await page.setViewport({ width, height: 900 });
            assert.equal(await page.$eval('#day-dialog', el => el.scrollWidth > el.clientWidth), false);
            if (width === 390) await page.screenshot({ path: path.join(root, 'artifacts/intervals-mobile.png') });
        }
        await applyDay();
        assert.equal(await page.$$eval('[data-day="1"] .day-time', rows => rows.length), 3);
        assert.match(await page.$eval('#total-hours', el => el.textContent), /^8/);
        assert.match(await page.$eval('#work-days', el => el.textContent), /^1/);
        phase = 'real mouse drag copies all intervals';
        await page.setViewport({ width: 1440, height: 1100 });
        await page.$eval('#calendar', el => el.scrollIntoView({ block: 'center' }));
        const source = await (await page.$('[data-day="1"]')).boundingBox();
        const target = await (await page.$('[data-day="2"]')).boundingBox();
        await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
        await page.mouse.down();
        await page.mouse.move(source.x + source.width / 2 + 18, source.y + source.height / 2, { steps: 4 });
        await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 12 });
        await page.mouse.up();
        await page.waitForSelector('[data-day="2"].copyable-day');
        assert.equal(await page.$$eval('[data-day="2"] .day-time', rows => rows.length), 3);
        assert.equal(await page.$('dialog[open]'), null);
        await new Promise(resolve => setTimeout(resolve, 450));
        phase = 'manual-only deletion restores an empty date';
        await click('[data-day="1"]');
        await click('#remove-day-button');
        await confirm();
        await page.waitForSelector('#day-dialog:not([open])');
        assert.equal(await page.$('[data-day="1"].excluded-day'), null);
        assert.equal(await page.$('[data-day="1"].work-day'), null);
        await save();
        await page.reload({ waitUntil: 'networkidle0' });
        await page.waitForSelector('[data-day="2"].work-day');
        assert.equal(await page.$('[data-day="1"].excluded-day'), null);
        phase = 'remove one interval without removing the date';
        await click('[data-day="2"]');
        assert.equal(await page.$$eval('#day-ranges .work-range', rows => rows.length), 3);
        await click('#day-ranges [data-remove-range="1"]');
        await applyDay();
        assert.match(await page.$eval('#total-hours', el => el.textContent), /^5/);
        phase = 'multiple recurring ranges';
        const date = new Date();
        const weekday = new Date(date.getFullYear(), date.getMonth(), 3).getDay();
        const editor = `[data-repeat-day="${weekday}"]`;
        await click('#repeat-settings-button');
        await click(`${editor} input[type="checkbox"]`);
        await click(`${editor} .range-start`);
        await page.keyboard.type('8');
        await page.keyboard.press('Tab');
        await page.keyboard.type('11');
        await page.keyboard.press('Tab');
        assert.equal(await page.$eval(`${editor} .range-start`, el => el.value), '08:00');
        assert.equal(await page.$eval(`${editor} .range-end`, el => el.value), '11:00');
        await click(`${editor} [data-add-range]`);
        await editRange(editor, 1, '1200', '1500');
        await click(`${editor} [data-add-range]`);
        await editRange(editor, 2, '1600', '1800');
        await click('#repeat-form button[type="submit"]');
        await confirm();
        await page.waitForSelector('#repeat-dialog:not([open])');
        await click('[data-day="3"]');
        assert.equal(await page.$$eval('#day-ranges .work-range', rows => rows.length), 3);
        await click('#remove-day-button');
        await confirm();
        await page.waitForSelector('#day-dialog:not([open])');
        assert.ok(await page.$('[data-day="3"].excluded-day'));
        await save();
        const user = runtime.db.findUserByUsername('interval-test');
        const schedule = runtime.db.getSchedule(user.id, date.getFullYear(), date.getMonth() + 1);
        assert.equal(schedule.specialDates[1], undefined);
        assert.equal(schedule.vacationDates.includes(1), false);
        assert.equal(schedule.specialDates[2].length, 2);
        assert.equal(schedule.regularRules.length, 3);
        assert.equal(schedule.vacationDates.includes(3), true);
        assert.deepEqual(errors, []);
        console.log(JSON.stringify({ ok: true, splitShifts: true, midnightEnd: true, overlapBlocked: true,
            replaceTimeWithoutClearing: true, shortTimeInput: true, enterSubmitsShortTime: true,
            realMouseDragCopiesAllRanges: true, manualDeleteRestoresEmptyDate: true, recurringDeleteExcludesOnlyDate: true,
            savedAndReloaded: true, mobileWidths: [320, 390, 768, 1440], realPortalWrites: 0 }));
    } catch (error) {
        console.error(JSON.stringify({ phase, errors, openDialogs: await page.$$eval('dialog[open]', nodes => nodes.map(node => node.id)) }));
        await page.screenshot({ path: path.join(root, 'artifacts/intervals-failure.png'), fullPage: true });
        throw error;
    } finally {
        await browser.close();
        await new Promise(resolve => server.close(resolve));
        runtime.db.close();
    }
}
main().catch(error => { console.error(error); process.exit(1); });
