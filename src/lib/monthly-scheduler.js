const crypto = require('crypto');
const { validateSchedulePayload, previewSchedule } = require('./schedule');

const KST_OFFSET = 9 * 60 * 60 * 1000;

function localMonth(value) {
    const date = new Date(new Date(value).getTime() + KST_OFFSET);
    return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 };
}

function occurrence(settings, year, month) {
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const day = settings.day === 0 ? lastDay : Math.min(settings.day, lastDay);
    return new Date(Date.UTC(year, month - 1, day, Number(settings.time.slice(0, 2)), Number(settings.time.slice(2))) - KST_OFFSET).toISOString();
}

function nextOccurrence(settings, after, alreadyRan = () => false) {
    const now = new Date(after).getTime();
    const current = localMonth(after);
    for (let offset = 0; offset < 120; offset++) {
        const date = new Date(Date.UTC(current.year, current.month - 1 + offset, 1));
        const year = date.getUTCFullYear();
        const month = date.getUTCMonth() + 1;
        const next = occurrence(settings, year, month);
        if (Date.parse(next) > now && !alreadyRan(year * 100 + month)) return next;
    }
    throw new Error('다음 예약 실행일을 계산하지 못했습니다.');
}

function targetMonth(settings, dueAt) {
    const current = localMonth(dueAt);
    const date = new Date(Date.UTC(current.year, current.month - 1 + (settings.targetMonth === 'previous' ? -1 : 0), 1));
    return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 };
}

function nextDayOccurrence(settings, now) {
    const date = new Date(Date.parse(now) + KST_OFFSET);
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1,
        Number(settings.time.slice(0, 2)), Number(settings.time.slice(2))) - KST_OFFSET).toISOString();
}

function validateMonthlySettings(payload) {
    if (typeof payload?.enabled !== 'boolean') return { error: '예약 실행 사용 여부를 확인해주세요.' };
    if (!payload.enabled) return { value: { enabled: false } };
    if (payload.confirmed !== true) return { error: '매월 실제 포털 자동 등록에 동의해주세요.' };
    const day = payload.day;
    const time = String(payload.time || '').replace(':', '');
    if (!Number.isInteger(day) || day < 0 || day > 31 || !/^([01]\d|2[0-3])[0-5]\d$/.test(time)) {
        return { error: '실행 날짜와 시각(00:00~23:59)을 확인해주세요.' };
    }
    if (!['current', 'previous'].includes(payload.targetMonth)) return { error: '실행 대상 월을 선택해주세요.' };
    const assignment = validateSchedulePayload({ portalAssignment: payload.assignment }, 2026, 1);
    if (!assignment.ok || !assignment.value.portalAssignment) return { error: '예약 실행의 기본 근로 배정을 선택해주세요.' };
    return { value: { enabled: true, day, time, targetMonth: payload.targetMonth, assignment: assignment.value.portalAssignment } };
}

class MonthlyScheduler {
    constructor({ db, queue, calendar, isBusy = () => false, paused = () => false, activeUsers = new Set(), now = () => new Date() }) {
        Object.assign(this, { db, queue, calendar, isBusy, paused, activeUsers, now });
        this.stopped = false;
        this.pendingTick = null;
        this.timer = null;
    }

    start() {
        if (this.timer) return;
        this.stopped = false;
        this.timer = setInterval(() => { void this.tick().catch(error => console.error('Monthly scheduler:', error.message)); }, 30_000);
        this.timer.unref();
        void this.tick().catch(error => console.error('Monthly scheduler:', error.message));
    }

    async stop() {
        this.stopped = true;
        clearInterval(this.timer);
        this.timer = null;
        await this.pendingTick;
    }

    tick() {
        if (this.pendingTick) return this.pendingTick;
        this.pendingTick = this.processDue().finally(() => { this.pendingTick = null; });
        return this.pendingTick;
    }

    async processDue() {
        if (this.stopped || this.paused()) return;
        const retries = this.db.listDueApprovalRetries(this.now().toISOString()).map(retry => ({
            ...this.db.getMonthlyAutomation(retry.user_id), retry, nextRunAt: retry.retry_at
        }));
        for (const settings of [...retries, ...this.db.listDueMonthlyAutomations(this.now().toISOString())]) {
            if (this.stopped || this.paused()) break;
            if (this.isBusy(settings.userId) || this.queue.hasPendingForUser(settings.userId)) continue;
            this.activeUsers.add(settings.userId);
            let job;
            try {
                const now = this.now();
                const target = settings.retry ? { year: settings.retry.schedule_year, month: settings.retry.schedule_month }
                    : targetMonth(settings, settings.nextRunAt);
                const slot = localMonth(settings.nextRunAt);
                job = settings.retry ? this.db.claimApprovalRetry(settings.retry, crypto.randomUUID(), now.toISOString()) : this.db.claimMonthlyRun(settings, {
                    id: crypto.randomUUID(), ...target, runMonth: slot.year * 100 + slot.month,
                    nextRunAt: nextOccurrence(settings, now), now: now.toISOString()
                });
                if (!job) continue;
                if (now.getTime() - Date.parse(settings.nextRunAt) > 24 * 60 * 60 * 1000) {
                    throw new Error('예약 시각으로부터 24시간이 지나 자동 등록을 건너뛰었습니다. 일정을 확인한 뒤 직접 실행해주세요.');
                }
                if (!this.db.getPortalCredential(settings.userId)) throw new Error('포털 연결정보가 없어 예약 실행을 중단했습니다.');
                const saved = this.db.getSchedule(settings.userId, target.year, target.month);
                const calendar = await this.calendar(target.year, target.month);
                if (calendar.error) throw new Error('공휴일 조회 실패로 예약 실행을 중단했습니다. 직접 확인 후 실행해주세요.');
                const validated = validateSchedulePayload({
                    ...(saved || this.db.getRecurringRules(settings.userId, target.year, target.month)),
                    portalAssignment: saved?.portalAssignment || settings.assignment,
                    holidayDates: calendar.holidays.map(holiday => holiday.day)
                }, target.year, target.month);
                if (!validated.ok) throw new Error(validated.errors[0]);
                if (this.stopped) throw new Error('서버 종료로 예약 실행을 중단했습니다. 다음 접속 시 작업 결과를 확인해주세요.');
                const schedule = validated.value;
                if (!previewSchedule(schedule, new Set(schedule.extraHolidayDates)).count) {
                    this.db.completeJob(job.id, { scheduled: true, skipped: true, reason: '등록할 예정 일정이 없습니다.' });
                    this.db.addJobLog(job.id, 'info', '등록할 예정 일정이 없어 포털 접속 없이 종료했습니다.');
                    continue;
                }
                this.queue.enqueue({ id: job.id, userId: settings.userId, type: 'submit', ...target, schedule, scheduled: true });
            } catch (error) {
                if (job) {
                    this.db.failJob(job.id, error.message);
                    this.db.addJobLog(job.id, 'error', error.message);
                } else throw error;
            } finally {
                this.activeUsers.delete(settings.userId);
                if (job) this.queue.emitSnapshot(job.id);
            }
        }
    }
}

module.exports = { MonthlyScheduler, localMonth, occurrence, nextOccurrence, nextDayOccurrence, targetMonth, validateMonthlySettings };
