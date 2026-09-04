const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const ROOT_DIR = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT_DIR, 'users', 'LSH.json');
const LOGIN_URL = 'https://portal.dongyang.ac.kr/login_real.jsp?targetId=DMIS&RelayState=/';

const SELECTORS = {
    userId: '#user_id',
    userPassword: '#user_password',
    loginButton: 'button.btn_login',
    menuWorkStudy: 'a[data-itemid="ESERVICE_SCH04"]',
    inputSchoolYear: 'input[aria-label="학년도"]',
    inputWorkMonth: 'input[aria-label="근로월"]',
    btnSearch: '.btn-search'
};

const SECRET_KEY_PATTERN = /(pass|pwd|token|cookie|session|auth|user|student|std|name|email|phone|tel|jumin|member)/i;
const SAFE_VALUE_KEY_PATTERN = /(year|month|date|time|page|size|limit|offset|sort|order|command|menu|role|status|work|scho|dept|message|^strdt$|^strnat$)/i;

function summarizeValue(value, key = '') {
    if (Array.isArray(value)) {
        return {
            type: 'array',
            length: value.length,
            firstItem: value.length
                ? summarizeValue(value[0], value[0] && typeof value[0] === 'object' ? '' : key)
                : null
        };
    }
    if (SECRET_KEY_PATTERN.test(key)) return '[REDACTED]';
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value).slice(0, 30).map(([childKey, childValue]) => [
                childKey,
                summarizeValue(childValue, childKey)
            ])
        );
    }
    if (SAFE_VALUE_KEY_PATTERN.test(key)) return value;
    return { type: value === null ? 'null' : typeof value };
}

function summarizeBody(rawBody) {
    if (!rawBody) return null;
    try {
        return summarizeValue(JSON.parse(rawBody));
    } catch {
        const params = new URLSearchParams(rawBody);
        if ([...params.keys()].length > 0) {
            return Object.fromEntries([...params.entries()].map(([key, value]) => [
                key,
                SECRET_KEY_PATTERN.test(key)
                    ? '[REDACTED]'
                    : SAFE_VALUE_KEY_PATTERN.test(key)
                        ? value
                        : { type: 'string' }
            ]));
        }
        return { type: 'non-json', length: rawBody.length };
    }
}

function summarizeUrl(rawUrl) {
    const parsed = new URL(rawUrl);
    const query = {};
    for (const [key, value] of parsed.searchParams.entries()) {
        query[key] = SECRET_KEY_PATTERN.test(key)
            ? '[REDACTED]'
            : SAFE_VALUE_KEY_PATTERN.test(key)
                ? value
                : '{string}';
    }
    return {
        origin: parsed.origin,
        path: parsed.pathname,
        query
    };
}

