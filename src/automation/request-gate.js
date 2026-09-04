class PortalRequestGate {
    constructor({ intervalMs = 1500, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
        this.intervalMs = intervalMs;
        this.now = now;
        this.sleep = sleep;
        this.nextAt = 0;
        this.blockedUntil = 0;
        this.tail = Promise.resolve();
    }

    run(send) {
        const pending = this.tail.then(async () => {
            if (this.now() < this.blockedUntil) throw new Error('학교 포털이 요청 대기를 요구했습니다. 잠시 후 다시 조회해주세요.');
            const delay = Math.max(0, this.nextAt - this.now());
            if (delay) await this.sleep(delay);
            this.nextAt = this.now() + this.intervalMs;
            const response = await send();
            if ([429, 503].includes(response.status)) {
                const retryAfter = response.headers.get('retry-after');
                const delay = /^\d+$/.test(retryAfter || '')
                    ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - this.now();
                this.blockedUntil = this.now() + Math.max(60000, Number.isFinite(delay) ? delay : 60000);
            }
            return response;
        });
        // A rejected request must not poison the shared queue. Writes are never retried.
        this.tail = pending.catch(() => {});
        return pending;
    }
}

module.exports = { PortalRequestGate };
