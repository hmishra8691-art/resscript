/**
 * Consumer-loop tests.
 *
 * Everything here runs against `MemoryJobStore`, which implements the same semantics as the SQL
 * functions (single claim, idempotency, attempts, backoff, stalled sweep). That is what makes
 * this suite fast and green with no database while still asserting real behaviour rather than
 * mock interactions.
 *
 * The four named acceptance tests from roadmap M0.4 are marked with ACCEPTANCE comments.
 */
import { AppError, createCapturingLogger, InMemorySpanExporter } from '@resscript/observability';
import { runWithContext } from '@resscript/observability/node';
import { describe, expect, it } from 'vitest';

import { Consumer, withCorrelation } from './consumer.js';
import type { JobStore } from './job-store.js';
import type { JsonObject } from './json.js';
import { MemoryJobStore } from './memory-job-store.js';
import { defineJob, JobRegistry, payload as p } from './registry.js';
import { noopJob, NOOP_KIND } from './kinds/noop.js';

/** Small intervals everywhere: the real timers are exercised, in milliseconds. */
const FAST = {
  concurrency: 1,
  pollIntervalMs: 2,
  heartbeatIntervalMs: 5,
  stalledAfterMs: 50,
  sweepIntervalMs: 5,
  drainTimeoutMs: 2_000,
  backoffMs: () => 0,
} as const;

function nullLog() {
  return createCapturingLogger({ service: 'worker', level: 'debug' });
}

function tick(ms = 5): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await tick(2);
  }
}

describe('the noop job end to end', () => {
  it('runs, reports progress and writes a result', async () => {
    // ACCEPTANCE (M0.4): "Triggering a noop job from studio shows live progress."
    const store = new MemoryJobStore();
    const cap = nullLog();
    const consumer = new Consumer({
      store,
      registry: JobRegistry.create().register(NOOP_KIND, noopJob),
      logger: cap.logger,
      ...FAST,
    });

    const { id } = await store.enqueue({ kind: 'noop', payload: { steps: 4, label: 'poke' } });
    await consumer.runUntilIdle();

    const job = await store.get(id);
    expect(job).toMatchObject({
      status: 'succeeded',
      attempts: 1,
      result: { ok: true, steps: 4, attempt: 1, label: 'poke' },
    });
    // Progress landed in ops.jobs.progress with the exact keys the studio component reads.
    expect(job?.progress).toMatchObject({ step: 4, total: 4, message: 'noop step 4 of 4' });
    expect(typeof (job?.progress as JsonObject)['updated_at']).toBe('string');

    const progressLines = cap.lines.filter((l) => l['msg'] === 'job_progress');
    expect(progressLines.map((l) => l['step'])).toEqual([1, 2, 3, 4]);
    expect(consumer.stats()).toMatchObject({ claimed: 1, succeeded: 1, failed: 0 });
  });

  it('coalesces progress writes: first, last, and one per heartbeat interval', async () => {
    // A projection handler reports progress thousands of times. One UPDATE each would make
    // progress reporting more expensive than the work, so only the writes that matter go out.
    let now = 5_000_000;
    const store = new MemoryJobStore({ now: () => now });
    const writes: (number | undefined)[] = [];
    const original = store.heartbeat.bind(store);
    store.heartbeat = async (id, workerId, progress) => {
      if (progress !== undefined) writes.push(progress['step'] as number);
      return original(id, workerId, progress);
    };

    const chatty = defineJob({
      parse: () => ({}),
      handle: async (ctx): Promise<JsonObject> => {
        for (let step = 1; step <= 100; step += 1) await ctx.progress(step, 100, '');
        return { ok: true };
      },
    });

    const consumer = new Consumer({
      store,
      registry: JobRegistry.create().register('chatty', chatty),
      logger: nullLog().logger,
      ...FAST,
      // The clock never advances inside the handler, so nothing is ever "due".
      heartbeatIntervalMs: 1_000,
      stalledAfterMs: 10_000,
      sweepIntervalMs: 0,
      now: () => now,
    });

    const { id } = await store.enqueue({ kind: 'chatty', payload: {} });
    await consumer.runUntilIdle();

    // 100 progress calls, exactly two database writes: the first step and the last.
    expect(writes).toEqual([1, 100]);
    expect((await store.get(id))?.progress).toMatchObject({ step: 100, total: 100 });
  });

  it('rejects a malformed payload as non-retryable rather than crashing', async () => {
    const store = new MemoryJobStore();
    const consumer = new Consumer({
      store,
      registry: JobRegistry.create().register(NOOP_KIND, noopJob),
      logger: nullLog().logger,
      ...FAST,
    });

    const { id } = await store.enqueue({ kind: 'noop', payload: { steps: 99_999 } });
    await consumer.runUntilIdle();

    const job = await store.get(id);
    expect(job?.status).toBe('failed');
    // One attempt only: a payload this deploy cannot read will not become readable on retry.
    expect(job?.attempts).toBe(1);
    expect(job?.error).toMatchObject({ code: 'malformed_request' });
  });
});

