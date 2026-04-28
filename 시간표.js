// 콘솔 인코딩 설정 (Windows 한글 깨짐 방지)
if (process.platform === 'win32') {
    const { execSync } = require('child_process');
    try {
        execSync('chcp 65001', { stdio: 'ignore' });
    } catch (e) {
        // 무시
    }
}

const puppeteer = require('puppeteer');
const readlineSync = require('readline-sync');
const fs = require('fs');
const path = require('path');

// ==========================================
// 1. 사용자 설정 로드
// ==========================================

const userName = readlineSync.question('사용자 이름을 입력하세요: ');
const userConfigPath = path.join(__dirname, 'users', `${userName}.json`);

if (!fs.existsSync(userConfigPath)) {
    console.error(`❌ 오류: ${userConfigPath} 파일을 찾을 수 없습니다.`);
    console.error(`사용자 설정 파일을 생성해주세요: users/${userName}.json`);
    process.exit(1);
}

const userConfig = JSON.parse(fs.readFileSync(userConfigPath, 'utf8'));

// ==========================================
// 2. 페이지 셀렉터 (새 포털 DOM 기준)
// ==========================================

const LOGIN_URL = 'https://portal.dongyang.ac.kr/login_real.jsp?targetId=DMIS&RelayState=/';

const SELECTORS = {
    // 로그인
    userId: '#user_id',
    userPassword: '#user_password',
    loginButton: 'button.btn_login',
    // 메뉴 (근로장학생 → 근로장학생일지는 텍스트로 클릭)
    menuWorkStudy: 'a[data-itemid="ESERVICE_SCH04"]',
    // 일지 화면 (조회 전 확인)
    inputSchoolYear: 'input[aria-label="학년도"]',
    inputWorkMonth: 'input[aria-label="근로월"]',
    btnSearch: '.btn-search',
    btnNew: '.btn-new',
    inputDate: 'input[aria-label="일자"]',
    inputStart: 'input[aria-label="시작시간"]',
    inputEnd: 'input[aria-label="종료시간"]',
    inputContent: 'textarea[aria-label="근무내용"]',
};

// ==========================================
// 3. 사용자 설정에서 데이터 로드
// ==========================================

const REGULAR_RULES = userConfig.regularRules || [];
const SPECIAL_DATES = userConfig.specialDates || {};
const VACATION_DATES = userConfig.vacationDates || [];
const SCHEDULE_INFO = userConfig.schedule || { year: 2026, month: 1, content: '실습실 점검' };
const CLEANUP_UNEXPECTED_ROWS = Boolean(userConfig.cleanupUnexpectedRows);

const HOLIDAY_API_BASE_URL = 'https://date.nager.at/api/v3/PublicHolidays';
const HOLIDAY_COUNTRY_CODE = 'KR';

async function fetchPublicHolidayDays(year, month) {
    const monthText = String(month).padStart(2, '0');
    const url = `${HOLIDAY_API_BASE_URL}/${year}/${HOLIDAY_COUNTRY_CODE}`;
    const response = await fetch(url, {
        headers: {
            'User-Agent': 'work-log-automation/1.0'
        }
    });

    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }

    const holidays = await response.json();
    if (!Array.isArray(holidays)) {
        throw new Error('응답 형식 오류');
    }

    const days = holidays
        .map(item => String(item?.date || ''))
        .filter(date => date.startsWith(`${year}-${monthText}-`))
        .map(date => Number(date.slice(8, 10)))
        .filter(day => Number.isInteger(day));

    return new Set(days);
}

// ==========================================
// 4. 스케줄 생성기
// ==========================================

function generateSchedule(publicHolidayDays = new Set()) {
    const logs = [];
    const lastDay = new Date(SCHEDULE_INFO.year, SCHEDULE_INFO.month, 0).getDate();
    const days = ['일', '월', '화', '수', '목', '금', '토'];

    for (let day = 1; day <= lastDay; day++) {
        const dateObj = new Date(SCHEDULE_INFO.year, SCHEDULE_INFO.month - 1, day);
        const dayIdx = dateObj.getDay();
        const dayChar = days[dayIdx];
        const dateStr = `${SCHEDULE_INFO.year}${String(SCHEDULE_INFO.month).padStart(2, '0')}${String(day).padStart(2, '0')}`;

        if (publicHolidayDays.has(day)) {
            console.log(`🎉 공휴일 제외: ${dateStr}(${dayChar})`);
            continue;
        }
        if (VACATION_DATES.includes(day)) {
            console.log(`🏖️  휴가 제외: ${dateStr}(${dayChar})`);
            continue;
        }
        if (SPECIAL_DATES[day]) {
            logs.push({
                date: dateStr,
                start: SPECIAL_DATES[day].start,
                end: SPECIAL_DATES[day].end,
                week: dayChar
            });
            continue;
        }
        if (day <= 32) {
            const rule = REGULAR_RULES.find(r => r.day === dayIdx);
            if (rule) {
                logs.push({
                    date: dateStr,
                    start: rule.start,
                    end: rule.end,
                    week: rule.week
                });
            }
        }
    }
    return logs.sort((a, b) => a.date - b.date);
}

