/**
 * The consumer loop.
 *
 * One `Consumer` owns N concurrent "slots"; each slot loops: claim → run → heartbeat →
 * complete/fail. On top of that sit two process-wide timers: a heartbeat tick for in-flight
 * jobs, and the stalled sweeper.
 *
 * The three properties worth stating up front, because each one is a real failure the design
 * is chosen to avoid:
 *
 *  1. GRACEFUL DRAIN. On SIGTERM the consumer stops CLAIMING immediately and lets in-flight
 *     jobs finish. Dropping an in-flight job on deploy is the version of this failure that
 *     matters: `compile` is what "Publish" enqueued, and a publish that vanishes because a pod
 *     rolled is indistinguishable from a broken product. The exit code is 0 for a clean drain
 *     and non-zero only when the drain itself failed or timed out.
 *  2. LOST-OWNERSHIP DETECTION. Every write is a compare-and-set on
 *     `(status='running', locked_by=this worker)`. If the stalled sweeper requeued a job while we
 *     were running it, `complete` returns false and the handler's result is DISCARDED rather than
 *     written. Without this, worker A hangs, the sweeper requeues, worker B finishes the job, and
 *     A then wakes up and overwrites B's result — a corruption no status check alone can detect.
 *  3. ONE SPAN TREE. Each job runs inside `withActiveSpan`, parented to the `traceparent` the
 *     enqueuer stored in the payload. That is what makes M0.4's acceptance criterion —
 *     "a request_id from the studio HTTP log … retrieve the full studio → queue → worker span
 *     tree" — true across a non-HTTP hop.
 *
 * Note on metrics: this file emits NO metrics. The M0.4 vocabulary is closed (see
 * `@resscript/observability`'s METRICS) and contains no job-queue metric. Inventing
 * `worker.job.duration` here is exactly what the fixed vocabulary exists to prevent; when
 * queue metrics are wanted they get added to the registry in a review, not here.
 */

import {
  AppError,
  createLogger,
  type Logger,
  nullLogger,
  startSpan,
} from '@resscript/observability';
import { runWithContext, withActiveSpan } from '@resscript/observability/node';

import {
  defaultBackoffMs,
  makeProgress,
  type FailOutcome,
  type JobErrorRecord,
  type JobRow,
  type JobStore,
} from './job-store.js';
import { asJsonObject, type JsonObject, type JsonValue } from './json.js';
import type { ErasedJobDefinition, JobContext, JobRegistry, PayloadMap } from './registry.js';

/**
 * The correlation keys carried inside `ops.jobs.payload`.
 *
 * The queue hop is not HTTP, so there are no headers. Rather than invent a second propagation
 * format, the enqueuer writes the same three values under reserved `_` keys and the worker
 * parses them with the same functions. Underscore-prefixed so they cannot collide with a
 * handler's own fields.
 */
export const CORRELATION_KEYS = {
  requestId: '_request_id',
  traceparent: '_traceparent',
  orgId: '_org_id',
} as const;

/** Merge correlation into a payload at enqueue time. Called by the API and by the studio. */
export function withCorrelation(
  payload: JsonObject,
  correlation: { requestId?: string; traceparent?: string; orgId?: string },
): JsonObject {
  const out: JsonObject = { ...payload };
  if (correlation.requestId !== undefined) out[CORRELATION_KEYS.requestId] = correlation.requestId;
  if (correlation.traceparent !== undefined) {
    out[CORRELATION_KEYS.traceparent] = correlation.traceparent;
  }
  if (correlation.orgId !== undefined) out[CORRELATION_KEYS.orgId] = correlation.orgId;
  return out;
}

function readCorrelation(payload: JsonObject): {
  requestId: string | undefined;
  traceparent: string | undefined;
  orgId: string | undefined;
} {
  const str = (k: string): string | undefined => {
    const v = payload[k];
    return typeof v === 'string' ? v : undefined;
  };
  return {
    requestId: str(CORRELATION_KEYS.requestId),
    traceparent: str(CORRELATION_KEYS.traceparent),
    orgId: str(CORRELATION_KEYS.orgId),
  };
}