describe('retry with backoff', () => {
  it('a job that crashes twice then succeeds ends with attempts = 3 and ONE succeeded row', async () => {
    // ACCEPTANCE (M0.4 Tests): "enqueues a job which crashes twice then succeeds, asserting
    // attempts = 3 and one succeeded row".
    const store = new MemoryJobStore();
    const attemptsSeen: number[] = [];

    const flaky = defineJob({
      parse: (raw) => ({ failTimes: p.optionalInt(raw, 'failTimes', 2) }),
      handle: async (ctx) => {
        attemptsSeen.push(ctx.attempt);
        if (ctx.attempt <= ctx.payload.failTimes) {
          throw new Error(`boom on attempt ${String(ctx.attempt)}`);
        }
        return { ok: true } satisfies JsonObject;
      },
    });

    const consumer = new Consumer({
      store,
      registry: JobRegistry.create().register('flaky', flaky),
      logger: nullLog().logger,
      ...FAST,
    });

    const { id } = await store.enqueue({ kind: 'flaky', payload: { failTimes: 2 } });
    await consumer.runUntilIdle();

    const job = await store.get(id);
    expect(attemptsSeen).toEqual([1, 2, 3]);
    expect(job?.attempts).toBe(3);
    expect(job?.status).toBe('succeeded');
    expect(store.withStatus('succeeded')).toHaveLength(1);
    expect(store.all()).toHaveLength(1);
    expect(consumer.stats()).toMatchObject({ claimed: 3, requeued: 2, succeeded: 1, failed: 0 });
  });

  it('exhausts max_attempts then fails terminally, recording the last error', async () => {
    const store = new MemoryJobStore();
    const always = defineJob({
      parse: () => ({}),
      handle: async (): Promise<JsonObject> => {
        throw new AppError('unavailable', 'downstream is down', { retryable: true });
      },
    });
    const consumer = new Consumer({
      store,
      registry: JobRegistry.create().register('always', always),
      logger: nullLog().logger,
      ...FAST,
    });

    const { id } = await store.enqueue({ kind: 'always', payload: {}, maxAttempts: 3 });
    await consumer.runUntilIdle();

    expect(await store.get(id)).toMatchObject({
      status: 'failed',
      attempts: 3,
      error: { code: 'unavailable', message: 'downstream is down', retryable: true },
    });
  });

  it("an AppError's own retryable flag beats the handler default", async () => {
    const store = new MemoryJobStore();
    const permanent = defineJob({
      parse: () => ({}),
      handle: async (): Promise<JsonObject> => {
        throw new AppError('validation_failed', 'survey has 3 compile errors');
      },
      // Even with retries enabled by default for unknown throws…
      retryUnknownErrors: true,
    });
    const consumer = new Consumer({
      store,
      registry: JobRegistry.create().register('permanent', permanent),
      logger: nullLog().logger,
      ...FAST,
    });

    const { id } = await store.enqueue({ kind: 'permanent', payload: {}, maxAttempts: 5 });
    await consumer.runUntilIdle();

    // …a deterministic validation failure is tried once. Retrying it three times just delays
    // the user's error message by the backoff interval.
    expect(await store.get(id)).toMatchObject({ status: 'failed', attempts: 1 });
  });

  it('honours the configured backoff as a not-before, not as a sleep', async () => {
    let now = 1_000_000;
    const store = new MemoryJobStore({ now: () => now });
    const always = defineJob({
      parse: () => ({}),
      handle: async (): Promise<JsonObject> => {
        throw new Error('boom');
      },
    });
    const consumer = new Consumer({
      store,
      registry: JobRegistry.create().register('always', always),
      logger: nullLog().logger,
      ...FAST,
      now: () => now,
      backoffMs: () => 10_000,
    });

    const { id } = await store.enqueue({ kind: 'always', payload: {} });
    await consumer.runUntilIdle();

    // runUntilIdle stops as soon as nothing is claimable, which is the correct behaviour: the
    // job is queued but not yet available.
    expect(await store.get(id)).toMatchObject({ status: 'queued', attempts: 1 });
    expect((await store.get(id))?.available_at.getTime()).toBe(now + 10_000);

    now += 10_000;
    await consumer.runUntilIdle();
    expect((await store.get(id))?.attempts).toBe(2);
  });

  it('a kind with no handler fails without retrying', async () => {
    const store = new MemoryJobStore();
    const consumer = new Consumer({
      store,
      registry: JobRegistry.create().register(NOOP_KIND, noopJob),
      kinds: ['noop', 'ghost'],
      logger: nullLog().logger,
      ...FAST,
    });
    const { id } = await store.enqueue({ kind: 'ghost', payload: {} });
    await consumer.runUntilIdle();
    expect(await store.get(id)).toMatchObject({ status: 'failed', attempts: 1 });
    expect((await store.get(id))?.error).toMatchObject({ code: 'malformed_request' });
  });
});

