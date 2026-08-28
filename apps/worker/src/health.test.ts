/**
 * `/health` and `/ready`.
 *
 * M0.3's smoke test hits `/health` on all three deployables, so these endpoints are a contract,
 * not a convenience. The tests bind a real socket on port 0 (an OS-assigned free port) rather
 * than calling the handler with fake req/res objects, because half of what can go wrong here —
 * a header written twice, a content-length mismatch — only shows up over a real connection.
 */
import { createCapturingLogger } from '@resscript/observability';
import { afterEach, describe, expect, it } from 'vitest';

import { Consumer } from './consumer.js';
import { createHealthServer, readiness } from './health.js';
import type { JobStore } from './job-store.js';
import { MemoryJobStore } from './memory-job-store.js';
import { JobRegistry, type PayloadMap } from './registry.js';
import { noopJob, NOOP_KIND } from './kinds/noop.js';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function makeConsumer(store: MemoryJobStore): Consumer<PayloadMap> {
  return new Consumer({
    store,
    registry: JobRegistry.create().register(NOOP_KIND, noopJob),
    logger: createCapturingLogger({ service: 'worker' }).logger,
    pollIntervalMs: 5,
    heartbeatIntervalMs: 10,
    stalledAfterMs: 100,
    sweepIntervalMs: 0,
  }) as unknown as Consumer<PayloadMap>;
}

async function serve(store: MemoryJobStore, consumer: Consumer<PayloadMap>): Promise<string> {
  const health = createHealthServer({
    store,
    consumer,
    port: 0,
    logger: createCapturingLogger({ service: 'worker' }).logger,
    version: 'abc1234',
  });
  const port = await health.listen();
  cleanups.push(() => health.close());
  return `http://127.0.0.1:${String(port)}`;
}

