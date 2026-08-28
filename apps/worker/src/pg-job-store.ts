/**
 * The Postgres `JobStore`: a thin translation layer over the six `ops.*` functions documented
 * at the top of `job-store.ts`.
 *
 * Two deliberate design points:
 *
 *  1. It depends on a `SqlClient` INTERFACE, not on `pg` directly. `pg`'s `Pool` satisfies it
 *     structurally, so production wiring is `new PgJobStore(new Pool({ … }))` — but a test can
 *     substitute a recording double and assert the exact function calls and argument order
 *     without a database. That matters here specifically because the SQL functions are being
 *     written concurrently by another agent: the arguments are the contract, and a test that
 *     pins them catches a mismatch the moment the migration lands.
 *  2. Every call is a single `SELECT ops.<fn>(…)`. No transactions, no multi-statement
 *     sequences, no ORM. The functions are `SECURITY DEFINER` and own their own atomicity
 *     (DB §10.1), so the worker role can be granted `EXECUTE` on exactly six functions and no
 *     table privileges at all — which is what keeps a compromised worker from reading
 *     `content.nodes` (ADR-001, security §7).
 */

import { AppError } from '@resscript/observability';

import type {
  EnqueueInput,
  EnqueueResult,
  FailOutcome,
  JobErrorRecord,
  JobRow,
  JobStatus,
  JobStore,
} from './job-store.js';
import { isJobStatus } from './job-store.js';
import { asJsonObject, isJsonObject, type JsonObject, type JsonValue } from './json.js';

/**
 * The subset of `pg.Pool`/`pg.Client` this store uses.
 *
 * Declared structurally rather than importing `pg`'s types so that this module has no
 * value-level dependency on `pg` — the only place `pg` is actually constructed is `server.ts`.
 */
export interface SqlClient {
  query<R extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: R[] }>;
  end?(): Promise<void>;
}

/**
 * The SQL text, in one place, so a migration review can diff it against the functions.
 *
 * Every call uses NAMED argument notation (`p_kinds => $1`) rather than positional. This is
 * not a style choice: the first version of this file called `ops.claim_job($1::text,
 * $2::text[])` while migration 0003 declared `claim_job(p_kinds text[], p_worker text)`, so
 * the arguments were transposed. Positionally that is a type error Postgres catches, but the
 * same class of mistake between two same-typed parameters is silent and would have shipped.
 * Named notation also means a migration can add a defaulted parameter without breaking this
 * file — which 0005 did.
 */
export const SQL = {
  // `SELECT * FROM`, not `SELECT ... AS id`. enqueue_job RETURNS TABLE(id, created), and
  // selecting it as a scalar expression yields ONE composite column whose value is the
  // literal string "(job_01…,t)" — no error, just a ULID-shaped field that is not a ULID.
  // That is the same class of silent mismatch migration 0005 exists to close.
  enqueue:
    'SELECT * FROM ops.enqueue_job(' +
    'p_kind => $1::text, p_payload => $2::jsonb, p_idempotency_key => $3::text, ' +
    'p_org_id => $4::app.ulid, p_project_id => $5::app.ulid, ' +
    'p_survey_version_id => $6::app.ulid, p_max_attempts => $7::int, ' +
    'p_delay_ms => $8::int)',
  claim: 'SELECT * FROM ops.claim_job(p_kinds => $1::text[], p_worker => $2::text)',
  heartbeat:
    'SELECT ops.heartbeat_job(p_id => $1::app.ulid, p_worker => $2::text, ' +
    'p_progress => $3::jsonb) AS alive',
  complete:
    'SELECT ops.complete_job(p_id => $1::app.ulid, p_worker => $2::text, ' +
    'p_result => $3::jsonb) AS completed',
  // 0005 returns 'queued' | 'failed' | 'not_owner'.
  //
  // FIVE parameters, not four. The comment that used to sit here said "backoff is computed in
  // SQL from attempts, so the worker no longer passes a retry delay: one place owns the
  // schedule" — and it was wrong about the schema it was describing. 0005's body is
  // `WHEN COALESCE(p_retry_after_ms, 0) > 0 THEN make_interval(...) ELSE least(power(2,
  // attempts) * interval '1 second', interval '10 minutes')`: the caller MAY override and SQL
  // owns the default. The stale comment came with a stale query string carrying only $1..$4,
  // while PgJobStore.fail below has always bound five values.
  //
  // The consequence was not a wrong delay, it was no failure record at all. Postgres rejected
  // the bind outright ("bind message supplies 5 parameters, but prepared statement requires
  // 4"), so EVERY failing job threw inside the failure path: the row stayed `running` with a
  // stale heartbeat until the stalled sweeper found it, `error` was never written, and the
  // consumer's job.compile span closed with status "ok" for a job that had failed. A deployed
  // worker would have reported healthy while silently converting every failure into a stall.
  //
  // Nothing in the unit tests could see it: they assert against a recording client that
  // accepts any number of values for any query text. See the arity test in pg-job-store.test.ts,
  // which now checks every entry in SQL against the values its caller binds.
  fail:
    'SELECT ops.fail_job(p_id => $1::app.ulid, p_worker => $2::text, ' +
    'p_error => $3::jsonb, p_retry => $4::boolean, ' +
    'p_retry_after_ms => $5::int) AS status',
  requeueStalled:
    'SELECT ops.requeue_stalled_jobs(' +
    'p_stalled_after => make_interval(secs => $1::double precision)) AS requeued',
  // Reads the table directly because the worker connects as a role that owns the queue.
  // The studio must NOT use this — it goes through ops.get_job(), which filters on
  // app.current_org() and omits the payload (migration 0005).
  get: 'SELECT * FROM ops.jobs WHERE id = $1::app.ulid',
  ping: 'SELECT 1 AS ok',
} as const;

