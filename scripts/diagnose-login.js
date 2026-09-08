// Local login diagnosis. The password is read from an environment variable at run
// time and never stored. Run it yourself:
//   PowerShell:  $env:PORTAL_ID="아이디"; $env:PORTAL_PW="비밀번호"; node scripts/diagnose-login.js
//   bash:        PORTAL_ID=아이디 PORTAL_PW=비밀번호 node scripts/diagnose-login.js
// It makes ONE login attempt and prints exactly which portal step stopped answering.
const { PortalHttpClient } = require('../src/automation/portal-http-client');

const id = process.env.PORTAL_ID;
const pw = process.env.PORTAL_PW;
if (!id || !pw) {
    console.error('PORTAL_ID 와 PORTAL_PW 환경변수를 설정한 뒤 실행하세요.');
    process.exit(1);
}

const trace = [];
const client = new PortalHttpClient({
    onRequest: (e) => trace.push(`${e.method} ${e.origin}${e.path} → ${e.status}`)
});

(async () => {
    try {
        await client.login(id, pw, (message, progress) => console.log(`  [${progress}%] ${message}`));
        console.log('\n✅ 프로그램 로그인 성공');
        console.log('   학생 이름 확인:', client.identity?.name ? '있음' : '없음',
            '· 일지 저장 권한:', client.identity?.canUpdate);
        console.log('\n요청 단계:');
        for (const step of trace) console.log('   ', step);
    } catch (error) {
        console.log('\n❌ 프로그램 로그인 실패');
        console.log('   코드   :', error.code || '(없음)');
        console.log('   메시지 :', error.message);
        console.log('\n포털 요청 단계 (어디서 멈췄는지):');
        for (const step of (error.portalSteps && error.portalSteps.length ? error.portalSteps : trace)) console.log('   ', step);
        process.exitCode = 1;
    } finally {
        await client.close();
    }
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
