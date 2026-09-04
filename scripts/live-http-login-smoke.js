const fs = require('node:fs');
const path = require('node:path');
const { PortalHttpClient } = require('../src/automation/portal-http-client');

async function main() {
    const account = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'users', 'LSH.json'), 'utf8'));
    const trace = [];
    const client = new PortalHttpClient({ onRequest: (event) => trace.push(event) });
    try {
        await client.login(account.id, account.password);
        const response = await client.command('FindWork', client.requestKey(2026, 9));
        console.log(JSON.stringify({ ok: true, transport: 'http-only', trace,
            catalog: { scholarships: client.catalog.listSchoCd.length, departments: client.catalog.listWorkDeptCd.length },
            assignments: response.listStdno, writes: 0 }, null, 2));
    } catch (error) {
        console.log(JSON.stringify({ ok: false, error: error.message, trace }, null, 2));
        process.exitCode = 1;
    } finally { await client.close(); }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
