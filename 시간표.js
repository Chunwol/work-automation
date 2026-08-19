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

const EXTRA_HOLIDAY_DATES = userConfig.extraHolidayDates || [];

async function fetchGoogleIcsHolidayDays(year, month) {
    // Google Public Holidays (South Korea) - keyless ICS
    const icsUrl = 'https://calendar.google.com/calendar/ical/ko.south_korea%23holiday%40group.v.calendar.google.com/public/basic.ics';
    const res = await fetch(icsUrl, { headers: { 'User-Agent': 'work-log-automation/1.0' } });
    if (!res.ok) throw new Error(`Google ICS HTTP ${res.status}`);
    const ics = await res.text();

    const monthText = String(month).padStart(2, '0');
    const daySet = new Set();

    // Google 한국 휴일 캘린더에는 기념일도 포함되므로
    // DESCRIPTION에 '공휴일'이 명시된 일정만 반영한다.
    const blocks = ics.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g) || [];

    const unfoldIcsLines = (text) => String(text || '').replace(/\r?\n[ \t]/g, '');

    for (const block of blocks) {
        const unfolded = unfoldIcsLines(block);
        const dateMatch = unfolded.match(/DTSTART(?:;VALUE=DATE)?:?(\d{8})/);
        if (!dateMatch) continue;
        const d = dateMatch[1];
        if (!d.startsWith(String(year))) continue;
        if (d.slice(4, 6) !== monthText) continue;

        const descriptionRaw = (unfolded.match(/DESCRIPTION:([^\r\n]*)/) || [])[1] || '';
        const description = descriptionRaw.replace(/\\,/g, ',').replace(/\\n/g, ' ').trim();
        if (!description.includes('공휴일')) continue;

        const day = Number(d.slice(6, 8));
        if (Number.isInteger(day)) daySet.add(day);
    }

    return daySet;
}

async function fetchDongyangAcademicHolidays(year, month) {
    // 동양대 학사일정 공개 페이지에서 '개교기념일'/'보강일' 날짜를 추출
    const url = 'https://www.dongyang.ac.kr/dmu/4749/subview.do';
    try {
        const res = await fetch(url, { headers: { 'User-Agent': 'work-log-automation/1.0' } });
        if (!res.ok) throw new Error(`Dongyang HTTP ${res.status}`);
        const html = await res.text();

        const daySet = new Set();
        const monthText = String(month).padStart(2, '0');

        const normalizeMonth = (m) => String(Number(m || 0)).padStart(2, '0');
        const addIfTargetMonth = (m, d) => {
            const mm = normalizeMonth(m);
            const dd = Number(d);
            if (mm === monthText && Number.isInteger(dd) && dd >= 1 && dd <= 31) {
                daySet.add(dd);
            }
        };

        // 1) 휴강일 표기: "05.20 ... =>/⇒ 보강일" 패턴의 원 날짜를 제외 대상으로 추가
        for (const m of html.matchAll(/(\d{2})\.(\d{2})[\s\S]{0,200}?(?:=>|⇒)\s*보강일/g)) {
            addIfTargetMonth(m[1], m[2]);
        }

        // 2) 보강 안내의 원 날짜 표기: "... [5/20(수)]" 에서 괄호 안 날짜를 제외 대상으로 추가
        // 예: "보강일: 개교기념일[5/20(수)] 보강일" -> 5/20 제외
        for (const m of html.matchAll(/\[(\d{1,2})\s*\/(\d{1,2})(?:\([^\]]*\))?\]/g)) {
            addIfTargetMonth(m[1], m[2]);
        }

        return daySet;
    } catch (e) {
        console.warn('⚠️ 동양대 학사일정 파싱 실패:', e.message);
        return new Set();
    }
}

async function fetchPublicHolidayDays(year, month) {
    const monthText = String(month).padStart(2, '0');
    let daySet = new Set();

    // 1) Google ICS 우선 (keyless)
    try {
        const icsSet = await fetchGoogleIcsHolidayDays(year, month);
        if (icsSet && icsSet.size > 0) {
            daySet = new Set([...daySet, ...icsSet]);
            console.log(`🎌 공휴일(Google ICS) 로드 완료: ${year}-${monthText} (${daySet.size}일)`);
        }
    } catch (e) {
        console.warn(`⚠️ Google ICS 조회 실패: ${e.message}`);
    }

    // 2) 동양대 학사일정에서 반드시 제외할 날짜 추가
    try {
        const dmuSet = await fetchDongyangAcademicHolidays(year, month);
        for (const d of dmuSet) daySet.add(d);
        if (dmuSet.size > 0) {
            console.log(`🏫 동양대 학사일정 반영(제외): ${[...dmuSet].sort((a, b) => a - b).join(',')}`);
        } else {
            console.log('🏫 동양대 학사일정 반영(제외): 없음');
        }
    } catch (e) {
        console.warn('⚠️ 동양대 학사일정 통합 실패:', e.message);
    }

    // 3) 설정의 추가 공휴일(수동) 반영
    for (const day of EXTRA_HOLIDAY_DATES) {
        if (Number.isInteger(day) && day >= 1 && day <= 31) {
            daySet.add(day);
        }
    }

    return daySet;
}

function calculateTotalWorkMinutes(logs) {
    let totalMinutes = 0;

    for (const log of logs) {
        const startDigits = String(log.start || '').replace(/\D/g, '');
        const endDigits = String(log.end || '').replace(/\D/g, '');
        if (startDigits.length < 4 || endDigits.length < 4) continue;

        const startHour = Number(startDigits.slice(0, 2));
        const startMinute = Number(startDigits.slice(2, 4));
        const endHour = Number(endDigits.slice(0, 2));
        const endMinute = Number(endDigits.slice(2, 4));

        const startTotal = startHour * 60 + startMinute;
        const endTotal = endHour * 60 + endMinute;

        if (Number.isNaN(startTotal) || Number.isNaN(endTotal) || endTotal <= startTotal) {
            continue;
        }

        totalMinutes += (endTotal - startTotal);
    }

    return totalMinutes;
}

