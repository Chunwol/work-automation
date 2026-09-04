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
            for (const input of rows[index].querySelectorAll('input')) {
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
            }
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
        assert.equal(await page.$eval('#day-range-editor [data-remove-range]', el => el.hidden), true);
        assert.equal(await page.$eval('#day-duration', el => el.textContent), '1구간 · 총 8시간');
        await page.$eval('#day-dialog', async el => { await Promise.all(el.getAnimations().map(animation => animation.finished)); });
        await (await page.$('#day-dialog')).screenshot({ path: path.join(root, 'artifacts/intervals-day-single.png') });
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
        assert.equal(await page.$eval('#day-error', el => el.hidden), true);
        assert.equal(await page.$eval('#day-duration', el => el.textContent), '3구간 · 총 8시간');
        await click('#day-excluded');
        assert.equal(await page.$eval('#day-duration', el => el.textContent), '근무 제외');
        assert.equal(await page.$$eval('#day-range-editor input', inputs => inputs.every(input => input.disabled)), true);
        await click('#day-excluded');
        assert.equal(await page.$eval('#day-duration', el => el.textContent), '3구간 · 총 8시간');
        assert.equal(await page.$$eval('#day-range-editor input', inputs => inputs.every(input => input.type === 'text' && input.inputMode === 'numeric')), true);
        const dayWidths = [320, 390, 560, 600, 768, 1440];
        for (const width of dayWidths) {
            await page.setViewport({ width, height: 900 });
            assert.equal(await page.$eval('#day-dialog', el => el.scrollWidth > el.clientWidth), false);
            const rows = await page.$$eval('#day-ranges .work-range', rows => rows.map(row => {
                const rect = selector => row.querySelector(selector).getBoundingClientRect().toJSON();
                return { start: rect('.range-start'), end: rect('.range-end'), remove: rect('.range-remove'),
                    border: getComputedStyle(row).borderWidth, height: row.getBoundingClientRect().height };
            }));
            for (const row of rows) {
                assert.ok(Math.abs(row.start.width - row.end.width) < 1, `day equal widths at ${width}`);
                assert.ok(Math.abs(row.start.top - row.end.top) < 1, `day aligned times at ${width}`);
                assert.ok(row.start.width >= 80, `day readable input at ${width}`);
                assert.equal(row.start.height, 48);
                assert.equal(row.end.height, 48);
                assert.equal(row.border, '0px');
                assert.ok(row.remove.width >= 44 && row.remove.height >= 44);
                assert.ok(row.height <= (width > 560 ? 100 : 150));
            }
            await page.$eval('#day-dialog-body', el => { el.scrollTop = 0; });
            await (await page.$('#day-dialog')).screenshot({ path: path.join(root, 'artifacts', `intervals-day-${width}.png`) });
        }
        await page.setViewport({ width: 390, height: 360 });
        await page.focus('#day-ranges .work-range:last-child .range-end');
        await page.waitForFunction(() => {
            const input = document.activeElement;
            const rect = input.getBoundingClientRect();
            const body = document.querySelector('#day-dialog-body').getBoundingClientRect();
            return rect.top >= body.top && rect.bottom <= body.bottom
                && input === document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        });
        await page.keyboard.press('Tab');
        assert.equal(await page.evaluate(() => document.activeElement.dataset.removeRange), '2');
        await (await page.$('#day-dialog')).screenshot({ path: path.join(root, 'artifacts/intervals-day-keyboard.png') });
        await page.setViewport({ width: 1440, height: 1100 });
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
        await page.$eval('#repeat-dialog', async el => {
            await Promise.all(el.getAnimations().map(animation => animation.finished));
        });
        phase = 'compact inactive weekdays and keyboard toggles';
        for (const width of [1440, 390, 320]) {
            await page.setViewport({ width, height: 900 });
            assert.equal(await page.$$eval('.repeat-row [data-add-range]', buttons => buttons.every(button => button.hidden)), true);
            assert.equal(await page.$$eval('.repeat-row', rows => rows.every(row => row.getBoundingClientRect().height <= 54)), true);
            assert.equal(await page.$eval('#repeat-list', el => el.scrollHeight > el.clientHeight), false);
            await (await page.$('#repeat-dialog')).screenshot({ path: path.join(root, 'artifacts', `repeat-layout-empty-${width}.png`) });
        }
        await page.setViewport({ width: 1440, height: 900 });
        await page.focus(`${editor} input[type="checkbox"]`);
        await page.keyboard.press('Space');
        assert.equal(await page.$eval(`${editor} [data-add-range]`, el => el.hidden), false);
        assert.equal(await page.$eval(`${editor} [data-remove-range]`, el => el.hidden), true);
        assert.equal(await page.$eval('#repeat-selection-count', el => el.textContent), '1일 선택');
        await page.keyboard.press('Space');
        phase = 'multiple recurring ranges';
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
        const savedInputs = await page.$$eval(`${editor} .time-input`, inputs => inputs.map(input => input.value.replace(':', '')));
        await click(`${editor} input[type="checkbox"]`);
        assert.equal(await page.$eval(`${editor} [data-range-list]`, el => el.hidden), true);
        await click(`${editor} input[type="checkbox"]`);
        assert.deepEqual(await page.$$eval(`${editor} .time-input`, inputs => inputs.map(input => input.value.replace(':', ''))), savedInputs);
        const repeatLayouts = [];
        for (const width of [1440, 1024, 768, 560, 430, 390, 320]) {
            await page.setViewport({ width, height: 900 });
            await page.$eval('#repeat-dialog', el => { el.scrollTop = 0; });
            await page.waitForFunction(() => {
                const rect = document.querySelector('#repeat-dialog').getBoundingClientRect();
                return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight;
            });
            await page.focus(`${editor} .work-range:last-child .range-end`);
            await page.waitForFunction(selector => {
                const input = document.querySelector(selector);
                const rect = input.getBoundingClientRect();
                const list = document.querySelector('#repeat-list').getBoundingClientRect();
                return rect.top >= list.top && rect.bottom <= list.bottom;
            }, {}, `${editor} .work-range:last-child .range-end`);
            const layout = await page.$$eval(`${editor} .work-range`, rows => rows.map((row, index) => {
                const start = row.querySelector('.range-start').getBoundingClientRect();
                const end = row.querySelector('.range-end').getBoundingClientRect();
                const remove = row.querySelector('[data-remove-range]').getBoundingClientRect();
                const box = row.getBoundingClientRect();
                const style = getComputedStyle(row);
                const divider = index > 0 ? getComputedStyle(row, '::before') : null;
                return { width: box.width, height: box.height, start: start.toJSON(), end: end.toJSON(), remove: remove.toJSON(),
                    borderWidth: style.borderWidth, borderRadius: style.borderRadius,
                    dividerHeight: divider?.height ?? null };
            }));
            repeatLayouts.push({ width, rows: layout });
            for (const row of layout) {
                assert.ok(Math.abs(row.start.width - row.end.width) < 1, `equal field widths at ${width}`);
                assert.ok(Math.abs(row.start.y - row.end.y) < 1, `aligned input row at ${width}`);
                assert.equal(row.start.height, 48);
                assert.equal(row.end.height, 48);
                assert.equal(row.borderWidth, '0px', `flat interval row at ${width}`);
                assert.equal(row.borderRadius, '0px', `no interval card at ${width}`);
                if (row.dividerHeight !== null) assert.equal(row.dividerHeight, '1px');
                assert.ok(row.start.width >= 80, `readable time field at ${width}`);
                assert.ok(row.height <= (width > 560 ? 100 : 150), `compact interval at ${width}`);
                assert.ok(row.start.right < row.end.left, `non-overlapping fields at ${width}`);
                assert.ok(row.remove.width >= 44 && row.remove.height >= 44, `touch target at ${width}`);
                if (width > 560) assert.equal(row.remove.bottom, row.end.bottom);
            }
            const weekdayRows = await page.$$eval('.repeat-row', rows => rows.map((row, index) => {
                const style = getComputedStyle(row);
                const divider = index > 0 ? getComputedStyle(row, '::before') : null;
                return { border: style.borderWidth, radius: style.borderRadius,
                    divider: divider ? [divider.height, divider.left, divider.right] : null };
            }));
            for (const row of weekdayRows) {
                assert.equal(row.border, '0px');
                assert.equal(row.radius, '0px');
                if (row.divider) assert.deepEqual(row.divider, ['1px', '10px', '10px']);
            }
            assert.equal(await page.$eval('#repeat-list', el => el.scrollWidth > el.clientWidth), false);
            await page.keyboard.press('Tab');
            assert.equal(await page.evaluate(() => document.activeElement.dataset.removeRange), '2');
            await (await page.$('#repeat-dialog')).screenshot({ path: path.join(root, 'artifacts', `${process.env.REPEAT_CAPTURE_PREFIX || 'repeat-layout'}-${width}.png`) });
            if ([1440, 390].includes(width)) await (await page.$(editor)).screenshot({ path: path.join(root, 'artifacts', `repeat-layout-section-${width}.png`) });
        }
        fs.writeFileSync(path.join(root, 'artifacts', `${process.env.REPEAT_CAPTURE_PREFIX || 'repeat-layout'}.json`), JSON.stringify(repeatLayouts, null, 2));
        await page.setViewport({ width: 390, height: 360 });
        await page.focus(`${editor} .work-range:last-child .range-end`);
        await page.waitForFunction(selector => {
            const input = document.querySelector(selector);
            const rect = input.getBoundingClientRect();
            return input === document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
                && rect.top >= document.querySelector('#repeat-list').getBoundingClientRect().top
                && rect.bottom <= document.querySelector('#repeat-list').getBoundingClientRect().bottom;
        }, {}, `${editor} .work-range:last-child .range-end`);
        await (await page.$('#repeat-dialog')).screenshot({ path: path.join(root, 'artifacts/repeat-layout-keyboard.png') });
        await page.setViewport({ width: 1440, height: 1100 });
        await click('#repeat-form button[type="submit"]');
        await confirm();
        await page.waitForSelector('#repeat-dialog:not([open])');
        phase = 'manual override deletion restores all recurring ranges';
        const recurringRules = await page.evaluate(() => state.schedule.regularRules);
        await click('[data-day="3"]');
        assert.equal(await page.$$eval('#day-ranges .work-range', rows => rows.length), 3);
        await editRange('#day-range-editor', 0, '0900', '1000');
        await applyDay();
        assert.ok(await page.$('[data-day="3"].override-day'));
        const beforeCancel = await page.evaluate(() => JSON.stringify(state.schedule));
        await click('[data-day="3"]');
        await click('#remove-day-button');
        await page.waitForSelector('#action-confirm-dialog[open]');
        assert.match(await page.$eval('#action-confirm-title', el => el.textContent), /반복 일정으로/);
        assert.match(await page.$eval('#action-confirm-details', el => el.textContent), /08:00 ~ 11:00, 12:00 ~ 15:00, 16:00 ~ 18:00/);
        await page.setViewport({ width: 320, height: 740 });
        await page.$eval('#action-confirm-dialog', async el => { await Promise.all(el.getAnimations().map(animation => animation.finished)); });
        assert.equal(await page.$eval('#action-confirm-dialog', el => el.scrollWidth > el.clientWidth), false);
        assert.equal(await page.$eval('#action-confirm-submit', el => {
            const box = el.getBoundingClientRect();
            return box.top >= 0 && box.bottom <= innerHeight
                && el.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2));
        }), true);
        await (await page.$('#action-confirm-dialog')).screenshot({ path: path.join(root, 'artifacts/intervals-restore-recurring-mobile.png') });
        await click('#action-confirm-cancel');
        await page.waitForFunction(() => !document.querySelector('#action-confirm-dialog').open && pendingConfirmation === null);
        assert.equal(await page.evaluate(() => JSON.stringify(state.schedule)), beforeCancel);
        await click('#remove-day-button');
        await confirm();
        await page.waitForSelector('#day-dialog:not([open])');
        await page.setViewport({ width: 1440, height: 1100 });
        assert.ok(await page.$('[data-day="3"].work-day:not(.override-day):not(.excluded-day)'));
        assert.equal(await page.$$eval('[data-day="3"] .day-time', rows => rows.length), 3);
        assert.match(await page.$eval('[data-day="3"] .day-time', el => el.textContent), /08:00/);
        assert.deepEqual(await page.evaluate(() => state.schedule.regularRules), recurringRules);
        await save();
        await page.reload({ waitUntil: 'networkidle0' });
        await page.waitForSelector('[data-day="3"].work-day:not(.override-day):not(.excluded-day)');
        assert.equal(await page.evaluate(() => state.schedule.specialDates['3']), undefined);
        assert.equal(await page.evaluate(() => state.schedule.vacationDates.includes(3)), false);
        phase = 'equal-time manual override also restores recurring rules';
        await click('[data-day="3"]');
        await applyDay();
        assert.ok(await page.$('[data-day="3"].override-day'));
        await click('[data-day="3"]');
        await click('#remove-day-button');
        await confirm();
        await page.waitForSelector('#day-dialog:not([open])');
        assert.ok(await page.$('[data-day="3"].work-day:not(.override-day):not(.excluded-day)'));
        phase = 'deleting recurring-only day still excludes only that date';
        await click('[data-day="3"]');
        await click('#remove-day-button');
        await page.waitForSelector('#action-confirm-dialog[open]');
        assert.match(await page.$eval('#action-confirm-details', el => el.textContent), /이 날짜만 반복 일정에서 제외/);
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
            repeatLayoutWidths: repeatLayouts.map(item => item.width), repeatInsetDividers: true, repeatKeyboardViewport: true,
            dayLayoutWidths: dayWidths, dayDurationSummary: true, dayKeyboardViewport: true,
            realMouseDragCopiesAllRanges: true, manualDeleteRestoresEmptyDate: true, recurringDeleteExcludesOnlyDate: true,
            manualOverrideDeletionRestoresRecurring: true, recurringRestorationPersisted: true, equalTimeOverrideRestored: true,
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