export interface ConsumerOptions<M extends PayloadMap> {
  readonly store: JobStore;
  readonly registry: JobRegistry<M>;
  /** Identifies this process in `ops.jobs.locked_by`. Defaults to `worker-<pid>-<rand>`. */
  readonly workerId?: string;
  /** Restrict to a subset of registered kinds. Defaults to all of them. */
  readonly kinds?: readonly string[];
  /** Max jobs in flight in this process. Defaults to 4. */
  readonly concurrency?: number;
  /** Sleep between empty claims. Defaults to 200 ms. */
  readonly pollIntervalMs?: number;
  /** How often to write heartbeats. Must be well under `stalledAfterMs`. Defaults to 5 s. */
  readonly heartbeatIntervalMs?: number;
  /** Silence after which a running job is considered dead. Defaults to 30 s. */
  readonly stalledAfterMs?: number;
  /** How often this process runs the stalled sweep. Defaults to 10 s. `0` disables it. */
  readonly sweepIntervalMs?: number;
  /** Backoff for a retryable failure, given the number of attempts already made. */
  readonly backoffMs?: (attempt: number) => number;
  /** How long `drain()` waits for in-flight jobs before aborting them. Defaults to 25 s. */
  readonly drainTimeoutMs?: number;
  readonly logger?: Logger;
  /**
   * Deployable name stamped on every span. Passed explicitly rather than relying on
   * `setTracerService`, so a span is attributed correctly even in an entry point (a test, a
   * one-shot CLI) that never called it.
   */
  readonly service?: string;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface ConsumerStats {
  readonly claimed: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly requeued: number;
  readonly abandoned: number;
  readonly stalledRequeued: number;
  readonly inFlight: number;
}

interface InFlight {
  readonly job: JobRow;
  readonly controller: AbortController;
  /** Latest progress, flushed by the next heartbeat. Mutable by design. */
  progress: JsonObject | undefined;
  /** Epoch ms of the last progress write to the store, for the coalescing throttle. */
  lastProgressFlush: number;
  /** Set when a heartbeat reports the row is no longer ours. */
  lostOwnership: boolean;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    // Do not hold the event loop open for a poll interval during shutdown.
    if (typeof t === 'object' && 'unref' in t) t.unref();
  });
}

export class Consumer<M extends PayloadMap = PayloadMap> {
  private readonly store: JobStore;
  private readonly registry: JobRegistry<M>;
  private readonly kinds: readonly string[];
  private readonly concurrency: number;
  private readonly pollIntervalMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly stalledAfterMs: number;
  private readonly sweepIntervalMs: number;
  private readonly backoffMs: (attempt: number) => number;
  private readonly drainTimeoutMs: number;
  private readonly log: Logger;
  private readonly service: string;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  readonly workerId: string;

  private running = false;
  private draining = false;
  private slots: Promise<void>[] = [];
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private sweepTimer: ReturnType<typeof setInterval> | undefined;
  private readonly inFlight = new Map<string, InFlight>();

  private counters = {
    claimed: 0,
    succeeded: 0,
    failed: 0,
    requeued: 0,
    abandoned: 0,
    stalledRequeued: 0,
  };

  constructor(options: ConsumerOptions<M>) {
    this.store = options.store;
    this.registry = options.registry;
    this.kinds = options.kinds ?? options.registry.kinds();
    this.concurrency = Math.max(1, options.concurrency ?? 4);
    this.pollIntervalMs = options.pollIntervalMs ?? 200;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 5_000;
    this.stalledAfterMs = options.stalledAfterMs ?? 30_000;
    this.sweepIntervalMs = options.sweepIntervalMs ?? 10_000;
    this.backoffMs = options.backoffMs ?? ((attempt) => defaultBackoffMs(attempt));
    this.drainTimeoutMs = options.drainTimeoutMs ?? 25_000;
    this.log = options.logger ?? nullLogger('worker');
    this.service = options.service ?? 'worker';
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? defaultSleep;
    this.workerId =
      options.workerId ??
      `worker-${String(globalThis.process?.pid ?? 0)}-${Math.random().toString(36).slice(2, 8)}`;

    if (this.heartbeatIntervalMs >= this.stalledAfterMs) {
      // A heartbeat slower than the stall deadline requeues every healthy job. Catching this
      // at construction is the difference between a config typo and a queue that duplicates
      // every long job in production.
      throw new Error(
        `heartbeatIntervalMs (${this.heartbeatIntervalMs}) must be < stalledAfterMs (${this.stalledAfterMs})`,
      );
    }
    if (this.kinds.length === 0) {
      throw new Error('consumer has no job kinds to claim; register at least one handler');
    }
  }

  stats(): ConsumerStats {
    return { ...this.counters, inFlight: this.inFlight.size };
  }

  get isRunning(): boolean {
    return this.running;
  }