describe('the stalled sweeper', () => {
  it('requeues a job whose worker died mid-run', async () => {
    // ACCEPTANCE (M0.4 Tests): "a job killed mid-run is requeued by the stalled sweeper".
    // The kill is simulated exactly as the roadmap says: by not heartbeating. The handler
    // hangs, we advance the clock past the deadline, and the consumer's own sweeper recovers it.
    let now = 2_000_000;
    const store = new MemoryJobStore({ now: () => now });
    let released = false;
    const runs: number[] = [];

    const hangs = defineJob({
      parse: () => ({}),
      handle: async (ctx): Promise<JsonObject> => {
        runs.push(ctx.attempt);
        // First attempt hangs forever (the "killed" worker); later attempts return.
        if (ctx.attempt === 1) {
          await waitFor(() => released, 5_000);
          return { late: true };
        }
        return { ok: true };
      },
    });

    const consumer = new Consumer({
      store,
      registry: JobRegistry.create().register('hangs', hangs),
      logger: nullLog().logger,
      ...FAST,
      concurrency: 2,
      // Disable the automatic heartbeat so the job genuinely goes silent, which is what an
      // OOM-killed pod looks like to the database.
      heartbeatIntervalMs: 10_000,
      stalledAfterMs: 20_000,
      sweepIntervalMs: 0,
      now: () => now,
    });

    const { id } = await store.enqueue({ kind: 'hangs', payload: {} });
    consumer.start();
    await waitFor(() => runs.length === 1);

    // Nothing has requeued it yet: the stall deadline has not passed.
    expect(await consumer.sweepStalled()).toBe(0);

    // The worker "dies": no heartbeat, and the clock moves past the deadline.
    now += 25_000;
    expect(await consumer.sweepStalled()).toBe(1);
    expect((await store.get(id))?.status).toBe('queued');

    // The second slot picks it up and finishes it.
    await waitFor(() => store.withStatus('succeeded').length === 1, 5_000);
    released = true;
    await consumer.drain();

    const job = await store.get(id);
    expect(runs).toEqual([1, 2]);
    expect(job?.attempts).toBe(2);
    expect(job?.status).toBe('succeeded');
    expect(job?.result).toEqual({ ok: true });
    // The first, "dead" run's result is discarded, not written over the good one.
    expect(consumer.stats().abandoned).toBe(1);
  });

  it('discards the result of a job it no longer owns rather than racing complete_job', async () => {
    // Two workers writing complete_job for one id makes `result` a coin flip. The heartbeat's
    // false return is the signal, and this asserts the consumer acts on it.
    const store = new MemoryJobStore();
    const cap = nullLog();
    let inHandler = false;
    let release = false;

    const slow = defineJob({
      parse: () => ({}),
      handle: async (): Promise<JsonObject> => {
        inHandler = true;
        await waitFor(() => release, 5_000);
        return { from: 'the-old-worker' };
      },
    });

    const consumer = new Consumer({
      store,
      registry: JobRegistry.create().register('slow', slow),
      logger: cap.logger,
      ...FAST,
      workerId: 'worker-original',
      heartbeatIntervalMs: 5,
      stalledAfterMs: 100,
      sweepIntervalMs: 0,
    });

    const { id } = await store.enqueue({ kind: 'slow', payload: {} });
    consumer.start();
    await waitFor(() => inHandler);

    // Simulate the sweeper (running in another pod) taking the job away.
    await store.fail(id, 'worker-original', { code: 'internal_error', message: 'stolen' }, true, 0);
    const stolen = await store.claim('other-worker', ['slow']);
    expect(stolen?.locked_by).toBe('other-worker');

    await consumer.flushHeartbeats();
    release = true;
    await consumer.drain();

    expect(consumer.stats().abandoned).toBe(1);
    expect(cap.lines.some((l) => l['msg'] === 'job_abandoned_lost_ownership')).toBe(true);
    // Still running under the other worker: our result was NOT written.
    expect(await store.get(id)).toMatchObject({ status: 'running', locked_by: 'other-worker' });
  });

  it('survives a store that throws from requeueStalled', async () => {
    const store = new MemoryJobStore();
    const broken: JobStore = {
      ...store,
      enqueue: store.enqueue.bind(store),
      claim: store.claim.bind(store),
      heartbeat: store.heartbeat.bind(store),
      complete: store.complete.bind(store),
      fail: store.fail.bind(store),
      get: store.get.bind(store),
      ping: store.ping.bind(store),
      close: store.close.bind(store),
      requeueStalled: async () => {
        throw new Error('pg unreachable');
      },
    };
    const cap = nullLog();
    const consumer = new Consumer({
      store: broken,
      registry: JobRegistry.create().register(NOOP_KIND, noopJob),
      logger: cap.logger,
      ...FAST,
    });
    await expect(consumer.sweepStalled()).resolves.toBe(0);
    expect(cap.lines.some((l) => l['msg'] === 'stalled_sweep_failed')).toBe(true);
  });
});