/** Raw row shape as `pg` returns it: `jsonb` is `unknown`, `timestamptz` is `Date`. */
interface RawJobRow extends Record<string, unknown> {
  id: string;
  kind: string;
  status: string;
  attempts: string | number;
  max_attempts: string | number;
}

function asDate(v: unknown): Date | null {
  if (v instanceof Date) return v;
  if (typeof v === 'string') return new Date(v);
  return null;
}

function requireDate(v: unknown, field: string): Date {
  const d = asDate(v);
  if (d === null) throw new AppError('internal_error', `ops.jobs.${field} was null`);
  return d;
}

function asNullableString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/**
 * `bigint` and `int8` come back from `pg` as STRINGS, because a Postgres bigint does not fit in
 * a JS number. `attempts` is an `int` and is safe, but `queue_msg_id` is a `bigint` — parsing it
 * with `Number.parseInt` is correct only because pgmq message ids stay far below 2^53, and that
 * assumption is worth writing down rather than discovering.
 */
function asInt(v: unknown, fallback: number): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = Number.parseInt(v, 10);
    return Number.isNaN(n) ? fallback : n;
  }
  return fallback;
}

export function mapJobRow(raw: RawJobRow): JobRow {
  const status = raw['status'];
  if (typeof status !== 'string' || !isJobStatus(status)) {
    // A status outside the CHECK constraint means the schema and this code have diverged.
    // Failing here beats letting a `switch` fall through to a default nobody wrote.
    throw new AppError('internal_error', `unknown ops.jobs.status: ${String(status)}`, {
      context: { job_id: raw['id'], status: String(status) },
    });
  }

  return {
    id: raw['id'],
    org_id: asNullableString(raw['org_id']),
    project_id: asNullableString(raw['project_id']),
    survey_version_id: asNullableString(raw['survey_version_id']),
    kind: raw['kind'],
    status: status satisfies JobStatus,
    idempotency_key: asNullableString(raw['idempotency_key']),
    payload: asJsonObject(raw['payload']),
    progress: asJsonObject(raw['progress']),
    result: (raw['result'] ?? null) as JsonValue | null,
    error: isJsonObject(raw['error']) ? raw['error'] : null,
    attempts: asInt(raw['attempts'], 0),
    max_attempts: asInt(raw['max_attempts'], 3),
    queue_msg_id: raw['queue_msg_id'] === null || raw['queue_msg_id'] === undefined
      ? null
      : asInt(raw['queue_msg_id'], 0),
    created_by: asNullableString(raw['created_by']),
    created_at: requireDate(raw['created_at'], 'created_at'),
    started_at: asDate(raw['started_at']),
    finished_at: asDate(raw['finished_at']),
    heartbeat_at: asDate(raw['heartbeat_at']),
    // The physical column is `ops.jobs.run_after` (migration 0003). This TypeScript field is
    // named `available_at` because that is the vocabulary the JobStore contract uses; the
    // mapping is deliberate and this is the single place the two names meet.
    //
    // `run_after` is NOT NULL DEFAULT now(), but a store running against a migration that
    // predates the column returns undefined — fall back to created_at so the worker degrades
    // to "no backoff" instead of crashing. `available_at` is also accepted so that a future
    // rename in either direction does not break this mapper.
    available_at:
      asDate(raw['run_after']) ??
      asDate(raw['available_at']) ??
      requireDate(raw['created_at'], 'created_at'),
    locked_by: asNullableString(raw['locked_by']),
  };
}

export class PgJobStore implements JobStore {
  constructor(private readonly sql: SqlClient) {}