// ==========================================
// 5. 로그인 및 네비게이션 (DOM 기반)
// ==========================================

async function loginAndNavigate(page) {
    console.log('🔐 로그인 시작...');

    await page.goto(LOGIN_URL, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 1500));

    await page.waitForSelector(SELECTORS.userId, { timeout: 10000 });
    await page.type(SELECTORS.userId, userConfig.id, { delay: 50 });
    await new Promise(r => setTimeout(r, 200));
    await page.type(SELECTORS.userPassword, userConfig.password, { delay: 50 });
    await new Promise(r => setTimeout(r, 300));

    await page.click(SELECTORS.loginButton);
    console.log('⏳ 로그인 처리 중...');
    await new Promise(r => setTimeout(r, 4000));

    console.log('✅ 로그인 완료');

    console.log('📋 근로장학생 메뉴로 이동...');
    await page.waitForSelector(SELECTORS.menuWorkStudy, { timeout: 15000 });
    await page.click(SELECTORS.menuWorkStudy);
    await new Promise(r => setTimeout(r, 1500));

    console.log('📝 근로장학생일지 메뉴로 이동...');
    await page.evaluate(() => {
        const items = document.querySelectorAll('a, [role="menuitem"], [role="link"], .cl-sidenavigation-item');
        for (const el of items) {
            if (el.textContent.trim() === '근로장학생일지') {
                el.click();
                return;
            }
        }
    });
    await new Promise(r => setTimeout(r, 3000));
}

// 텍스트로 버튼 클릭 (저장, 확인 등)
async function clickButtonByText(page, text) {
    await page.evaluate((btnText) => {
        const candidates = document.querySelectorAll('button, [role="button"], .cl-control, .cl-button');
        for (const el of candidates) {
            if (el.textContent.trim() === btnText) {
                el.click();
                return;
            }
        }
        // 확인 등이 div.cl-text 안에만 있는 경우
        const textEls = document.querySelectorAll('.cl-text');
        for (const el of textEls) {
            if (el.textContent.trim() === btnText) {
                (el.closest('button') || el.closest('[role="button"]') || el.parentElement || el).click();
                return;
            }
        }
    }, text);
}

async function setInputValueAndVerify(page, selector, value) {
    const expected = String(value || '').replace(/\D/g, '');
    const result = await page.evaluate((targetSelector, targetValue, expectedDigits) => {
        const el = document.querySelector(targetSelector);
        if (!el) return { ok: false, actual: '' };

        el.focus();
        const proto = Object.getPrototypeOf(el);
        const valueSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (valueSetter) {
            valueSetter.call(el, targetValue);
        } else {
            el.value = targetValue;
        }

        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.blur();

        const actualDigits = String(el.value || '').replace(/\D/g, '');
        return { ok: actualDigits === expectedDigits, actual: actualDigits };
    }, selector, String(value || ''), expected);

    return result;
}

function normalizePortalDateToYmd(text) {
    const raw = String(text || '').trim();
    if (!raw) return '';
    const digits = raw.replace(/\D/g, '');
    if (digits.length === 8) return digits;
    return '';
}

function normalizePortalTimeToHm(text) {
    const raw = String(text || '').trim();
    if (!raw) return '';
    const digits = raw.replace(/\D/g, '');
    if (digits.length >= 4) return digits.slice(0, 4);
    return '';
}

function buildLogKey(date, start, end) {
    return `${date}|${start}|${end}`;
}

async function readExistingRows(page) {
    return page.evaluate(() => {
        const pickCellText = (row, idx) => {
            const cell = row.querySelector(`[data-cellindex="${idx}"]`);
            if (!cell) return '';
            const textEl = cell.querySelector('.cl-text');
            return (textEl?.textContent || '').trim();
        };

        const rows = [];
        const gridRows = document.querySelectorAll('.cl-grid-detail [data-role="rowgroup"][data-loc="middle"] .cl-grid-row[data-rowindex]');
        for (const row of gridRows) {
            const dateText = pickCellText(row, 3);
            const startText = pickCellText(row, 8);
            const endText = pickCellText(row, 9);
            if (!dateText) continue;
            rows.push({
                dateText,
                startText,
                endText
            });
        }
        return rows;
    });
}

