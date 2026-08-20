/**
 * The job-queue contract.
 *
 * ============================================================================================
 * THE SQL CONTRACT THIS FILE CONSUMES
 * ============================================================================================
 *
 * `ops.jobs` (DB §10.1) is the durable, user-visible record of work a user pressed a button
 * for — not a second queue. The queue itself is pgmq. Everything the worker needs is behind six
 * `SECURITY DEFINER` functions, so the worker role needs `EXECUTE` on those and nothing else:
 *
 *   ops.enqueue_job(
 *     p_kind             text,
 *     p_payload          jsonb,
 *     p_idempotency_key  text     DEFAULT NULL,
 *     p_org_id           app.ulid DEFAULT NULL,
 *     p_project_id       app.ulid DEFAULT NULL,
 *     p_survey_version_id app.ulid DEFAULT NULL,
 *     p_max_attempts     int      DEFAULT 3
 *   ) RETURNS TABLE (id app.ulid, created boolean)
 *     -- Inserts one row, ON CONFLICT ON CONSTRAINT jobs_idem_key DO NOTHING, then selects the
 *     -- winner. `created` tells the caller whether this call or an earlier one made the row,
 *     -- which is what lets the API answer a double-clicked Publish with the RUNNING job's id
 *     -- (roadmap M0.4: "Double-clicking the trigger produces exactly one job row").
 *
 *   ops.claim_job(p_worker_id text, p_kinds text[])
 *     RETURNS SETOF ops.jobs
 *     -- SELECT ... WHERE status = 'queued' AND kind = ANY(p_kinds) AND available_at <= now()
 *     --   ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
 *     -- then UPDATE SET status='running', attempts = attempts + 1, started_at = coalesce(
 *     --   started_at, now()), heartbeat_at = now(), locked_by = p_worker_id.
 *     -- SKIP LOCKED is the whole design: N workers polling the same table never block each
 *     -- other and never claim the same row.
 *
 *   ops.heartbeat_job(p_id app.ulid, p_worker_id text, p_progress jsonb DEFAULT NULL)
 *     RETURNS boolean
 *     -- UPDATE ... SET heartbeat_at = now(), progress = coalesce(p_progress, progress)
 *     --   WHERE id = p_id AND status = 'running' AND locked_by = p_worker_id
 *     -- Returns false when the row is no longer OURS, which is how a worker learns its job
 *     -- was requeued underneath it (see JobStore.heartbeat below).
 *
 *   ops.complete_job(p_id app.ulid, p_worker_id text, p_result jsonb) RETURNS boolean
 *     -- UPDATE ... SET status='succeeded', result=p_result, finished_at=now()
 *     --   WHERE id = p_id AND status='running' AND locked_by = p_worker_id
 *     -- Returns false when the guard did not match, i.e. we no longer own this job.
 *
 *   ops.fail_job(p_id app.ulid, p_worker_id text, p_error jsonb, p_retryable boolean,
 *                p_retry_after_ms int DEFAULT 0) RETURNS text
 *     -- Guarded by the same `status='running' AND locked_by = p_worker_id` predicate.
 *     -- If p_retryable AND attempts < max_attempts: status='queued',
 *     --   available_at = now() + (p_retry_after_ms || ' milliseconds')::interval.
 *     -- Else: status='failed', error=p_error, finished_at=now().
 *     -- Returns the resulting status, or 'not_owner' when the guard did not match.
 *
 *   ops.requeue_stalled_jobs(p_stalled_after interval) RETURNS int
 *     -- UPDATE ops.jobs SET status='queued', locked_by=NULL
 *     --   WHERE status='running' AND heartbeat_at < now() - p_stalled_after
 *     -- Driven by `jobs_stalled_idx` (DB §10.1). Returns the number requeued.
 *     -- Note it does NOT increment attempts: the claim did that already, so a worker that is
 *     -- OOM-killed on every attempt still exhausts max_attempts rather than looping forever.
 *
 * TWO DEVIATIONS FROM DB §10.1 AS WRITTEN, both required by M0.4's own acceptance criteria:
 *
 *  1. `available_at timestamptz NOT NULL DEFAULT now()` — a not-before marker. `ops.jobs` as
 *     specified has no such column, and without one "retry with backoff" (M0.4 Backend) cannot
 *     be expressed: a failed job set back to 'queued' is immediately re-claimable, so three
 *     attempts burn in under a second and the backoff is a no-op. The alternative is to hold
 *     the delay in pgmq's visibility timeout, which works but makes `ops.jobs` unable to answer
 *     "when will this retry" — a question the studio's job-status component needs.
 *  2. `locked_by text` — the claiming worker id, and a `status='running' AND locked_by = $worker`
 *     guard on `heartbeat_job`, `complete_job` and `fail_job`. This is NOT a nice-to-have. Without
 *     it, consider: worker A claims a job and hangs; the stalled sweeper requeues it; worker B
 *     claims and completes it; worker A then wakes up and calls `complete_job` with ITS result,
 *     silently overwriting B's. Nothing about `status` alone detects that — the row is 'running'
 *     or 'succeeded' either way. Making the write a compare-and-set on `locked_by` is the only
 *     place that race can be closed atomically, and it must be in SQL rather than in the worker
 *     because the two workers are different processes.
 *
 * `MemoryJobStore` implements both faithfully so the harness tests exercise the same semantics
 * the SQL will have. See `memory-job-store.ts`.
 * ============================================================================================
 */

