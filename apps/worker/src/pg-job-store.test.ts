/**
 * `PgJobStore`.
 *
 * Two suites:
 *
 *  1. CONTRACT tests, always run, against a recording `SqlClient` double. These pin the SQL
 *     function names, the argument ORDER and the casts. `db/migrations` is being written
 *     concurrently by another agent, and the arguments are the interface between us — a test
 *     that asserts them turns "the worker silently passes retry_after in the wrong slot" into
 *     a red build the moment either side changes.
 *  2. INTEGRATION tests, which SKIP with a clear message when `DATABASE_URL` is unset. These
 *     are the same semantics `memory-job-store.test.ts` asserts, re-run against real SQL, so a
 *     divergence between the two implementations is a failing test rather than a production
 *     surprise.
 */
import { describe, expect, it } from 'vitest';

import { mapJobRow, PgJobStore, SQL, type SqlClient } from './pg-job-store.js';
import type { JobStore } from './job-store.js';

interface Call {
  readonly text: string;
  readonly values: readonly unknown[];
}

/** A recording double. Not a mock of behaviour — a recorder of the wire calls. */
function recorder(responses: Record<string, Record<string, unknown>[]>): {
  client: SqlClient;
  calls: Call[];
} {
  const calls: Call[] = [];
  const client: SqlClient = {
    query: async <R extends Record<string, unknown>>(text: string, values?: readonly unknown[]) => {
      calls.push({ text, values: values ?? [] });
      const key = Object.keys(responses).find((k) => text.includes(k));
      return { rows: (key === undefined ? [] : responses[key] ?? []) as R[] };
    },
  };
  return { client, calls };
}

const RAW_ROW = {
  id: '01JC8KX9Q2M4V7ZB3F0T5N6R8W',
  org_id: 'org_1',
  project_id: null,
  survey_version_id: 'sv_1',
  kind: 'noop',
  status: 'running',
  idempotency_key: 'publish:sv_1',
  payload: { steps: 3 },
  progress: {},
  result: null,
  error: null,
  attempts: 1,
  max_attempts: 3,
  queue_msg_id: '42',
  created_by: null,
  created_at: new Date('2026-08-20T10:00:00Z'),
  started_at: new Date('2026-08-20T10:00:01Z'),
  finished_at: null,
  heartbeat_at: new Date('2026-08-20T10:00:02Z'),
  available_at: new Date('2026-08-20T10:00:00Z'),
  locked_by: 'worker-1',
} as const;