describe('/health — liveness', () => {
  it('is 200 with the service identity, even before the consumer starts', async () => {
    const store = new MemoryJobStore();
    const consumer = makeConsumer(store);
    const base = await serve(store, consumer);

    const res = await fetch(`${base}/health`, { headers: { 'x-request-id': 'req_probe' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({
      status: 'ok',
      service: 'worker',
      version: 'abc1234',
      worker_id: consumer.workerId,
      request_id: 'req_probe',
    });
  });

  it('stays 200 while draining — liveness is not readiness', async () => {
    // A database-checking liveness probe restarts every pod during a Postgres failover, turning
    // a recoverable blip into a fleet-wide cold start with the in-flight jobs dropped.
    const store = new MemoryJobStore();
    const consumer = makeConsumer(store);
    const base = await serve(store, consumer);

    consumer.start();
    const draining = consumer.drain();
    expect((await fetch(`${base}/health`)).status).toBe(200);
    await draining;
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });

  it('mints a request id when the probe sends none', async () => {
    const store = new MemoryJobStore();
    const base = await serve(store, makeConsumer(store));
    const body = (await (await fetch(`${base}/health`)).json()) as { request_id: string };
    expect(body.request_id).toMatch(/^req_[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});

describe('/ready — readiness', () => {
  it('is 503 before the consumer starts', async () => {
    const store = new MemoryJobStore();
    const consumer = makeConsumer(store);
    const base = await serve(store, consumer);

    const res = await fetch(`${base}/ready`);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { ready: boolean; checks: Record<string, string> };
    expect(body.ready).toBe(false);
    expect(body.checks).toEqual({ job_store: 'ok', consumer: 'stopped' });
  });

  it('is 200 once the consumer is claiming', async () => {
    const store = new MemoryJobStore();
    const consumer = makeConsumer(store);
    const base = await serve(store, consumer);
    consumer.start();
    cleanups.push(async () => {
      await consumer.drain();
    });

    const res = await fetch(`${base}/ready`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ready: boolean;
      checks: Record<string, string>;
      stats: Record<string, number>;
    };
    expect(body.ready).toBe(true);
    expect(body.checks).toEqual({ job_store: 'ok', consumer: 'running', claim: 'ok' });
    expect(body.stats).toMatchObject({ claimed: 0, succeeded: 0, inFlight: 0 });
  });

  /*
   * The case `/ready` was blind to: the queue is unreachable, and everything else looks fine.
   *
   * This is not a hypothetical. `ops.claim_job` returns an all-NULL composite row when the queue
   * is empty; `PgJobStore.claim` treated that as a job and `mapJobRow` threw on its NULL status,
   * so a worker against a real database failed EVERY claim, four slots at 5Hz, from boot. Both
   * of the checks that existed stayed green — `store.ping()` is `SELECT 1` and the slot loops
   * were still looping — so `/ready` answered 200 while the worker was incapable of starting a
   * single job. Nothing an orchestrator probes would have caught it.
   *
   * The clock is injected rather than waited on: the real threshold is 30s.
   */
  it('is 503 when every claim has been failing, though the store pings and the loop runs', async () => {
    const store = new MemoryJobStore();
    const broken: JobStore = {
      ...store,
      enqueue: store.enqueue.bind(store),
      heartbeat: store.heartbeat.bind(store),
      complete: store.complete.bind(store),
      fail: store.fail.bind(store),
      get: store.get.bind(store),
      close: store.close.bind(store),
      requeueStalled: store.requeueStalled.bind(store),
      // Exactly the split that made this invisible: the health probe's query works...
      ping: async () => true,
      // ...and the one the worker actually needs does not.
      claim: async () => {
        throw new Error('unknown ops.jobs.status: null');
      },
    };

    let clock = 1_000;
    const consumer = new Consumer({
      store: broken,
      registry: JobRegistry.create().register(NOOP_KIND, noopJob),
      logger: createCapturingLogger({ service: 'worker' }).logger,
      pollIntervalMs: 5,
      heartbeatIntervalMs: 10,
      stalledAfterMs: 100,
      sweepIntervalMs: 0,
      claimStaleAfterMs: 30_000,
      now: () => clock,
    }) as unknown as Consumer<PayloadMap>;
    const base = await serve(store, consumer);
    consumer.start();
    cleanups.push(async () => {
      await consumer.drain();
    });

    // Before the threshold: a brief outage must NOT flap readiness. This is the half that keeps
    // a Postgres failover from restarting the fleet.
    const early = await fetch(`${base}/ready`);
    expect(early.status).toBe(200);
    expect(((await early.json()) as { checks: Record<string, string> }).checks['claim']).toBe('ok');

    clock += 30_001;

    const res = await fetch(`${base}/ready`);
    const body = (await res.json()) as { ready: boolean; checks: Record<string, string> };
    expect(res.status).toBe(503);
    expect(body.ready).toBe(false);
    // The distinction an operator needs: the loop is alive, the queue is not reachable.
    expect(body.checks).toEqual({ job_store: 'ok', consumer: 'running', claim: 'stale' });
  });

  it('is 503 while draining, so a rolling deploy stops sending work', async () => {
    const store = new MemoryJobStore();
    const consumer = makeConsumer(store);
    const base = await serve(store, consumer);
    consumer.start();

    const draining = consumer.drain();
    const res = await fetch(`${base}/ready`);
    const body = (await res.json()) as { ready: boolean; checks: Record<string, string> };
    expect(res.status).toBe(503);
    expect(body.checks['consumer']).toBe('draining');
    await draining;
  });

  it('is 503 when the store is unreachable', async () => {
    const store = new MemoryJobStore();
    const consumer = makeConsumer(store);
    const base = await serve(store, consumer);
    consumer.start();
    cleanups.push(async () => {
      await consumer.drain();
    });

    await store.close();
    const res = await fetch(`${base}/ready`);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { checks: Record<string, string> }).checks['job_store']).toBe(
      'unreachable',
    );
  });

  it('reports a store that throws rather than 500ing the probe', async () => {
    const store = new MemoryJobStore();
    const consumer = makeConsumer(store);
    const throwing = {
      ...store,
      ping: async () => {
        throw new TypeError('pool destroyed');
      },
    } as unknown as MemoryJobStore;

    const report = await readiness(throwing, consumer);
    expect(report.ready).toBe(false);
    expect(report.checks['job_store']).toBe('error: TypeError');
  });
});

describe('everything else', () => {
  it('is 404 with the error envelope shape', async () => {
    const store = new MemoryJobStore();
    const base = await serve(store, makeConsumer(store));
    const res = await fetch(`${base}/metrics`);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: 'not_found' } });
  });

  it('ignores the query string when routing', async () => {
    const store = new MemoryJobStore();
    const base = await serve(store, makeConsumer(store));
    expect((await fetch(`${base}/health?probe=k8s`)).status).toBe(200);
  });
});