describe('concurrency', () => {
  it('two concurrent consumers never claim the same job', async () => {
    // ACCEPTANCE (M0.4 Tests): the SKIP LOCKED property, asserted from the consumer's side.
    const store = new MemoryJobStore();
    const handledBy: string[] = [];
    const jobIds: string[] = [];

    const marker = defineJob({
      parse: (raw) => ({ n: p.optionalInt(raw, 'n', 0) }),
      handle: async (ctx): Promise<JsonObject> => {
        handledBy.push(`${ctx.job.locked_by ?? '?'}:${ctx.job.id}`);
        jobIds.push(ctx.job.id);
        // Force interleaving: without an await here both consumers would run to completion
        // one after the other and the test would prove nothing.
        await tick(1);
        return { n: ctx.payload.n };
      },
    });
    const registry = JobRegistry.create().register('marker', marker);

    for (let i = 0; i < 30; i += 1) await store.enqueue({ kind: 'marker', payload: { n: i } });

    const mk = (id: string): Consumer<{ marker: { n: number } }> =>
      new Consumer({
        store,
        registry,
        logger: nullLog().logger,
        ...FAST,
        workerId: id,
        concurrency: 4,
      });
    const a = mk('worker-a');
    const b = mk('worker-b');

    a.start();
    b.start();
    await waitFor(() => store.withStatus('succeeded').length === 30, 10_000);
    await Promise.all([a.drain(), b.drain()]);

    // Every job ran exactly once…
    expect(jobIds).toHaveLength(30);
    expect(new Set(jobIds).size).toBe(30);
    expect(new Set(handledBy).size).toBe(30);
    // …with no failures, and the work genuinely split across both processes.
    expect(store.withStatus('succeeded')).toHaveLength(30);
    expect(store.withStatus('failed')).toHaveLength(0);
    expect(a.stats().claimed + b.stats().claimed).toBe(30);
    expect(a.stats().claimed).toBeGreaterThan(0);
    expect(b.stats().claimed).toBeGreaterThan(0);
  });

  it('never exceeds the concurrency limit', async () => {
    const store = new MemoryJobStore();
    let concurrent = 0;
    let peak = 0;

    const counted = defineJob({
      parse: () => ({}),
      handle: async (): Promise<JsonObject> => {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        await tick(3);
        concurrent -= 1;
        return { ok: true };
      },
    });

    const consumer = new Consumer({
      store,
      registry: JobRegistry.create().register('counted', counted),
      logger: nullLog().logger,
      ...FAST,
      concurrency: 3,
    });

    for (let i = 0; i < 20; i += 1) await store.enqueue({ kind: 'counted', payload: {} });
    consumer.start();
    await waitFor(() => store.withStatus('succeeded').length === 20, 10_000);
    await consumer.drain();

    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(3);
  });
});

