import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import test from 'node:test';
import { CACHE_MISS_STOP, FRONTEND_LEASE_MS, KeepaliveScheduler, PAYLOAD_WAIT_MS, dispatchKeepaliveRequest, getCacheUsage, getResponseError, isCacheMiss } from '../server/index.mjs';

function fixture(dispatch = async () => {}) {
    let now = 0;
    const scheduler = new KeepaliveScheduler({ now: () => now, dispatch, setTimer: () => ({ unref() {} }), clearTimer: () => {} });
    return { scheduler, setNow: value => { now = value; } };
}

test('heartbeat renews the lease without delaying the cache refresh', () => {
    const { scheduler, setNow } = fixture();
    scheduler.register('u:t', { id: 't', intervalMs: 60000, delayMs: 60000 });
    setNow(20000); scheduler.heartbeat('u:t');
    assert.equal(scheduler.get('u:t').nextRun, 60000);
});

test('dispatches on schedule and retains alignment after a late tick', async () => {
    let calls = 0;
    const { scheduler, setNow } = fixture(async () => { calls++; });
    scheduler.register('u:t', { id: 't', intervalMs: 60000, delayMs: 60000 });
    setNow(60000); await scheduler.tick();
    assert.equal(calls, 1); assert.equal(scheduler.get('u:t').nextRun, 120000);
    setNow(190000); await scheduler.tick();
    assert.equal(calls, 2); assert.equal(scheduler.get('u:t').nextRun, 240000);
});

test('expires when the frontend lease disappears', async () => {
    const { scheduler, setNow } = fixture();
    scheduler.register('u:t', { id: 't', intervalMs: 60000, delayMs: 60000 });
    setNow(FRONTEND_LEASE_MS); await scheduler.tick();
    assert.equal(scheduler.get('u:t'), null);
});

test('backs off repeated failures and resets after a success', async () => {
    let fail = true;
    const { scheduler, setNow } = fixture(async () => { if (fail) throw new Error('rejected'); });
    const warn = console.warn;
    console.warn = () => {};
    try {
        scheduler.register('u:t', { id: 't', intervalMs: 60000, delayMs: 0 });
        await scheduler.tick();
        assert.equal(scheduler.get('u:t').nextRun, 5000);
        setNow(5000); scheduler.heartbeat('u:t'); await scheduler.tick();
        assert.equal(scheduler.get('u:t').nextRun, 15000);
        setNow(15000); scheduler.heartbeat('u:t'); await scheduler.tick();
        assert.equal(scheduler.get('u:t').nextRun, 35000);
        assert.equal(scheduler.get('u:t').lastRun, null);
        fail = false;
        setNow(35000); scheduler.heartbeat('u:t'); await scheduler.tick();
        assert.equal(scheduler.get('u:t').failures, 0);
        assert.equal(scheduler.get('u:t').lastRun, 35000);
    } finally {
        console.warn = warn;
    }
});

test('caps the failure backoff at the keepalive interval', async () => {
    const { scheduler, setNow } = fixture(async () => { throw new Error('rejected'); });
    const warn = console.warn;
    console.warn = () => {};
    try {
        scheduler.register('u:t', { id: 't', intervalMs: 60000, delayMs: 0 });
        let now = 0;
        for (let i = 0; i < 6; i++) {
            setNow(now); scheduler.heartbeat('u:t'); await scheduler.tick();
            now = scheduler.get('u:t').nextRun;
        }
        assert.equal(scheduler.get('u:t').nextRun - scheduler.get('u:t').lastSeen, 60000);
    } finally {
        console.warn = warn;
    }
});

test('reads SillyTavern provider errors from a successful response', () => {
    assert.equal(getResponseError(JSON.stringify({ error: { message: 'Bad Request' }, quota_error: false })), 'Bad Request');
    assert.equal(getResponseError(JSON.stringify({ error: true })), 'unknown error');
    assert.equal(getResponseError(JSON.stringify({ choices: [], usage: {} })), null);
    assert.equal(getResponseError('not json'), null);
});

function quietly(fn) {
    return async () => {
        const info = console.info;
        console.info = () => {};
        try {
            await fn();
        } finally {
            console.info = info;
        }
    };
}

const MISS = { promptTokens: 20000, cachedTokens: 1700 };
const HIT = { promptTokens: 20000, cachedTokens: 17951 };

test('stops after two cache misses without a message in between', quietly(async () => {
    const results = [MISS, HIT, MISS];
    const { scheduler, setNow } = fixture(async () => results.shift());
    scheduler.register('u:t', { id: 't', intervalMs: 60000, delayMs: 0, activityCount: 1 });
    for (const now of [0, 60000]) {
        setNow(now); scheduler.heartbeat('u:t'); await scheduler.tick();
    }
    assert.equal(scheduler.get('u:t').cacheMisses, 1);
    setNow(120000); scheduler.heartbeat('u:t'); await scheduler.tick();
    assert.equal(scheduler.get('u:t'), null);
    assert.equal(scheduler.getExpired('u:t').reason, CACHE_MISS_STOP);
}));

