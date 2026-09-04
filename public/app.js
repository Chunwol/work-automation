const state = {
    setupRequired: false,
    setupTokenRequired: false,
    authMode: 'login',
    user: null,
    csrfToken: null,
    portalCredential: { configured: false },
    portalCredentialSaving: false,
    year: new Date().getFullYear(),
    month: new Date().getMonth() + 1,
    schedule: null,
    preview: null,
    dirty: false,
    jobs: [],
    expandedJobId: null,
    selectedDay: null,
    eventSource: null,
    portalAssignments: [],
    portalSnapshot: null,
    portalSnapshotError: '',
    portalReadVersion: 0,
    scheduleReadVersion: 0,
    calendar: { holidays: [], error: null },
    selectedPortalRecord: null,
    portalMutationOperation: null,
    portalMutationBusy: false,
    draggedSchedule: null,
    pointerSchedule: null,
    suppressDayClickUntil: 0,
    assignmentSelectionJobId: null
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
let pendingConfirmation = null;

function confirmAction({ title, message, details = [], confirmLabel = '확인', destructive = false }) {
    if (pendingConfirmation) return Promise.resolve(false);
    const dialog = $('#action-confirm-dialog');
    $('#action-confirm-title').textContent = title;
    $('#action-confirm-message').textContent = message;
    const list = $('#action-confirm-details');
    list.replaceChildren(...details.map(text => {
        const item = document.createElement('li');
        item.textContent = text;
        return item;
    }));
    list.hidden = !details.length;
    const submit = $('#action-confirm-submit');
    submit.textContent = confirmLabel;
    submit.classList.toggle('button-destructive', destructive);
    dialog.returnValue = '';
    return new Promise(resolve => {
        pendingConfirmation = resolve;
        dialog.showModal();
    });
}

function scheduleRevision() {
    return JSON.stringify([state.user?.id, state.year, state.month, state.scheduleReadVersion, state.schedule]);
}

function verifyScheduleRevision(revision) {
    if (revision === scheduleRevision()) return true;
    toast('확인 중 일정이 바뀌었습니다. 다시 선택해주세요.', 'error');
    return false;
}

let dialogFocusFrame = 0;

function revealDialogInput() {
    cancelAnimationFrame(dialogFocusFrame);
    dialogFocusFrame = requestAnimationFrame(() => {
        const input = document.activeElement;
        const dialog = input?.closest('dialog[open]');
        if (!dialog || !input.matches('input:not([type="checkbox"]), textarea, select')) return;
        const box = input.getBoundingClientRect();
        const header = dialog.querySelector('.modal-header')?.getBoundingClientRect();
        const footer = dialog.querySelector('.modal-actions')?.getBoundingClientRect();
        const bounds = dialog.getBoundingClientRect();
        const top = Math.max(bounds.top, header?.bottom || bounds.top) + 12;
        const bottom = Math.min(bounds.bottom, footer?.top || bounds.bottom) - 12;
        if (box.bottom > bottom) dialog.scrollTop += box.bottom - bottom;
        else if (box.top < top) dialog.scrollTop -= top - box.top;
    });
}

function updateDialogViewport() {
    const viewport = window.visualViewport;
    document.documentElement.style.setProperty('--dialog-viewport-height', `${viewport?.height || innerHeight}px`);
    document.documentElement.style.setProperty('--dialog-viewport-top', `${viewport?.offsetTop || 0}px`);
    revealDialogInput();
}

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

function showError(element, message) {
    element.textContent = message || '';
    element.hidden = !message;
}

function toast(message, type = 'info') {
    const element = document.createElement('div');
    element.className = `toast ${type}`;
    element.textContent = message;
    $('#toast-region').append(element);
    while ($('#toast-region').children.length > 2) $('#toast-region').firstElementChild.remove();
    setTimeout(() => element.remove(), 4_500);
}

async function api(path, options = {}) {
    const method = options.method || 'GET';
    const headers = { Accept: 'application/json', ...(options.headers || {}) };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (!['GET', 'HEAD'].includes(method) && state.csrfToken) headers['X-CSRF-Token'] = state.csrfToken;

    const response = await fetch(path, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
    if (response.status === 204) return null;
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
        const error = new Error(payload.error || `요청 실패 (${response.status})`);
        error.status = response.status;
        error.payload = payload;
        throw error;
    }
    return payload;
}

function setButtonBusy(button, busy, label) {
    if (busy) {
        button.dataset.originalText = button.textContent;
        button.textContent = label || '처리 중...';
        button.disabled = true;
    } else {
        button.textContent = button.dataset.originalText || button.textContent;
        button.disabled = false;
    }
}

function showAuthView(setupRequired, setupTokenRequired = false, mode = 'login') {
    state.setupRequired = setupRequired;
    state.setupTokenRequired = setupTokenRequired;
    state.authMode = mode === 'setup' && !setupRequired ? 'signup' : mode;
    const isSetup = state.authMode === 'setup';
    const isSignup = state.authMode === 'signup';
    $('#dashboard-view').hidden = true;
    $('#auth-view').hidden = false;
    $('#display-name-field').hidden = !isSetup && !isSignup;
    $('#setup-token-field').hidden = !isSetup || !setupTokenRequired;
    $('#password-confirm-field').hidden = !isSignup;
    $('#setup-hint').hidden = !isSetup && !isSignup;
    $('#setup-hint').textContent = isSetup ? '서버 운영자를 위한 관리자 설정입니다. 비밀번호는 10자 이상 사용해주세요.' : '회원가입 후 학교 포털 계정을 별도로 연결합니다. 비밀번호는 10자 이상 사용해주세요.';
    $('#admin-setup-button').hidden = !setupRequired || isSetup;
    $('#login-tab').setAttribute('aria-pressed', String(state.authMode === 'login'));
    $('#signup-tab').setAttribute('aria-pressed', String(isSignup));
    $('#auth-kicker').textContent = isSetup ? 'FIRST SETUP' : isSignup ? 'YOUR OWN WORKSPACE' : 'WELCOME BACK';
    $('#auth-title').textContent = isSetup ? '첫 관리자 계정을 만들어요.' : isSignup ? '나만의 근로기록실.' : '다시 만나 반가워요.';
    $('#auth-description').textContent = isSetup
        ? '이 계정으로 다른 사용자를 추가하고 관리할 수 있습니다.'
        : isSignup ? '계정을 만들고 내 일정을 직접 관리하세요.' : '내 계정으로 로그인하거나 새로 가입하세요.';
    $('#auth-submit').textContent = isSetup ? '관리자 계정 생성' : isSignup ? '회원가입' : '로그인';
    $('#password').autocomplete = isSetup || isSignup ? 'new-password' : 'current-password';
    showError($('#auth-error'), '');
}

function showDashboard() {
    $('#auth-view').hidden = true;
    $('#dashboard-view').hidden = false;
    $('#user-display-name').textContent = state.user.displayName;
    $('#heading-name').textContent = state.user.displayName;
    $('#user-role').textContent = state.user.role === 'admin' ? '관리자' : '일반 사용자';
    $('#user-avatar').textContent = state.user.displayName.slice(0, 1);
    $('#admin-button').hidden = state.user.role !== 'admin';
    $('#admin-menu-button').hidden = state.user.role !== 'admin';
    updatePortalSummary();
}

function updatePortalSummary() {
    const configured = Boolean(state.portalCredential?.configured);
    $('#portal-state').textContent = configured ? '등록 완료' : '미등록';
    $('#portal-state').style.color = configured ? 'var(--green)' : 'var(--red)';
    $('#portal-settings-button').textContent = configured
        ? `${state.portalCredential.maskedId || '등록됨'} · 변경`
        : '계정 설정';
}

function renderAssignmentSummary() {
    const assignment = state.schedule?.portalAssignment;
    const label = $('#assignment-label');
    if (!assignment) {
        label.textContent = '아직 선택하지 않음';
        return;
    }
    label.textContent = `${assignment.scholarshipName || assignment.scholarshipCode} · ${assignment.workDepartmentName || assignment.workDepartmentCode}`;
}

async function bootstrap() {
    const data = await api('/api/bootstrap');
    if (!data.authenticated) {
        showAuthView(data.setupRequired, data.setupTokenRequired);
        return;
    }
    state.user = data.user;
    state.csrfToken = data.csrfToken;
    state.portalCredential = data.portalCredential;
    showDashboard();
    await Promise.all([loadSchedule(), loadJobs()]);
}

function daysInMonth(year, month) {
    return new Date(year, month, 0).getDate();
}

function timeToMinutes(value) {
    const text = String(value || '').trim();
    if (!/^\d{2}:?\d{2}$/.test(text)) return null;
    const digits = text.replace(':', '');
    const hour = Number(digits.slice(0, 2));
    const minute = Number(digits.slice(2));
    if (hour > 24 || minute > 59 || (hour === 24 && minute !== 0)) return null;
    return hour * 60 + minute;
}

function displayTime(value) {
    const digits = String(value || '').replace(/\D/g, '');
    return digits.length === 4 ? `${digits.slice(0, 2)}:${digits.slice(2)}` : '';
}

function inputTime(value) {
    return displayTime(value);
}

function compactTime(value) {
    return String(value || '').trim().replace(':', '');
}

const asRanges = value => Array.isArray(value) ? value : value ? [value] : [];
const storedRanges = ranges => ranges.length === 1 ? ranges[0] : ranges;
const rangeSummary = ranges => ranges.map(range => `${displayTime(range.start)} ~ ${displayTime(range.end)}`).join(', ');
const rangeKey = ranges => JSON.stringify(ranges.map(({ start, end }) => ({ start, end })).sort((a, b) => a.start.localeCompare(b.start)));

function validateRanges(ranges) {
    if (!ranges.length || ranges.length > 8) throw new Error('근무 구간은 하루 1~8개로 입력해주세요.');
    const sorted = ranges.map(range => ({ start: compactTime(range.start), end: compactTime(range.end) }))
        .sort((a, b) => a.start.localeCompare(b.start));
    for (const [index, range] of sorted.entries()) {
        const start = timeToMinutes(range.start);
        const end = timeToMinutes(range.end);
        if (start === null || end === null || end <= start) throw new Error('퇴근 시간은 출근 시간보다 늦어야 하며, 시간은 00:00~24:00 범위여야 합니다.');
        if (index && range.start < sorted[index - 1].end) throw new Error('근무 구간의 시간이 겹칩니다.');
    }
    return sorted;
}

function getEffectiveDay(day, schedule = state.schedule) {
    if (!schedule) return null;
    const holidayExcluded = (schedule.holidayDates || []).includes(day) && !(schedule.holidayWorkDates || []).includes(day);
    const excluded = schedule.vacationDates.includes(day) || schedule.extraHolidayDates.includes(day) || holidayExcluded;
    const specific = schedule.specialDates[String(day)] || null;
    const weekday = new Date(schedule.year, schedule.month - 1, day).getDay();
    const recurring = schedule.regularRules.filter((rule) => rule.day === weekday);
    const ranges = specific ? asRanges(specific) : recurring;
    return { excluded, specific, recurring, ranges, value: ranges.length ? ranges : null };
}

function calculateClientPreview(schedule = state.schedule) {
    const logs = [];
    if (!schedule) return { logs, count: 0, totalMinutes: 0 };
    for (let day = 1; day <= daysInMonth(schedule.year, schedule.month); day += 1) {
        const entry = getEffectiveDay(day, schedule);
        if (!entry || entry.excluded || !entry.value) continue;
        for (const range of entry.ranges) {
            const start = timeToMinutes(range.start);
            const end = timeToMinutes(range.end);
            if (start === null || end === null || end <= start) continue;
            logs.push({ day, start: range.start, end: range.end, minutes: end - start });
        }
    }
    return {
        logs,
        count: new Set(logs.map(log => log.day)).size,
        entryCount: logs.length,
        totalMinutes: logs.reduce((sum, log) => sum + log.minutes, 0)
    };
}

function formatDuration(minutes) {
    return { hours: Math.floor(minutes / 60), minutes: minutes % 60 };
}

function renderSummary() {
    const preview = calculateClientPreview();
    const duration = formatDuration(preview.totalMinutes);
    $('#total-hours').innerHTML = `${duration.hours}<small>시간</small>`;
    $('#total-minutes-note').textContent = `추가 ${duration.minutes}분`;
    $('#total-minutes-note').hidden = !duration.minutes;
    $('#work-days').innerHTML = `${preview.count}<small>일</small>`;
    state.preview = preview;
}

function renderCalendar() {
    const calendar = $('#calendar');
    const firstWeekday = new Date(state.year, state.month - 1, 1).getDay();
    const lastDay = daysInMonth(state.year, state.month);
    const today = new Date();
    let html = '';
    for (let index = 0; index < firstWeekday; index += 1) html += '<span class="calendar-day empty" aria-hidden="true"></span>';
    for (let day = 1; day <= lastDay; day += 1) {
        const entry = getEffectiveDay(day);
        const value = entry?.value;
        const ranges = entry?.ranges || [];
        const minutes = ranges.reduce((sum, range) => sum + Math.max(0, (timeToMinutes(range.end) || 0) - (timeToMinutes(range.start) || 0)), 0);
        const records = portalRecordsForDay(day);
        const missingRanges = ranges.filter(range => !records.some(record => record.start === range.start
            && record.end === range.end && assignmentMatches(record, state.schedule.portalAssignment)));
        const sameAsDraft = value && !entry.excluded && missingRanges.length === 0;
        const classes = ['calendar-day'];
        const weekday = new Date(state.year, state.month - 1, day).getDay();
        const holiday = state.calendar.holidays.find((item) => item.day === day);
        const isHoliday = (state.schedule?.holidayDates || []).includes(day);
        const holidayWorked = (state.schedule?.holidayWorkDates || []).includes(day);
        const canCopy = Boolean(entry?.specific && !entry.excluded && minutes > 0);
        if (weekday === 0 || (isHoliday && !holidayWorked)) classes.push('red-day');
        if (weekday === 6) classes.push('saturday');
        if (isHoliday && !holidayWorked) classes.push('holiday-day');
        if (records.length) classes.push('has-portal-records');
        if (value && !entry.excluded) classes.push('work-day');
        if (entry?.specific) classes.push('override-day');
        if (entry?.excluded) classes.push('excluded-day');
        if (canCopy) classes.push('copyable-day');
        if (today.getFullYear() === state.year && today.getMonth() + 1 === state.month && today.getDate() === day) classes.push('today');
        html += `
            <button class="${classes.join(' ')}" type="button" data-day="${day}" draggable="${canCopy}" aria-label="${state.month}월 ${day}일, 포털 기록 ${records.length}건, 일정 설정${canCopy ? ', 수동 예정 일정 드래그 복사 가능' : ''}">
                <span class="date-number">${day}</span>
                ${isHoliday ? `<span class="holiday-label" title="${escapeHtml(holiday?.name || '공휴일')}">${holidayWorked ? '근무 예외' : escapeHtml(holiday?.name || '공휴일')}</span>` : ''}
                ${value && !entry.excluded && !sameAsDraft ? `${missingRanges.slice(0, 3).map(range => `<span class="day-time"><span>${escapeHtml(displayTime(range.start))}</span><span class="time-divider">–</span><span>${escapeHtml(displayTime(range.end))}</span></span>`).join('')}${missingRanges.length > 3 ? `<span class="portal-more">+${missingRanges.length - 3}구간</span>` : ''}<span class="day-hours">예정 ${Math.floor(minutes / 60)}시간${minutes % 60 ? ` ${minutes % 60}분` : ''}</span>` : ''}
                ${records.slice(0, 2).map((record) => {
                    const kind = portalRecordKind(record);
                    return `<span class="calendar-portal-record ${kind.className}" title="${escapeHtml(`${record.scholarshipName} / ${record.workDepartmentName} / ${record.confirmed ? '확인 완료' : '미확인'}`)}"><span class="portal-record-label">${escapeHtml(kind.label)}</span><span class="portal-record-time"><span>${escapeHtml(displayTime(record.start))}</span><span class="time-divider">–</span><span>${escapeHtml(displayTime(record.end))}</span></span></span>`;
                }).join('')}
                ${records.length > 2 ? `<span class="portal-more">+${records.length - 2}건</span>` : ''}
                ${sameAsDraft ? '<span class="portal-match">일정 일치</span>' : ''}
                ${entry?.excluded ? '<span class="day-hours">예정 제외</span>' : ''}
            </button>`;
    }
    const trailingDays = (7 - (firstWeekday + lastDay) % 7) % 7;
    for (let index = 0; index < trailingDays; index += 1) html += '<span class="calendar-day empty" aria-hidden="true"></span>';
    calendar.innerHTML = html;
    $$('[data-day]', calendar).forEach(bindCalendarDay);
    renderSummary();
    renderPortalCalendarSummary();
    showError($('#holiday-calendar-note'), state.calendar.error);
}

function manualCopySource(day) {
    if (state.schedule?.year !== state.year || state.schedule?.month !== state.month) return null;
    const entry = getEffectiveDay(day);
    if (!entry?.specific || entry.excluded) return null;
    return { year: state.year, month: state.month, userId: state.user?.id, day,
        ranges: asRanges(entry.specific).map(({ start, end }) => ({ start, end })) };
}

function clearScheduleDrag() {
    const pointer = state.pointerSchedule;
    state.pointerSchedule = null;
    if (pointer?.button.hasPointerCapture(pointer.id)) pointer.button.releasePointerCapture(pointer.id);
    state.draggedSchedule = null;
    document.body.classList.remove('schedule-dragging');
    $$('.drag-source, .drag-target', $('#calendar')).forEach(el => el.classList.remove('drag-source', 'drag-target'));
}

function bindCalendarDay(button) {
    const day = Number(button.dataset.day);
    button.addEventListener('click', () => {
        if (Date.now() >= state.suppressDayClickUntil) openDayDialog(day);
    });
    // Embedded browsers do not consistently deliver native HTML drag/drop.
    button.addEventListener('pointerdown', event => {
        if (event.button !== 0 || event.pointerType === 'touch' || event.isPrimary === false) return;
        const source = manualCopySource(day);
        if (!source) return;
        clearScheduleDrag();
        state.pointerSchedule = { source, button, id: event.pointerId, x: event.clientX, y: event.clientY, active: false };
        button.setPointerCapture(event.pointerId);
    });
    button.addEventListener('pointermove', event => {
        const pointer = state.pointerSchedule;
        if (!pointer || pointer.id !== event.pointerId) return;
        if (!pointer.active && Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) < 8) return;
        pointer.active = true;
        event.preventDefault();
        state.draggedSchedule = pointer.source;
        button.classList.add('drag-source');
        document.body.classList.add('schedule-dragging');
        $$('.drag-target', $('#calendar')).forEach(el => el.classList.remove('drag-target'));
        const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('#calendar [data-day]');
        if (target && Number(target.dataset.day) !== day) target.classList.add('drag-target');
    });
    button.addEventListener('pointerup', event => {
        const pointer = state.pointerSchedule;
        if (!pointer || pointer.id !== event.pointerId) return;
        const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('#calendar [data-day]');
        if (pointer.active) {
            event.preventDefault();
            state.suppressDayClickUntil = Date.now() + 400;
        }
        clearScheduleDrag();
        if (pointer.active && target) void copyManualSchedule(pointer.source, Number(target.dataset.day));
    });
    button.addEventListener('pointercancel', clearScheduleDrag);
    button.addEventListener('lostpointercapture', () => {
        if (state.pointerSchedule?.button === button) clearScheduleDrag();
    });
    button.addEventListener('dragstart', (event) => {
        if (state.pointerSchedule) return event.preventDefault();
        const source = manualCopySource(day);
        if (!source || !event.dataTransfer) return event.preventDefault();
        state.draggedSchedule = source;
        event.dataTransfer.effectAllowed = 'copy';
        event.dataTransfer.setData('text/plain', `${source.month}월 ${day}일 예정 일정 복사`);
        button.classList.add('drag-source');
    });
    button.addEventListener('dragover', (event) => {
        if (!state.draggedSchedule || state.draggedSchedule.day === day) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        $$('.drag-target', $('#calendar')).forEach(el => el.classList.remove('drag-target'));
        button.classList.add('drag-target');
    });
    button.addEventListener('dragleave', (event) => {
        if (!button.contains(event.relatedTarget)) button.classList.remove('drag-target');
    });
    button.addEventListener('drop', (event) => {
        if (!state.draggedSchedule) return;
        event.preventDefault();
        const source = state.draggedSchedule;
        clearScheduleDrag();
        state.suppressDayClickUntil = Date.now() + 300;
        copyManualSchedule(source, day);
    });
    button.addEventListener('dragend', () => {
        clearScheduleDrag();
        state.suppressDayClickUntil = Date.now() + 300;
    });
}