describe('graceful drain', () => {
  it('SIGTERM during an in-flight job drains it rather than dropping it', async () => {
    // ACCEPTANCE (M0.4 Tests): the deploy-safety property. `drain()` is what the SIGTERM
    // handler in server.ts calls; calling it directly is the same code path without emitting
    // a signal into the test runner's own process.
    const store = new MemoryJobStore();
    let started = false;
    let release = false;
    let completed = false;

    const slow = defineJob({
      parse: () => ({}),
      handle: async (): Promise<JsonObject> => {
        started = true;
        await waitFor(() => release, 5_000);
        completed = true;
        return { finished: true };
      },
    });

    const consumer = new Consumer({
      store,
      registry: JobRegistry.create().register('slow', slow),
      logger: nullLog().logger,
      ...FAST,
    });

    const inFlight = await store.enqueue({ kind: 'slow', payload: {} });
    const queued = await store.enqueue({ kind: 'slow', payload: {} });

    consumer.start();
    await waitFor(() => started);

    // SIGTERM arrives here. Drain starts; the in-flight job is still running.
    const draining = consumer.drain();
    await tick(20);
    expect(consumer.isDraining).toBe(true);
    expect(completed).toBe(false);

    release = true;
    const outcome = await draining;

    expect(outcome).toEqual({ drained: true, aborted: 0 });
    expect(completed).toBe(true);
    // The in-flight job finished…
    expect(await store.get(inFlight.id)).toMatchObject({
      status: 'succeeded',
      result: { finished: true },
    });
    // …and the second job was NOT claimed: draining stops claiming immediately, so it stays
    // available for the next pod rather than being half-run by this one.
    expect(await store.get(queued.id)).toMatchObject({ status: 'queued', attempts: 0 });
    expect(consumer.isRunning).toBe(false);
  });

  it('flushes the final progress on drain so the UI does not stick at step N-1', async () => {
    const store = new MemoryJobStore();
    const consumer = new Consumer({
      store,
      registry: JobRegistry.create().register(NOOP_KIND, noopJob),
      logger: nullLog().logger,
      ...FAST,
    });
    const { id } = await store.enqueue({ kind: 'noop', payload: { steps: 3 } });
    consumer.start();
    await waitFor(() => store.withStatus('succeeded').length === 1);
    await consumer.drain();
    expect((await store.get(id))?.progress).toMatchObject({ step: 3, total: 3 });
  });

  it('aborts and reports a dirty drain when the timeout fires', async () => {
    const store = new MemoryJobStore();
    const cap = nullLog();
    let sawAbort = false;

    const stubborn = defineJob({
      parse: () => ({}),
      handle: async (ctx): Promise<JsonObject> => {
        await waitFor(() => ctx.signal.aborted, 5_000);
        sawAbort = true;
        // A cooperative handler that gives up when aborted throws retryably, so the job goes
        // back in the queue rather than being marked done.
        throw new AppError('unavailable', 'aborted during drain', { retryable: true });
      },
    });

    const consumer = new Consumer({
      store,
      registry: JobRegistry.create().register('stubborn', stubborn),
      logger: cap.logger,
      ...FAST,
      drainTimeoutMs: 30,
    });

    const { id } = await store.enqueue({ kind: 'stubborn', payload: {} });
    consumer.start();
    await waitFor(() => consumer.stats().inFlight === 1);

    const outcome = await consumer.drain();
    expect(outcome.drained).toBe(false);
    expect(outcome.aborted).toBe(1);
    expect(sawAbort).toBe(true);
    expect(cap.lines.some((l) => l['msg'] === 'worker_drain_timeout')).toBe(true);
    // Requeued, not lost: the next pod picks it up.
    expect(await store.get(id)).toMatchObject({ status: 'queued', attempts: 1 });
  });

  it('drain on a consumer that never started is a no-op', async () => {
    const consumer = new Consumer({
      store: new MemoryJobStore(),
      registry: JobRegistry.create().register(NOOP_KIND, noopJob),
      logger: nullLog().logger,
      ...FAST,
    });
    await expect(consumer.drain()).resolves.toEqual({ drained: true, aborted: 0 });
  });
});