async function selectRowsForDelete(page, keysToDelete) {
    if (!keysToDelete.length) return 0;
    return page.evaluate((keys) => {
        const keySet = new Set(keys);
        const normalizeDate = (text) => {
            const digits = String(text || '').replace(/\D/g, '');
            return digits.length === 8 ? digits : '';
        };
        const normalizeTime = (text) => {
            const digits = String(text || '').replace(/\D/g, '');
            return digits.length >= 4 ? digits.slice(0, 4) : '';
        };

        const pickCellText = (row, idx) => {
            const cell = row.querySelector(`[data-cellindex="${idx}"]`);
            if (!cell) return '';
            const textEl = cell.querySelector('.cl-text');
            return (textEl?.textContent || '').trim();
        };

        let selected = 0;
        const gridRows = document.querySelectorAll('.cl-grid-detail [data-role="rowgroup"][data-loc="middle"] .cl-grid-row[data-rowindex]');
        for (const row of gridRows) {
            const date = normalizeDate(pickCellText(row, 3));
            const start = normalizeTime(pickCellText(row, 8));
            const end = normalizeTime(pickCellText(row, 9));
            if (!date) continue;
            const key = `${date}|${start}|${end}`;
            if (!keySet.has(key)) continue;

            const checkbox = row.querySelector('[data-cellindex="0"] .cl-checkbox-icon[role="checkbox"]');
            if (!checkbox) continue;
            const checked = checkbox.getAttribute('aria-checked') === 'true';
            if (!checked) {
                checkbox.click();
                selected += 1;
            }
        }
        return selected;
    }, keysToDelete);
}

// ==========================================
// 6. 실행 로직
// ==========================================

