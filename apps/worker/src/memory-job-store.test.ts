/**
 * `MemoryJobStore` semantics.
 *
 * These tests are the specification the SQL functions must also satisfy. `pg-job-store.test.ts`
 * runs an equivalent set against a real database when `DATABASE_URL` is set, so a divergence
 * between the two implementations shows up as a failing test rather than as a production
 * surprise.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { defaultBackoffMs } from './job-store.js';
import { MemoryJobStore } from './memory-job-store.js';

let now = 1_700_000_000_000;
const clock = (): number => now;

function store(): MemoryJobStore {
  return new MemoryJobStore({ now: clock });
}

beforeEach(() => {
  now = 1_700_000_000_000;
});

describe('enqueue', () => {
  it('creates a queued row with ops.jobs defaults', async () => {
    const s = store();
    const { id, created } = await s.enqueue({ kind: 'noop', payload: { steps: 2 } });

    expect(created).toBe(true);
    const job = await s.get(id);
    expect(job).toMatchObject({
      kind: 'noop',
      status: 'queued',
      attempts: 0,
      max_attempts: 3,
      payload: { steps: 2 },
      progress: {},
      result: null,
      error: null,
      started_at: null,
      finished_at: null,
      heartbeat_at: null,
      locked_by: null,
    });
  });

  it('carries the tenancy columns through', async () => {
    const s = store();
    const { id } = await s.enqueue({
      kind: 'noop',
      payload: {},
      orgId: 'org_1',
      projectId: 'prj_1',
      surveyVersionId: 'sv_1',
      createdBy: 'user_1',
      maxAttempts: 5,
    });
    expect(await s.get(id)).toMatchObject({
      org_id: 'org_1',
      project_id: 'prj_1',
      survey_version_id: 'sv_1',
      created_by: 'user_1',
      max_attempts: 5,
    });
  });

  it('does not alias the caller payload object', async () => {
    const s = store();
    const payload = { steps: 1 };
    const { id } = await s.enqueue({ kind: 'noop', payload });
    payload.steps = 99;
    expect((await s.get(id))?.payload).toEqual({ steps: 1 });
  });

  it('is undefined for an unknown id', async () => {
    expect(await store().get('nope')).toBeNull();
  });
});

describe('idempotency keys — jobs_idem_key', () => {
  it('the same key enqueued twice returns ONE job id and creates ONE row', async () => {
    // Roadmap M0.4: "Double-clicking the trigger produces exactly one job row."
    const s = store();
    const first = await s.enqueue({
      kind: 'noop',
      payload: { steps: 1 },
      idempotencyKey: 'publish:sv_1',
    });
    const second = await s.enqueue({
      kind: 'noop',
      payload: { steps: 1 },
      idempotencyKey: 'publish:sv_1',
    });

    expect(second.id).toBe(first.id);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(s.all()).toHaveLength(1);
  });

  it('de-duplicates against a RUNNING job, not only a queued one', async () => {
    // The real double-click case: the first job is already being worked when the second
    // request arrives. Returning the running job's id is what lets the UI attach to it.
    const s = store();
    const first = await s.enqueue({ kind: 'noop', payload: {}, idempotencyKey: 'k' });
    await s.claim('w1', ['noop']);
    const second = await s.enqueue({ kind: 'noop', payload: {}, idempotencyKey: 'k' });

    expect(second).toEqual({ id: first.id, created: false });
    expect(s.all()).toHaveLength(1);
  });

  it('scopes the key to the kind — the index is (kind, idempotency_key)', async () => {
    const s = store();
    const a = await s.enqueue({ kind: 'noop', payload: {}, idempotencyKey: 'sv_1' });
    const b = await s.enqueue({ kind: 'compile', payload: {}, idempotencyKey: 'sv_1' });
    expect(b.id).not.toBe(a.id);
    expect(s.all()).toHaveLength(2);
  });

  it('does not de-duplicate jobs without a key', async () => {
    const s = store();
    await s.enqueue({ kind: 'noop', payload: {} });
    await s.enqueue({ kind: 'noop', payload: {} });
    expect(s.all()).toHaveLength(2);
  });
});

describe('claim — FOR UPDATE SKIP LOCKED equivalence', () => {
  it('marks the job running and increments attempts', async () => {
    const s = store();
    const { id } = await s.enqueue({ kind: 'noop', payload: {} });
    const claimed = await s.claim('w1', ['noop']);

    expect(claimed?.id).toBe(id);
    expect(claimed).toMatchObject({ status: 'running', attempts: 1, locked_by: 'w1' });
    expect(claimed?.started_at).not.toBeNull();
    expect(claimed?.heartbeat_at).not.toBeNull();
  });

  it('never returns the same job to two claimers', async () => {
    const s = store();
    await s.enqueue({ kind: 'noop', payload: {} });
    expect(await s.claim('w1', ['noop'])).not.toBeNull();
    expect(await s.claim('w2', ['noop'])).toBeNull();
  });

  it('holds up under many interleaved concurrent claims', async () => {
    const s = store();
    for (let i = 0; i < 40; i += 1) await s.enqueue({ kind: 'noop', payload: { i } });

    const claims = await Promise.all(
      Array.from({ length: 80 }, (_u, i) => s.claim(`w${String(i % 8)}`, ['noop'])),
    );
    const ids = claims.filter((c) => c !== null).map((c) => c.id);
    expect(ids).toHaveLength(40);
    expect(new Set(ids).size).toBe(40);
  });

  it('claims in creation order', async () => {
    const s = store();
    const a = await s.enqueue({ kind: 'noop', payload: {} });
    now += 1;
    const b = await s.enqueue({ kind: 'noop', payload: {} });
    expect((await s.claim('w1', ['noop']))?.id).toBe(a.id);
    expect((await s.claim('w1', ['noop']))?.id).toBe(b.id);
  });

  it('only claims requested kinds', async () => {
    const s = store();
    await s.enqueue({ kind: 'export', payload: {} });
    expect(await s.claim('w1', ['noop', 'compile'])).toBeNull();
    expect(await s.claim('w1', ['export'])).not.toBeNull();
  });

  it('honours available_at, so a delay is a real delay', async () => {
    const s = store();
    await s.enqueue({ kind: 'noop', payload: {}, delayMs: 5_000 });
    expect(await s.claim('w1', ['noop'])).toBeNull();
    now += 4_999;
    expect(await s.claim('w1', ['noop'])).toBeNull();
    now += 1;
    expect(await s.claim('w1', ['noop'])).not.toBeNull();
  });
});

describe('heartbeat', () => {
  it('advances heartbeat_at and writes progress', async () => {
    const s = store();
    const { id } = await s.enqueue({ kind: 'noop', payload: {} });
    await s.claim('w1', ['noop']);

    now += 1_000;
    expect(await s.heartbeat(id, 'w1', { step: 2, total: 5, message: 'half', updated_at: 'x' })).toBe(
      true,
    );
    const job = await s.get(id);
    expect(job?.heartbeat_at?.getTime()).toBe(now);
    expect(job?.progress).toEqual({ step: 2, total: 5, message: 'half', updated_at: 'x' });
  });

  it('preserves existing progress when none is supplied', async () => {
    const s = store();
    const { id } = await s.enqueue({ kind: 'noop', payload: {} });
    await s.claim('w1', ['noop']);
    await s.heartbeat(id, 'w1', { step: 1, total: 2, message: '', updated_at: 'x' });
    await s.heartbeat(id, 'w1');
    expect((await s.get(id))?.progress).toMatchObject({ step: 1 });
  });

  it('returns false once the row is no longer running — the lost-ownership signal', async () => {
    const s = store();
    const { id } = await s.enqueue({ kind: 'noop', payload: {} });
    await s.claim('w1', ['noop']);
    now += 60_000;
    await s.requeueStalled(30_000);

    expect(await s.heartbeat(id, 'w1')).toBe(false);
  });

  it('returns false for an unknown id', async () => {
    expect(await store().heartbeat('nope', 'w1')).toBe(false);
  });

  it('returns false for a worker that does not hold the job — the compare-and-set guard', async () => {
    // Worker A hangs, the sweeper requeues, worker B claims. A's heartbeat and A's complete
    // must both fail, or A silently overwrites B's result.
    const s = store();
    const { id } = await s.enqueue({ kind: 'noop', payload: {} });
    await s.claim('worker-a', ['noop']);
    now += 60_000;
    await s.requeueStalled(30_000);
    await s.claim('worker-b', ['noop']);

    expect(await s.heartbeat(id, 'worker-a')).toBe(false);
    expect(await s.complete(id, 'worker-a', { from: 'a' })).toBe(false);
    expect(await s.fail(id, 'worker-a', { code: 'x', message: 'y' }, true)).toBe('not_owner');
    // B still owns it and its writes land.
    expect(await s.complete(id, 'worker-b', { from: 'b' })).toBe(true);
    expect(await s.get(id)).toMatchObject({ status: 'succeeded', result: { from: 'b' } });
  });
});

describe('complete', () => {
  it('writes the result and finishes the row', async () => {
    const s = store();
    const { id } = await s.enqueue({ kind: 'noop', payload: {} });
    await s.claim('w1', ['noop']);
    now += 100;
    await s.complete(id, 'w1', { ok: true, steps: 3 });

    expect(await s.get(id)).toMatchObject({
      status: 'succeeded',
      result: { ok: true, steps: 3 },
      error: null,
      locked_by: null,
    });
    expect((await s.get(id))?.finished_at?.getTime()).toBe(now);
  });
});

describe('fail', () => {
  const err = { code: 'unavailable', message: 'redis down' } as const;

  it('requeues with a not-before while attempts remain', async () => {
    const s = store();
    const { id } = await s.enqueue({ kind: 'noop', payload: {} });
    await s.claim('w1', ['noop']);

    expect(await s.fail(id, 'w1', err, true, 2_000)).toBe('requeued');
    const job = await s.get(id);
    expect(job).toMatchObject({ status: 'queued', attempts: 1, locked_by: null });
    expect(job?.error).toEqual(err);
    expect(job?.available_at.getTime()).toBe(now + 2_000);
    // Backoff is real: the job is not claimable until the window elapses.
    expect(await s.claim('w1', ['noop'])).toBeNull();
    now += 2_000;
    expect(await s.claim('w1', ['noop'])).not.toBeNull();
  });

  it('fails terminally once the attempt budget is spent', async () => {
    const s = store();
    const { id } = await s.enqueue({ kind: 'noop', payload: {}, maxAttempts: 2 });

    await s.claim('w1', ['noop']);
    expect(await s.fail(id, 'w1', err, true, 0)).toBe('requeued');
    await s.claim('w1', ['noop']);
    expect(await s.fail(id, 'w1', err, true, 0)).toBe('failed');

    expect(await s.get(id)).toMatchObject({ status: 'failed', attempts: 2 });
    expect(await s.claim('w1', ['noop'])).toBeNull();
  });

  it('fails immediately when not retryable, whatever the budget', async () => {
    const s = store();
    const { id } = await s.enqueue({ kind: 'noop', payload: {}, maxAttempts: 9 });
    await s.claim('w1', ['noop']);
    expect(await s.fail(id, 'w1', { code: 'malformed_request', message: 'bad payload' }, false)).toBe(
      'failed',
    );
    expect(await s.get(id)).toMatchObject({ status: 'failed', attempts: 1 });
  });
});

describe('requeueStalled — the jobs_stalled_idx path', () => {
  it('requeues a running job whose heartbeat went silent', async () => {
    // "A job killed mid-run is requeued by the stalled sweeper" (roadmap M0.4 Tests),
    // simulated exactly as the roadmap describes: by not heartbeating.
    const s = store();
    const { id } = await s.enqueue({ kind: 'noop', payload: {} });
    await s.claim('w1', ['noop']);

    now += 29_999;
    expect(await s.requeueStalled(30_000)).toBe(0);
    expect((await s.get(id))?.status).toBe('running');

    now += 2;
    expect(await s.requeueStalled(30_000)).toBe(1);
    expect(await s.get(id)).toMatchObject({
      status: 'queued',
      locked_by: null,
      heartbeat_at: null,
    });
    // Immediately re-claimable, and attempts is NOT double-counted by the sweep.
    const reclaimed = await s.claim('w2', ['noop']);
    expect(reclaimed?.attempts).toBe(2);
  });

  it('a live heartbeat prevents the requeue', async () => {
    const s = store();
    const { id } = await s.enqueue({ kind: 'noop', payload: {} });
    await s.claim('w1', ['noop']);
    for (let i = 0; i < 10; i += 1) {
      now += 5_000;
      expect(await s.heartbeat(id, 'w1')).toBe(true);
      expect(await s.requeueStalled(30_000)).toBe(0);
    }
    expect((await s.get(id))?.status).toBe('running');
  });

  it('does not increment attempts, so a repeatedly-killed job still terminates', async () => {
    const s = store();
    const { id } = await s.enqueue({ kind: 'noop', payload: {}, maxAttempts: 3 });

    for (let i = 1; i <= 3; i += 1) {
      const claimed = await s.claim('w1', ['noop']);
      expect(claimed?.attempts).toBe(i);
      now += 31_000;
      await s.requeueStalled(30_000);
    }

    // Fourth sweep: the budget is spent, so it is finished rather than requeued forever.
    expect((await s.get(id))?.status).toBe('failed');
    expect((await s.get(id))?.attempts).toBe(3);
    expect(await s.claim('w1', ['noop'])).toBeNull();
  });

  it('ignores queued, succeeded and failed rows', async () => {
    const s = store();
    await s.enqueue({ kind: 'noop', payload: {} });
    const done = await s.enqueue({ kind: 'noop', payload: {} });
    await s.claim('w1', ['noop']); // claims the first
    await s.claim('w1', ['noop']); // claims `done`
    await s.complete(done.id, 'w1', null);

    now += 60_000;
    expect(await s.requeueStalled(30_000)).toBe(1);
    expect((await s.get(done.id))?.status).toBe('succeeded');
  });
});

describe('lifecycle', () => {
  it('ping is true until closed, then operations throw', async () => {
    const s = store();
    expect(await s.ping()).toBe(true);
    await s.close();
    expect(await s.ping()).toBe(false);
    await expect(s.enqueue({ kind: 'noop', payload: {} })).rejects.toThrow('closed');
  });

  it('withStatus filters', async () => {
    const s = store();
    await s.enqueue({ kind: 'noop', payload: {} });
    const b = await s.enqueue({ kind: 'noop', payload: {} });
    await s.claim('w1', ['noop']);
    expect(s.withStatus('queued').map((r) => r.id)).toEqual([b.id]);
    expect(s.withStatus('running')).toHaveLength(1);
  });
});

describe('defaultBackoffMs', () => {
  it('grows exponentially and caps', () => {
    const full = (attempt: number): number => defaultBackoffMs(attempt, { random: () => 1 });
    expect(full(1)).toBe(1_000);
    expect(full(2)).toBe(2_000);
    expect(full(3)).toBe(4_000);
    expect(full(10)).toBe(60_000);
    expect(full(100)).toBe(60_000);
  });

  it('applies full jitter, so N workers do not retry in lockstep', () => {
    expect(defaultBackoffMs(3, { random: () => 0 })).toBe(0);
    expect(defaultBackoffMs(3, { random: () => 0.5 })).toBe(2_000);
    const values = new Set(Array.from({ length: 40 }, () => defaultBackoffMs(5)));
    expect(values.size).toBeGreaterThan(20);
  });

  it('never returns a negative delay for a nonsense attempt number', () => {
    expect(defaultBackoffMs(0, { random: () => 1 })).toBe(1_000);
    expect(defaultBackoffMs(-5, { random: () => 1 })).toBe(1_000);
  });
});
