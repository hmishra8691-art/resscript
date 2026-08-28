/**
 * The worker's HTTP surface: `/health` and `/ready`, and nothing else.
 *
 * `node:http` with no framework, matching `apps/runtime`'s server. A background worker needs
 * two endpoints; adding Express for them would put a dependency tree on the deploy critical
 * path for zero benefit.
 *
 * The distinction between the two probes is the whole point and is routinely collapsed:
 *
 *  - `/health` is LIVENESS. "Is this process wedged?" A 200 means the event loop turns. It must
 *    NOT check the database, because when Postgres has a 30-second failover a database-checking
 *    liveness probe restarts every worker pod — turning a recoverable blip into a cold start of
 *    the whole fleet, with the in-flight jobs dropped.
 *  - `/ready` is READINESS. "Should this process be given work / counted as up?" It checks the
 *    store and reports draining state, so a rolling deploy stops routing to a draining pod.
 *
 * A draining worker answers `/health` 200 and `/ready` 503: it is alive and finishing its job,
 * and it must not be handed more.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { createLogger, requestIdFrom, type Logger } from '@resscript/observability';

import type { Consumer } from './consumer.js';
import type { JobStore } from './job-store.js';
import type { PayloadMap } from './registry.js';

export interface HealthServerOptions {
  readonly store: JobStore;
  readonly consumer: Consumer<PayloadMap>;
  readonly port?: number;
  readonly logger?: Logger;
  /** Reported in the payload so a smoke test can tell one deploy from another. */
  readonly version?: string;
}

export interface ReadinessReport {
  readonly ready: boolean;
  readonly checks: Record<string, string>;
}

export async function readiness(
  store: JobStore,
  consumer: Consumer<PayloadMap>,
): Promise<ReadinessReport> {
  const checks: Record<string, string> = {};

  let storeOk = false;
  try {
    storeOk = await store.ping();
    checks['job_store'] = storeOk ? 'ok' : 'unreachable';
  } catch (err: unknown) {
    checks['job_store'] = `error: ${err instanceof Error ? err.name : 'unknown'}`;
  }

  checks['consumer'] = consumer.isDraining
    ? 'draining'
    : consumer.isRunning
      ? 'running'
      : 'stopped';

  /*
   * A worker that cannot claim is not ready, even though it pings and its loops are alive.
   *
   * The two checks above were both TRUE during a total claim outage: `SELECT 1` answered
   * (`job_store: ok`) and the slot loops were still looping (`consumer: running`), while every
   * single `ops.claim_job` call threw and no job could ever start. `/ready` returned 200
   * throughout, so nothing an orchestrator could probe reflected a worker doing zero work. See
   * `Consumer.claimIsStale` for why the signal is elapsed-time-since-last-successful-claim
   * rather than a failure count.
   *
   * Reported as its own check rather than folded into `consumer`, so the distinction an operator
   * needs — the loop is running but the queue is unreachable — survives into the probe body.
   */
  const claimStale = consumer.claimIsStale;
  // Only while the consumer is actually claiming. A `claim` value on a stopped or draining
  // worker would be answering a question nobody asked — `consumer: stopped` already says why it
  // is not ready — and "ok" there would be actively misleading.
  if (consumer.isRunning && !consumer.isDraining) checks['claim'] = claimStale ? 'stale' : 'ok';

  return {
    ready: storeOk && consumer.isRunning && !consumer.isDraining && !claimStale,
    checks,
  };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    // The worker has no browser clients at all, so lock it down rather than reasoning about it.
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
  });
  res.end(payload);
}

/** Exported separately from the server so a test can exercise it without binding a port. */
export function createHealthHandler(
  options: HealthServerOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { store, consumer } = options;
  const version = options.version ?? '0.0.0';

  return async (req, res) => {
    const requestId = requestIdFrom(req.headers);
    const path = (req.url ?? '/').split('?')[0] ?? '/';

    if (path === '/health') {
      json(res, 200, {
        status: 'ok',
        service: 'worker',
        version,
        worker_id: consumer.workerId,
        request_id: requestId,
      });
      return;
    }

    if (path === '/ready') {
      const report = await readiness(store, consumer);
      json(res, report.ready ? 200 : 503, {
        ready: report.ready,
        checks: report.checks,
        stats: consumer.stats(),
        request_id: requestId,
      });
      return;
    }

    json(res, 404, { error: { code: 'not_found' }, request_id: requestId });
  };
}

export interface HealthServer {
  readonly server: Server;
  listen(): Promise<number>;
  close(): Promise<void>;
}

export function createHealthServer(options: HealthServerOptions): HealthServer {
  const log = options.logger ?? createLogger({ service: 'worker' });
  const handler = createHealthHandler(options);
  const port = options.port ?? 8082;

  const server = createServer((req, res) => {
    void handler(req, res).catch((err: unknown) => {
      log.error('health_handler_error', { err: String(err) });
      if (!res.headersSent) json(res, 500, { error: { code: 'internal_error' } });
    });
  });

  return {
    server,
    listen: () =>
      new Promise<number>((resolve, reject) => {
        server.once('error', reject);
        // Port 0 asks the OS for a free port, which is how the tests avoid a fixed-port clash
        // when they run in parallel.
        server.listen(port, () => {
          const address = server.address();
          const actual = typeof address === 'object' && address !== null ? address.port : port;
          log.info('health_listening', { port: actual });
          resolve(actual);
        });
      }),
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
