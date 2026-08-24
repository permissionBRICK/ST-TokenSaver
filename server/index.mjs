import express from 'express';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import fetch from 'node-fetch';

const apiRouter = express.Router();
const OPENROUTER_FORWARDING_MARKER = "bodyParams['session_id'] = request.body.session_id";

export function hasOpenRouterSessionForwarding(root = process.cwd()) {
    try {
        const backend = path.join(root, 'src/endpoints/backends/chat-completions.js');
        return fs.readFileSync(backend, 'utf8').includes(OPENROUTER_FORWARDING_MARKER);
    } catch {
        return false;
    }
}

export const FRONTEND_LEASE_MS = 5 * 60 * 1000;
const MIN_INTERVAL_MS = 60 * 1000;
const MAX_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FAILED_REQUEST_RETRY_MS = 5 * 1000;
const EXPIRED_JOB_RETENTION_MS = MAX_INTERVAL_MS;
const MAX_EXPIRED_JOBS = 1000;
const MAX_JOB_ID_LENGTH = 128;
const ALLOWED_ENDPOINTS = new Set([
    '/api/backends/chat-completions/generate',
    '/api/backends/text-completions/generate',
    '/api/backends/kobold/generate',
    '/api/novelai/generate',
    '/api/horde/generate-text',
]);
const localHttpsAgent = new https.Agent({ rejectUnauthorized: false });

function advanceDeadline(deadline, interval, now) {
    if (deadline > now) {
        return deadline;
    }
    const missedIntervals = Math.floor((now - deadline) / interval) + 1;
    return deadline + missedIntervals * interval;
}

/**
 * Backend-owned scheduler for prompt-cache keepalive requests.
 */
export class KeepaliveScheduler {
    #jobs = new Map();
    #expiredJobs = new Map();
    #timer = null;
    #now;
    #dispatch;
    #setTimer;
    #clearTimer;

    constructor({
        now = Date.now,
        dispatch = dispatchKeepaliveRequest,
        setTimer = setTimeout,
        clearTimer = clearTimeout,
    } = {}) {
        this.#now = now;
        this.#dispatch = dispatch;
        this.#setTimer = setTimer;
        this.#clearTimer = clearTimer;
    }