test('a successful message starts a new idle period', quietly(async () => {
    const { scheduler, setNow } = fixture(async () => MISS);
    scheduler.register('u:t', { id: 't', intervalMs: 60000, delayMs: 0, activityCount: 1 });
    await scheduler.tick();
    setNow(30000); scheduler.pause('u:t'); scheduler.resume('u:t', 5000);
    assert.equal(scheduler.get('u:t').cacheMisses, 0);
    scheduler.register('u:t', { id: 't', intervalMs: 60000, delayMs: 55000, activityCount: 2 });
    setNow(85000); scheduler.heartbeat('u:t'); await scheduler.tick();
    assert.equal(scheduler.get('u:t').cacheMisses, 1);
}));

test('a miss from before the latest message does not count', quietly(async () => {
    let finish;
    const { scheduler } = fixture(() => new Promise(resolve => { finish = resolve; }));
    scheduler.register('u:t', { id: 't', intervalMs: 60000, delayMs: 0, activityCount: 1 });
    const tick = scheduler.tick();
    scheduler.resume('u:t', 0);
    finish(MISS);
    await tick;
    assert.equal(scheduler.get('u:t').cacheMisses, 0);
}));

test('unknown cache usage never stops the job', quietly(async () => {
    const { scheduler, setNow } = fixture(async () => null);
    scheduler.register('u:t', { id: 't', intervalMs: 60000, delayMs: 0, activityCount: 1 });
    for (const now of [0, 60000, 120000]) {
        setNow(now); scheduler.heartbeat('u:t'); await scheduler.tick();
    }
    assert.equal(scheduler.get('u:t').cacheMisses, 0);
}));

test('a stopped job restarts only after a newer message', quietly(async () => {
    const { scheduler, setNow } = fixture(async () => MISS);
    scheduler.register('u:t', { id: 't', intervalMs: 60000, delayMs: 0, activityCount: 3 });
    for (const now of [0, 60000]) {
        setNow(now); scheduler.heartbeat('u:t'); await scheduler.tick();
    }
    assert.equal(scheduler.get('u:t'), null);
    assert.equal(scheduler.register('u:t', { id: 't', intervalMs: 60000, activityCount: 3 }), null);
    assert.equal(scheduler.register('u:t', { id: 't', intervalMs: 60000, activityCount: 4 }).cacheMisses, 0);
}));

test('older frontends without an activity count can always re-register', quietly(async () => {
    const { scheduler, setNow } = fixture(async () => MISS);
    scheduler.register('u:t', { id: 't', intervalMs: 60000, delayMs: 0 });
    for (const now of [0, 60000]) {
        setNow(now); scheduler.heartbeat('u:t'); await scheduler.tick();
    }
    assert.equal(scheduler.getExpired('u:t').reason, CACHE_MISS_STOP);
    assert.ok(scheduler.register('u:t', { id: 't', intervalMs: 60000 }));
}));

test('reads cache usage from OpenAI-compatible responses only', () => {
    const openRouter = { usage: { prompt_tokens: 24065, prompt_tokens_details: { cached_tokens: 22016 } } };
    assert.deepEqual(getCacheUsage(JSON.stringify(openRouter)), { promptTokens: 24065, cachedTokens: 22016 });
    const deepSeek = { usage: { prompt_tokens: 9000, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 9000 } };
    assert.deepEqual(getCacheUsage(JSON.stringify(deepSeek)), { promptTokens: 9000, cachedTokens: 0 });
    // SillyTavern rewraps direct Claude and Gemini responses without usage.
    assert.equal(getCacheUsage(JSON.stringify({ choices: [{ message: { content: '' } }], content: [] })), null);
    assert.equal(getCacheUsage(JSON.stringify({ usage: { prompt_tokens: 5000, completion_tokens: 16 } })), null);
    assert.equal(getCacheUsage('not json'), null);
});

test('counts a hit on only the shared system prompt as a miss', () => {
    assert.equal(isCacheMiss({ promptTokens: 21295, cachedTokens: 2379 }), true);
    assert.equal(isCacheMiss({ promptTokens: 24065, cachedTokens: 22016 }), false);
    assert.equal(isCacheMiss(null), false);
});

test('an early first keepalive after a message, then the interval', async () => {
    let calls = 0;
    const { scheduler, setNow } = fixture(async () => { calls++; });
    scheduler.register('u:t', { id: 't', intervalMs: 420000, firstDelayMs: 45000, delayMs: 45000 });
    setNow(45000); scheduler.heartbeat('u:t'); await scheduler.tick();
    assert.equal(calls, 1); assert.equal(scheduler.get('u:t').nextRun, 465000);
    setNow(100000); scheduler.pause('u:t'); scheduler.resume('u:t', 5000);
    assert.equal(scheduler.get('u:t').nextRun, 140000);
});