describe('correlation across the queue hop', () => {
  it('carries the request id from the enqueuer into the handler log lines', async () => {
    // ACCEPTANCE (M0.4): "a request_id from the studio HTTP log can be pasted into the trace
    // viewer to retrieve the full studio → queue → worker span tree." This is the log half.
    const store = new MemoryJobStore();
    const cap = nullLog();
    const seen: string[] = [];

    const traced = defineJob({
      parse: () => ({}),
      handle: async (ctx): Promise<JsonObject> => {
        ctx.log.info('inside_handler');
        return { ok: true };
      },
    });

    const consumer = new Consumer({
      store,
      registry: JobRegistry.create().register('traced', traced),
      logger: cap.logger,
      ...FAST,
    });

    // The studio side: a request id and a traceparent stashed in the payload.
    const traceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
    await store.enqueue({
      kind: 'traced',
      payload: withCorrelation({ x: 1 }, { requestId: 'req_STUDIO', traceparent, orgId: 'org_7' }),
    });

    await runWithContext({ requestId: 'req_UNRELATED' }, async () => {
      seen.push('outer');
      await consumer.runUntilIdle();
    });

    const handlerLine = cap.lines.find((l) => l['msg'] === 'inside_handler');
    expect(handlerLine).toBeDefined();
    // The worker's own ambient context is REPLACED by the job's, not merged with it: a worker
    // slot must not inherit the request id of whatever happened to run before it.
    expect(handlerLine?.['request_id']).toBe('req_STUDIO');
    expect(handlerLine?.['org_id']).toBe('org_7');
    expect(handlerLine?.['trace_id']).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(handlerLine?.['job_id']).toBeDefined();
    expect(handlerLine?.['kind']).toBe('traced');
    expect(handlerLine?.['attempt']).toBe(1);
    expect(seen).toEqual(['outer']);
  });

  it('parents the job span to the enqueuer span — the span tree half', async () => {
    const store = new MemoryJobStore();
    const exporter = new InMemorySpanExporter();
    const { setSpanExporter } = await import('@resscript/observability');
    const previous = (await import('@resscript/observability')).getSpanExporter();
    setSpanExporter(exporter);
    try {
      const consumer = new Consumer({
        store,
        registry: JobRegistry.create().register(NOOP_KIND, noopJob),
        logger: nullLog().logger,
        ...FAST,
      });
      const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
      const studioSpanId = '00f067aa0ba902b7';
      await store.enqueue({
        kind: 'noop',
        payload: withCorrelation(
          { steps: 1 },
          { traceparent: `00-${traceId}-${studioSpanId}-01`, requestId: 'req_1' },
        ),
      });
      await consumer.runUntilIdle();

      const jobSpan = exporter.byName('job.noop');
      expect(jobSpan).toBeDefined();
      expect(jobSpan?.context.traceId).toBe(traceId);
      expect(jobSpan?.parentSpanId).toBe(studioSpanId);
      expect(jobSpan?.kind).toBe('consumer');
      // Attributed to the deployable even though this test never called setTracerService.
      expect(jobSpan?.service).toBe('worker');
      expect(jobSpan?.attributes['job.kind']).toBe('noop');
      expect(jobSpan?.attributes['job.attempt']).toBe(1);
      expect(jobSpan?.status.code).toBe('ok');
    } finally {
      setSpanExporter(previous);
    }
  });

  it('starts a fresh trace for a job enqueued without correlation', async () => {
    const store = new MemoryJobStore();
    const exporter = new InMemorySpanExporter();
    const obs = await import('@resscript/observability');
    const previous = obs.getSpanExporter();
    obs.setSpanExporter(exporter);
    try {
      const consumer = new Consumer({
        store,
        registry: JobRegistry.create().register(NOOP_KIND, noopJob),
        logger: nullLog().logger,
        ...FAST,
      });
      await store.enqueue({ kind: 'noop', payload: { steps: 1 } });
      await consumer.runUntilIdle();
      expect(exporter.byName('job.noop')?.parentSpanId).toBeUndefined();
    } finally {
      obs.setSpanExporter(previous);
    }
  });

  it('records the exception on the job span when a handler throws', async () => {
    const store = new MemoryJobStore();
    const exporter = new InMemorySpanExporter();
    const obs = await import('@resscript/observability');
    const previous = obs.getSpanExporter();
    obs.setSpanExporter(exporter);
    try {
      const boom = defineJob({
        parse: () => ({}),
        handle: async (): Promise<JsonObject> => {
          throw new AppError('unavailable', 'nope', { retryable: false });
        },
      });
      const consumer = new Consumer({
        store,
        registry: JobRegistry.create().register('boom', boom),
        logger: nullLog().logger,
        ...FAST,
      });
      await store.enqueue({ kind: 'boom', payload: {} });
      await consumer.runUntilIdle();

      const span = exporter.byName('job.boom');
      // The handler's failure does not propagate out of the span (the consumer records it and
      // fails the job), so the span status is `ok`; the failure detail is a child span plus
      // the job_failed log line and ops.jobs.error.
      expect(span).toBeDefined();
      expect(exporter.byName('job.failure')?.attributes['error.code']).toBe('unavailable');
    } finally {
      obs.setSpanExporter(previous);
    }
  });
});

