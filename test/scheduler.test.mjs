import assert from 'node:assert/strict';
import test from 'node:test';
import { FRONTEND_LEASE_MS, KeepaliveScheduler } from '../server/index.mjs';

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