test('a keepalive due when a slow reply finishes waits for the prompt with the reply', async () => {
    const sent = [];
    const { scheduler, setNow } = fixture(async job => { sent.push(job.payload); });
    const gemini = { id: 't', intervalMs: 420000, firstDelayMs: 45000 };
    scheduler.register('u:t', { ...gemini, payload: 'before', delayMs: 45000, activityCount: 1 });
    setNow(10000); scheduler.pause('u:t');
    // The reply took 60 s, so the first keepalive is already overdue when it finishes.
    setNow(70000); scheduler.resume('u:t', 60000);
    await scheduler.tick();
    assert.deepEqual(sent, []);
    setNow(70600); scheduler.register('u:t', { ...gemini, payload: 'with reply', delayMs: 0, activityCount: 2 });
    await scheduler.tick();
    assert.deepEqual(sent, ['with reply']);
    assert.equal(scheduler.get('u:t').nextRun, 490000);
});

test('a fast reply keeps its first keepalive time and sends the new prompt', async () => {
    const sent = [];
    const { scheduler, setNow } = fixture(async job => { sent.push(job.payload); });
    const gemini = { id: 't', intervalMs: 420000, firstDelayMs: 45000 };
    scheduler.register('u:t', { ...gemini, payload: 'before', delayMs: 45000, activityCount: 1 });
    setNow(10000); scheduler.pause('u:t');
    setNow(30000); scheduler.resume('u:t', 20000);
    setNow(30500); scheduler.register('u:t', { ...gemini, payload: 'with reply', delayMs: 24500, activityCount: 2 });
    await scheduler.tick();
    assert.deepEqual(sent, []);
    setNow(55000); scheduler.heartbeat('u:t'); await scheduler.tick();
    assert.deepEqual(sent, ['with reply']);
});

test('the previous prompt goes out when the tab never sends the new one', quietly(async () => {
    const sent = [];
    const { scheduler, setNow } = fixture(async job => { sent.push(job.payload); });
    scheduler.register('u:t', { id: 't', intervalMs: 420000, firstDelayMs: 45000, payload: 'before', delayMs: 45000 });
    setNow(10000); scheduler.pause('u:t');
    setNow(70000); scheduler.resume('u:t', 60000);
    setNow(70000 + PAYLOAD_WAIT_MS - 1); scheduler.heartbeat('u:t'); await scheduler.tick();
    assert.deepEqual(sent, []);
    setNow(70000 + PAYLOAD_WAIT_MS); scheduler.heartbeat('u:t'); await scheduler.tick();
    assert.deepEqual(sent, ['before']);
}));

test('a failed foreground request does not hold the keepalive', async () => {
    const sent = [];
    const { scheduler, setNow } = fixture(async job => { sent.push(job.payload); });
    scheduler.register('u:t', { id: 't', intervalMs: 420000, firstDelayMs: 45000, payload: 'before', delayMs: 45000 });
    setNow(10000); scheduler.pause('u:t');
    setNow(70000); scheduler.resume('u:t', null);
    await scheduler.tick();
    assert.deepEqual(sent, ['before']);
});

test('without a first delay the next message waits a whole interval', () => {
    const { scheduler, setNow } = fixture();
    scheduler.register('u:t', { id: 't', intervalMs: 280000, delayMs: 280000 });
    setNow(100000); scheduler.pause('u:t'); scheduler.resume('u:t', 5000);
    assert.equal(scheduler.get('u:t').nextRun, 375000);
});

test('keepalives reach ST directly while the global agent goes to a request proxy', async () => {
    const server = http.createServer((req, res) => {
        req.resume();
        req.on('end', () => res.end('{"usage":{"prompt_tokens":10}}'));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    // What SillyTavern's requestProxy does: every request on the global agent goes to the proxy,
    // which here can't connect.
    class DeadProxyAgent extends http.Agent {
        createConnection() { return net.connect(1, '127.0.0.1'); }
    }
    const globalAgent = http.globalAgent;
    const info = console.info;
    try {
        http.globalAgent = new DeadProxyAgent();
        console.info = () => {};
        const { port } = server.address();
        await dispatchKeepaliveRequest({
            id: 't',
            endpoint: '/api/backends/chat-completions/generate',
            payload: {},
            request: { origin: `http://127.0.0.1:${port}`, headers: { 'Content-Type': 'application/json' }, secure: false },
        });
    } finally {
        console.info = info;
        http.globalAgent = globalAgent;
        server.closeAllConnections();
        server.close();
    }
});