  get isDraining(): boolean {
    return this.draining;
  }

  /** Start the slots and the timers. Returns immediately; the loops run in the background. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.draining = false;

    this.heartbeatTimer = setInterval(() => {
      void this.tickHeartbeats();
    }, this.heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();

    if (this.sweepIntervalMs > 0) {
      this.sweepTimer = setInterval(() => {
        void this.tickSweep();
      }, this.sweepIntervalMs);
      this.sweepTimer.unref?.();
    }

    this.slots = Array.from({ length: this.concurrency }, (_unused, i) => this.slotLoop(i));
    this.log.info('worker_started', {
      worker_id: this.workerId,
      kinds: [...this.kinds],
      concurrency: this.concurrency,
    });
  }

  /**
   * Graceful shutdown: stop claiming, let in-flight jobs finish, then stop the timers.
   *
   * Resolves `{ drained: true }` when every in-flight job reached a terminal state, and
   * `{ drained: false }` when the timeout fired and jobs were aborted — the caller turns that
   * into a non-zero exit code, because an aborted job is a job the queue will have to requeue
   * via the stalled sweeper, and that is worth alerting on.
   */
  async drain(): Promise<{ drained: boolean; aborted: number }> {
    if (!this.running) return { drained: true, aborted: 0 };
    this.draining = true;
    this.log.info('worker_draining', {
      worker_id: this.workerId,
      in_flight: this.inFlight.size,
    });

    const timedOut = await Promise.race([
      Promise.all(this.slots).then(() => false),
      this.sleep(this.drainTimeoutMs).then(() => true),
    ]);

    let aborted = 0;
    if (timedOut) {
      // Past the grace period: signal the handlers. A well-behaved handler checks
      // `ctx.signal` between batches; one that does not will be requeued by the sweeper.
      for (const entry of this.inFlight.values()) {
        entry.controller.abort();
        aborted += 1;
      }
      this.log.warn('worker_drain_timeout', {
        worker_id: this.workerId,
        aborted,
        drain_timeout_ms: this.drainTimeoutMs,
      });
      await Promise.allSettled(this.slots);
    }

    this.running = false;
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer);
    if (this.sweepTimer !== undefined) clearInterval(this.sweepTimer);
    this.heartbeatTimer = undefined;
    this.sweepTimer = undefined;

    // One last heartbeat flush, so the final progress a handler reported is durable and the
    // studio's job view does not sit at "step 6 of 7" for a job that finished.
    await this.tickHeartbeats();

