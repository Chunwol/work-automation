const fs = require('node:fs');
const path = require('node:path');

const MESSAGE_LIMIT = 500;
const STACK_LIMIT = 600;

function entryOf(scope, error, context, time) {
    const stack = String(error?.stack || '').split('\n').slice(1, 4).map((line) => line.trim()).join(' | ');
    return {
        time, scope,
        message: String(error?.message ?? error ?? '알 수 없는 오류').slice(0, MESSAGE_LIMIT),
        ...(error?.code ? { code: String(error.code).slice(0, 60) } : {}),
        ...context,
        ...(stack ? { stack: stack.slice(0, STACK_LIMIT) } : {})
    };
}

// Job failures are stored per job in SQLite. This keeps the same failures readable
// from the host file system and from container logs, which survive a database that
// is only reachable with an administrator shell.
function createErrorLog({ filePath = null, maxBytes = 1024 * 1024, now = () => new Date(), mirror = console.error } = {}) {
    let warned = false;
    const rotate = () => {
        try {
            if (fs.statSync(filePath).size < maxBytes) return;
        } catch (error) {
            if (error.code === 'ENOENT') return;
            throw error;
        }
        // One previous file bounds the volume; the container is replaced on every deploy.
        fs.renameSync(filePath, `${filePath}.1`);
    };
    return function record(scope, error, context = {}) {
        const entry = entryOf(scope, error, context, now().toISOString());
        const line = JSON.stringify(entry);
        mirror?.(line);
        if (!filePath) return entry;
        try {
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            rotate();
            fs.appendFileSync(filePath, `${line}\n`);
        } catch (writeError) {
            // A log that cannot be written must never fail the job or request that reported it.
            if (!warned) mirror?.(`error log write failed: ${writeError.message}`);
            warned = true;
        }
        return entry;
    };
}

module.exports = { createErrorLog };
