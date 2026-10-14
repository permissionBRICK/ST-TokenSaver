import assert from 'node:assert/strict';
import test from 'node:test';
import { FRONTEND_LEASE_MS, KeepaliveScheduler, getResponseError } from '../server/index.mjs';

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
