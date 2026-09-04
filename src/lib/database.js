const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

function nowIso() {
    return new Date().toISOString();
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

        CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
        CREATE INDEX IF NOT EXISTS idx_schedules_user_month ON schedules(user_id, year, month);
        CREATE INDEX IF NOT EXISTS idx_jobs_user_created ON jobs(user_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_job_logs_job ON job_logs(job_id, id);
        CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);
    `);

    const scheduleColumns = new Set(db.pragma('table_info(schedules)').map((column) => column.name));
    if (!scheduleColumns.has('portal_assignment_json')) {
        db.exec('ALTER TABLE schedules ADD COLUMN portal_assignment_json TEXT');
    }
    for (const column of ['holiday_dates_json', 'holiday_work_dates_json']) {
        if (!scheduleColumns.has(column)) db.exec(`ALTER TABLE schedules ADD COLUMN ${column} TEXT NOT NULL DEFAULT '[]'`);
    }

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
            INSERT INTO jobs (id, user_id, type, schedule_year, schedule_month, status, progress, created_at)
            VALUES (@id, @userId, @type, @year, @month, 'queued', 0, @now)
        `),
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
        updateUser(userId, { displayName, role, isActive }) {
            statements.updateUserState.run(displayName, role, isActive ? 1 : 0, nowIso(), userId);
            if (!isActive) statements.deleteUserSessions.run(userId);
            return toPublicUser(statements.findUserById.get(userId));
        },
        savePortalCredential(userId, portalIdEncrypted, portalPasswordEncrypted) {
            statements.upsertCredential.run({ userId, portalIdEncrypted, portalPasswordEncrypted, now: nowIso() });
        },
        getPortalCredential: (userId) => statements.getCredential.get(userId) || null,
        deletePortalCredential: (userId) => statements.deleteCredential.run(userId).changes > 0,
        getSchedule: (userId, year, month) => toSchedule(statements.getSchedule.get(userId, year, month)),
        saveSchedule(userId, schedule) {
            const now = nowIso();
            statements.upsertSchedule.run({
                userId,
                year: schedule.year,
                month: schedule.month,
                content: schedule.content,
                portalAssignmentJson: schedule.portalAssignment ? JSON.stringify(schedule.portalAssignment) : null,
                regularRulesJson: JSON.stringify(schedule.regularRules),
                specialDatesJson: JSON.stringify(schedule.specialDates),
                vacationDatesJson: JSON.stringify(schedule.vacationDates),
                extraHolidayDatesJson: JSON.stringify(schedule.extraHolidayDates),
                holidayDatesJson: JSON.stringify(schedule.holidayDates || []),
                holidayWorkDatesJson: JSON.stringify(schedule.holidayWorkDates || []),
                cleanupUnexpectedRows: schedule.cleanupUnexpectedRows ? 1 : 0,
                now
            });
            return toSchedule(statements.getSchedule.get(userId, schedule.year, schedule.month));
        },
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
        createJob({ id, userId, type, year, month }) {
            statements.createJob.run({ id, userId, type, year, month, now: nowIso() });
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
