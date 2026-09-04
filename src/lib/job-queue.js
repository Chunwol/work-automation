const { EventEmitter } = require('events');

class JobQueue {
    constructor({ db, executeJob, concurrency = 1 }) {
        this.db = db;
        this.executeJob = executeJob;
        this.concurrency = Math.max(1, concurrency);
        this.pending = [];
        this.running = 0;
        this.activeUsers = new Set();
        this.events = new EventEmitter();
        this.events.setMaxListeners(100);
    }

    hasPendingForUser(userId) {
        return this.activeUsers.has(userId) || this.pending.some((item) => item.userId === userId);
    }

    enqueue(item) {
        if (this.hasPendingForUser(item.userId)) {
            throw new Error('이미 대기 중이거나 실행 중인 작업이 있습니다.');
        }
        this.pending.push(item);
        this.emitSnapshot(item.id);
        queueMicrotask(() => this.drain());
    }

    subscribe(jobId, listener) {
        const eventName = `job:${jobId}`;
        this.events.on(eventName, listener);
        return () => this.events.off(eventName, listener);
    }

    emitSnapshot(jobId) {
        this.events.emit(`job:${jobId}`, this.db.getJob(jobId, true));
    }

    async drain() {
        while (this.running < this.concurrency && this.pending.length > 0) {
            const item = this.pending.shift();
            this.running += 1;
            this.activeUsers.add(item.userId);
            this.process(item).finally(() => {
                this.running -= 1;
                this.activeUsers.delete(item.userId);
                this.drain();
            });
        }
    }

    async process(item) {
        this.db.markJobRunning(item.id);
        this.db.addJobLog(item.id, 'info', '작업 실행을 시작합니다.');
        this.emitSnapshot(item.id);

        const onEvent = ({ level = 'info', message, progress }) => {
            if (Number.isFinite(progress)) this.db.updateJobProgress(item.id, progress);
            if (message) this.db.addJobLog(item.id, level, message);
            this.emitSnapshot(item.id);
        };

        try {
            const summary = await this.executeJob(item, onEvent);
            this.db.completeJob(item.id, summary);
            this.db.addJobLog(item.id, 'success', '작업이 정상적으로 완료되었습니다.');
        } catch (error) {
            const message = String(error?.message || '알 수 없는 오류');
            this.db.failJob(item.id, message);
            this.db.addJobLog(item.id, 'error', message);
        } finally {
            this.emitSnapshot(item.id);
        }
    }
}

module.exports = {
    JobQueue
};