    this.log.info('worker_drained', {
      worker_id: this.workerId,
      ...this.stats(),
      drained: !timedOut,
    });
    return { drained: !timedOut, aborted };
  }

  /**
   * Run until the queue has nothing claimable, then stop. For tests and for a one-shot CLI
   * invocation (`worker --once`), which is how a CI smoke test exercises a real job.
   */
  async runUntilIdle(maxIterations = 10_000): Promise<void> {
    this.running = true;
    this.draining = false;
    for (let i = 0; i < maxIterations; i += 1) {
      const job = await this.claimOne();
      if (job === null) break;
      await this.runJob(job);
    }
    this.running = false;
  }

  /** One sweep, on demand. Exposed so a test can drive the sweeper without waiting on a timer. */
  async sweepStalled(): Promise<number> {
    return this.tickSweep();
  }

  /** One heartbeat flush, on demand. */
  async flushHeartbeats(): Promise<void> {
    await this.tickHeartbeats();
  }

  // ---------------------------------------------------------------------------------------

  private async slotLoop(slot: number): Promise<void> {
    while (this.running && !this.draining) {
      let job: JobRow | null = null;
      try {
        job = await this.claimOne();
      } catch (err: unknown) {
        // A store error must not kill the slot: Postgres restarts, and a worker that exits on
        // the first `ECONNRESET` turns a 2-second failover into a manual restart.
        this.log.error('claim_failed', { slot, err: AppError.from(err).toJSON() });
        await this.sleep(this.pollIntervalMs);
        continue;
      }

      if (job === null) {
        await this.sleep(this.pollIntervalMs);
        continue;
      }
      await this.runJob(job);
    }
  }

  private async claimOne(): Promise<JobRow | null> {
    if (this.draining) return null;
    const job = await this.store.claim(this.workerId, this.kinds);
    if (job !== null) this.counters.claimed += 1;
    return job;
  }

  private async runJob(job: JobRow): Promise<void> {
    const def = this.registry.get(job.kind);
    if (def === undefined) {
      // Claimed a kind we cannot handle. Not retryable — retrying will not teach this process
      // a new handler — and worth an error line, because it means `kinds` and the registry
      // disagree, or a deploy removed a handler that still has queued work.
      await this.finishFailure(
        job,
        new AppError('malformed_request', `no handler registered for job kind ${job.kind}`, {
          retryable: false,
          context: { kind: job.kind },
        }),
        this.log,
      );
      return;
    }

    const correlation = readCorrelation(job.payload);
    const log = this.log.child({
      job_id: job.id,
      kind: job.kind,
      attempt: job.attempts,
      worker_id: this.workerId,
    });

    const controller = new AbortController();
    const entry: InFlight = {
      job,
      controller,
      progress: undefined,
      lastProgressFlush: 0,
      lostOwnership: false,
    };
    this.inFlight.set(job.id, entry);

    // The correlation context: every log line and span inside the handler inherits the request
    // id the user's click created, hops ago and in another process.
    const context = {
      ...(correlation.requestId === undefined ? {} : { requestId: correlation.requestId }),
      ...(correlation.orgId === undefined ? {} : { orgId: correlation.orgId }),
    };

    try {
      await runWithContext(context, async () =>
        withActiveSpan(
          `job.${job.kind}`,
          {
            kind: 'consumer',
            service: this.service,
            // The queue hop, joined. `parent` is undefined for a job enqueued without
            // correlation, which starts a fresh trace rather than failing.
            ...(correlation.traceparent === undefined ? { root: true } : { parent: correlation.traceparent }),
            attributes: {
              'job.id': job.id,
              'job.kind': job.kind,
              'job.attempt': job.attempts,
              'job.max_attempts': job.max_attempts,
              ...(job.org_id === null ? {} : { 'org.id': job.org_id }),
              ...(job.survey_version_id === null
                ? {}
                : { 'survey.version_id': job.survey_version_id }),
            },
          },
          async () => this.executeHandler(job, def, entry, log),
        ),
      );
    } finally {
      this.inFlight.delete(job.id);
    }
  }

  private async executeHandler(
    job: JobRow,
    def: ErasedJobDefinition,
    entry: InFlight,
    log: Logger,
  ): Promise<void> {
    log.info('job_started', { payload_keys: Object.keys(job.payload) });

    let parsed: unknown;
    try {
      parsed = def.parse(asJsonObject(job.payload));
    } catch (err: unknown) {
      // A payload this deploy cannot read will not become readable on retry.
      await this.finishFailure(
        job,
        new AppError('malformed_request', `invalid payload for ${job.kind}`, {
          retryable: false,
          cause: err,
          context: { reason: err instanceof Error ? err.message : String(err) },
        }),
        log,
      );
      return;
    }

    const ctx: JobContext<unknown> = {
      job,
      payload: parsed,
      attempt: job.attempts,
      maxAttempts: job.max_attempts,
      log,
      signal: entry.controller.signal,
      progress: async (step, total, message = '') => {
        const nowMs = this.now();
        entry.progress = makeProgress(step, total, message, new Date(nowMs));
        log.debug('job_progress', { step, total, message });

        // COALESCING. A projection or export handler may report progress thousands of times;
        // one UPDATE each would make progress reporting more expensive than the work. So the
        // value is always stashed (the heartbeat tick will carry it) and written through only
        // when it matters:
        //   - the FIRST step, so the studio's spinner becomes "step 1 of N" immediately rather
        //     than after a heartbeat interval of apparent nothing;
        //   - the LAST step, so a job that finishes between ticks does not leave the UI showing
        //     "step 6 of 7" forever;
        //   - otherwise at most once per heartbeat interval.
        const isFirst = entry.lastProgressFlush === 0;
        const isLast = step >= total;
        const due = nowMs - entry.lastProgressFlush >= this.heartbeatIntervalMs;
        if (!isFirst && !isLast && !due) return;

        entry.lastProgressFlush = nowMs;
        const alive = await this.store.heartbeat(job.id, this.workerId, entry.progress);
        if (!alive) entry.lostOwnership = true;
      },
    };

    const startedAt = this.now();
    let result: JsonValue;
    try {
      result = await def.handle(ctx);
    } catch (err: unknown) {
      const appError = AppError.from(err, `job ${job.kind} failed`);
      // An unknown throw is retryable by default (most job failures are transient); an
      // AppError's own `retryable` always wins, because the handler knows more than we do.
      const retryable = AppError.isAppError(err) ? err.retryable : def.retryUnknownErrors;
      startSpan('job.failure', { attributes: { 'error.code': appError.code } }).end();
      await this.finishFailure(job, appError, log, retryable);
      return;
    }

    const durationMs = this.now() - startedAt;

    // `complete` is a compare-and-set on (status='running', locked_by=us). It returns false when
    // the stalled sweeper requeued the job and another worker took it — in which case OUR result
    // is stale and must be discarded rather than written over theirs. The `lostOwnership` flag
    // from the heartbeat is a fast path for the same condition; the store's return value is the
    // authoritative check, because ownership can change in the window after the last heartbeat.
    const wrote = entry.lostOwnership
      ? false
      : await this.store.complete(job.id, this.workerId, result);

    if (!wrote) {
      this.counters.abandoned += 1;
      log.warn('job_abandoned_lost_ownership', { duration_ms: durationMs });
      return;
    }

    this.counters.succeeded += 1;
    log.info('job_succeeded', { duration_ms: durationMs });
  }

  private async finishFailure(
    job: JobRow,
    error: AppError,
    log: Logger,
    retryableOverride?: boolean,
  ): Promise<void> {
    const retryable = retryableOverride ?? error.retryable;
    const record: JobErrorRecord = {
      ...(error.toJSON() as JsonObject),
      code: error.code,
      message: error.message,
    };
    const retryAfterMs = retryable ? this.backoffMs(job.attempts) : 0;

    let outcome: FailOutcome;
    try {
      outcome = await this.store.fail(job.id, this.workerId, record, retryable, retryAfterMs);
    } catch (err: unknown) {
      // We cannot record the failure. The job stays 'running' with a stale heartbeat and the
      // stalled sweeper will pick it up, which is exactly the right fallback — but it must be
      // loud, because it means the store is unhealthy.
      log.error('job_fail_write_failed', {
        err: AppError.from(err).toJSON(),
        original_error: record,
      });
      return;
    }

    switch (outcome) {
      case 'requeued':
        this.counters.requeued += 1;
        log.warn('job_retry_scheduled', {
          err: record,
          retry_after_ms: retryAfterMs,
          attempts_remaining: job.max_attempts - job.attempts,
        });
        return;
      case 'failed':
        this.counters.failed += 1;
        log.error('job_failed', { err: record, attempts: job.attempts });
        return;
      case 'not_owner':
        // Someone else owns this job now, so the failure is theirs to record. Counting it as
        // abandoned rather than failed keeps the failure count honest.
        this.counters.abandoned += 1;
        log.warn('job_abandoned_lost_ownership', { err: record, phase: 'fail' });
        return;
      default: {
        const exhaustive: never = outcome;
        throw new Error(`unhandled fail outcome: ${String(exhaustive)}`);
      }
    }
  }

  private async tickHeartbeats(): Promise<void> {
    const entries = [...this.inFlight.values()];
    await Promise.all(
      entries.map(async (entry) => {
        try {
          const alive = await this.store.heartbeat(entry.job.id, this.workerId, entry.progress);
          if (!alive) {
            entry.lostOwnership = true;
            this.log.warn('heartbeat_lost_ownership', {
              job_id: entry.job.id,
              kind: entry.job.kind,
            });
          }
        } catch (err: unknown) {
          // A missed heartbeat is survivable: the next tick may succeed, and the stall
          // deadline is several ticks wide precisely so one failure is not fatal.
          this.log.warn('heartbeat_failed', {
            job_id: entry.job.id,
            err: AppError.from(err).toJSON(),
          });
        }
      }),
    );
  }

  private async tickSweep(): Promise<number> {
    try {
      const n = await this.store.requeueStalled(this.stalledAfterMs);
      if (n > 0) {
        this.counters.stalledRequeued += n;
        this.log.warn('stalled_jobs_requeued', { count: n, stalled_after_ms: this.stalledAfterMs });
      }
      return n;
    } catch (err: unknown) {
      this.log.error('stalled_sweep_failed', { err: AppError.from(err).toJSON() });
      return 0;
    }
  }
}

/** Convenience factory that also builds the worker's logger. */
export function createConsumer<M extends PayloadMap>(
  options: ConsumerOptions<M> & { readonly service?: string },
): Consumer<M> {
  const logger =
    options.logger ??
    createLogger({
      service: options.service ?? 'worker',
      bindings: { deployable: 'worker' },
    });
  return new Consumer({ ...options, logger });
}