  async enqueue(input: EnqueueInput): Promise<EnqueueResult> {
    const { rows } = await this.sql.query<{ id: string; created: boolean }>(SQL.enqueue, [
      input.kind,
      JSON.stringify(input.payload),
      input.idempotencyKey ?? null,
      input.orgId ?? null,
      input.projectId ?? null,
      input.surveyVersionId ?? null,
      input.maxAttempts ?? 3,
      input.delayMs ?? 0,
    ]);
    const row = rows[0];
    if (row === undefined) {
      throw new AppError('internal_error', 'ops.enqueue_job returned no row', {
        context: { kind: input.kind },
      });
    }
    return { id: row.id, created: row.created };
  }

  async claim(workerId: string, kinds: readonly string[]): Promise<JobRow | null> {
    // Order matters and is NOT the order of this method's own parameters: SQL.claim binds
    // `p_kinds => $1::text[], p_worker => $2::text`, matching migration 0003's declaration
    // order. Passing (workerId, kinds) here sends a bare string to a text[] parameter and
    // fails with "malformed array literal" — which is how this bug was actually found, once
    // DATABASE_URL was set and the integration tests stopped skipping.
    //
    // `$1::text[]` with a JS array: node-postgres serialises an array of strings to a
    // Postgres array literal, so this is one round trip and not a generated IN-list.
    const { rows } = await this.sql.query<RawJobRow>(SQL.claim, [[...kinds], workerId]);
    const row = rows[0];
    if (row === undefined) return null;

    // An empty queue does NOT come back as zero rows. `ops.claim_job` is declared
    // `RETURNS ops.jobs` — a single composite, not SETOF — and returns a NULL composite when
    // nothing was claimable. `SELECT * FROM f()` expands that composite into columns, so
    // Postgres hands back exactly ONE row with every column NULL. 0005's body says so in as
    // many words: "all-NULL composite when the queue is empty; callers check .id IS NULL".
    // This caller did not check, so mapJobRow — correctly strict about a status outside the
    // CHECK constraint — threw `unknown ops.jobs.status: null` on every poll of an idle
    // queue: four slots x 5Hz of error logs, forever, while /ready still said ready.
    //
    // The unit test for this case passed throughout, because it faked the empty queue as
    // `claim_job: []`. Zero rows is a shape this function cannot produce. The fake was wrong
    // in precisely the way the code was wrong, which is the second time this exact file has
    // been bitten by a recording client agreeing with the bug (see the bind-order comment
    // above). The regression test now returns the all-NULL row the database actually sends.
    if (row['id'] === null || row['id'] === undefined) return null;

    return mapJobRow(row);
  }

  async heartbeat(id: string, workerId: string, progress?: JsonObject): Promise<boolean> {
    const { rows } = await this.sql.query<{ alive: boolean }>(SQL.heartbeat, [
      id,
      workerId,
      progress === undefined ? null : JSON.stringify(progress),
    ]);
    return rows[0]?.alive === true;
  }

  async complete(id: string, workerId: string, result: JsonValue): Promise<boolean> {
    const { rows } = await this.sql.query<{ completed: boolean }>(SQL.complete, [
      id,
      workerId,
      JSON.stringify(result),
    ]);
    return rows[0]?.completed === true;
  }

  async fail(
    id: string,
    workerId: string,
    error: JobErrorRecord,
    retryable: boolean,
    retryAfterMs = 0,
  ): Promise<FailOutcome> {
    const { rows } = await this.sql.query<{ status: string }>(SQL.fail, [
      id,
      workerId,
      JSON.stringify(error),
      retryable,
      Math.max(0, Math.round(retryAfterMs)),
    ]);
    // The function returns the resulting status; 'queued' means it will be retried, and
    // 'not_owner' means the guard did not match and nothing was written.
    const status = rows[0]?.status;
    if (status === 'queued') return 'requeued';
    if (status === 'not_owner') return 'not_owner';
    return 'failed';
  }

  async requeueStalled(stalledAfterMs: number): Promise<number> {
    const { rows } = await this.sql.query<{ requeued: string | number }>(SQL.requeueStalled, [
      stalledAfterMs / 1_000,
    ]);
    return asInt(rows[0]?.requeued, 0);
  }

  async get(id: string): Promise<JobRow | null> {
    const { rows } = await this.sql.query<RawJobRow>(SQL.get, [id]);
    const row = rows[0];
    return row === undefined ? null : mapJobRow(row);
  }

  async ping(): Promise<boolean> {
    try {
      const { rows } = await this.sql.query<{ ok: number }>(SQL.ping);
      return rows.length === 1;
    } catch {
      // `/ready` must report `false`, not throw: a probe endpoint that 500s is a probe endpoint
      // whose failure message nobody reads.
      return false;
    }
  }

  async close(): Promise<void> {
    await this.sql.end?.();
  }
}