async function copyManualSchedule(source, targetDay) {
    if (pendingConfirmation) return false;
    if (!source || source.userId !== state.user?.id || source.year !== state.year || source.month !== state.month
        || !Number.isInteger(targetDay) || targetDay < 1 || targetDay > daysInMonth(state.year, state.month)
        || source.day === targetDay) return false;
    const current = manualCopySource(source.day);
    if (!current || rangeKey(current.ranges) !== rangeKey(source.ranges)) {
        toast('원본 일정이 변경되었습니다. 다시 선택해주세요.', 'error');
        return false;
    }
    const target = getEffectiveDay(targetDay);
    const holiday = (state.schedule.holidayDates || []).includes(targetDay) || state.schedule.extraHolidayDates.includes(targetDay);
    const records = portalRecordsForDay(targetDay);
    if (target.value && !target.excluded && rangeKey(target.ranges) === rangeKey(source.ranges)) {
        return false;
    }
    const warnings = [];
    if (target.value) warnings.push(`기존 예정 시간 ${rangeSummary(target.ranges)}을 바꿉니다.`);
    if (holiday) warnings.push('공휴일 근무 예외로 추가합니다. 포털의 공휴일 입력 제한은 별도 적용됩니다.');
    else if (target.excluded) warnings.push('대상 날짜의 근무 제외를 해제합니다.');
    if (records.length) warnings.push(`이미 포털 기록 ${records.length}건이 있습니다. 해당 기록은 변경하지 않습니다.`);
    if (holiday || target.value || records.length) {
        const revision = scheduleRevision();
        const recordsBefore = JSON.stringify(records);
        if (!await confirmAction({
            title: holiday ? '공휴일에 일정을 복사할까요?' : target.value ? '기존 예정 일정을 바꿀까요?' : '포털 기록이 있는 날짜입니다',
            message: `${state.year}년 ${state.month}월 ${source.day}일 → ${targetDay}일 · ${rangeSummary(source.ranges)}`,
            details: warnings,
            confirmLabel: target.value ? '예정 일정 교체' : '일정 복사'
        })) return false;
        // Modal confirmation is asynchronous; do not apply consent to a changed target.
        if (!verifyScheduleRevision(revision)) return false;
        if (recordsBefore !== JSON.stringify(portalRecordsForDay(targetDay))) {
            toast('확인 중 포털 기록이 바뀌었습니다. 다시 선택해주세요.', 'error');
            return false;
        }
    }
    state.schedule.specialDates[String(targetDay)] = storedRanges(structuredClone(source.ranges));
    state.schedule.vacationDates = state.schedule.vacationDates.filter(day => day !== targetDay);
    state.schedule.extraHolidayDates = state.schedule.extraHolidayDates.filter(day => day !== targetDay);
    if (holiday) state.schedule.holidayWorkDates = [...new Set([...(state.schedule.holidayWorkDates || []), targetDay])].sort((a, b) => a - b);
    setDirty(true);
    if ($('#day-dialog').open) $('#day-dialog').close();
    renderCalendar();
    $(`[data-day="${targetDay}"]`, $('#calendar')).focus({ preventScroll: true });
    return true;
}

