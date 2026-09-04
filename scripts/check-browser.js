const fs = require('node:fs');
const puppeteer = require('puppeteer');

async function checkBrowser() {
    if (!['darwin', 'win32'].includes(process.platform)) {
        throw new Error(`지원하지 않는 플랫폼입니다: ${process.platform}`);
    }

    if (!['arm64', 'x64'].includes(process.arch)) {
        throw new Error(`지원하지 않는 아키텍처입니다: ${process.arch}`);
    }

    const executablePath = await puppeteer.executablePath();
    fs.accessSync(executablePath, fs.constants.X_OK);

    let browser;
    try {
        browser = await puppeteer.launch({ headless: true });
        const page = await browser.newPage();
        await page.setContent('<title>macOS compatibility check</title>');
        const title = await page.title();
        if (title !== 'macOS compatibility check') {
            throw new Error('브라우저 페이지 검증에 실패했습니다.');
        }
    } finally {
        await browser?.close();
    }

    console.log(`${process.platform} ${process.arch}: Puppeteer 브라우저 실행 확인 완료`);
    console.log(`브라우저 경로: ${executablePath}`);
}

checkBrowser().catch((error) => {
    console.error(`브라우저 호환성 검사 실패: ${error.message}`);
    process.exitCode = 1;
});