import type { JsonObject, JsonValue } from './json.js';

/** `ops.jobs.status` CHECK constraint, verbatim (DB §10.1). */
export const JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

export function isJobStatus(v: string): v is JobStatus {
  return (JOB_STATUSES as readonly string[]).includes(v);
}

/**
 * One `ops.jobs` row.
 *
 * Field names are snake_case to match the column names exactly. The temptation to camelCase
 * them at the store boundary is worth resisting: every one of these appears in a `pg_prove`
 * assertion, a jsonb path and a studio API response, and one mapping layer per hop is one
 * place for `survey_version_id` to become `surveyVersionID`.
 */
export interface JobRow {
  readonly id: string;
  readonly org_id: string | null;
  readonly project_id: string | null;
  readonly survey_version_id: string | null;
  readonly kind: string;
  readonly status: JobStatus;
  readonly idempotency_key: string | null;
  readonly payload: JsonObject;
  readonly progress: JsonObject;
  readonly result: JsonValue | null;
  readonly error: JsonObject | null;
  readonly attempts: number;
  readonly max_attempts: number;
  readonly queue_msg_id: number | null;
  readonly created_by: string | null;
  readonly created_at: Date;
  readonly started_at: Date | null;
  readonly finished_at: Date | null;
  readonly heartbeat_at: Date | null;
  /** Deviation 1 above: the not-before marker that makes backoff real. */
  readonly available_at: Date;
  /** Deviation 2 above: the worker id holding this job. */
  readonly locked_by: string | null;
}

export interface EnqueueInput {
  readonly kind: string;
  readonly payload: JsonObject;
  /**
   * The de-duplication handle. Unique per `(kind, idempotency_key)` — DB §10.1's
   * `jobs_idem_key` partial index — so "publish survey version X" is naturally idempotent.
   */
  readonly idempotencyKey?: string | undefined;
  readonly orgId?: string | undefined;
  readonly projectId?: string | undefined;
  readonly surveyVersionId?: string | undefined;
  readonly createdBy?: string | undefined;
  readonly maxAttempts?: number | undefined;
  /** Delay before the job becomes claimable. Used by the retry path, and by scheduled work. */
  readonly delayMs?: number | undefined;
}

export interface EnqueueResult {
  readonly id: string;
  /**
   * False when an existing row with the same `(kind, idempotency_key)` was returned instead of
   * a new one. The API turns this into "here is your already-running publish job" rather than
   * a second compile.
   */
  readonly created: boolean;
}

/** Shape written to `ops.jobs.error`. Matches `AppError.toJSON()` from @resscript/observability. */
export interface JobErrorRecord extends JsonObject {
  readonly code: string;
  readonly message: string;
}

/**
 * The result of `ops.fail_job`: back in the queue, finished, or "you do not own this job any
 * more, so nothing was written".
 */
