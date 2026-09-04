const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { nextOccurrence, nextDayOccurrence } = require('./monthly-scheduler');

function nowIso() {
    return new Date().toISOString();
}

function ruleKey(rules) {
    return JSON.stringify(rules.map(({ day, start, end }) => ({ day, start, end }))
        .sort((a, b) => a.day - b.day || a.start.localeCompare(b.start) || a.end.localeCompare(b.end)));
}

function parseJson(value, fallback) {
    try {
        return value ? JSON.parse(value) : fallback;
    } catch {
        return fallback;
    }
}

function toPublicUser(row) {
    if (!row) return null;
    return {
        id: row.id,
        username: row.username,
        displayName: row.display_name,
        role: row.role,
        isActive: Boolean(row.is_active),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        lastLoginAt: row.last_login_at || null
    };
}

function toSchedule(row) {
    if (!row) return null;
    return {
        id: row.id,
        userId: row.user_id,
        year: row.year,
        month: row.month,
        content: row.content,
        portalAssignment: parseJson(row.portal_assignment_json, null),
        regularRules: parseJson(row.regular_rules_json, []),
        specialDates: parseJson(row.special_dates_json, {}),
        vacationDates: parseJson(row.vacation_dates_json, []),
        extraHolidayDates: parseJson(row.extra_holiday_dates_json, []),
        holidayDates: parseJson(row.holiday_dates_json, []),
        holidayWorkDates: parseJson(row.holiday_work_dates_json, []),
        cleanupUnexpectedRows: Boolean(row.cleanup_unexpected_rows),
        updatedAt: row.updated_at
    };
}

function toJob(row, logs = undefined) {
    if (!row) return null;
    const job = {
        id: row.id,
        userId: row.user_id,
        type: row.type,
        triggerSource: row.trigger_source || 'manual',
        year: row.schedule_year,
        month: row.schedule_month,
        status: row.status,
        progress: row.progress,
        summary: parseJson(row.summary_json, null),
        errorMessage: row.error_message || null,
        createdAt: row.created_at,
        startedAt: row.started_at || null,
        finishedAt: row.finished_at || null
    };
    if (logs !== undefined) job.logs = logs;
    return job;
}