function portalRecordKind(record) {
    if (record.scholarshipCode === '50064') return { label: '일반', className: 'portal-general' };
    if (['50085', '50086', '50314', '50315'].includes(record.scholarshipCode)) return { label: '국가', className: 'portal-national' };
    return { label: '포털', className: 'portal-other' };
}

function portalRecordsForDay(day) {
    const date = `${state.year}${String(state.month).padStart(2, '0')}${String(day).padStart(2, '0')}`;
    return (state.portalSnapshot?.records || []).filter((record) => record.date === date);
}

function renderPortalCalendarSummary() {
    const element = $('#portal-calendar-summary');
    const snapshot = state.portalSnapshot;
    if (!snapshot) {
        element.innerHTML = `<strong>${state.portalSnapshotError ? '포털 기록 불러오기 실패' : '포털 기록 미조회'}</strong>`;
        return;
    }
    const minutes = snapshot.records.reduce((sum, record) => sum + Math.max(0, (timeToMinutes(record.end) || 0) - (timeToMinutes(record.start) || 0)), 0);
    const duration = formatDuration(minutes);
    const days = new Set(snapshot.records.map((record) => record.date)).size;
    const updated = new Date(snapshot.queriedAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    element.innerHTML = `<strong>포털 기록 ${snapshot.records.length}건 · ${days}일 · ${duration.hours}시간${duration.minutes ? ` ${duration.minutes}분` : ''}</strong><small>${escapeHtml(updated)} 조회${state.portalSnapshotError ? ' · 갱신 실패, 이전 기록' : ''}</small>`;
}

function renderDayPortalRecords(day) {
    const container = $('#day-portal-records');
    const records = portalRecordsForDay(day);
    container.hidden = !records.length;
    container.innerHTML = records.length ? `<h3>포털에 등록된 기록</h3>${records.map((record, index) => {
        const kind = portalRecordKind(record);
        const disabled = record.confirmed || !record.sequence;
        return `<article class="day-portal-record ${kind.className}"><div><strong>${escapeHtml(displayTime(record.start))} ~ ${escapeHtml(displayTime(record.end))}</strong><span>${record.confirmed ? '확인 완료' : '미확인'}</span></div><p>${escapeHtml(record.scholarshipName || record.scholarshipCode)} · ${escapeHtml(record.workDepartmentName || record.workDepartmentCode)}</p><p class="portal-record-content">${escapeHtml(record.content || '근무내용 없음')}</p><div class="portal-record-actions"><button type="button" class="text-button" data-portal-action="update" data-record-index="${index}" ${disabled ? 'disabled' : ''}>포털 일지 수정</button><button type="button" class="text-button portal-delete-action" data-portal-action="delete" data-record-index="${index}" ${disabled ? 'disabled' : ''}>포털 일지 삭제</button></div>${disabled ? `<p class="portal-record-locked">${record.confirmed ? '확인 완료된 기록은 학교 담당자에게 문의해주세요.' : '수정·삭제하려면 기록만 조회를 다시 실행해주세요.'}</p>` : ''}</article>`;
    }).join('')}` : '';
    $$('[data-portal-action]', container).forEach((button) => button.addEventListener('click', () => {
        openPortalRecordDialog(records[Number(button.dataset.recordIndex)], button.dataset.portalAction);
    }));
}

function openPortalRecordDialog(record, operation) {
    if (record.confirmed || !record.sequence) return;
    state.selectedPortalRecord = { ...record };
    state.portalMutationOperation = operation;
    const deleting = operation === 'delete';
    $('#portal-record-title').textContent = deleting ? '포털 일지 삭제' : '포털 일지 수정';
    $('#portal-record-submit').textContent = deleting ? '실제 포털 일지 삭제' : '포털에 수정 저장';
    $('#portal-record-submit').disabled = true;
    $('#portal-record-confirm').checked = false;
    $('#portal-record-warning').textContent = deleting ? '학교 포털의 이 일지 1건이 실제 삭제됩니다.' : '학교 포털의 실제 일지가 수정됩니다.';
    $('#portal-record-summary').innerHTML = `<strong>${escapeHtml(formatPortalDate(record.date))} · ${escapeHtml(displayTime(record.start))}~${escapeHtml(displayTime(record.end))}</strong><p>${escapeHtml(record.scholarshipName || record.scholarshipCode)} · ${escapeHtml(record.workDepartmentName || record.workDepartmentCode)}</p><p>${escapeHtml(record.content)}</p>`;
    $('#portal-record-edit-fields').hidden = deleting;
    $('#portal-record-start').value = inputTime(record.start);
    $('#portal-record-end').value = inputTime(record.end);
    $('#portal-record-content').value = record.content;
    for (const field of ['start', 'end', 'content']) $(`#portal-record-${field}`).disabled = deleting;
    showError($('#portal-record-error'), '');
    $('#portal-record-dialog').showModal();
}

async function submitPortalRecordChange(event) {
    event.preventDefault();
    if (state.portalMutationBusy) return;
    if (event.submitter?.value === 'cancel') return $('#portal-record-dialog').close();
    if (!$('#portal-record-confirm').checked || !state.selectedPortalRecord) return;
    const record = state.selectedPortalRecord;
    const year = Number(record.date.slice(0, 4));
    const month = Number(record.date.slice(4, 6));
    state.portalMutationBusy = true;
    const button = $('#portal-record-submit');
    setButtonBusy(button, true, '포털 처리·검증 중...');
    $$('#portal-record-form button[value="cancel"]').forEach((item) => { item.disabled = true; });
    showError($('#portal-record-error'), '');
    try {
        const result = await api(`/api/portal-records/${year}/${month}/mutate`, { method: 'POST', body: {
            operation: state.portalMutationOperation, record, confirmed: true,
            changes: { start: compactTime($('#portal-record-start').value), end: compactTime($('#portal-record-end').value), content: $('#portal-record-content').value }
        } });
        $('#portal-record-dialog').close();
        toast(`${result.job.summary.operation === 'delete' ? '포털 일지 삭제' : '포털 일지 수정'} 및 재조회 검증이 완료되었습니다.`, 'success');
    } catch (error) {
        showError($('#portal-record-error'), error.message);
    } finally {
        state.portalMutationBusy = false;
        setButtonBusy(button, false);
        $$('#portal-record-form button[value="cancel"]').forEach((item) => { item.disabled = false; });
        await loadJobs();
    }
}

async function loadPortalSnapshot() {
    const version = ++state.portalReadVersion;
    const { year, month, user } = state;
    try {
        const data = await api(`/api/portal-records/${year}/${month}`);
        if (version !== state.portalReadVersion || state.user?.id !== user?.id || year !== state.year || month !== state.month) return;
        state.portalSnapshot = data.snapshot;
        state.portalSnapshotError = '';
    } catch (error) {
        if (version !== state.portalReadVersion || state.user?.id !== user?.id || year !== state.year || month !== state.month) return;
        state.portalSnapshotError = error.message;
    }
    if (state.schedule?.year === year && state.schedule?.month === month) renderCalendar();
    if ($('#day-dialog').open) renderDayPortalRecords(state.selectedDay);
}

function setDirty(dirty = true) {
    state.dirty = dirty;
    const label = $('#save-state');
    label.textContent = dirty ? '저장하지 않은 변경 있음' : state.schedule?.updatedAt ? '저장 완료' : '새 일정';
    label.classList.toggle('dirty', dirty);
}

async function loadSchedule() {
    clearScheduleDrag();
    const version = ++state.scheduleReadVersion;
    const { year, month, user } = state;
    state.portalReadVersion += 1;
    state.portalSnapshot = null;
    state.portalSnapshotError = '';
    $('#calendar').innerHTML = '<p class="calendar-loading">일정을 불러오고 있습니다.</p>';
    $('#month-label').textContent = `${state.year}. ${String(state.month).padStart(2, '0')}`;
    const data = await api(`/api/schedules/${year}/${month}`);
    if (version !== state.scheduleReadVersion || user?.id !== state.user?.id || year !== state.year || month !== state.month) return;
    state.schedule = data.schedule;
    state.calendar = data.calendar || { holidays: [], error: null };
    $('#work-content').value = state.schedule.content;
    setDirty(false);
    renderAssignmentSummary();
    renderCalendar();
    await loadPortalSnapshot();
}

async function changeMonth(offset) {
    const date = new Date(state.year, state.month - 1 + offset, 1);
    state.year = date.getFullYear();
    state.month = date.getMonth() + 1;
    await loadSchedule();
}

function readRangeEditor(editor) {
    return $$('.work-range', editor).map(row => ({ start: $('.range-start', row).value, end: $('.range-end', row).value }));
}

function syncRangeEditor(editor) {
    const enabled = editor.dataset.rangeEditor === 'day' ? !$('#day-excluded').checked : $('input[type="checkbox"]', editor).checked;
    const rows = $$('.work-range', editor);
    if (editor.dataset.rangeEditor === 'repeat') $('[data-range-list]', editor).hidden = !enabled;
    $$('.time-input', editor).forEach(input => { input.disabled = !enabled; });
    $$('[data-remove-range]', editor).forEach(button => { button.disabled = !enabled || rows.length === 1; });
    $('[data-add-range]', editor).disabled = !enabled || rows.length >= 8;
}

function renderRangeEditor(editor, ranges) {
    const kind = editor.dataset.rangeEditor;
    const label = kind === 'day' ? '예정 일정' : `${['일', '월', '화', '수', '목', '금', '토'][Number(editor.dataset.repeatDay)]}요일`;
    $('[data-range-list]', editor).innerHTML = ranges.map((range, index) => {
        const input = (side, name) => {
            const id = kind === 'day' && index === 0 ? `id="day-${side}"` : '';
            const pattern = side === 'end' ? '(([01][0-9]|2[0-3]):?[0-5][0-9]|24:?00)' : '([01][0-9]|2[0-3]):?[0-5][0-9]';
            const value = timeToMinutes(range[side]) === null ? range[side] : displayTime(range[side]);
            return `<label class="field repeat-time-field"><span>${name}</span><input ${id} class="range-${side} ${kind}-${side} time-input" type="text" inputmode="numeric" maxlength="5" pattern="${pattern}" value="${escapeHtml(value)}" placeholder="${side === 'start' ? '09:00' : '17:00'}" aria-label="${label} ${index + 1}구간 ${name}, 24시간제" required></label>`;
        };
        return `<div class="work-range"><div class="range-header"><span>근무 ${index + 1}</span><button type="button" class="range-remove" data-remove-range="${index}" aria-label="${label} ${index + 1}구간 삭제">삭제</button></div>${input('start', '출근')}<span class="range-arrow" aria-hidden="true">→</span>${input('end', '퇴근')}</div>`;
    }).join('');
    syncRangeEditor(editor);
}

function openDayDialog(day) {
    if (state.schedule?.year !== state.year || state.schedule?.month !== state.month) return;
    state.selectedDay = day;
    const weekdayNames = ['일', '월', '화', '수', '목', '금', '토'];
    const weekday = weekdayNames[new Date(state.year, state.month - 1, day).getDay()];
    const entry = getEffectiveDay(day);
    $('#day-dialog-title').textContent = `${state.month}월 ${day}일 ${weekday}요일`;
    renderDayPortalRecords(day);
    $('#day-excluded').checked = Boolean(entry?.excluded);
    renderRangeEditor($('#day-range-editor'), entry?.ranges.length ? entry.ranges : [{ start: '0900', end: '1700' }]);
    const holiday = (state.schedule.holidayDates || []).includes(day);
    $('#day-holiday-field').hidden = !holiday;
    $('#day-holiday-work').checked = (state.schedule.holidayWorkDates || []).includes(day);
    $('#day-holiday-label').textContent = `${state.calendar.holidays.find((item) => item.day === day)?.name || '공휴일'} 근무 · 자동 제외 해제`;
    $('#remove-day-button').disabled = !entry?.value;
    $('#day-copy-fields').hidden = !manualCopySource(day);
    $('#day-copy-target').innerHTML = Array.from({ length: daysInMonth(state.year, state.month) }, (_, index) => index + 1)
        .filter(value => value !== day).map(value => `<option value="${value}">${state.month}월 ${value}일</option>`).join('');
    $('#day-copy-target').value = String(day < daysInMonth(state.year, state.month) ? day + 1 : 1);
    showError($('#day-error'), '');
    $('#day-dialog').showModal();
}

function applyDayEdit() {
    const day = state.selectedDay;
    let ranges = [];
    const holiday = (state.schedule.holidayDates || []).includes(day);
    if (holiday && !$('#day-excluded').checked && !$('#day-holiday-work').checked) {
        showError($('#day-error'), '공휴일에는 공휴일 근무를 선택해야 자동 제외가 해제됩니다.');
        return false;
    }
    if (!$('#day-excluded').checked) {
        try { ranges = validateRanges(readRangeEditor($('#day-range-editor'))); }
        catch (error) { showError($('#day-error'), error.message); return false; }
    }

    state.schedule.vacationDates = state.schedule.vacationDates.filter((value) => value !== day);
    state.schedule.holidayWorkDates = (state.schedule.holidayWorkDates || []).filter((value) => value !== day);
    if (holiday && $('#day-holiday-work').checked && !$('#day-excluded').checked) state.schedule.holidayWorkDates.push(day);
    if ($('#day-excluded').checked) {
        state.schedule.vacationDates.push(day);
        state.schedule.vacationDates.sort((a, b) => a - b);
    } else {
        state.schedule.extraHolidayDates = state.schedule.extraHolidayDates.filter((value) => value !== day);
        state.schedule.specialDates[String(day)] = storedRanges(ranges);
    }
    setDirty();
    renderCalendar();
    return true;
}

async function removeDayEdit() {
    const day = state.selectedDay;
    const entry = getEffectiveDay(day);
    if (!entry?.value) return;
    const hasRecurring = entry.recurring.length > 0;
    const revision = scheduleRevision();
    if (!await confirmAction({ title: '이 날의 예정 일정을 삭제할까요?', message: `${state.year}년 ${state.month}월 ${day}일`,
        details: [hasRecurring ? '이 날짜만 반복 일정에서 제외합니다. 포털 기록은 삭제하지 않습니다.' : '이 날의 수동 예정 일정만 삭제합니다. 포털 기록은 삭제하지 않습니다.'], confirmLabel: '예정 일정 삭제', destructive: true })) return;
    if (!verifyScheduleRevision(revision)) return;
    delete state.schedule.specialDates[String(day)];
    state.schedule.vacationDates = state.schedule.vacationDates.filter(value => value !== day);
    if (hasRecurring) state.schedule.vacationDates.push(day);
    state.schedule.vacationDates.sort((a, b) => a - b);
    state.schedule.holidayWorkDates = (state.schedule.holidayWorkDates || []).filter((value) => value !== day);
    setDirty();
    renderCalendar();
    $('#day-dialog').close();
}

function renderRepeatRules() {
    const names = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'];
    $('#repeat-list').innerHTML = names.map((name, day) => {
        const enabled = state.schedule.regularRules.some((item) => item.day === day);
        return `
            <div class="repeat-row" data-repeat-day="${day}" data-range-editor="repeat">
                <div class="range-toolbar"><label class="repeat-day-field"><input type="checkbox" ${enabled ? 'checked' : ''}>${name}</label><button type="button" class="button button-quiet range-add" data-add-range aria-label="${name} 구간 추가">구간 추가</button></div>
                <div class="range-list" data-range-list></div>
            </div>`;
    }).join('');
    $$('.repeat-row').forEach((row) => {
        const ranges = state.schedule.regularRules.filter(rule => rule.day === Number(row.dataset.repeatDay));
        renderRangeEditor(row, ranges.length ? ranges : [{ start: '0900', end: '1700' }]);
        const checkbox = $('input[type="checkbox"]', row);
        checkbox.addEventListener('change', () => syncRangeEditor(row));
    });
    showError($('#repeat-error'), '');
}

async function applyRepeatRules() {
    showError($('#repeat-error'), '');
    const rules = [];
    for (const row of $$('.repeat-row')) {
        const enabled = $('input[type="checkbox"]', row).checked;
        if (!enabled) continue;
        const day = Number(row.dataset.repeatDay);
        try {
            rules.push(...validateRanges(readRangeEditor(row)).map(range => ({ day, week: ['일', '월', '화', '수', '목', '금', '토'][day], ...range })));
        } catch (error) { showError($('#repeat-error'), `${['일', '월', '화', '수', '목', '금', '토'][day]}요일: ${error.message}`); return false; }
    }
    const preview = calculateClientPreview({ ...state.schedule, regularRules: rules });
    const duration = formatDuration(preview.totalMinutes);
    const ruleTimes = values => JSON.stringify(values.map(({ day, start, end }) => ({ day, start, end })).sort((a, b) => a.day - b.day || a.start.localeCompare(b.start)));
    if (ruleTimes(rules) === ruleTimes(state.schedule.regularRules)) return true;
    const revision = scheduleRevision();
    if (!await confirmAction({ title: '요일 반복 일정을 적용할까요?',
        message: `${state.year}년 ${state.month}월 · ${preview.count}일 · ${duration.hours}시간 ${duration.minutes}분`,
        details: ['날짜별 설정과 제외일은 유지합니다. 포털에는 아직 저장하지 않습니다.',
            ...(state.calendar.error ? ['공휴일 조회에 실패했습니다. 제외일을 직접 확인해주세요.'] : [])], confirmLabel: '반복 일정 적용' })) return false;
    if (!verifyScheduleRevision(revision)) return false;
    state.schedule.regularRules = rules;
    setDirty();
    renderCalendar();
    return true;
}

async function saveSchedule() {
    const button = $('#save-schedule-button');
    state.schedule.content = $('#work-content').value.trim();
    setButtonBusy(button, true, '저장 중...');
    try {
        const data = await api(`/api/schedules/${state.year}/${state.month}`, {
            method: 'PUT',
            body: state.schedule
        });
        state.schedule = data.schedule;
        state.calendar = data.calendar || state.calendar;
        setDirty(false);
        renderCalendar();
        toast('일정이 저장되었습니다.', 'success');
        return true;
    } catch (error) {
        toast(error.message, 'error');
        return false;
    } finally {
        setButtonBusy(button, false);
    }
}

async function savePortalCredential(event) {
    event.preventDefault();
    if (state.portalCredentialSaving) return;
    if (event.submitter?.value === 'cancel') {
        $('#portal-dialog').close();
        return;
    }
    showError($('#portal-error'), '');
    const submit = $('#portal-save-button');
    const controls = $$('#portal-form input, #portal-form button').map(control => [control, control.disabled]);
    state.portalCredentialSaving = true;
    $('#portal-form').setAttribute('aria-busy', 'true');
    setButtonBusy(submit, true, '로그인 확인 중...');
    controls.forEach(([control]) => { control.disabled = true; });
    try {
        state.portalCredential = await api('/api/portal-credentials', {
            method: 'PUT',
            body: { portalId: $('#portal-id').value, portalPassword: $('#portal-password').value }
        });
        updatePortalSummary();
        $('#portal-form').reset();
        $('#portal-dialog').close();
        state.portalSnapshot = null;
        await loadPortalSnapshot();
        toast('로그인 확인 후 포털 계정을 암호화하여 저장했습니다.', 'success');
    } catch (error) {
        showError($('#portal-error'), error.message);
    } finally {
        state.portalCredentialSaving = false;
        $('#portal-form').removeAttribute('aria-busy');
        controls.forEach(([control, disabled]) => { control.disabled = disabled; });
        setButtonBusy(submit, false);
    }
}

async function deletePortalCredential() {
    if (!state.portalCredential.configured) return;
    const userId = state.user?.id;
    const credential = JSON.stringify(state.portalCredential);
    if (!await confirmAction({ title: '포털 연결정보를 삭제할까요?', message: '보관 중인 학교 포털 아이디와 비밀번호를 삭제합니다.',
        details: ['학교 포털의 실제 일지와 앱의 예정 일정은 유지됩니다.'], confirmLabel: '연결정보 삭제', destructive: true })) return;
    if (userId !== state.user?.id || credential !== JSON.stringify(state.portalCredential)) return;
    setButtonBusy($('#delete-portal-button'), true, '삭제 중...');
    try {
        await api('/api/portal-credentials', { method: 'DELETE' });
        state.portalCredential = { configured: false };
        updatePortalSummary();
        $('#portal-dialog').close();
        state.portalSnapshot = null;
        await loadPortalSnapshot();
        toast('포털 계정 정보를 삭제했습니다.');
    } catch (error) {
        showError($('#portal-error'), error.message);
    } finally {
        setButtonBusy($('#delete-portal-button'), false);
    }
}

function statusLabel(status) {
    return { queued: '대기', running: '실행 중', succeeded: '완료', failed: '실패', cancelled: '취소' }[status] || status;
}

function jobTitle(job) {
    const operation = job.summary?.operation;
    return `${job.year}년 ${job.month}월 ${operation === 'delete' ? '포털 일지 삭제' : operation === 'update' ? '포털 일지 수정' : job.type === 'query' ? '기록 조회' : '자동 입력'}`;
}

function jobSummary(job) {
    if (!job.summary) return '';
    if (job.summary.operation) return `${formatPortalDate(job.summary.date)} ${job.summary.operation === 'delete' ? '삭제' : '수정'} · 재조회 검증 완료`;
    if (job.type === 'submit') {
        return `입력 ${job.summary.insertedCount || 0}건 · 중복 제외 ${job.summary.skippedCount || 0}건 · 검증 완료`;
    }
    if (Array.isArray(job.summary.records)) {
        const totalMinutes = job.summary.records.reduce((sum, record) => {
            const start = timeToMinutes(record.start);
            const end = timeToMinutes(record.end);
            return start !== null && end !== null && end > start ? sum + end - start : sum;
        }, 0);
        const duration = formatDuration(totalMinutes);
        const assignmentCount = Array.isArray(job.summary.assignments) ? job.summary.assignments.length : 0;
        const assignmentText = assignmentCount ? `승인 배정 ${assignmentCount}개 · ` : '';
        return `${assignmentText}포털 ${job.summary.records.length}건 · ${duration.hours}시간${duration.minutes ? ` ${duration.minutes}분` : ''}`;
    }
    return '';
}

function renderJobs() {
    const list = $('#job-list');
    if (!state.jobs.length) {
        list.innerHTML = '<div class="empty-state"><span aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="5" width="16" height="16" rx="3"/><path d="M8 3v4m8-4v4M4 10h16m-11 5h6"/></svg></span><p>아직 실행한 작업이 없습니다.</p></div>';
        updateAutomationStatus(null);
        return;
    }
    list.innerHTML = state.jobs.map((job) => {
        const expanded = state.expandedJobId === job.id;
        const logs = expanded && job.logs?.length
            ? `<div class="job-logs">${job.logs.map((log) => `<p class="${escapeHtml(log.level)}">${escapeHtml(log.message)}</p>`).join('')}</div>`
            : '';
        const summary = jobSummary(job);
        return `
            <article class="job-item" data-job-id="${escapeHtml(job.id)}">
                <div class="job-top"><strong>${escapeHtml(jobTitle(job))}</strong><span class="job-status ${escapeHtml(job.status)}">${escapeHtml(statusLabel(job.status))}</span></div>
                <div class="job-meta"><span>${escapeHtml(new Date(job.createdAt).toLocaleString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }))}</span><span>${job.progress}%</span></div>
                <progress class="job-progress" max="100" value="${Math.max(0, job.progress)}" aria-label="작업 진행률 ${job.progress}%"></progress>
                ${summary ? `<p class="job-summary">${escapeHtml(summary)}</p>` : ''}
                ${job.errorMessage ? `<p class="form-error">${escapeHtml(job.errorMessage)}</p>` : ''}
                ${logs}
            </article>`;
    }).join('');
    $$('.job-item', list).forEach((item) => item.addEventListener('click', async () => {
        const id = item.dataset.jobId;
        state.expandedJobId = state.expandedJobId === id ? null : id;
        if (state.expandedJobId) await loadJobDetails(id);
        else renderJobs();
    }));
    updateAutomationStatus(state.jobs[0]);
}

function updateAutomationStatus(job) {
    const live = $('.live-dot');
    if (!job) {
        $('#automation-state').textContent = '준비';
        $('#automation-note').textContent = '실행 대기 중';
        live.classList.remove('running');
        live.innerHTML = '<i></i>대기';
        return;
    }
    $('#automation-state').textContent = statusLabel(job.status);
    $('#automation-note').textContent = job.status === 'running' ? `${job.progress}% 진행 중` : jobTitle(job);
    const running = ['queued', 'running'].includes(job.status);
    live.classList.toggle('running', running);
    live.innerHTML = `<i></i>${running ? '작동 중' : statusLabel(job.status)}`;
}

async function loadJobs() {
    const data = await api('/api/jobs');
    state.jobs = data.jobs;
    renderJobs();
    const active = state.jobs.find((job) => ['queued', 'running'].includes(job.status));
    if (active) subscribeToJob(active.id);
    await loadPortalSnapshot();
}

async function loadJobDetails(id) {
    const data = await api(`/api/jobs/${id}`);
    state.jobs = state.jobs.map((job) => job.id === id ? data.job : job);
    renderJobs();
}

function subscribeToJob(id) {
    state.eventSource?.close();
    const source = new EventSource(`/api/jobs/${id}/events`);
    state.eventSource = source;
    source.addEventListener('job', (event) => {
        const job = JSON.parse(event.data);
        const index = state.jobs.findIndex((item) => item.id === job.id);
        if (index >= 0) state.jobs[index] = job;
        else state.jobs.unshift(job);
        renderJobs();
        if (['succeeded', 'failed', 'cancelled'].includes(job.status)) {
            source.close();
            state.eventSource = null;
            if (state.assignmentSelectionJobId === job.id) {
                state.assignmentSelectionJobId = null;
                if (job.status === 'succeeded' && job.year === state.year && job.month === state.month) handleAssignmentQueryResult(job.summary?.assignments || []);
            }
            void loadPortalSnapshot();
            toast(job.status === 'succeeded' ? '작업이 완료되었습니다.' : '작업이 실패했습니다. 로그를 확인해주세요.', job.status === 'succeeded' ? 'success' : 'error');
        }
    });
    source.onerror = () => {
        if (source.readyState === EventSource.CLOSED) state.eventSource = null;
    };
}

async function createJob(type, options = {}) {
    if (!state.portalCredential.configured) {
        toast('학교 포털 계정을 먼저 등록해주세요.', 'error');
        $('#portal-dialog').showModal();
        return;
    }
    const button = type === 'query' ? $('#query-button') : $('#confirm-run-button');
    setButtonBusy(button, true, type === 'query' ? '조회 요청 중...' : '실행 요청 중...');
    try {
        const data = await api('/api/jobs', {
            method: 'POST',
            body: { type, year: state.year, month: state.month }
        });
        state.jobs.unshift(data.job);
        state.expandedJobId = data.job.id;
        if (options.selectAssignment) state.assignmentSelectionJobId = data.job.id;
        renderJobs();
        subscribeToJob(data.job.id);
        if (type === 'submit') $('#run-dialog').close();
        toast(type === 'query' ? '포털 조회를 시작했습니다.' : '자동 입력을 시작했습니다.', 'success');
        return data.job;
    } catch (error) {
        toast(error.message, 'error');
    } finally {
        setButtonBusy(button, false);
    }
}

function formatPortalDate(value) {
    const digits = String(value || '').replace(/\D/g, '');
    return digits.length === 8 ? `${digits.slice(0, 4)}.${digits.slice(4, 6)}.${digits.slice(6)}` : '기간 정보 없음';
}

function assignmentMatches(left, right) {
    return Boolean(left && right
        && left.scholarshipCode === right.scholarshipCode
        && left.workDepartmentCode === right.workDepartmentCode);
}

function chooseAssignment(assignment) {
    state.schedule.portalAssignment = {
        scholarshipCode: assignment.scholarshipCode,
        scholarshipName: assignment.scholarshipName,
        workDepartmentCode: assignment.workDepartmentCode,
        workDepartmentName: assignment.workDepartmentName
    };
    setDirty();
    renderAssignmentSummary();
}

function renderAssignmentDialog(assignments) {
    state.portalAssignments = assignments;
    const selected = state.schedule?.portalAssignment;
    $('#assignment-list').innerHTML = assignments.map((assignment, index) => {
        const checked = assignmentMatches(selected, assignment) || (!selected && assignments.length === 1);
        return `
            <label class="assignment-option">
                <input type="radio" name="portal-assignment" value="${index}" ${checked ? 'checked' : ''}>
                <span class="assignment-radio" aria-hidden="true"></span>
                <span class="assignment-option-copy">
                    <strong>${escapeHtml(assignment.scholarshipName || assignment.scholarshipCode)}</strong>
                    <span>${escapeHtml(assignment.workDepartmentName || assignment.workDepartmentCode)}</span>
                    <small>${escapeHtml(formatPortalDate(assignment.startDate))}–${escapeHtml(formatPortalDate(assignment.endDate))} · 기존 기록 ${Number(assignment.recordCount) || 0}건${assignment.totalWorkTime ? ` · 누적 ${escapeHtml(assignment.totalWorkTime)}` : ''}</small>
                </span>
                <span class="assignment-code">${escapeHtml(assignment.scholarshipCode)} / ${escapeHtml(assignment.workDepartmentCode)}</span>
            </label>`;
    }).join('');
    showError($('#assignment-error'), '');
    $('#assignment-dialog').showModal();
}

function handleAssignmentQueryResult(assignments) {
    if (!assignments.length) {
        toast('해당 월에 승인된 근로 배정을 찾지 못했습니다.', 'error');
        return;
    }
    if (assignments.length === 1) {
        chooseAssignment(assignments[0]);
        toast('승인된 근로 배정 1개를 선택했습니다. 일정을 저장하면 적용됩니다.', 'success');
        return;
    }
    renderAssignmentDialog(assignments);
}

async function openAssignmentSelection() {
    if (!state.portalCredential.configured) {
        toast('학교 포털 계정을 먼저 등록해주세요.', 'error');
        $('#portal-dialog').showModal();
        return;
    }
    await createJob('query', { selectAssignment: true });
}

async function openRunDialog() {
    if (state.schedule?.year !== state.year || state.schedule?.month !== state.month) return;
    // Persist refreshed holiday exclusions before showing the submission preview.
    if (!await saveSchedule()) return;
    if (!state.schedule.portalAssignment) {
        toast('자동입력할 장학 유형과 근무지를 먼저 선택해주세요.', 'error');
        await openAssignmentSelection();
        return;
    }
    const preview = calculateClientPreview();
    if (!preview.count) {
        toast('입력할 근무 일정이 없습니다.', 'error');
        return;
    }
    const duration = formatDuration(preview.totalMinutes);
    $('#run-summary').innerHTML = `
        <div><span>대상 연월</span><strong>${state.year}. ${String(state.month).padStart(2, '0')}</strong></div>
        <div><span>예상 입력</span><strong>${preview.count}일 · ${preview.entryCount}구간</strong></div>
        <div><span>예상 시수</span><strong>${duration.hours}시간 ${duration.minutes}분</strong></div>
        <div><span>근무 내용</span><strong>${escapeHtml(state.schedule.content)}</strong></div>
        <div class="run-assignment"><span>장학 유형</span><strong>${escapeHtml(state.schedule.portalAssignment.scholarshipName || state.schedule.portalAssignment.scholarshipCode)}</strong></div>
        <div class="run-assignment"><span>근무지</span><strong>${escapeHtml(state.schedule.portalAssignment.workDepartmentName || state.schedule.portalAssignment.workDepartmentCode)}</strong></div>`;
    $('#run-confirm-checkbox').checked = false;
    $('#confirm-run-button').disabled = true;
    $('#run-dialog').showModal();
}

async function changePassword(event) {
    event.preventDefault();
    if (event.submitter?.value === 'cancel') {
        $('#password-dialog').close();
        return;
    }
    showError($('#password-error'), '');
    try {
        const data = await api('/api/me/password', {
            method: 'PUT',
            body: { currentPassword: $('#current-password').value, newPassword: $('#new-password').value }
        });
        state.csrfToken = data.csrfToken;
        $('#password-form').reset();
        $('#password-dialog').close();
        toast('앱 비밀번호를 변경했습니다.', 'success');
    } catch (error) {
        showError($('#password-error'), error.message);
    }
}

async function openAdminDialog() {
    $('#admin-dialog').showModal();
    await loadAdminUsers();
}

async function loadAdminUsers() {
    const data = await api('/api/admin/users');
    $('#admin-user-list').innerHTML = data.users.map((user) => `
        <article class="admin-user" data-user-id="${user.id}">
            <p><strong>${escapeHtml(user.displayName)}</strong><small>${escapeHtml(user.username)} · ${user.isActive ? '활성' : '비활성'}</small></p>
            <select aria-label="${escapeHtml(user.displayName)} 권한" ${user.id === state.user.id ? 'disabled' : ''}>
                <option value="user" ${user.role === 'user' ? 'selected' : ''}>일반 사용자</option>
                <option value="admin" ${user.role === 'admin' ? 'selected' : ''}>관리자</option>
            </select>
            <button type="button" ${user.id === state.user.id ? 'disabled' : ''}>${user.isActive ? '비활성화' : '활성화'}</button>
        </article>`).join('');
    $$('.admin-user').forEach((row) => {
        const id = Number(row.dataset.userId);
        const select = $('select', row);
        select.addEventListener('change', () => updateAdminUser(id, { role: select.value }));
        $('button', row).addEventListener('click', () => {
            const isCurrentlyActive = $('small', row).textContent.includes('활성') && !$('small', row).textContent.includes('비활성');
            updateAdminUser(id, { isActive: !isCurrentlyActive });
        });
    });
}

async function updateAdminUser(id, changes) {
    try {
        await api(`/api/admin/users/${id}`, { method: 'PATCH', body: changes });
        await loadAdminUsers();
        toast('사용자 정보를 변경했습니다.', 'success');
    } catch (error) {
        toast(error.message, 'error');
        await loadAdminUsers();
    }
}

async function createUser(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    showError($('#create-user-error'), '');
    try {
        await api('/api/admin/users', {
            method: 'POST',
            body: Object.fromEntries(form.entries())
        });
        event.currentTarget.reset();
        await loadAdminUsers();
        toast('새 사용자를 만들었습니다.', 'success');
    } catch (error) {
        showError($('#create-user-error'), error.message);
    }
}

function bindEvents() {
    window.addEventListener('blur', clearScheduleDrag);
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && state.pointerSchedule?.active) {
            state.suppressDayClickUntil = Date.now() + 400;
            clearScheduleDrag();
        }
    });
    document.addEventListener('focusout', event => {
        if (!event.target.matches('.time-input')) return;
        const digits = compactTime(event.target.value);
        if (timeToMinutes(digits) !== null) event.target.value = displayTime(digits);
    });
    document.addEventListener('click', event => {
        const button = event.target.closest('[data-add-range], [data-remove-range]');
        if (!button || button.disabled) return;
        const editor = button.closest('[data-range-editor]');
        const ranges = readRangeEditor(editor);
        const adding = button.hasAttribute('data-add-range');
        if (adding && ranges.length < 8) ranges.push({ start: '', end: '' });
        else if (!adding && ranges.length > 1) ranges.splice(Number(button.dataset.removeRange), 1);
        renderRangeEditor(editor, ranges);
        const inputs = $$('.range-start', editor);
        inputs[adding ? inputs.length - 1 : 0]?.focus();
    });
    // Cancelling a dialog must not trigger validation of unfinished inputs.
    $$('button[value="cancel"]').forEach(button => { button.formNoValidate = true; });
    $('#action-confirm-dialog').addEventListener('close', () => {
        const resolve = pendingConfirmation;
        pendingConfirmation = null;
        resolve?.($('#action-confirm-dialog').returnValue === 'confirm');
    });
    $$('dialog').forEach(dialog => {
        const title = $('h2', dialog);
        if (!title) return;
        title.id ||= `${dialog.id}-title`;
        dialog.setAttribute('aria-labelledby', title.id);
    });
    updateDialogViewport();
    window.addEventListener('resize', updateDialogViewport);
    window.visualViewport?.addEventListener('resize', updateDialogViewport);
    window.visualViewport?.addEventListener('scroll', updateDialogViewport);
    document.addEventListener('focusin', revealDialogInput);
    document.addEventListener('animationend', event => {
        if (event.target.matches('dialog[open]')) revealDialogInput();
    });
    $('#portal-record-form').addEventListener('submit', submitPortalRecordChange);
    $('#portal-record-confirm').addEventListener('change', (event) => {
        if (!state.portalMutationBusy) $('#portal-record-submit').disabled = !event.target.checked;
    });
    $('#portal-record-dialog').addEventListener('cancel', (event) => {
        if (state.portalMutationBusy) event.preventDefault();
    });
    $('#day-holiday-work').addEventListener('change', (event) => {
        $('#day-excluded').checked = !event.target.checked;
        syncRangeEditor($('#day-range-editor'));
    });
    $('#day-excluded').addEventListener('change', () => syncRangeEditor($('#day-range-editor')));
    for (const [id, mode] of [['login-tab', 'login'], ['signup-tab', 'signup'], ['admin-setup-button', 'setup']]) {
        $(`#${id}`).addEventListener('click', () => {
            $('#password').value = '';
            $('#password-confirm').value = '';
            showAuthView(state.setupRequired, state.setupTokenRequired, mode);
        });
    }
    $('#auth-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        showError($('#auth-error'), '');
        const button = $('#auth-submit');
        setButtonBusy(button, true, state.authMode !== 'login' ? '계정 생성 중...' : '로그인 중...');
        try {
            const endpoint = `/api/${state.authMode}`;
            const payload = {
                username: $('#username').value,
                password: $('#password').value,
                passwordConfirmation: $('#password-confirm').value,
                displayName: $('#display-name').value,
                setupToken: $('#setup-token').value
            };
            const data = await api(endpoint, { method: 'POST', body: payload });
            state.user = data.user;
            state.csrfToken = data.csrfToken;
            state.portalCredential = data.portalCredential || { configured: false };
            $('#auth-form').reset();
            showDashboard();
            await Promise.all([loadSchedule(), loadJobs()]);
        } catch (error) {
            showError($('#auth-error'), error.message);
        } finally {
            setButtonBusy(button, false);
        }
    });

    $$('.password-toggle').forEach((button) => button.addEventListener('click', () => {
        const input = $(`#${button.dataset.target}`);
        input.type = input.type === 'password' ? 'text' : 'password';
        button.textContent = input.type === 'password' ? '보기' : '숨김';
    }));

    $('#previous-month').addEventListener('click', () => changeMonth(-1));
    $('#next-month').addEventListener('click', () => changeMonth(1));
    $('#month-label').addEventListener('click', async () => {
        state.year = new Date().getFullYear();
        state.month = new Date().getMonth() + 1;
        await loadSchedule();
    });
    $('#work-content').addEventListener('input', () => {
        state.schedule.content = $('#work-content').value;
        setDirty();
    });
    $('#save-schedule-button').addEventListener('click', saveSchedule);
    $('#copy-day-button').addEventListener('click', () => {
        const source = manualCopySource(state.selectedDay);
        if (!source) return;
        let ranges;
        try { ranges = validateRanges(readRangeEditor($('#day-range-editor'))); }
        catch (error) { showError($('#day-error'), error.message); return; }
        if (rangeKey(ranges) !== rangeKey(source.ranges) || $('#day-excluded').checked) {
            showError($('#day-error'), '시간이나 제외 여부를 바꿨다면 먼저 적용한 뒤 복사해주세요.');
            return;
        }
        copyManualSchedule(source, Number($('#day-copy-target').value));
    });

    $('#day-form').addEventListener('submit', (event) => {
        event.preventDefault();
        if (event.submitter?.value === 'cancel') return $('#day-dialog').close();
        if (applyDayEdit()) $('#day-dialog').close();
    });
    $('#remove-day-button').addEventListener('click', removeDayEdit);
    $('#repeat-settings-button').addEventListener('click', () => {
        renderRepeatRules();
        $('#repeat-dialog').showModal();
    });
    $('#repeat-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        if (event.submitter?.value === 'cancel') return $('#repeat-dialog').close();
        if (await applyRepeatRules()) $('#repeat-dialog').close();
    });

    $('#portal-settings-button').addEventListener('click', () => {
        $('#portal-form').reset();
        $('#portal-id').placeholder = state.portalCredential.configured ? state.portalCredential.maskedId : '학교 포털 아이디';
        $('#delete-portal-button').hidden = !state.portalCredential.configured;
        showError($('#portal-error'), '');
        $('#portal-dialog').showModal();
    });
    $('#portal-form').addEventListener('submit', savePortalCredential);
    $('#portal-dialog').addEventListener('cancel', event => {
        if (state.portalCredentialSaving) event.preventDefault();
    });
    $('#delete-portal-button').addEventListener('click', deletePortalCredential);

    $('#assignment-settings-button').addEventListener('click', openAssignmentSelection);
    $('#assignment-form').addEventListener('submit', (event) => {
        event.preventDefault();
        if (event.submitter?.value === 'cancel') return $('#assignment-dialog').close();
        const selected = $('input[name="portal-assignment"]:checked', event.currentTarget);
        const assignment = selected ? state.portalAssignments[Number(selected.value)] : null;
        if (!assignment) {
            showError($('#assignment-error'), '사용할 장학 유형과 근무지를 선택해주세요.');
            return;
        }
        chooseAssignment(assignment);
        $('#assignment-dialog').close();
        toast('근로 배정을 선택했습니다. 일정을 저장하면 적용됩니다.', 'success');
    });

    $('#query-button').addEventListener('click', () => createJob('query'));
    $('#run-button').addEventListener('click', openRunDialog);
    $('#run-confirm-checkbox').addEventListener('change', (event) => { $('#confirm-run-button').disabled = !event.target.checked; });
    $('#run-confirm-form').addEventListener('submit', (event) => {
        event.preventDefault();
        if (event.submitter?.value === 'cancel') return $('#run-dialog').close();
        createJob('submit');
    });
    $('#refresh-jobs-button').addEventListener('click', loadJobs);

    $('#user-menu-button').addEventListener('click', () => { $('#user-menu').hidden = !$('#user-menu').hidden; });
    document.addEventListener('click', (event) => {
        if (!event.target.closest('.topbar-actions')) $('#user-menu').hidden = true;
    });
    $('#logout-button').addEventListener('click', async () => {
        try { await api('/api/logout', { method: 'POST' }); } catch {}
        state.eventSource?.close();
        state.user = null;
        state.csrfToken = null;
        state.portalCredential = { configured: false };
        state.portalSnapshot = null;
        state.portalReadVersion += 1;
        state.scheduleReadVersion += 1;
        state.jobs = [];
        state.assignmentSelectionJobId = null;
        $('#user-menu').hidden = true;
        await bootstrap();
    });
    $('#change-password-button').addEventListener('click', () => {
        $('#user-menu').hidden = true;
        $('#password-form').reset();
        showError($('#password-error'), '');
        $('#password-dialog').showModal();
    });
    $('#password-form').addEventListener('submit', changePassword);

    $('#admin-button').addEventListener('click', openAdminDialog);
    $('#admin-menu-button').addEventListener('click', () => {
        $('#user-menu').hidden = true;
        void openAdminDialog();
    });
    $('#create-user-form').addEventListener('submit', createUser);
    $('#help-button').addEventListener('click', () => $('#help-dialog').showModal());
    $$('[data-close-dialog]').forEach((button) => button.addEventListener('click', () => $(`#${button.dataset.closeDialog}`).close()));
}

bindEvents();
bootstrap().catch((error) => {
    console.error(error);
    showAuthView(false);
    showError($('#auth-error'), '서버에 연결하지 못했습니다. 잠시 후 새로고침해주세요.');
});
