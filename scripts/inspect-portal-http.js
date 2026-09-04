const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer');

async function main() {
    const root = path.resolve(__dirname, '..');
    const account = JSON.parse(fs.readFileSync(path.join(root, 'users', 'LSH.json'), 'utf8'));
    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    const trace = [];
    const assets = [];
    const pending = [];
    const captureDelete = process.argv.includes('--capture-blocked-delete');
    const captureUpdate = process.argv.includes('--capture-blocked-update');
    const captureSave = process.argv.includes('--capture-blocked-save') || captureDelete || captureUpdate;
    let blockedSave = null;
    const alerts = [];
    let draft = null;
    let runtimeInfo = null;
    if (captureSave) {
        await page.setRequestInterception(true);
        page.on('request', async (request) => {
            if (new URL(request.url()).pathname === '/ui/app/sub/SubWorkSchoE.clx.js') {
                const source = await (await fetch(request.url())).text();
                const marker = 'onCreate:function(n,U){';
                if (!source.includes(marker)) return request.abort();
                return request.respond({ status: 200, contentType: 'application/javascript',
                    body: source.replace(marker, `${marker}window.__worklogDiagnosticApp=n;`) });
            }
            if (new URL(request.url()).pathname === '/sub.SubWorkSchoE.do' && request.method() === 'POST') {
                let payload;
                try { payload = JSON.parse(request.postData()); } catch { return request.abort(); }
                const commands = payload.param?.strCommand || [];
                if (commands.includes('Save')) {
                    const redact = (value, key = '') => {
                        if (/student|^nm$|^strNm$|strStudentNm|parentkey/i.test(key)) return '[SESSION VALUE]';
                        if (Array.isArray(value)) return value.map((entry) => redact(entry));
                        if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k)]));
                        return value;
                    };
                    blockedSave = redact(payload);
                    return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ dmMain: { errMessage: 'DIAGNOSTIC: Save blocked before network transmission' } }) });
                }
                if (!commands.every((command) => ['OnLoad', 'FindWork', 'Find', 'Bef', 'List', 'Checkweek', 'Vacation', 'Holi', 'Chgdeptcd'].includes(command))) return request.abort();
            }
            return request.continue();
        });
    }
    page.on('dialog', (dialog) => {
        alerts.push(dialog.message().replaceAll(account.id, '[ID]').replaceAll(account.password, '[PASSWORD]'));
        return dialog.accept();
    });
    page.on('request', (request) => {
        if (!request.isNavigationRequest() || request.frame() !== page.mainFrame()) return;
        const url = new URL(request.url());
        const body = request.postData();
        trace.push({ method: request.method(), origin: url.origin, path: url.pathname,
            queryKeys: [...url.searchParams.keys()], formKeys: body ? [...new URLSearchParams(body).keys()] : [] });
    });
    page.on('response', (response) => {
        const url = new URL(response.url());
        if (/SubWorkSchoE/.test(url.pathname) && /\.(js|clx)$/.test(url.pathname)) {
            pending.push((async () => {
                const source = await response.text();
                const dir = path.join(root, 'artifacts', 'portal-static');
                fs.mkdirSync(dir, { recursive: true });
                const file = path.join(dir, path.basename(url.pathname));
                fs.writeFileSync(file, source.replace('window.__worklogDiagnosticApp=n;', ''));
                assets.push({ path: url.pathname, file, length: source.length });
            })());
        }
    });
    try {
        await page.goto('https://portal.dongyang.ac.kr/login_real.jsp?targetId=DMIS&RelayState=/', { waitUntil: 'networkidle2' });
        await page.type('#user_id', account.id);
        await page.type('#user_password', account.password);
        await page.click('button.btn_login');
        await page.waitForSelector('a[data-itemid="ESERVICE_SCH04"]', { timeout: 30000 });
        await page.click('a[data-itemid="ESERVICE_SCH04"]');
        await new Promise((resolve) => setTimeout(resolve, 1800));
        await page.evaluate(() => {
            const menu = [...document.querySelectorAll('a, [role="menuitem"], .cl-sidenavigation-item')]
                .find((element) => element.textContent.trim() === '근로장학생일지');
            if (!menu) throw new Error('근로장학생일지 메뉴 없음');
            menu.click();
        });
        await page.waitForSelector('.btn-search');
        await new Promise((resolve) => setTimeout(resolve, 2500));
        runtimeInfo = await page.evaluate(() => ({
            appClass: Object.getOwnPropertyNames(cpr.core.App),
            instanceClass: Object.getOwnPropertyNames(cpr.core.AppInstance),
            buttons: [...document.querySelectorAll('.btn-search,.btn-new,.btn-save')].map((el) => ({ text: el.textContent, visible: Boolean(el.getClientRects().length), id: el.id }))
        }));
        if (captureSave) {
            await page.evaluate(({ deleteMode, updateMode }) => {
                const app = window.__worklogDiagnosticApp;
                if (!app) throw new Error('진단용 로컬 앱 인스턴스 없음');
                const request = app.lookup('dmRequestKey');
                const data = app.lookup('dsListMain');
                data.clearData();
                data.addRowData({
                    YEAR: '2026', SCHO_CD: request.getValue('strSchoCd'), WORK_DEPT_CD: request.getValue('strWorkDeptCd'),
                    STUDENT_NO: request.getValue('strStudentNo'), NM: request.getValue('strStudentNm'),
                    WORK_DT: '20260901', SEQ: '1', ST_HHMI: '1300', END_HHMI: '1400', WORK_MI: '0100',
                    REMARK: 'API schema diagnostic (network blocked)'
                });
                if (deleteMode) {
                    data.setRowState(0, cpr.data.tabledata.RowState.UNCHANGED);
                    data.deleteRow(0);
                }
                if (updateMode) {
                    data.setRowState(0, cpr.data.tabledata.RowState.UNCHANGED);
                    data.setValue(0, 'REMARK', 'Updated API diagnostic (network blocked)');
                }
                createCommonUtil().Submit.sendX(app, 'subSave', 'Save', () => {});
            }, { deleteMode: captureDelete, updateMode: captureUpdate });
            await new Promise((resolve) => setTimeout(resolve, 2000));
            draft = await page.evaluate(() => [...document.querySelectorAll('input[aria-label="일자"],input[aria-label="시작시간"],input[aria-label="종료시간"],textarea[aria-label="근무내용"]')].map((input) => ({ label: input.getAttribute('aria-label'), value: input.value })));
        }
        for (const promise of pending) await promise;
        const resources = await page.evaluate(() => performance.getEntriesByType('resource')
            .map((entry) => new URL(entry.name).pathname).filter((url) => /SubWorkScho|Main|CmnAppHeader|sso/i.test(url)));
        console.log(JSON.stringify({ trace, assets, resources: [...new Set(resources)], blockedSave, alerts, draft, runtimeInfo, writes: 0 }, null, 2));
    } finally {
        await browser.close();
    }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
