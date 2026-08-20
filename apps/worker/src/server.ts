/**
 * `apps/worker` process entry point.
 *
 * Startup order matters and is the reverse of shutdown order:
 *   1. install the Node correlation context (`@resscript/observability/node`'s import side
 *      effect) and the span exporter — before anything that might log or trace;
 *   2. build the store;
 *   3. build the consumer and start claiming;
 *   4. bind `/health` and `/ready` LAST, so the readiness probe cannot report ready before the
 *      consumer exists.
 *
 * Shutdown (SIGTERM, which is what a container runtime sends on deploy):
 *   1. stop serving `/ready` as ready and stop claiming;
 *   2. let in-flight jobs finish (`consumer.drain()`);
 *   3. close the HTTP server, then the store;
 *   4. exit 0 for a clean drain, 1 if the drain timed out — because an aborted job is work the
 *      stalled sweeper has to recover, and that deserves to show up as a failed pod termination.
 */

import {
  ConsoleSpanExporter,
  createLogger,
  isLogLevel,
  LogMetricSink,
  setMetricSink,
  setSpanExporter,
  setTracerService,
} from '@resscript/observability';
// Imported for its side effect: installs the AsyncLocalStorage-backed correlation provider, so
// `request_id` propagates into every handler without being threaded through signatures.
import '@resscript/observability/node';

import { Consumer } from './consumer.js';
import { createHealthServer } from './health.js';
import type { JobStore, PayloadMap } from './index.js';
import { buildRegistry } from './kinds/registry.js';
import { MemoryJobStore } from './memory-job-store.js';
import { PgJobStore, type SqlClient } from './pg-job-store.js';

const SERVICE = 'worker';

function env(name: string): string | undefined {
  return process.env[name];
}

function intEnv(name: string, fallback: number): number {
  const raw = env(name);
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isNaN(n) ? fallback : n;
}

/**
 * Build the store from `DATABASE_URL`.
 *
 * `pg` is imported dynamically so that importing this module (a test, the studio's enqueue path)
 * does not open a connection pool as a side effect, and so a worker configured without a
 * database can still start in-memory for a smoke test.
 */
async function createStore(): Promise<{ store: JobStore; backend: 'postgres' | 'memory' }> {
  const url = env('DATABASE_URL');
  if (url === undefined || url === '') {
    return { store: new MemoryJobStore(), backend: 'memory' };
  }
  const pg = await import('pg');
  const pool = new pg.default.Pool({
    connectionString: url,
    // A worker with `concurrency` slots needs at most concurrency + 1 connections (one spare
    // for heartbeats and the sweeper). Sizing it from the same number avoids the classic
    // "worker exhausts the pool and heartbeats time out, so every job is requeued" failure.
    max: intEnv('WORKER_CONCURRENCY', 4) + 2,
    application_name: 'resscript-worker',
  });
  return { store: new PgJobStore(pool as unknown as SqlClient), backend: 'postgres' };
}

export async function main(): Promise<number> {
  const levelRaw = env('LOG_LEVEL');
  const log = createLogger({
    service: SERVICE,
    ...(levelRaw !== undefined && isLogLevel(levelRaw) ? { level: levelRaw } : {}),
  });

  setTracerService(SERVICE);
  setSpanExporter(new ConsoleSpanExporter());
  // Log-based metrics until an OTLP/Prometheus exporter is chosen (M0.4's dashboards). The
  // worker can afford a real client library later; `setMetricSink` is the only line that changes.
  setMetricSink(new LogMetricSink((line) => process.stdout.write(`${line}\n`), SERVICE));

  const { store, backend } = await createStore();
  const registry = buildRegistry();

  const consumer = new Consumer({
    store,
    registry,
    logger: log,
    concurrency: intEnv('WORKER_CONCURRENCY', 4),
    pollIntervalMs: intEnv('WORKER_POLL_INTERVAL_MS', 200),
    heartbeatIntervalMs: intEnv('WORKER_HEARTBEAT_INTERVAL_MS', 5_000),
    stalledAfterMs: intEnv('WORKER_STALLED_AFTER_MS', 30_000),
    sweepIntervalMs: intEnv('WORKER_SWEEP_INTERVAL_MS', 10_000),
    drainTimeoutMs: intEnv('WORKER_DRAIN_TIMEOUT_MS', 25_000),
  });

  log.info('worker_boot', {
    backend,
    kinds: registry.kinds(),
    node_version: process.version,
  });
  if (backend === 'memory') {
    // Loud, because an in-memory queue in production silently loses every job on restart.
    log.warn('worker_using_memory_store', {
      reason: 'DATABASE_URL is unset',
      durable: false,
    });
  }

  consumer.start();

  const health = createHealthServer({
    store,
    // The Consumer's payload map is irrelevant to the health endpoint, which only reads
    // lifecycle state; widening it here keeps HealthServerOptions from being generic.
    consumer: consumer as unknown as Consumer<PayloadMap>,
    port: intEnv('PORT', 8082),
    logger: log,
    ...(env('GIT_SHA') === undefined ? {} : { version: env('GIT_SHA') as string }),
  });
  await health.listen();

  const exitCode = await new Promise<number>((resolve) => {
    let shuttingDown = false;
    const shutdown = (signal: string): void => {
      if (shuttingDown) {
        // A second SIGTERM during drain means the operator (or the runtime's grace period)
        // wants us gone now. Honour it rather than ignoring the signal.
        log.warn('worker_forced_shutdown', { signal });
        resolve(1);
        return;
      }
      shuttingDown = true;
      log.info('worker_signal', { signal });
      void (async () => {
        const { drained, aborted } = await consumer.drain();
        await health.close();
        await store.close();
        resolve(drained ? 0 : 1);
        if (!drained) log.error('worker_exit_dirty', { aborted });
      })();
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  });

  return exitCode;
}

// `NODE_ENV=test` guard matches apps/runtime's server.ts: importing the module in a test must
// not start a worker.
if (process.env['NODE_ENV'] !== 'test' && process.env['WORKER_NO_AUTOSTART'] !== '1') {
  main()
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      createLogger({ service: SERVICE }).error('worker_boot_failed', { err: String(err) });
      process.exit(1);
    });
}
