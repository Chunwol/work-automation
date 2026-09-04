const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { readSecret } = require('../src/config');

test('secrets accept an environment value or a mounted file, never both', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'worklog-secret-test-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const file = path.join(directory, 'test-secret');
    fs.writeFileSync(file, ' synthetic-secret\n');
    assert.equal(readSecret('KEY', { KEY: ' direct ' }), 'direct');
    assert.equal(readSecret('KEY', { KEY_FILE: file }), 'synthetic-secret');
    assert.equal(readSecret('KEY', {}), '');
    assert.throws(() => readSecret('KEY', { KEY: 'value', KEY_FILE: file }), /KEY/);
    assert.throws(() => readSecret('KEY', { KEY_FILE: path.join(directory, 'absent') }));
});
