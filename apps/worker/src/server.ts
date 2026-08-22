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

import { FsArtifactStore } from './artifact-store.js';
import { Consumer } from './consumer.js';
import { FsExportSink, PgExportStore } from './export-store.js';
import { createHealthServer } from './health.js';
import type { JobStore, PayloadMap } from './index.js';
import type { CompileEnvironment } from './kinds/compile.js';
import type { ExportEnvironment } from './kinds/export.js';
import { buildRegistry } from './kinds/registry.js';
import { MemoryJobStore } from './memory-job-store.js';
import { PgJobStore, type SqlClient } from './pg-job-store.js';
import { PgPublishStore, poolSessions, type PoolLike } from './publish-store.js';

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
async function createStore(): Promise<{
  store: JobStore;
  backend: 'postgres' | 'memory';
  /**
   * The pool, when there is one. Exposed because the `compile` job needs a CONNECTION and not a
   * connection pool's `query()`: migration 0009's calling convention has it assume the enqueuing
   * user's identity with `SET LOCAL ROLE`, which is meaningless outside a transaction, and a pool
   * hands out a different connection per `query()`. See `publish-store.ts`.
   */
  pool: PoolLike | null;
}> {
  const url = env('DATABASE_URL');
  if (url === undefined || url === '') {
    return { store: new MemoryJobStore(), backend: 'memory', pool: null };
  }
  const pg = await import('pg');
  const pool = new pg.default.Pool({
    connectionString: url,
    // A worker with `concurrency` slots needs at most concurrency + 1 connections (one spare
    // for heartbeats and the sweeper). Sizing it from the same number avoids the classic
    // "worker exhausts the pool and heartbeats time out, so every job is requeued" failure.
    // Publish takes a second connection for the duration of its transaction, so the compile
    // slots are counted twice.
    max: intEnv('WORKER_CONCURRENCY', 4) * 2 + 2,
    application_name: 'resscript-worker',
  });
  return {
    store: new PgJobStore(pool as unknown as SqlClient),
    backend: 'postgres',
    pool: pool as unknown as PoolLike,
  };
}

/**
 * The `compile` job's environment, or nothing.
 *
 * `ARTIFACT_DIR` and not a Supabase bucket: `artifact-store.ts`'s header says why the shipped
 * implementation is a filesystem tree and where the Supabase adapter plugs in. A deployment that
 * wants the bucket constructs its client here and passes `client.storage.from(bucket)` to
 * `SupabaseArtifactStore`; that is the only line that changes, and it is deliberately not written
 * against an SDK this app does not depend on.
 */
function createCompileEnvironment(pool: PoolLike | null): CompileEnvironment | undefined {
  if (pool === null) return undefined;
  return {
    store: new PgPublishStore(poolSessions(pool)),
    artifacts: new FsArtifactStore(env('ARTIFACT_DIR') ?? '/var/lib/resscript/artifacts'),
    // No entitlements and no theme: `billing` holds no plans table yet and the theme compiler is
    // P2-12. `CompileInput` distinguishes "no plan to check" from "a plan granting nothing", so
    // omitting it skips the check instead of failing every survey. See `kinds/compile.ts`.
  };
}

/**
 * The `export` job's environment, or nothing.
 *
 * `EXPORT_DIR` is where the CSVs land — a local directory, because object storage is not stood
 * up in this deployment (artifact-store.ts's header); `app.exports.storage_key` records a
 * RELATIVE key so the P5-02 move to a bucket with signed URLs replaces the sink and touches no
 * row. `ARTIFACT_DIR` must be the SAME store the compile job publishes into: the export's
 * column contract is read from the artifact the version names (ADR-002's content addressing is
 * what makes "same" checkable — a wrong directory is a missing hash, never wrong columns).
 */
function createExportEnvironment(pool: PoolLike | null): ExportEnvironment | undefined {
  if (pool === null) return undefined;
  return {
    store: new PgExportStore(poolSessions(pool)),
    artifacts: new FsArtifactStore(env('ARTIFACT_DIR') ?? '/var/lib/resscript/artifacts'),
    sink: new FsExportSink(env('EXPORT_DIR') ?? '/var/lib/resscript/exports'),
  };
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

  const { store, backend, pool } = await createStore();
  const compile = createCompileEnvironment(pool);
  const exportEnv = createExportEnvironment(pool);
  const registry = buildRegistry({
    ...(compile === undefined ? {} : { compile }),
    ...(exportEnv === undefined ? {} : { export: exportEnv }),
  });

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
