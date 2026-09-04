const assert = require('node:assert/strict');
const test = require('node:test');
const { PortalRequestGate } = require('../src/automation/request-gate');

function clock() {
    let time = 100000;
    return {
        now: () => time,
        sleep: async ms => { time += ms; },
        advance: ms => { time += ms; }
    };
}

test('all clients share serialized, spaced request starts', async () => {
    const timer = clock();
    const gate = new PortalRequestGate({ ...timer, intervalMs: 1500 });
    const starts = [];
    await Promise.all(Array.from({ length: 4 }, () => gate.run(async () => {
        starts.push(timer.now());
        return new Response('', { status: 200 });
    })));
    assert.deepEqual(starts, [100000, 101500, 103000, 104500]);
});

test('rate limiting stops queued requests without retries until Retry-After', async () => {
    const timer = clock();
    const gate = new PortalRequestGate(timer);
    let calls = 0;
    const send = async () => {
        calls += 1;
        return new Response('', { status: 429, headers: { 'retry-after': '120' } });
    };
    const first = gate.run(send);
    const queued = gate.run(send);
    await first;
    await assert.rejects(queued);
    timer.advance(119999);
    await assert.rejects(gate.run(send));
    assert.equal(calls, 1);
    timer.advance(1);
    await gate.run(send);
    assert.equal(calls, 2);
});

test('HTTP-date cooldown and minimum cooldown are honored', async () => {
    for (const value of ['invalid', new Date(280000).toUTCString()]) {
        const timer = clock();
        const gate = new PortalRequestGate(timer);
        await gate.run(async () => new Response('', { status: 503, headers: { 'retry-after': value } }));
        assert.equal(gate.blockedUntil, value === 'invalid' ? 160000 : 280000);
    }
});

test('a network error does not poison the queue or trigger a retry', async () => {
    const timer = clock();
    const gate = new PortalRequestGate(timer);
    let calls = 0;
    await assert.rejects(gate.run(async () => { calls += 1; throw new Error('offline'); }));
    const result = await gate.run(async () => new Response('', { status: 200 }));
    assert.equal(calls, 1);
    assert.equal(result.status, 200);
    assert.equal(timer.now(), 101500);
});
