const { fetchGoogleHolidays } = require('./schedule');
const cache = new Map();

async function getCalendar(year, month) {
    const key = `${year}-${month}`;
    const previous = cache.get(key);
    if (previous && previous.expiresAt > Date.now()) return previous.promise;
    const entry = { expiresAt: Date.now() + 3600000 };
    entry.promise = fetchGoogleHolidays(year, month)
        .then((holidays) => ({ holidays, source: 'Google 대한민국 공휴일 달력', error: null }))
        .catch(() => {
            entry.expiresAt = Date.now() + 30000;
            return { holidays: [], source: 'Google 대한민국 공휴일 달력', error: '공휴일 자동 조회에 실패했습니다. 제외일을 직접 확인해주세요.' };
        });
    cache.set(key, entry);
    return entry.promise;
}

module.exports = { getCalendar };
