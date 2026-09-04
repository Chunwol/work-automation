class PortalSessionPool {
    constructor({ clientFactory, now = () => Date.now(), idleTtlMs = 30 * 60_000, maxAgeMs = 8 * 60 * 60_000, maxEntries = 50 }) {
        Object.assign(this, { clientFactory, now, idleTtlMs, maxAgeMs, maxEntries });
        this.entries = new Map();
        this.activeKeys = new Set();
        this.timer = null;
    }

    start() {
        if (!this.timer) {
            this.timer = setInterval(() => { void this.prune().catch(() => {}); }, 60_000);
            this.timer.unref();
        }
    }

    async discard(key, entry) {
        if (this.entries.get(key) === entry) this.entries.delete(key);
        entry.invalidated = true;
        if (!entry.busy) await entry.client.close();
    }

    async prune() {
        const now = this.now();
        for (const [key, entry] of this.entries) {
            if (!entry.busy && (now - entry.lastUsed >= this.idleTtlMs || now - entry.createdAt >= this.maxAgeMs)) await this.discard(key, entry);
        }
    }

    async invalidateUser(userId) {
        for (const [key, entry] of this.entries) if (key.startsWith(`${userId}:`)) await this.discard(key, entry);
    }

    async close() {
        clearInterval(this.timer);
        this.timer = null;
        for (const [key, entry] of this.entries) await this.discard(key, entry);
    }

    async use(key, options, operation, { readOnly = false } = {}) {
        if (this.activeKeys.has(key)) throw new Error('같은 포털 세션의 작업이 진행 중입니다. 완료 후 다시 시도해주세요.');
        this.activeKeys.add(key);
        try { return await this.useReserved(key, options, operation, { readOnly }); }
        finally { this.activeKeys.delete(key); }
    }

    async useReserved(key, options, operation, { readOnly }) {
        await this.prune();
        let entry = this.entries.get(key);
        if (entry?.busy) throw new Error('같은 포털 세션의 작업이 진행 중입니다. 완료 후 다시 시도해주세요.');
        if (!entry) {
            if (this.entries.size >= this.maxEntries) {
                const oldest = [...this.entries].filter(([, value]) => !value.busy).sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
                if (!oldest) throw new Error('포털 세션이 모두 사용 중입니다. 잠시 후 다시 시도해주세요.');
                await this.discard(...oldest);
            }
            entry = { client: this.clientFactory(), createdAt: this.now(), lastUsed: this.now(), busy: false, invalidated: false };
            this.entries.set(key, entry);
        }
        entry.busy = true;
        let reauthenticated = false;
        const onStage = (message, progress) => options.onEvent?.({ level: 'info', message, progress });
        const authenticate = async () => {
            onStage('학교 포털 로그인과 SSO 인증을 진행합니다.', 1);
            await entry.client.login(options.portalId, options.portalPassword, onStage);
            entry.createdAt = this.now();
        };
        const renew = async () => {
            reauthenticated = true;
            await entry.client.close();
            entry.client = this.clientFactory();
            onStage('포털 세션이 만료되어 다시 로그인합니다.', 1);
            await authenticate();
        };
        try {
            if (entry.client.identity) {
                onStage('저장된 포털 로그인 세션의 본인 정보와 권한을 확인합니다.', 1);
                try {
                    await entry.client.refreshSession(onStage);
                    onStage('기존 포털 로그인 세션을 재사용합니다.', 20);
                }
                catch (error) {
                    if (error.code !== 'PORTAL_AUTH_EXPIRED') throw error;
                    await renew();
                }
            } else await authenticate();
            if (entry.invalidated) throw new Error('포털 연결 또는 앱 로그인 상태가 바뀌어 작업을 중단했습니다.');
            try { return await operation(entry.client); }
            catch (error) {
                // Only a read-only query may restart. A Save/Change is never replayed here.
                if (!readOnly || reauthenticated || error.code !== 'PORTAL_AUTH_EXPIRED' || entry.invalidated) throw error;
                await renew();
                if (entry.invalidated) throw new Error('포털 연결 또는 앱 로그인 상태가 바뀌어 조회를 중단했습니다.');
                return await operation(entry.client);
            }
        } catch (error) {
            await this.discard(key, entry);
            throw error;
        } finally {
            entry.busy = false;
            entry.lastUsed = this.now();
            if (entry.invalidated) await entry.client.close();
        }
    }
}

module.exports = { PortalSessionPool };