async function setInput(page, selector, value) {
    await page.waitForSelector(selector, { timeout: 15_000 });
    const input = await page.$(selector);
    await input.click({ clickCount: 4 });
    await page.keyboard.down(process.platform === 'darwin' ? 'Meta' : 'Control');
    await page.keyboard.press('KeyA');
    await page.keyboard.up(process.platform === 'darwin' ? 'Meta' : 'Control');
    await page.keyboard.press('Backspace');
    await page.keyboard.type(value, { delay: 80 });
    await page.$eval(selector, (element) => {
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        element.blur();
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
}

async function clickText(page, text) {
    const clicked = await page.evaluate((targetText) => {
        const elements = document.querySelectorAll('a, button, [role="menuitem"], [role="link"], [role="button"], .cl-sidenavigation-item');
        for (const element of elements) {
            if ((element.textContent || '').trim() === targetText) {
                element.click();
                return true;
            }
        }
        return false;
    }, text);
    if (!clicked) throw new Error(`메뉴를 찾지 못했습니다: ${text}`);
}

async function main() {
    if (!fs.existsSync(CONFIG_PATH)) throw new Error('users/LSH.json 파일이 없습니다.');
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    if (!config.id || !config.password) throw new Error('LSH 포털 계정 정보가 비어 있습니다.');

    const year = Number(process.env.TARGET_YEAR || 2026);
    const month = Number(process.env.TARGET_MONTH || 6);
    const schoolYear = String(month >= 3 ? year : year - 1);
    const workMonth = `${year}년 ${month}월`;
    const exchanges = [];
    const pending = new Map();
    let capturedSearchRequest = null;
    let portalOptions = null;
    let approvedAssignments = [];
    let captureEnabled = false;

    const browser = await puppeteer.launch({
        headless: true,
        defaultViewport: { width: 1440, height: 1000 }
    });
    const page = await browser.newPage();

    page.on('dialog', async (dialog) => {
        await dialog.accept().catch(() => {});
    });

    page.on('request', (request) => {
        if (!captureEnabled || !['xhr', 'fetch'].includes(request.resourceType())) return;
        const record = {
            method: request.method(),
            url: summarizeUrl(request.url()),
            requestBody: summarizeBody(request.postData()),
            status: null,
            response: null
        };
        pending.set(request, record);
        exchanges.push(record);

        if (request.url().includes('/sub.SubWorkSchoE.do') && request.postData()?.includes('requestKey')) {
            capturedSearchRequest = {
                url: request.url(),
                method: request.method(),
                body: request.postData(),
                contentType: request.headers()['content-type'] || 'application/json'
            };
        }
    });

    page.on('response', async (response) => {
        const request = response.request();
        const record = pending.get(request);
        if (!record) return;
        record.status = response.status();
        const contentType = response.headers()['content-type'] || '';
        record.contentType = contentType.split(';')[0];
        if (!contentType.includes('json')) return;
        try {
            const body = await response.json();
            record.response = summarizeValue(body);
            if (Array.isArray(body?.listSchoCd) || Array.isArray(body?.listWorkDeptCd)) {
                portalOptions = {
                    scholarships: (body.listSchoCd || []).map((item) => ({ code: item.SCHO_CD, name: item.SCHO_NM })),
                    workDepartments: (body.listWorkDeptCd || []).map((item) => ({ code: item.DEPT_CD, name: item.DEPT_NM }))
                };
            }
            if (Array.isArray(body?.listStdno)) {
                approvedAssignments = body.listStdno.map((item) => ({
                    scholarshipCode: item.SCHO_CD,
                    workDepartmentCode: item.WORK_DEPT_CD,
                    startDate: item.ST_DT,
                    endDate: item.END_DT
                }));
            }
        } catch {
            record.response = { type: 'unreadable-json' };
        }
    });

    try {
        await page.goto(LOGIN_URL, { waitUntil: 'networkidle2', timeout: 30_000 });
        await page.type(SELECTORS.userId, config.id, { delay: 20 });
        await page.type(SELECTORS.userPassword, config.password, { delay: 20 });
        await Promise.all([
            page.click(SELECTORS.loginButton),
            page.waitForNetworkIdle({ idleTime: 800, timeout: 20_000 }).catch(() => {})
        ]);

        await page.waitForSelector(SELECTORS.menuWorkStudy, { timeout: 20_000 });
        captureEnabled = true;
        await page.click(SELECTORS.menuWorkStudy);
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        await clickText(page, '근로장학생일지');
        await new Promise((resolve) => setTimeout(resolve, 3_000));

        await setInput(page, SELECTORS.inputSchoolYear, schoolYear);
        await setInput(page, SELECTORS.inputWorkMonth, workMonth);
        await page.click(SELECTORS.btnSearch);
        await page.waitForNetworkIdle({ idleTime: 1_000, timeout: 15_000 }).catch(() => {});
        await new Promise((resolve) => setTimeout(resolve, 1_000));

        const gridSummary = await page.evaluate(() => {
            return [...document.querySelectorAll('.cl-grid')].map((grid, index) => {
                const headers = [...grid.querySelectorAll('.cl-grid-header .cl-text')]
                    .map((element) => (element.textContent || '').trim())
                    .filter(Boolean);
                const rows = [...grid.querySelectorAll('.cl-grid-detail .cl-grid-row[data-rowindex]')];
                return {
                    index,
                    id: grid.id || '',
                    headers,
                    rowCount: rows.length,
                    firstRowCellIndexes: rows[0]
                        ? [...rows[0].querySelectorAll('[data-cellindex]')].map((cell) => cell.getAttribute('data-cellindex'))
                        : []
                };
            });
        });
        const assignmentControls = await page.evaluate(() => {
            const allowed = /(학년도|근로월|장학|근로부서|근무부서|근무처|근로기관)/;
            return [...document.querySelectorAll('input, select, textarea, [role="combobox"]')]
                .map((element) => ({
                    tag: element.tagName.toLowerCase(),
                    id: element.id || '',
                    ariaLabel: element.getAttribute('aria-label') || '',
                    role: element.getAttribute('role') || '',
                    value: 'value' in element ? String(element.value || '') : '',
                    className: String(element.className || ''),
                    parentId: element.parentElement?.id || '',
                    parentClass: String(element.parentElement?.className || ''),
                    grandparentId: element.parentElement?.parentElement?.id || '',
                    grandparentClass: String(element.parentElement?.parentElement?.className || '')
                }))
                .filter((item) => allowed.test(item.ariaLabel));
        });
        const scholarshipInput = await page.$('input[aria-label="장학금"]');
        let scholarshipPopup = [];
        let scholarshipControlHtml = '';
        if (scholarshipInput) {
            scholarshipControlHtml = await scholarshipInput.evaluate((element) => {
                let current = element;
                for (let index = 0; index < 4 && current.parentElement; index += 1) current = current.parentElement;
                return current.outerHTML.slice(0, 5000);
            });
            await scholarshipInput.evaluate((element) => {
                const control = element.closest('.cl-combobox');
                (control?.querySelector('.cl-combobox-button') || element).click();
            });
            await new Promise((resolve) => setTimeout(resolve, 500));
            scholarshipPopup = await page.evaluate(() => {
                const candidates = [...document.querySelectorAll('[role="option"], [role="listbox"] *, .cl-listbox-item, .cl-combobox-list-item')];
                return candidates
                    .filter((element) => {
                        const style = getComputedStyle(element);
                        const rect = element.getBoundingClientRect();
                        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
                    })
                    .map((element) => ({
                        role: element.getAttribute('role') || '',
                        className: String(element.className || ''),
                        text: (element.textContent || '').trim()
                    }))
                    .filter((item) => item.text)
                    .slice(0, 30);
            });
            await page.keyboard.press('Escape');
        }

        let directApiReplay = null;
        let anonymousReplay = null;
        if (capturedSearchRequest) {
            directApiReplay = await page.evaluate(async (captured) => {
                const payload = JSON.parse(captured.body);
                payload.data.requestKey.strYear = '2026';
                payload.data.requestKey.strMonth = '06';

                const response = await fetch(captured.url, {
                    method: captured.method,
                    credentials: 'include',
                    headers: {
                        Accept: 'application/json, text/plain, */*',
                        'Content-Type': captured.contentType
                    },
                    body: JSON.stringify(payload)
                });
                const body = await response.json();
                return { status: response.status, body };
            }, capturedSearchRequest);

            const anonymousPayload = JSON.parse(capturedSearchRequest.body);
            anonymousPayload.data.requestKey.strYear = '2026';
            anonymousPayload.data.requestKey.strMonth = '06';
            const anonymousResponse = await fetch(capturedSearchRequest.url, {
                method: capturedSearchRequest.method,
                redirect: 'manual',
                headers: {
                    Accept: 'application/json, text/plain, */*',
                    'Content-Type': capturedSearchRequest.contentType
                },
                body: JSON.stringify(anonymousPayload)
            });
            const anonymousContentType = anonymousResponse.headers.get('content-type') || '';
            let anonymousBody = null;
            if (anonymousContentType.includes('json')) {
                anonymousBody = summarizeValue(await anonymousResponse.json());
            }
            anonymousReplay = {
                status: anonymousResponse.status,
                redirected: anonymousResponse.status >= 300 && anonymousResponse.status < 400,
                locationOrigin: anonymousResponse.headers.get('location')
                    ? new URL(anonymousResponse.headers.get('location'), capturedSearchRequest.url).origin
                    : null,
                contentType: anonymousContentType.split(';')[0],
                response: anonymousBody
            };
        }

        console.log(JSON.stringify({
            inspectedAt: new Date().toISOString(),
            target: { year, month },
            exchangeCount: exchanges.length,
            exchanges,
            gridSummary,
            assignmentControls,
            scholarshipPopup,
            scholarshipControlHtml,
            portalOptions,
            approvedAssignments,
            anonymousReplay,
            directApiReplay: directApiReplay
                ? {
                    target: { year: 2026, month: 6 },
                    status: directApiReplay.status,
                    response: summarizeValue(directApiReplay.body),
                    rowCount: Array.isArray(directApiReplay.body?.listStdno)
                        ? directApiReplay.body.listStdno.length
                        : null
                }
                : null
        }, null, 2));
    } finally {
        await browser.close();
    }
}

main().catch((error) => {
    console.error(`API 검사 실패: ${error.message}`);
    process.exitCode = 1;
});
