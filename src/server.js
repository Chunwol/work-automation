const { createConfig } = require('./config');
const { createApp } = require('./app');

const config = createConfig();
const { app, db, scheduler, portalSessions } = createApp(config);

const server = app.listen(config.port, config.host, () => {
    scheduler.start();
    portalSessions.start();
    console.log(`근로기록실 웹이 실행되었습니다: http://${config.host}:${config.port}`);
    if (config.nodeEnv !== 'production') {
        console.log('로컬 개발 모드입니다. 외부 공개 전 .env의 보안 설정을 확인하세요.');
    }
});

const cleanupTimer = setInterval(() => db.purgeExpiredSessions(), 60 * 60 * 1000);
cleanupTimer.unref();

async function shutdown(signal) {
    console.log(`${signal} 신호를 받아 서버를 종료합니다.`);
    clearInterval(cleanupTimer);
    setTimeout(() => process.exit(1), 10_000).unref();
    await scheduler.stop();
    await portalSessions.close();
    server.close(() => {
        db.close();
        process.exit(0);
    });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