function createDatabase(databasePath) {
    if (databasePath !== ':memory:') {
        fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    }

    const db = new Database(databasePath);
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    if (databasePath !== ':memory:') db.pragma('journal_mode = WAL');

    db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL COLLATE NOCASE UNIQUE,
            display_name TEXT NOT NULL,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL CHECK (role IN ('admin', 'user')) DEFAULT 'user',
            is_active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            last_login_at TEXT
        );

        CREATE TABLE IF NOT EXISTS portal_credentials (
            user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
            portal_id_encrypted TEXT NOT NULL,
            portal_password_encrypted TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS schedules (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            year INTEGER NOT NULL,
            month INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
            content TEXT NOT NULL,
            portal_assignment_json TEXT,
            regular_rules_json TEXT NOT NULL DEFAULT '[]',
            special_dates_json TEXT NOT NULL DEFAULT '{}',
            vacation_dates_json TEXT NOT NULL DEFAULT '[]',
            extra_holiday_dates_json TEXT NOT NULL DEFAULT '[]',
            cleanup_unexpected_rows INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE (user_id, year, month)
        );

        CREATE TABLE IF NOT EXISTS sessions (
            token_hash TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            csrf_token TEXT NOT NULL,
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS jobs (
            id TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            type TEXT NOT NULL CHECK (type IN ('submit', 'query')) DEFAULT 'submit',
            schedule_year INTEGER NOT NULL,
            schedule_month INTEGER NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
            progress INTEGER NOT NULL DEFAULT 0,
            summary_json TEXT,
            error_message TEXT,
            created_at TEXT NOT NULL,
            started_at TEXT,
            finished_at TEXT
        );

        CREATE TABLE IF NOT EXISTS job_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
            level TEXT NOT NULL CHECK (level IN ('info', 'success', 'warning', 'error')),
            message TEXT NOT NULL,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS audit_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
            action TEXT NOT NULL,
            metadata_json TEXT NOT NULL DEFAULT '{}',
            ip_address TEXT,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS monthly_automations (
            user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
            settings_json TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 0,
            next_run_at TEXT,
            revision INTEGER NOT NULL DEFAULT 1,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS monthly_runs (
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            run_month INTEGER NOT NULL,
            due_at TEXT NOT NULL,
            job_id TEXT NOT NULL REFERENCES jobs(id),
            PRIMARY KEY (user_id, run_month)
        );
        CREATE INDEX IF NOT EXISTS idx_monthly_due ON monthly_automations(enabled, next_run_at);

        CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
        CREATE INDEX IF NOT EXISTS idx_schedules_user_month ON schedules(user_id, year, month);
        CREATE INDEX IF NOT EXISTS idx_jobs_user_created ON jobs(user_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_job_logs_job ON job_logs(job_id, id);
        CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);
    `);

    const scheduleColumns = new Set(db.pragma('table_info(schedules)').map((column) => column.name));
    if (!db.pragma('table_info(jobs)').some(column => column.name === 'trigger_source')) {
        db.exec("ALTER TABLE jobs ADD COLUMN trigger_source TEXT NOT NULL DEFAULT 'manual'");
    }
    const monthlyColumns = new Set(db.pragma('table_info(monthly_runs)').map(column => column.name));
    for (const [column, type] of [['retry_at', 'TEXT'], ['automation_revision', 'INTEGER'], ['attempt_count', 'INTEGER NOT NULL DEFAULT 1']]) {
        if (!monthlyColumns.has(column)) db.exec(`ALTER TABLE monthly_runs ADD COLUMN ${column} ${type}`);
    }
    if (!scheduleColumns.has('portal_assignment_json')) {
        db.exec('ALTER TABLE schedules ADD COLUMN portal_assignment_json TEXT');
    }
    for (const column of ['holiday_dates_json', 'holiday_work_dates_json']) {
        if (!scheduleColumns.has(column)) db.exec(`ALTER TABLE schedules ADD COLUMN ${column} TEXT NOT NULL DEFAULT '[]'`);
    }

    // Seed legacy monthly rules exactly once; later monthly saves must not freeze inherited rules.
    db.transaction(() => {
        if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'recurring_rules'").get()) return;
        db.exec(`CREATE TABLE recurring_rules (
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            effective_month INTEGER NOT NULL,
            rules_json TEXT NOT NULL,
            revision INTEGER NOT NULL DEFAULT 1,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (user_id, effective_month)
        );
        INSERT INTO recurring_rules (user_id, effective_month, rules_json, updated_at)
        SELECT user_id, year * 100 + month, regular_rules_json, updated_at FROM schedules;`);
    })();

    db.prepare(`
        UPDATE jobs
        SET status = 'failed', error_message = '서버 재시작으로 작업이 중단되었습니다.',
            finished_at = ?, progress = CASE WHEN progress > 99 THEN 99 ELSE progress END
        WHERE status IN ('queued', 'running')
    `).run(nowIso());

    const statements = {
        countUsers: db.prepare('SELECT COUNT(*) AS count FROM users'),
        countAdmins: db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'"),
        createUser: db.prepare(`
            INSERT INTO users (username, display_name, password_hash, role, created_at, updated_at)
            VALUES (@username, @displayName, @passwordHash, @role, @now, @now)
        `),
        findUserById: db.prepare('SELECT * FROM users WHERE id = ?'),
        findUserByUsername: db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE'),
        listUsers: db.prepare('SELECT * FROM users ORDER BY created_at ASC'),
        touchLogin: db.prepare('UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?'),
        updatePassword: db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?'),
        updateUserState: db.prepare('UPDATE users SET display_name = ?, role = ?, is_active = ?, updated_at = ? WHERE id = ?'),
        upsertCredential: db.prepare(`
            INSERT INTO portal_credentials (user_id, portal_id_encrypted, portal_password_encrypted, updated_at)
            VALUES (@userId, @portalIdEncrypted, @portalPasswordEncrypted, @now)
            ON CONFLICT(user_id) DO UPDATE SET
                portal_id_encrypted = excluded.portal_id_encrypted,
                portal_password_encrypted = excluded.portal_password_encrypted,
                updated_at = excluded.updated_at
        `),
        getCredential: db.prepare('SELECT * FROM portal_credentials WHERE user_id = ?'),
        deleteCredential: db.prepare('DELETE FROM portal_credentials WHERE user_id = ?'),
        getSchedule: db.prepare('SELECT * FROM schedules WHERE user_id = ? AND year = ? AND month = ?'),
        getRecurringRules: db.prepare('SELECT * FROM recurring_rules WHERE user_id = ? AND effective_month <= ? ORDER BY effective_month DESC LIMIT 1'),
        saveRecurringRules: db.prepare(`
            INSERT INTO recurring_rules (user_id, effective_month, rules_json, updated_at) VALUES (?, ?, ?, ?)
            ON CONFLICT(user_id, effective_month) DO UPDATE SET
                rules_json = excluded.rules_json, revision = recurring_rules.revision + 1, updated_at = excluded.updated_at
        `),
        upsertSchedule: db.prepare(`
            INSERT INTO schedules (
                user_id, year, month, content, portal_assignment_json, regular_rules_json, special_dates_json,
                vacation_dates_json, extra_holiday_dates_json, holiday_dates_json, holiday_work_dates_json, cleanup_unexpected_rows,
                created_at, updated_at
            ) VALUES (
                @userId, @year, @month, @content, @portalAssignmentJson, @regularRulesJson, @specialDatesJson,
                @vacationDatesJson, @extraHolidayDatesJson, @holidayDatesJson, @holidayWorkDatesJson, @cleanupUnexpectedRows,
                @now, @now
            )
            ON CONFLICT(user_id, year, month) DO UPDATE SET
                content = excluded.content,
                portal_assignment_json = excluded.portal_assignment_json,
                regular_rules_json = excluded.regular_rules_json,
                special_dates_json = excluded.special_dates_json,
                vacation_dates_json = excluded.vacation_dates_json,
                extra_holiday_dates_json = excluded.extra_holiday_dates_json,
                holiday_dates_json = excluded.holiday_dates_json,
                holiday_work_dates_json = excluded.holiday_work_dates_json,
                cleanup_unexpected_rows = excluded.cleanup_unexpected_rows,
                updated_at = excluded.updated_at
        `),
        createSession: db.prepare(`
            INSERT INTO sessions (token_hash, user_id, csrf_token, created_at, expires_at)
            VALUES (@tokenHash, @userId, @csrfToken, @createdAt, @expiresAt)
        `),
        getSession: db.prepare(`
            SELECT s.token_hash, s.csrf_token, s.expires_at, u.*
            FROM sessions s JOIN users u ON u.id = s.user_id
            WHERE s.token_hash = ? AND s.expires_at > ? AND u.is_active = 1
        `),
        deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
        deleteUserSessions: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
        purgeSessions: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
        createJob: db.prepare(`
            INSERT INTO jobs (id, user_id, type, schedule_year, schedule_month, status, progress, created_at, trigger_source)
            VALUES (@id, @userId, @type, @year, @month, 'queued', 0, @now, @triggerSource)
        `),
        getMonthlyAutomation: db.prepare('SELECT * FROM monthly_automations WHERE user_id = ?'),
        dueMonthlyAutomations: db.prepare(`SELECT m.* FROM monthly_automations m JOIN users u ON u.id = m.user_id
            WHERE m.enabled = 1 AND u.is_active = 1 AND m.next_run_at <= ? ORDER BY m.next_run_at, m.user_id LIMIT 25`),
        saveMonthlyAutomation: db.prepare(`INSERT INTO monthly_automations (user_id, settings_json, enabled, next_run_at, updated_at)
            VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET settings_json = excluded.settings_json,
            enabled = excluded.enabled, next_run_at = excluded.next_run_at, revision = monthly_automations.revision + 1, updated_at = excluded.updated_at`),
        disableMonthlyAutomation: db.prepare(`UPDATE monthly_automations SET enabled = 0, next_run_at = NULL,
            revision = revision + 1, updated_at = ? WHERE user_id = ? AND enabled = 1`),
        monthlyRunExists: db.prepare('SELECT 1 FROM monthly_runs WHERE user_id = ? AND run_month = ?'),
        createMonthlyRun: db.prepare('INSERT INTO monthly_runs (user_id, run_month, due_at, job_id, automation_revision) VALUES (?, ?, ?, ?, ?)'),
        clearApprovalRetries: db.prepare('UPDATE monthly_runs SET retry_at = NULL WHERE user_id = ?'),
        monthlyRunForJob: db.prepare('SELECT * FROM monthly_runs WHERE job_id = ?'),
        scheduleApprovalRetry: db.prepare('UPDATE monthly_runs SET retry_at = ? WHERE job_id = ?'),
        dueApprovalRetries: db.prepare(`SELECT r.*, j.schedule_year, j.schedule_month FROM monthly_runs r
            JOIN monthly_automations m ON m.user_id = r.user_id JOIN users u ON u.id = r.user_id JOIN jobs j ON j.id = r.job_id
            WHERE r.retry_at <= ? AND m.enabled = 1 AND u.is_active = 1 AND r.automation_revision = m.revision
            ORDER BY r.retry_at LIMIT 25`),
        nextApprovalRetry: db.prepare(`SELECT r.retry_at FROM monthly_runs r JOIN monthly_automations m ON m.user_id = r.user_id
            WHERE r.user_id = ? AND m.enabled = 1 AND r.automation_revision = m.revision AND r.retry_at IS NOT NULL ORDER BY r.retry_at LIMIT 1`),
        claimApprovalRetry: db.prepare('UPDATE monthly_runs SET job_id = ?, retry_at = NULL, attempt_count = attempt_count + 1 WHERE job_id = ? AND retry_at = ?'),
        advanceMonthlyRun: db.prepare('UPDATE monthly_automations SET next_run_at = ?, revision = revision + 1 WHERE user_id = ?'),
        lastMonthlyJob: db.prepare('SELECT j.* FROM monthly_runs r JOIN jobs j ON j.id = r.job_id WHERE r.user_id = ? ORDER BY r.due_at DESC LIMIT 1'),
        getJob: db.prepare('SELECT * FROM jobs WHERE id = ?'),
        listUserJobs: db.prepare('SELECT * FROM jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?'),
        latestPortalSnapshot: db.prepare(`
            SELECT * FROM jobs
            WHERE user_id = ? AND schedule_year = ? AND schedule_month = ?
              AND created_at >= ? AND status = 'succeeded'
              AND json_valid(summary_json) AND json_type(summary_json, '$.records') = 'array'
            ORDER BY created_at DESC, rowid DESC LIMIT 1
        `),
        listAllJobs: db.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?'),
        updateJobRunning: db.prepare(`
            UPDATE jobs SET status = 'running', progress = ?, started_at = ?, error_message = NULL WHERE id = ?
        `),
        updateJobProgress: db.prepare('UPDATE jobs SET progress = ? WHERE id = ?'),
        updateJobSuccess: db.prepare(`
            UPDATE jobs SET status = 'succeeded', progress = 100, summary_json = ?, finished_at = ? WHERE id = ?
        `),
        updateJobFailure: db.prepare(`
            UPDATE jobs SET status = 'failed', error_message = ?, finished_at = ? WHERE id = ?
        `),
        addJobLog: db.prepare('INSERT INTO job_logs (job_id, level, message, created_at) VALUES (?, ?, ?, ?)'),
        getJobLogs: db.prepare('SELECT id, level, message, created_at AS createdAt FROM job_logs WHERE job_id = ? ORDER BY id ASC'),
        addAudit: db.prepare(`
            INSERT INTO audit_logs (user_id, action, metadata_json, ip_address, created_at)
            VALUES (?, ?, ?, ?, ?)
        `)
    };

    function getRecurringRules(userId, year, month) {
        const row = statements.getRecurringRules.get(userId, year * 100 + month);
        return {
            regularRules: row ? parseJson(row.rules_json, []) : [],
            recurringRuleRevision: row ? `${row.effective_month}:${row.revision}` : null,
            recurringRuleFrom: row?.effective_month || null
        };
    }

    function getSchedule(userId, year, month) {
        const schedule = toSchedule(statements.getSchedule.get(userId, year, month));
        return schedule ? { ...schedule, ...getRecurringRules(userId, year, month) } : null;
    }

    const saveSchedule = db.transaction((userId, schedule, expectedRevision) => {
        const current = getRecurringRules(userId, schedule.year, schedule.month);
        if (expectedRevision !== undefined && expectedRevision !== current.recurringRuleRevision) {
            const error = new Error('다른 화면에서 반복 설정이 바뀌었습니다. 변경 내용을 확인하고 새로고침한 뒤 다시 저장해주세요.');
            error.code = 'RECURRING_RULE_CONFLICT';
            throw error;
        }
        const now = nowIso();
        if (ruleKey(current.regularRules) !== ruleKey(schedule.regularRules)) {
            statements.saveRecurringRules.run(userId, schedule.year * 100 + schedule.month, JSON.stringify(schedule.regularRules), now);
        }
        statements.upsertSchedule.run({
            userId, year: schedule.year, month: schedule.month, content: schedule.content,
            portalAssignmentJson: schedule.portalAssignment ? JSON.stringify(schedule.portalAssignment) : null,
            regularRulesJson: JSON.stringify(schedule.regularRules),
            specialDatesJson: JSON.stringify(schedule.specialDates),
            vacationDatesJson: JSON.stringify(schedule.vacationDates),
            extraHolidayDatesJson: JSON.stringify(schedule.extraHolidayDates),
            holidayDatesJson: JSON.stringify(schedule.holidayDates || []),
            holidayWorkDatesJson: JSON.stringify(schedule.holidayWorkDates || []),
            cleanupUnexpectedRows: schedule.cleanupUnexpectedRows ? 1 : 0, now
        });
        return getSchedule(userId, schedule.year, schedule.month);
    });

    function monthlySettings(row, userId) {
        return {
            userId: row?.user_id || userId, day: 1, time: '0900', targetMonth: 'current', assignment: null,
            ...parseJson(row?.settings_json, {}), enabled: Boolean(row?.enabled), timezone: 'Asia/Seoul',
            nextRunAt: row?.next_run_at || null, revision: row?.revision || 0, updatedAt: row?.updated_at || null
        };
    }

    const saveMonthlyAutomation = db.transaction((userId, value, expectedRevision, now = nowIso()) => {
        const current = monthlySettings(statements.getMonthlyAutomation.get(userId), userId);
        if (expectedRevision !== current.revision) {
            const error = new Error('예약 설정이나 실행 상태가 바뀌었습니다. 설정창을 다시 열어 확인해주세요.');
            error.code = 'MONTHLY_CONFLICT';
            throw error;
        }
        const settings = { day: current.day, time: current.time, targetMonth: current.targetMonth, assignment: current.assignment, ...value };
        const nextRunAt = settings.enabled ? nextOccurrence(settings, now, month => Boolean(statements.monthlyRunExists.get(userId, month))) : null;
        statements.saveMonthlyAutomation.run(userId, JSON.stringify(settings), settings.enabled ? 1 : 0, nextRunAt, now);
        statements.clearApprovalRetries.run(userId);
        return monthlySettings(statements.getMonthlyAutomation.get(userId), userId);
    });

    // The durable monthly claim and job are committed together before any portal request.
    const claimMonthlyRun = db.transaction((settings, run) => {
        const current = statements.getMonthlyAutomation.get(settings.userId);
        if (!current?.enabled || current.revision !== settings.revision || current.next_run_at !== settings.nextRunAt) return null;
        if (!statements.findUserById.get(settings.userId)?.is_active) return null;
        statements.advanceMonthlyRun.run(run.nextRunAt, settings.userId);
        if (statements.monthlyRunExists.get(settings.userId, run.runMonth)) return null;
        statements.createJob.run({ id: run.id, userId: settings.userId, type: 'submit', year: run.year, month: run.month, now: run.now, triggerSource: 'monthly' });
        statements.createMonthlyRun.run(settings.userId, run.runMonth, settings.nextRunAt, run.id, settings.revision + 1);
        statements.addAudit.run(settings.userId, 'monthly_run_claimed', JSON.stringify({ jobId: run.id, dueAt: settings.nextRunAt, year: run.year, month: run.month }), null, run.now);
        return toJob(statements.getJob.get(run.id));
    });

    const scheduleApprovalRetry = db.transaction((jobId, now = nowIso()) => {
        const run = statements.monthlyRunForJob.get(jobId);
        if (!run) return null;
        const current = statements.getMonthlyAutomation.get(run.user_id);
        if (!current?.enabled || current.revision !== run.automation_revision || !statements.findUserById.get(run.user_id)?.is_active) return null;
        const retryAt = nextDayOccurrence(monthlySettings(current), now);
        if (retryAt >= current.next_run_at) return null;
        statements.scheduleApprovalRetry.run(retryAt, jobId);
        return retryAt;
    });

    const claimApprovalRetry = db.transaction((retry, id, now = nowIso()) => {
        const current = statements.getMonthlyAutomation.get(retry.user_id);
        if (!current?.enabled || current.revision !== retry.automation_revision || !statements.findUserById.get(retry.user_id)?.is_active) return null;
        if (now >= current.next_run_at) return null;
        const latest = statements.monthlyRunForJob.get(retry.job_id);
        if (!latest || latest.retry_at !== retry.retry_at || latest.retry_at > now) return null;
        statements.createJob.run({ id, userId: retry.user_id, type: 'submit', year: retry.schedule_year, month: retry.schedule_month, now, triggerSource: 'monthly' });
        statements.claimApprovalRetry.run(id, retry.job_id, retry.retry_at);
        statements.addAudit.run(retry.user_id, 'approval_retry_claimed', JSON.stringify({ jobId: id, previousJobId: retry.job_id }), null, now);
        return toJob(statements.getJob.get(id));
    });

    return {
        raw: db,
        close: () => db.close(),
        countUsers: () => statements.countUsers.get().count,
        countAdmins: () => statements.countAdmins.get().count,
        createUser({ username, displayName, passwordHash, role = 'user' }) {
            const now = nowIso();
            const result = statements.createUser.run({ username, displayName, passwordHash, role, now });
            return toPublicUser(statements.findUserById.get(result.lastInsertRowid));
        },
        findUserById: (id) => statements.findUserById.get(id) || null,
        findUserByUsername: (username) => statements.findUserByUsername.get(username) || null,
        getPublicUser: (id) => toPublicUser(statements.findUserById.get(id)),
        listUsers: () => statements.listUsers.all().map(toPublicUser),
        touchLogin(userId) {
            const now = nowIso();
            statements.touchLogin.run(now, now, userId);
        },
        updatePassword(userId, passwordHash) {
            statements.updatePassword.run(passwordHash, nowIso(), userId);
            statements.deleteUserSessions.run(userId);
        },
        updateUser: db.transaction((userId, { displayName, role, isActive }) => {
            statements.updateUserState.run(displayName, role, isActive ? 1 : 0, nowIso(), userId);
            if (!isActive) {
                statements.deleteUserSessions.run(userId);
                statements.disableMonthlyAutomation.run(nowIso(), userId);
            }
            return toPublicUser(statements.findUserById.get(userId));
        }),
        savePortalCredential: db.transaction((userId, portalIdEncrypted, portalPasswordEncrypted) => {
            statements.upsertCredential.run({ userId, portalIdEncrypted, portalPasswordEncrypted, now: nowIso() });
            statements.disableMonthlyAutomation.run(nowIso(), userId);
        }),
        getPortalCredential: (userId) => statements.getCredential.get(userId) || null,
        deletePortalCredential: db.transaction(userId => {
            statements.disableMonthlyAutomation.run(nowIso(), userId);
            return statements.deleteCredential.run(userId).changes > 0;
        }),
        getMonthlyAutomation(userId) {
            return { ...monthlySettings(statements.getMonthlyAutomation.get(userId), userId),
                retryAt: statements.nextApprovalRetry.get(userId)?.retry_at || null, lastRun: toJob(statements.lastMonthlyJob.get(userId)) };
        },
        saveMonthlyAutomation,
        claimMonthlyRun,
        scheduleApprovalRetry,
        claimApprovalRetry,
        listDueApprovalRetries: now => statements.dueApprovalRetries.all(now),
        listDueMonthlyAutomations: now => statements.dueMonthlyAutomations.all(now).map(row => monthlySettings(row)),
        getSchedule,
        getRecurringRules,
        saveSchedule,
        createSession({ tokenHash, userId, csrfToken, expiresAt }) {
            statements.createSession.run({ tokenHash, userId, csrfToken, createdAt: nowIso(), expiresAt });
        },
        getSession(tokenHash) {
            const row = statements.getSession.get(tokenHash, nowIso());
            if (!row) return null;
            return {
                tokenHash: row.token_hash,
                csrfToken: row.csrf_token,
                expiresAt: row.expires_at,
                user: toPublicUser(row)
            };
        },
        deleteSession: (tokenHash) => statements.deleteSession.run(tokenHash),
        purgeExpiredSessions: () => statements.purgeSessions.run(nowIso()).changes,
        createJob({ id, userId, type, year, month, triggerSource = 'manual' }) {
            statements.createJob.run({ id, userId, type, year, month, now: nowIso(), triggerSource });
            return toJob(statements.getJob.get(id));
        },
        getJob(id, includeLogs = false) {
            const row = statements.getJob.get(id);
            return toJob(row, includeLogs && row ? statements.getJobLogs.all(id) : undefined);
        },
        listJobs(userId, { all = false, limit = 20 } = {}) {
            const rows = all ? statements.listAllJobs.all(limit) : statements.listUserJobs.all(userId, limit);
            return rows.map(toJob);
        },
        getPortalSnapshot(userId, year, month, since) {
            const job = toJob(statements.latestPortalSnapshot.get(userId, year, month, since));
            if (!job) return null;
            return { jobId: job.id, year, month, queriedAt: job.finishedAt,
                records: job.summary.records, assignments: job.summary.assignments || [] };
        },
        markJobRunning(id) {
            statements.updateJobRunning.run(5, nowIso(), id);
        },
        updateJobProgress(id, progress) {
            statements.updateJobProgress.run(Math.max(0, Math.min(99, Math.round(progress))), id);
        },
        completeJob(id, summary) {
            statements.updateJobSuccess.run(JSON.stringify(summary || {}), nowIso(), id);
        },
        failJob(id, errorMessage) {
            statements.updateJobFailure.run(String(errorMessage || '알 수 없는 오류').slice(0, 1000), nowIso(), id);
        },
        addJobLog(id, level, message) {
            statements.addJobLog.run(id, level, String(message).slice(0, 2000), nowIso());
        },
        addAudit(userId, action, metadata = {}, ipAddress = null) {
            statements.addAudit.run(userId || null, action, JSON.stringify(metadata), ipAddress, nowIso());
        }
    };
}

module.exports = {
    createDatabase,
    toPublicUser
};