export type FailOutcome = 'requeued' | 'failed' | 'not_owner';

/**
 * The store abstraction.
 *
 * TWO implementations, on purpose:
 *  - `PgJobStore` calls the SQL functions above. It is the production path.
 *  - `MemoryJobStore` reimplements the same semantics in process. It is not a mock: it enforces
 *    single-claim, idempotency keys, attempt counting, backoff and the stalled sweep, so the
 *    consumer-loop tests assert real behaviour and run in milliseconds with no database.
 *
 * The reason this interface exists at all is that `db/migrations` is being written concurrently
 * by another agent. Coding the harness against an interface means the harness is finished,
 * tested and reviewable before the SQL lands, and integrating is one file.
 */
export interface JobStore {
  /** `ops.enqueue_job`. Idempotent on `(kind, idempotencyKey)`. */
  enqueue(input: EnqueueInput): Promise<EnqueueResult>;

  /**
   * `ops.claim_job`. Returns at most one job and marks it running, incrementing `attempts`.
   * Returns `null` when nothing is claimable.
   */
  claim(workerId: string, kinds: readonly string[]): Promise<JobRow | null>;

  /**
   * `ops.heartbeat_job`, optionally writing progress in the same statement.
   *
   * Returns `false` when the row is no longer ours — the stalled sweeper requeued it and
   * another worker may already own it. The consumer treats that as a signal to ABANDON the
   * in-flight job rather than completing it, because two workers writing `complete_job` for the
   * same id is how a job's `result` becomes non-deterministic.
   */
  heartbeat(id: string, workerId: string, progress?: JsonObject): Promise<boolean>;

  /**
   * `ops.complete_job`. Returns false when we no longer own the job, in which case the result
   * was NOT written — the caller must discard it rather than retrying, because another worker
   * owns the job and its result is the authoritative one.
   */
  complete(id: string, workerId: string, result: JsonValue): Promise<boolean>;

  /** `ops.fail_job`. Returns which branch was taken so the caller can log it. */
  fail(
    id: string,
    workerId: string,
    error: JobErrorRecord,
    retryable: boolean,
    retryAfterMs?: number,
  ): Promise<FailOutcome>;

  /** `ops.requeue_stalled_jobs`. Returns how many rows were requeued. */
  requeueStalled(stalledAfterMs: number): Promise<number>;

  /** A plain read, for the studio's job-status endpoint and for tests. */
  get(id: string): Promise<JobRow | null>;

  /** Cheap liveness probe for `/ready`. `SELECT 1` against Postgres; trivially true in memory. */
  ping(): Promise<boolean>;

  close(): Promise<void>;
}

/**
 * The progress shape written to `ops.jobs.progress`.
 *
 * Fixed here rather than left to each handler because the studio's job-status component
 * (roadmap M0.4 Frontend) renders "step N of M" off these exact keys. A handler that invents
 * `{ done: 3, outOf: 7 }` is a component that renders nothing.
 */
export interface JobProgress extends JsonObject {
  readonly step: number;
  readonly total: number;
  readonly message: string;
  /** ISO-8601. Lets the UI show staleness without a second column. */
  readonly updated_at: string;
}

export function makeProgress(
  step: number,
  total: number,
  message: string,
  at: Date = new Date(),
): JobProgress {
  return { step, total, message, updated_at: at.toISOString() };
}

/**
 * Exponential backoff with full jitter.
 *
 * Jitter is not decoration: without it, N workers that all failed on the same downstream outage
 * retry in lockstep and re-create the thundering herd that caused the outage. "Full jitter"
 * (random between 0 and the cap) is the variant that minimises contention.
 *
 * `attempt` is 1-based — the number of attempts already made.
 */
export function defaultBackoffMs(
  attempt: number,
  opts: { baseMs?: number; maxMs?: number; random?: () => number } = {},
): number {
  const base = opts.baseMs ?? 1_000;
  const max = opts.maxMs ?? 60_000;
  const random = opts.random ?? Math.random;
  const cap = Math.min(max, base * 2 ** Math.max(0, attempt - 1));
  return Math.floor(random() * cap);
}