function formatMinutesToHourText(totalMinutes) {
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return `${hours}시간 ${minutes}분`;
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

async function typeFieldWithRetryAndVerify(page, selector, value, attempts, normalize) {
    const typedValue = String(value || '');
    const expected = normalize(typedValue);
    const modifierKey = process.platform === 'darwin' ? 'Meta' : 'Control';
    let lastActual = '';

    for (const attempt of attempts) {
        const input = await page.$(selector);
        if (!input) return { ok: false, actual: '', reason: '필드 없음' };

        await input.click({ clickCount: 4 });
        await page.keyboard.down(modifierKey);
        await page.keyboard.press('KeyA');
        await page.keyboard.up(modifierKey);
        await page.keyboard.press('Backspace');
        await new Promise(r => setTimeout(r, 120));

        for (const ch of typedValue) {
            await page.keyboard.type(ch, { delay: attempt.keyDelay });
            await new Promise(r => setTimeout(r, attempt.betweenDelay));
        }

        await page.evaluate((targetSelector) => {
            const el = document.querySelector(targetSelector);
            if (!el) return;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            el.blur();
        }, selector);
        await new Promise(r => setTimeout(r, attempt.afterDelay));

        const actualRaw = await page.evaluate((targetSelector) => {
            const el = document.querySelector(targetSelector);
            return String(el?.value || '');
        }, selector);
        lastActual = normalize(actualRaw);

        if (lastActual === expected) {
            return { ok: true, actual: lastActual };
        }
    }

    return { ok: false, actual: lastActual };
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
    } catch (e) {
        console.error(`❌ 공휴일 API 조회 실패: ${e.message}`);
        process.exit(1);
    }

    const workLogs = generateSchedule(publicHolidayDays);
    const totalWorkMinutes = calculateTotalWorkMinutes(workLogs);
    console.log(`📅 설정된 규칙에 따라 ${workLogs.length}개의 일정을 생성했습니다.`);
    console.log(`⏱️ 전체 시수: ${formatMinutesToHourText(totalWorkMinutes)} (총 ${totalWorkMinutes}분)`);
    console.table(workLogs);

    const browserArgs = process.platform === 'darwin' ? [] : ['--start-maximized'];
    const browser = await puppeteer.launch({
        headless: false,
        defaultViewport: null,
        args: browserArgs
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
    const insertWorkMinutes = calculateTotalWorkMinutes(logsToInsert);
    const skippedCount = workLogs.length - logsToInsert.length;
    if (skippedCount > 0) {
        console.log(`⏭️  기존 동일 일정 ${skippedCount}건은 건너뜁니다.`);
    }
    console.log(`📝 신규 입력 대상: ${logsToInsert.length}건`);
    console.log(`⏱️ 신규 입력 시수: ${formatMinutesToHourText(insertWorkMinutes)} (총 ${insertWorkMinutes}분)`);

    for (const log of logsToInsert) {
        try {
            console.log(`👉 작성: ${log.date}(${log.week}) ${log.start}~${log.end}`);

            await page.click(SELECTORS.btnNew);
            await new Promise(r => setTimeout(r, 400));

            const normalizeDigits = (text) => String(text || '').replace(/\D/g, '');
            const normalizeText = (text) => String(text || '').trim();

            const dateSetResult = await typeFieldWithRetryAndVerify(
                page,
                SELECTORS.inputDate,
                log.date,
                [
                    { keyDelay: 250, betweenDelay: 80, afterDelay: 200 },
                    { keyDelay: 380, betweenDelay: 120, afterDelay: 260 },
                    { keyDelay: 450, betweenDelay: 140, afterDelay: 320 }
                ],
                normalizeDigits
            );
            if (!dateSetResult.ok) {
                throw new Error(`일자 입력 불일치(기대: ${log.date}, 실제: ${dateSetResult.actual || '없음'})`);
            }

            const startSetResult = await typeFieldWithRetryAndVerify(
                page,
                SELECTORS.inputStart,
                log.start,
                [
                    { keyDelay: 220, betweenDelay: 70, afterDelay: 180 },
                    { keyDelay: 320, betweenDelay: 100, afterDelay: 240 }
                ],
                normalizeDigits
            );
            if (!startSetResult.ok) {
                throw new Error(`시작시간 입력 불일치(기대: ${log.start}, 실제: ${startSetResult.actual || '없음'})`);
            }

            const endSetResult = await typeFieldWithRetryAndVerify(
                page,
                SELECTORS.inputEnd,
                log.end,
                [
                    { keyDelay: 220, betweenDelay: 70, afterDelay: 180 },
                    { keyDelay: 320, betweenDelay: 100, afterDelay: 240 }
                ],
                normalizeDigits
            );
            if (!endSetResult.ok) {
                throw new Error(`종료시간 입력 불일치(기대: ${log.end}, 실제: ${endSetResult.actual || '없음'})`);
            }

            const contentSetResult = await typeFieldWithRetryAndVerify(
                page,
                SELECTORS.inputContent,
                SCHEDULE_INFO.content,
                [
                    { keyDelay: 80, betweenDelay: 15, afterDelay: 220 },
                    { keyDelay: 120, betweenDelay: 25, afterDelay: 280 }
                ],
                normalizeText
            );
            if (!contentSetResult.ok) {
                throw new Error(`근무내용 입력 불일치(기대: ${normalizeText(SCHEDULE_INFO.content)}, 실제: ${contentSetResult.actual || '없음'})`);
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