    register(key, job) {
        const now = this.#now();
        this.#pruneExpiredJobs(now);
        this.#expiredJobs.delete(key);
        const existing = this.#jobs.get(key);
        const intervalMs = Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Number(job.intervalMs) || MIN_INTERVAL_MS));
        const requestedDelay = Number(job.delayMs);
        const delayMs = Number.isFinite(requestedDelay)
            ? Math.min(intervalMs, Math.max(0, requestedDelay))
            : intervalMs;
        const requestedNextRun = now + delayMs;
        if (existing) {
            // Re-registering updates the replay payload, but cannot claim that the provider cache
            // was refreshed. Mutate the existing object so an in-flight dispatch can still clear
            // its state, while preserving an earlier deadline and any foreground-request pause.
            Object.assign(existing, job, {
                intervalMs,
                lastSeen: now,
                nextRun: Math.min(existing.nextRun, requestedNextRun),
            });
        } else {
            this.#jobs.set(key, {
                ...job,
                intervalMs,
                lastSeen: now,
                nextRun: requestedNextRun,
                inFlight: false,
                paused: false,
                lastRun: null,
            });
        }
        this.#schedule();
        return this.#jobs.get(key);
    }

    heartbeat(key, request = null) {
        const job = this.#jobs.get(key);
        if (!job) {
            return null;
        }
        const now = this.#now();
        if ((now - job.lastSeen) >= FRONTEND_LEASE_MS) {
            this.#expire(key, job, now);
            this.#schedule();
            return null;
        }
        job.lastSeen = now;
        if (request) {
            job.request = request;
        }
        this.#schedule();
        return job;
    }

    pause(key) {
        const job = this.#jobs.get(key);
        if (!job) {
            return null;
        }
        job.lastSeen = this.#now();
        job.paused = true;
        this.#schedule();
        return job;
    }

    resume(key, activityElapsedMs = null) {
        const job = this.#jobs.get(key);
        if (!job) {
            return null;
        }
        const now = this.#now();
        job.lastSeen = now;
        job.paused = false;
        const elapsedMs = Number(activityElapsedMs);
        if (activityElapsedMs !== null && activityElapsedMs !== undefined && Number.isFinite(elapsedMs) && elapsedMs >= 0) {
            job.nextRun = now + Math.max(0, job.intervalMs - elapsedMs);
        }
        this.#schedule();
        return job;
    }

    stop(key) {
        const removed = this.#jobs.delete(key);
        this.#expiredJobs.delete(key);
        this.#schedule();
        return removed;
    }

    get(key) {
        return this.#jobs.get(key) ?? null;
    }

    getExpired(key) {
        this.#pruneExpiredJobs(this.#now());
        return this.#expiredJobs.get(key) ?? null;
    }

    async tick(now = this.#now()) {
        const pending = [];
        for (const [key, job] of this.#jobs) {
            if ((now - job.lastSeen) >= FRONTEND_LEASE_MS) {
                this.#expire(key, job, now);
                continue;
            }
            if (job.nextRun > now) {
                continue;
            }
            if (job.inFlight || job.paused) {
                continue;
            }
            const scheduledRun = job.nextRun;
            job.inFlight = true;
            pending.push(Promise.resolve(this.#dispatch(job)).then(() => {
                const completedAt = this.#now();
                job.lastRun = completedAt;
                job.nextRun = advanceDeadline(scheduledRun, job.intervalMs, completedAt);
                const expiredJob = this.#expiredJobs.get(key);
                if (expiredJob) {
                    expiredJob.lastRun = completedAt;
                }
            }).catch(error => {
                console.debug(`[Keepalive] Backend request failed for ${job.id}:`, error);
                job.nextRun = this.#now() + FAILED_REQUEST_RETRY_MS;
            }).finally(() => {
                job.inFlight = false;
                this.#schedule();
            }));
        }
        this.#schedule();
        await Promise.all(pending);
    }

    #expire(key, job, now) {
        this.#jobs.delete(key);
        this.#expiredJobs.set(key, {
            expiredAt: now,
            intervalMs: job.intervalMs,
            lastRun: job.lastRun,
        });
        this.#pruneExpiredJobs(now);
    }

    #pruneExpiredJobs(now) {
        for (const [key, job] of this.#expiredJobs) {
            if ((now - job.expiredAt) >= EXPIRED_JOB_RETENTION_MS) {
                this.#expiredJobs.delete(key);
            }
        }
        while (this.#expiredJobs.size > MAX_EXPIRED_JOBS) {
            this.#expiredJobs.delete(this.#expiredJobs.keys().next().value);
        }
    }

    #schedule() {
        if (this.#timer) {
            this.#clearTimer(this.#timer);
            this.#timer = null;
        }
        if (!this.#jobs.size) {
            return;
        }

        let nextWake = Infinity;
        for (const job of this.#jobs.values()) {
            const nextRun = (job.inFlight || job.paused) ? Infinity : job.nextRun;
            nextWake = Math.min(nextWake, nextRun, job.lastSeen + FRONTEND_LEASE_MS);
        }
        const delay = Math.max(0, nextWake - this.#now());
        this.#timer = this.#setTimer(() => {
            this.#timer = null;
            void this.tick();
        }, delay);
        this.#timer?.unref?.();
    }
}

async function dispatchKeepaliveRequest(job) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('Keepalive request timed out')), 120000);
    timeout.unref?.();
    try {
        console.info(`[Keepalive] Dispatching job ${job.id} to ${job.endpoint}`);
        const response = await fetch(`${job.request.origin}${job.endpoint}`, {
            method: 'POST',
            headers: job.request.headers,
            body: JSON.stringify(job.payload),
            signal: controller.signal,
            agent: job.request.secure ? localHttpsAgent : undefined,
        });
        await response.arrayBuffer();
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        console.info(`[Keepalive] Job ${job.id} completed successfully`);
    } finally {
        clearTimeout(timeout);
    }
}

const scheduler = new KeepaliveScheduler();

function getJobKey(request, id) {
    return `${request.user.profile.handle}:${id}`;
}

function getJobId(request) {
    const id = String(request.body?.id ?? '');
    if (!id || id.length > MAX_JOB_ID_LENGTH || !/^[a-zA-Z0-9_-]+$/.test(id)) {
        throw new Error('Invalid keepalive job id');
    }
    return id;
}

function getReplayRequest(request) {
    const localPort = Number(request.socket.localPort);
    if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) {
        throw new Error('Unable to determine local server port');
    }
    let localAddress = request.socket.localAddress || '127.0.0.1';
    if (localAddress === '::' || localAddress === '0:0:0:0:0:0:0:0') {
        localAddress = '::1';
    } else if (localAddress === '0.0.0.0') {
        localAddress = '127.0.0.1';
    } else if (localAddress.startsWith('::ffff:')) {
        localAddress = localAddress.slice('::ffff:'.length);
    }
    const loopbackHost = localAddress.includes(':') ? `[${localAddress}]` : localAddress;
    const headers = {
        'Content-Type': 'application/json',
        'Cookie': request.get('cookie') || '',
        'X-CSRF-Token': request.get('x-csrf-token') || '',
        'Host': request.get('host') || '',
    };
    for (const name of ['authorization', 'origin', 'referer', 'user-agent']) {
        const value = request.get(name);
        if (value) {
            headers[name] = value;
        }
    }
    const secure = !!request.socket.encrypted;
    return {
        origin: `${secure ? 'https' : 'http'}://${loopbackHost}:${localPort}`,
        headers,
        secure,
    };
}