describe('construction guards', () => {
  it('rejects a heartbeat interval at or above the stall deadline', () => {
    // A heartbeat slower than the stall deadline requeues every healthy job — a config typo
    // that would duplicate every long job in production.
    expect(
      () =>
        new Consumer({
          store: new MemoryJobStore(),
          registry: JobRegistry.create().register(NOOP_KIND, noopJob),
          heartbeatIntervalMs: 30_000,
          stalledAfterMs: 30_000,
        }),
    ).toThrow(/heartbeatIntervalMs/);
  });

  it('rejects an empty kind list', () => {
    expect(
      () =>
        new Consumer({
          store: new MemoryJobStore(),
          registry: JobRegistry.create(),
        }),
    ).toThrow(/no job kinds/);
  });

  it('mints a worker id when none is given', () => {
    const consumer = new Consumer({
      store: new MemoryJobStore(),
      registry: JobRegistry.create().register(NOOP_KIND, noopJob),
    });
    expect(consumer.workerId).toMatch(/^worker-\d+-[a-z0-9]+$/);
  });
});

describe('withCorrelation', () => {
  it('adds only the keys it is given, under reserved names', () => {
    expect(withCorrelation({ a: 1 }, { requestId: 'req_1' })).toEqual({ a: 1, _request_id: 'req_1' });
    expect(withCorrelation({ a: 1 }, {})).toEqual({ a: 1 });
    expect(
      withCorrelation({}, { requestId: 'r', traceparent: 't', orgId: 'o' }),
    ).toEqual({ _request_id: 'r', _traceparent: 't', _org_id: 'o' });
  });
});