(async () => {
    console.log('\n=======================================================');
    console.log(`사용자: ${userName}`);
    console.log('=======================================================\n');

    let publicHolidayDays;
    try {
        publicHolidayDays = await fetchPublicHolidayDays(SCHEDULE_INFO.year, SCHEDULE_INFO.month);
        console.log(`🎌 공휴일 API 로드 완료: ${SCHEDULE_INFO.year}-${String(SCHEDULE_INFO.month).padStart(2, '0')} (${publicHolidayDays.size}일)`);
    } catch (e) {
        console.error(`❌ 공휴일 API 조회 실패: ${e.message}`);
        process.exit(1);
    }

    const workLogs = generateSchedule(publicHolidayDays);
    console.log(`📅 설정된 규칙에 따라 ${workLogs.length}개의 일정을 생성했습니다.`);
    console.table(workLogs);

    const browser = await puppeteer.launch({
        headless: false,
        defaultViewport: null,
        args: ['--start-maximized']
    });
    const page = await browser.newPage();

    let shouldStop = false;
    let loginFailed = false;
    let sawNotApprovedDialog = false;

    page.on('dialog', async (dialog) => {
        const message = dialog.message();
        console.log(`🔔 Alert: ${message}`);

        const normalAlerts = ['해외 체류 기간', '국가근로장학생 해외', '학생지원팀'];
        if (normalAlerts.some(k => message.includes(k))) {
            console.log('ℹ️  정상 알림입니다. 계속 진행합니다.');
            await dialog.accept();
            return;
        }

        const loginFailureMessages = ['로그인 실패', '비밀번호가', '일치하지', '사용자를 찾을 수 없', '오류가 발생'];
        if (!loginFailed && loginFailureMessages.some(k => message.includes(k))) {
            console.error('❌ 로그인 실패:', message);
            loginFailed = true;
            shouldStop = true;
            await dialog.accept();
            await browser.close();
            process.exit(1);
        }

        if (message.includes('해당 연월에 근로장학생으로 승인되지 않았습니다') || message.includes('해당연월의 근로장학생으로 승인되지 않았습니다')) {
            // 초기 진입 시 기본 월 기준 알림이 먼저 뜰 수 있어 즉시 종료하지 않고 넘긴다.
            sawNotApprovedDialog = true;
            console.warn('⚠️  미승인 알림 감지: 근로월 변경/조회 후 최종 상태를 다시 확인합니다.');
            await dialog.accept();
            return;
        }
        await dialog.accept();
    });

    try {
        await loginAndNavigate(page);
    } catch (e) {
        console.error('❌ 로그인/네비게이션 실패:', e.message);
        await browser.close();
        process.exit(1);
    }

    if (shouldStop || loginFailed) {
        await browser.close();
        return;
    }

    // 근로장학생 페이지 진입 시 확인 팝업이 연속으로 뜰 수 있어 여러 번 닫는다.
    console.log('🔔 페이지 알림 확인 클릭...');
    await new Promise(r => setTimeout(r, 1500));
    for (let i = 0; i < 3; i++) {
        await clickButtonByText(page, '확인');
        await new Promise(r => setTimeout(r, 400));
    }

    // 학년도·근로월 확인 후 필요 시 변경 (3월~다음해 2월 = 해당 학년도. 예: 2026년 2월 → 2025 학년도)
    const year = SCHEDULE_INFO.year;
    const month = SCHEDULE_INFO.month;
    const expectedSchoolYear = String(month >= 3 ? year : year - 1);
    const expectedWorkMonth = `${year}년 ${month}월`;

    await page.waitForSelector(SELECTORS.inputSchoolYear, { timeout: 10000 }).catch(() => null);
    await page.waitForSelector(SELECTORS.inputWorkMonth, { timeout: 10000 }).catch(() => null);
    await new Promise(r => setTimeout(r, 300));

    const schoolYearEl = await page.$(SELECTORS.inputSchoolYear);
    if (schoolYearEl) {
        const current = await page.evaluate(el => el.value || '', schoolYearEl);
        if (current.trim() !== expectedSchoolYear) {
            console.log(`📌 학년도 변경: "${current}" → "${expectedSchoolYear}"`);
            await schoolYearEl.click({ clickCount: 3 });
            await page.keyboard.press('Backspace');
            await page.keyboard.type(expectedSchoolYear, { delay: 80 });
            await new Promise(r => setTimeout(r, 200));
        } else {
            console.log(`📌 학년도 확인: ${expectedSchoolYear}`);
        }
    }

    const workMonthEl = await page.$(SELECTORS.inputWorkMonth);
    if (workMonthEl) {
        const current = await page.evaluate(el => el.value || '', workMonthEl);
        if (current.trim() !== expectedWorkMonth) {
            console.log(`📌 근로월 변경: "${current}" → "${expectedWorkMonth}"`);
            await workMonthEl.click({ clickCount: 3 });
            await page.keyboard.down('Control');
            await page.keyboard.press('KeyA');
            await page.keyboard.up('Control');
            await page.keyboard.press('Backspace');
            await page.keyboard.type(expectedWorkMonth, { delay: 80 });
            await page.evaluate((selector) => {
                const el = document.querySelector(selector);
                if (el) {
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                    el.blur();
                }
            }, SELECTORS.inputWorkMonth);
            await new Promise(r => setTimeout(r, 200));
        } else {
            console.log(`📌 근로월 확인: ${expectedWorkMonth}`);
        }
    }

    console.log('🚀 일정 입력 시작...');
    console.log('🔄 조회...');
    await page.waitForSelector(SELECTORS.btnSearch, { timeout: 10000 });
    await page.click(SELECTORS.btnSearch);
    await new Promise(r => setTimeout(r, 1500));

    // 조회 후 페이지 내 알림: "해당연월의 근로장학생으로 승인되지 않았습니다" → 창은 열어두고 프로그램만 종료
    const notApproved = await page.evaluate(() => {
        const text = document.body.innerText || '';
        return text.includes('해당연월의 근로장학생으로 승인되지 않았습니다') ||
               text.includes('해당 연월에 근로장학생으로 승인되지 않았습니다');
    });
    if (notApproved) {
        console.error('❌ 해당 연월의 근로장학생으로 승인되지 않았습니다. 브라우저 창에서 확인 후 닫아주세요.');
        process.exit(1);
    }

    if (sawNotApprovedDialog) {
        console.log('ℹ️  초기 미승인 알림은 무시하고, 조회 결과 기준으로 계속 진행합니다.');
    }

    await new Promise(r => setTimeout(r, 300));

    const existingRows = await readExistingRows(page);
    const existingKeys = new Set();
    const existingByDate = new Map();

    for (const row of existingRows) {
        const date = normalizePortalDateToYmd(row.dateText);
        const start = normalizePortalTimeToHm(row.startText);
        const end = normalizePortalTimeToHm(row.endText);
        if (!date || !start || !end) continue;

        const key = buildLogKey(date, start, end);
        existingKeys.add(key);
        if (!existingByDate.has(date)) existingByDate.set(date, new Set());
        existingByDate.get(date).add(key);
    }

    const desiredKeys = new Set(workLogs.map(log => buildLogKey(log.date, log.start, log.end)));
    const desiredDates = new Set(workLogs.map(log => log.date));

    if (CLEANUP_UNEXPECTED_ROWS) {
        const keysToDelete = [];
        for (const key of existingKeys) {
            if (!desiredKeys.has(key)) {
                const date = key.split('|')[0];
                // 이번 스케줄 대상 날짜의 예상 외 행만 삭제 대상으로 제한
                if (desiredDates.has(date)) keysToDelete.push(key);
            }
        }

        if (keysToDelete.length > 0) {
            console.log(`🧹 예상 외 기존 행 삭제 시도: ${keysToDelete.length}건`);
            const selectedCount = await selectRowsForDelete(page, keysToDelete);
            if (selectedCount > 0) {
                await clickButtonByText(page, '삭제');
                await new Promise(r => setTimeout(r, 1500));
            }
        }
    }

    // 삭제 후 상태를 다시 읽고, 기존과 동일한 일정은 신규 입력에서 제외
    const rowsAfterCleanup = await readExistingRows(page);
    const existingKeysAfterCleanup = new Set();
    for (const row of rowsAfterCleanup) {
        const date = normalizePortalDateToYmd(row.dateText);
        const start = normalizePortalTimeToHm(row.startText);
        const end = normalizePortalTimeToHm(row.endText);
        if (!date || !start || !end) continue;
        existingKeysAfterCleanup.add(buildLogKey(date, start, end));
    }

    const logsToInsert = workLogs.filter(log => !existingKeysAfterCleanup.has(buildLogKey(log.date, log.start, log.end)));
    const skippedCount = workLogs.length - logsToInsert.length;
    if (skippedCount > 0) {
        console.log(`⏭️  기존 동일 일정 ${skippedCount}건은 건너뜁니다.`);
    }
    console.log(`📝 신규 입력 대상: ${logsToInsert.length}건`);

    for (const log of logsToInsert) {
        try {
            console.log(`👉 작성: ${log.date}(${log.week}) ${log.start}~${log.end}`);

            await page.click(SELECTORS.btnNew);
            await new Promise(r => setTimeout(r, 400));

            const dateSetResult = await setInputValueAndVerify(page, SELECTORS.inputDate, log.date);
            if (!dateSetResult.ok) {
                throw new Error(`일자 입력 불일치(기대: ${log.date}, 실제: ${dateSetResult.actual || '없음'})`);
            }

            const startInput = await page.$(SELECTORS.inputStart);
            if (startInput) {
                await startInput.click({ clickCount: 4 });
                await page.keyboard.press('Backspace');
                await new Promise(r => setTimeout(r, 100));
                await page.keyboard.type(log.start, { delay: 300 }); // 4자리 시간 입력 천천히
            }

            const endInput = await page.$(SELECTORS.inputEnd);
            if (endInput) {
                await endInput.click({ clickCount: 4 });
                await page.keyboard.press('Backspace');
                await new Promise(r => setTimeout(r, 100));
                await page.keyboard.type(log.end, { delay: 300 }); // 4자리 시간 입력 천천히
            }

            const contentInput = await page.$(SELECTORS.inputContent);
            if (contentInput) {
                await contentInput.click();
                await page.keyboard.type(SCHEDULE_INFO.content, { delay: 80 });
                // 포털 폼이 input/change 이벤트로만 값을 반영하는 경우 대비
                await page.evaluate((selector) => {
                    const el = document.querySelector(selector);
                    if (el) {
                        el.dispatchEvent(new Event('input', { bubbles: true }));
                        el.dispatchEvent(new Event('change', { bubbles: true }));
                        el.blur();
                    }
                }, SELECTORS.inputContent);
                await new Promise(r => setTimeout(r, 400));
            }

            console.log('💾 저장!');
            await clickButtonByText(page, '저장');
            await new Promise(r => setTimeout(r, 3000)); // 저장 로딩 대기

            console.log(`✅ ${log.date} 완료`);
        } catch (e) {
            console.error(`❌ 실패 (${log.date}):`, e.message);
        }
    }

    console.log('\n🎉 끝! 입력 내용 확인 후 브라우저 창을 직접 닫아주세요.');
    // await browser.close(); // 확인용으로 창 유지
})();