describe('the SQL contract', () => {
  it('calls ops.enqueue_job with the documented argument order', async () => {
    const { client, calls } = recorder({ enqueue_job: [{ id: 'job_1', created: true }] });
    const store = new PgJobStore(client);

    const got = await store.enqueue({
      kind: 'compile',
      payload: { survey_version_id: 'sv_1' },
      idempotencyKey: 'publish:sv_1',
      orgId: 'org_1',
      projectId: 'prj_1',
      surveyVersionId: 'sv_1',
      maxAttempts: 5,
      delayMs: 250,
    });

    expect(got).toEqual({ id: 'job_1', created: true });
    expect(calls[0]?.text).toBe(SQL.enqueue);
    expect(calls[0]?.values).toEqual([
      'compile',
      '{"survey_version_id":"sv_1"}',
      'publish:sv_1',
      'org_1',
      'prj_1',
      'sv_1',
      5,
      250,
    ]);
  });

  it('sends SQL NULL, not the string "undefined", for absent optionals', async () => {
    const { client, calls } = recorder({ enqueue_job: [{ id: 'j', created: true }] });
    await new PgJobStore(client).enqueue({ kind: 'noop', payload: {} });
    expect(calls[0]?.values).toEqual(['noop', '{}', null, null, null, null, 3, 0]);
  });

  it('throws a diagnosable error when enqueue_job returns no row', async () => {
    const { client } = recorder({ enqueue_job: [] });
    await expect(new PgJobStore(client).enqueue({ kind: 'noop', payload: {} })).rejects.toThrow(
      'ops.enqueue_job returned no row',
    );
  });

  it('passes the kinds as a text[] parameter, not an interpolated IN list', async () => {
    const { client, calls } = recorder({ claim_job: [RAW_ROW] });
    const job = await new PgJobStore(client).claim('worker-1', ['noop', 'compile']);
    expect(calls[0]?.text).toBe(SQL.claim);
    // Bind order is migration 0003's declaration order — `p_kinds` then `p_worker` — which is
    // the REVERSE of PgJobStore.claim()'s own parameter order. This assertion originally
    // pinned the transposed order, so it agreed with the bug and stayed green while every
    // real call failed with "malformed array literal". A recording client can only prove the
    // code is self-consistent; it cannot prove it agrees with the database. That is what the
    // integration tests below are for, and why leaving DATABASE_URL unset in CI is not an
    // acceptable steady state.
    expect(calls[0]?.values).toEqual([['noop', 'compile'], 'worker-1']);
    expect(job?.id).toBe(RAW_ROW.id);
  });

  it('returns null when claim_job yields no row', async () => {
    const { client } = recorder({ claim_job: [] });
    expect(await new PgJobStore(client).claim('w', ['noop'])).toBeNull();
  });

  it('sends progress as jsonb on the heartbeat, or NULL to leave it alone', async () => {
    const { client, calls } = recorder({ heartbeat_job: [{ alive: true }] });
    const store = new PgJobStore(client);

    expect(await store.heartbeat('job_1', 'worker-1', { step: 2, total: 5 })).toBe(true);
    expect(calls[0]?.values).toEqual(['job_1', 'worker-1', '{"step":2,"total":5}']);

    await store.heartbeat('job_1', 'worker-1');
    expect(calls[1]?.values).toEqual(['job_1', 'worker-1', null]);
  });

  it('reads a false heartbeat as lost ownership', async () => {
    const { client } = recorder({ heartbeat_job: [{ alive: false }] });
    expect(await new PgJobStore(client).heartbeat('job_1', 'worker-1')).toBe(false);
    const empty = recorder({ heartbeat_job: [] });
    expect(await new PgJobStore(empty.client).heartbeat('job_1', 'worker-1')).toBe(false);
  });

  it('serialises the result for complete_job and reports the ownership guard', async () => {
    const { client, calls } = recorder({ complete_job: [{ completed: true }] });
    expect(await new PgJobStore(client).complete('job_1', 'worker-1', { ok: true, rows: 3 })).toBe(
      true,
    );
    expect(calls[0]?.text).toBe(SQL.complete);
    expect(calls[0]?.values).toEqual(['job_1', 'worker-1', '{"ok":true,"rows":3}']);

    // The guard did not match: another worker owns this job and our result was NOT written.
    const lost = recorder({ complete_job: [{ completed: false }] });
    expect(await new PgJobStore(lost.client).complete('job_1', 'worker-1', {})).toBe(false);
  });

  it('maps fail_job → queued to "requeued" and anything else to "failed"', async () => {
    const requeue = recorder({ fail_job: [{ status: 'queued' }] });
    expect(
      await new PgJobStore(requeue.client).fail(
        'job_1',
        'worker-1',
        { code: 'unavailable', message: 'redis down' },
        true,
        2_500,
      ),
    ).toBe('requeued');
    expect(requeue.calls[0]?.values).toEqual([
      'job_1',
      'worker-1',
      '{"code":"unavailable","message":"redis down"}',
      true,
      2_500,
    ]);

    const terminal = recorder({ fail_job: [{ status: 'failed' }] });
    expect(
      await new PgJobStore(terminal.client).fail('job_1', 'w', { code: 'x', message: 'y' }, false),
    ).toBe('failed');
    expect(terminal.calls[0]?.values[4]).toBe(0);

    const lost = recorder({ fail_job: [{ status: 'not_owner' }] });
    expect(
      await new PgJobStore(lost.client).fail('job_1', 'w', { code: 'x', message: 'y' }, true),
    ).toBe('not_owner');
  });

  it('rounds and floors a fractional retry delay to a non-negative int', async () => {
    const { client, calls } = recorder({ fail_job: [{ status: 'queued' }] });
    const store = new PgJobStore(client);
    await store.fail('j', 'w', { code: 'a', message: 'b' }, true, 12.6);
    expect(calls[0]?.values[4]).toBe(13);
    await store.fail('j', 'w', { code: 'a', message: 'b' }, true, -5);
    expect(calls[1]?.values[4]).toBe(0);
  });

  it('converts the stall window from ms to the interval SQL expects', async () => {
    const { client, calls } = recorder({ requeue_stalled_jobs: [{ requeued: '4' }] });
    expect(await new PgJobStore(client).requeueStalled(30_000)).toBe(4);
    expect(calls[0]?.text).toBe(SQL.requeueStalled);
    expect(calls[0]?.values).toEqual([30]);
  });

  it('ping is false rather than throwing, so /ready reports instead of 500ing', async () => {
    const store = new PgJobStore({
      query: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    expect(await store.ping()).toBe(false);
  });

  it('closes the underlying client when it has an end()', async () => {
    let ended = false;
    await new PgJobStore({
      query: async () => ({ rows: [] }),
      end: async () => {
        ended = true;
      },
    }).close();
    expect(ended).toBe(true);
  });
});

describe('mapJobRow', () => {
  it('maps a full row, coercing pg types', () => {
    const row = mapJobRow({ ...RAW_ROW });
    expect(row).toMatchObject({
      id: RAW_ROW.id,
      org_id: 'org_1',
      project_id: null,
      kind: 'noop',
      status: 'running',
      payload: { steps: 3 },
      attempts: 1,
      max_attempts: 3,
      // bigint arrives as a string from pg; pgmq ids stay far below 2^53.
      queue_msg_id: 42,
      locked_by: 'worker-1',
    });
    expect(row.created_at).toBeInstanceOf(Date);
    expect(row.finished_at).toBeNull();
  });

  it('accepts int columns delivered as strings', () => {
    const row = mapJobRow({ ...RAW_ROW, attempts: '2', max_attempts: '9' });
    expect(row.attempts).toBe(2);
    expect(row.max_attempts).toBe(9);
  });

  it('rejects a status outside the CHECK constraint instead of falling through', () => {
    expect(() => mapJobRow({ ...RAW_ROW, status: 'zombie' })).toThrow(
      /unknown ops.jobs.status: zombie/,
    );
  });

  it('degrades to created_at when available_at is missing from an older migration', () => {
    const { available_at: _unused, ...withoutColumn } = RAW_ROW;
    const row = mapJobRow({ ...withoutColumn });
    expect(row.available_at.getTime()).toBe(RAW_ROW.created_at.getTime());
  });

  it('normalises a jsonb NULL payload to an empty object', () => {
    const row = mapJobRow({ ...RAW_ROW, payload: null, progress: null, error: null });
    expect(row.payload).toEqual({});
    expect(row.progress).toEqual({});
    expect(row.error).toBeNull();
  });

  it('parses an ISO timestamp string, which pg emits when type parsing is disabled', () => {
    const row = mapJobRow({ ...RAW_ROW, created_at: '2026-08-20T10:00:00.000Z' });
    expect(row.created_at.toISOString()).toBe('2026-08-20T10:00:00.000Z');
  });
});

/**
 * Integration suite.
 *
 * These SKIP rather than fail when there is no database, so `pnpm test` is green on a laptop
 * and on a CI job that has not provisioned Postgres — while still running for real against the
 * migrated database in the job that has (M0.2 wires `pg_prove` and a fresh migration into CI).
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const describeIntegration = DATABASE_URL === undefined || DATABASE_URL === '' ? describe.skip : describe;

if (DATABASE_URL === undefined || DATABASE_URL === '') {
  // eslint-disable-next-line no-console -- the whole point is that a human sees why these skipped
  console.info(
    '[pg-job-store] integration tests SKIPPED: DATABASE_URL is unset. ' +
      'Run `pnpm db:up` and set DATABASE_URL to exercise PgJobStore against ops.jobs.',
  );
}

describeIntegration('PgJobStore against a real ops.jobs', () => {
  async function connect(): Promise<{ store: JobStore; close: () => Promise<void> }> {
    const pg = await import('pg');
    const pool = new pg.default.Pool({ connectionString: DATABASE_URL, max: 4 });
    const store = new PgJobStore(pool as unknown as SqlClient);
    return { store, close: () => pool.end() };
  }

  /**
   * A job kind unique to one test execution.
   *
   * `ops.claim_job` hands out the oldest DUE job of a kind, and these tests run against a
   * persistent database that is not reset between runs. Sharing the kind `noop` meant a test
   * could be handed a job left queued by a sibling test or by an earlier run entirely, and
   * the failure surfaced as `expected 'job_01M0FJQ…' to be 'job_01M0FJR…'` — which reads like
   * a bug in claim ordering rather than a bug in test isolation.
   *
   * `jobs_kind_fmt` is `^[a-z][a-z0-9_]{1,63}$`, so hyphens are not allowed and the name must
   * not start with a digit.
   */
  const uniqueKind = (label: string): string =>
    `itest_${label}_${String(Date.now())}_${String(Math.floor(Math.random() * 1e6))}`;

  it('enqueues, claims, heartbeats and completes', async () => {
    const { store, close } = await connect();
    const kind = uniqueKind('lifecycle');
    try {
      const { id, created } = await store.enqueue({ kind, payload: { steps: 1 } });
      expect(created).toBe(true);

      const claimed = await store.claim('itest-worker', [kind]);
      expect(claimed?.id).toBe(id);
      expect(claimed?.attempts).toBe(1);
      expect(claimed?.status).toBe('running');

      expect(
        await store.heartbeat(id, 'itest-worker', {
          step: 1,
          total: 1,
          message: 'x',
          updated_at: 'y',
        }),
      ).toBe(true);
      expect(await store.complete(id, 'itest-worker', { ok: true })).toBe(true);

      expect(await store.get(id)).toMatchObject({ status: 'succeeded', result: { ok: true } });
    } finally {
      await close();
    }
  });

  it('de-duplicates on (kind, idempotency_key)', async () => {
    const { store, close } = await connect();
    const kind = uniqueKind('idem');
    try {
      const key = `itest-${String(Date.now())}`;
      const a = await store.enqueue({ kind, payload: {}, idempotencyKey: key });
      const b = await store.enqueue({ kind, payload: {}, idempotencyKey: key });
      expect(b).toEqual({ id: a.id, created: false });
    } finally {
      await close();
    }
  });

  it('never claims the same row twice', async () => {
    const { store, close } = await connect();
    const kind = uniqueKind('concurrent');
    try {
      // Two jobs and two claimants: with one job the test passes even if both claimants get
      // it, because a set of one duplicate id still has size 1. Two proves distinctness.
      const a = await store.enqueue({ kind, payload: {}, idempotencyKey: `${kind}_a` });
      const b = await store.enqueue({ kind, payload: {}, idempotencyKey: `${kind}_b` });
      const claims = await Promise.all([
        store.claim('itest-a', [kind]),
        store.claim('itest-b', [kind]),
      ]);
      const ids = claims.filter((c) => c !== null).map((c) => c.id);
      expect(ids).toHaveLength(2);
      expect(new Set(ids)).toEqual(new Set([a.id, b.id]));
    } finally {
      await close();
    }
  });

  it('requeues a stalled job', async () => {
    const { store, close } = await connect();
    const kind = uniqueKind('stalled');
    try {
      const { id } = await store.enqueue({ kind, payload: {} });
      const claimed = await store.claim('itest-dead', [kind]);
      expect(claimed?.id).toBe(id);
      // A zero window makes every running job stale, which is the only way to test this
      // without sleeping for the real stall deadline. It is also global — it can requeue jobs
      // belonging to other tests — so this asserts on THIS job's status rather than on the
      // returned count meaning anything specific.
      expect(await store.requeueStalled(0)).toBeGreaterThan(0);
      expect((await store.get(id))?.status).toBe('queued');
    } finally {
      await close();
    }
  });

  it('ping succeeds', async () => {
    const { store, close } = await connect();
    try {
      expect(await store.ping()).toBe(true);
    } finally {
      await close();
    }
  });
});