apiRouter.post('/register', (request, response) => {
    try {
        const id = getJobId(request);
        const endpoint = String(request.body?.endpoint ?? '');
        if (!ALLOWED_ENDPOINTS.has(endpoint)) {
            return response.status(400).send({ error: 'Unsupported keepalive endpoint' });
        }
        if (!request.body?.payload || typeof request.body.payload !== 'object' || Array.isArray(request.body.payload)) {
            return response.status(400).send({ error: 'Missing keepalive payload' });
        }
        const job = scheduler.register(getJobKey(request, id), {
            id,
            endpoint,
            payload: request.body.payload,
            intervalMs: request.body.intervalMs,
            delayMs: request.body.delayMs,
            request: getReplayRequest(request),
        });
        console.info(`[Keepalive] Registered job ${id}; first run in ${job.nextRun - Date.now()}ms, interval ${job.intervalMs}ms`);
        return response.send({ ok: true, nextRun: job.nextRun, leaseMs: FRONTEND_LEASE_MS });
    } catch (error) {
        return response.status(400).send({ error: String(error.message || error) });
    }
});

apiRouter.post('/heartbeat', (request, response) => {
    try {
        const id = getJobId(request);
        const key = getJobKey(request, id);
        const job = scheduler.heartbeat(key, getReplayRequest(request));
        if (!job) {
            const expiredJob = scheduler.getExpired(key);
            return response.status(404).send({
                expired: !!expiredJob,
                lastRun: expiredJob?.lastRun ?? null,
            });
        }
        return response.send({ ok: true, nextRun: job.nextRun, lastRun: job.lastRun, leaseMs: FRONTEND_LEASE_MS });
    } catch (error) {
        return response.status(400).send({ error: String(error.message || error) });
    }
});

apiRouter.post('/pause', (request, response) => {
    try {
        const id = getJobId(request);
        const job = scheduler.pause(getJobKey(request, id));
        if (!job) {
            return response.status(404).send({ expired: false });
        }
        console.info(`[Keepalive] Paused job ${id} while foreground inference is running`);
        return response.send({ ok: true, nextRun: job.nextRun, lastRun: job.lastRun, leaseMs: FRONTEND_LEASE_MS });
    } catch (error) {
        return response.status(400).send({ error: String(error.message || error) });
    }
});

apiRouter.post('/resume', (request, response) => {
    try {
        const id = getJobId(request);
        const job = scheduler.resume(getJobKey(request, id), request.body?.activityElapsedMs);
        if (!job) {
            const expiredJob = scheduler.getExpired(getJobKey(request, id));
            return response.status(404).send({
                expired: !!expiredJob,
                lastRun: expiredJob?.lastRun ?? null,
            });
        }
        const reset = request.body?.activityElapsedMs !== null && request.body?.activityElapsedMs !== undefined;
        console.info(`[Keepalive] Resumed job ${id}; deadline ${reset ? 'reset by successful foreground inference' : 'preserved after unsuccessful foreground inference'}`);
        return response.send({ ok: true, nextRun: job.nextRun, lastRun: job.lastRun, leaseMs: FRONTEND_LEASE_MS });
    } catch (error) {
        return response.status(400).send({ error: String(error.message || error) });
    }
});

apiRouter.post('/stop', (request, response) => {
    try {
        const id = getJobId(request);
        scheduler.stop(getJobKey(request, id));
        return response.send({ ok: true });
    } catch (error) {
        return response.status(400).send({ error: String(error.message || error) });
    }
});

apiRouter.get('/capabilities', (_request, response) => {
    return response.send({
        openRouterSessionForwarding: hasOpenRouterSessionForwarding(),
    });
});

export async function init(router) {
    router.use(apiRouter);
    if (!hasOpenRouterSessionForwarding()) {
        console.warn('[Token Saver] OpenRouter session IDs require the bundled server integration. See the ST-TokenSaver README.');
    }
}

export const info = {
    id: 'token-saver',
    name: 'Token Saver Scheduler',
    description: 'Schedules one-token prompt-cache keepalive requests while a SillyTavern tab holds a lease.',
};
