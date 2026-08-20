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
    expect(body.checks).toEqual({ job_store: 'ok', consumer: 'running' });
    expect(body.stats).toMatchObject({ claimed: 0, succeeded: 0, inFlight: 0 });
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
