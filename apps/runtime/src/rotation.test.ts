/**
 * The shared rotation ticket (roadmap P2-03).
 *
 * Run against a real Redis when `REDIS_URL` is set, which is where the interesting properties live:
 * a monotonic ticket is a claim about concurrency, and a fake that returns `n++` proves nothing
 * about it.
 *
 * The properties:
 *
 *  * MONOTONIC AND UNIQUE under concurrency. This is the whole feature — the roadmap's acceptance
 *    line ("1,000 sequential entries distribute starting offsets within one of even") is a claim
 *    about a counter nobody skips or repeats.
 *  * ZERO-BASED, so the first respondent of a wave sees the order the author wrote and a manual
 *    spot-check means something.
 *  * NULL, not 0, when Redis is unreachable. A zero would put every respondent at offset 0 during
 *    an outage — a survey with no rotation pretending to have one.
 */

import { afterAll, describe, expect, it } from 'vitest';

import {
  createRotationCounter,
  drainRotationCountersOnce,
  readRotationCounter,
  ROTATION_KEY_PREFIX,
} from './rotation.js';

const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379';
const HAVE_REDIS = process.env['REDIS_URL'] !== undefined || process.env['CI'] === undefined;

const VER = `ver_test_${String(Date.now())}_${String(Math.floor(Math.random() * 1e6))}`;

/**
 * A valid `app.ulid` from a readable tag.
 *
 * Written once because Crockford base32 excludes I, L, O and U, and a literal with a `U` in it fails
 * as a domain violation three layers away from the typo. Three separate fixtures in this phase have
 * hit that; this asserts the alphabet instead of trusting the author to remember it.
 */
function crockfordId(prefix: string, tag: string): string {
  const body = `0${tag.toUpperCase().padEnd(25, '0')}`;
  if (/[ILOU]/.test(body)) throw new Error(`tag ${tag} uses a letter Crockford base32 excludes`);
  return `${prefix}_${body}`;
}
const counter = createRotationCounter(REDIS_URL);

afterAll(async () => {
  await counter.close();
});

describe.skipIf(!HAVE_REDIS)('createRotationCounter against a real Redis', () => {
  it('is ZERO-based, so the first respondent sees the authored order', async () => {
    // Deliberate: `rotate` leaves the declared order alone at offset 0, which makes a manual
    // spot-check of the first entry meaningful.
    const first = await counter.next(`${VER}_zero`);
    expect(first).toBe(0);
  });

  it('increments once per call', async () => {
    const key = `${VER}_seq`;
    const tickets = [
      await counter.next(key),
      await counter.next(key),
      await counter.next(key),
    ];
    expect(tickets).toEqual([0, 1, 2]);
  });

  it('is UNIQUE and gapless under 200 concurrent calls', async () => {
    // The property the distribution guarantee rests on. A counter that skipped would leave a
    // rotation with holes; one that repeated would double-load a position. Neither is visible
    // without a test like this.
    const key = `${VER}_race`;
    const tickets = await Promise.all(Array.from({ length: 200 }, () => counter.next(key)));
    const set = new Set(tickets);

    expect(set.size).toBe(200); // no repeats
    expect(Math.min(...(tickets as number[]))).toBe(0);
    expect(Math.max(...(tickets as number[]))).toBe(199); // no gaps
  });

  it('keeps counters separate per version', async () => {
    // One counter per fielding version: two surveys must not share a rotation, or each advances at
    // twice the rate and "even across respondents" stops being true of either.
    const a = await counter.next(`${VER}_a`);
    await counter.next(`${VER}_b`);
    await counter.next(`${VER}_b`);
    expect(a).toBe(0);
    expect(await counter.next(`${VER}_a`)).toBe(1);
  });

  it('is readable for the write-behind drain', async () => {
    const { Redis } = await import('ioredis');
    const raw = new Redis(REDIS_URL, { maxRetriesPerRequest: 1 });
    try {
      const key = `${VER}_drain`;
      await counter.next(key);
      await counter.next(key);
      expect(await readRotationCounter(raw, key)).toBe(2);
      // A version nobody has entered reads as null, not 0 — "no counter yet" and "counter at zero"
      // are different facts, and flushing a 0 for the first would write a row that says nothing.
      expect(await readRotationCounter(raw, `${VER}_never`)).toBeNull();
    } finally {
      await raw.quit().catch(() => undefined);
    }
  });

  it('uses the documented key prefix, so the drain and the issuer agree', async () => {
    const { Redis } = await import('ioredis');
    const raw = new Redis(REDIS_URL, { maxRetriesPerRequest: 1 });
    try {
      const key = `${VER}_prefix`;
      await counter.next(key);
      expect(await raw.get(`${ROTATION_KEY_PREFIX}:${key}`)).toBe('1');
    } finally {
      await raw.quit().catch(() => undefined);
    }
  });
});

describe('when Redis is unreachable', () => {
  it('returns NULL rather than 0 or a throw', async () => {
    // A zero would put every respondent at offset 0 during an outage — a survey with no rotation
    // pretending to have one. Null makes `randomize()` report `needs_counter` and leave the declared
    // order alone, which is visibly unrotated rather than silently unbalanced.
    const dead = createRotationCounter('redis://127.0.0.1:1');
    try {
      expect(await dead.next('ver_x')).toBeNull();
    } finally {
      await dead.close();
    }
  }, 15_000);
});


/* ---------------------------------------------------------------- *
 * The write-behind drain
 * ---------------------------------------------------------------- */

describe.skipIf(!HAVE_REDIS)('drainRotationCountersOnce', () => {
  /**
   * Without this, 0025's table has no writer — and a table nobody writes is a migration that looks
   * like a feature, which is the failure this phase found three separate times.
   */
  function target() {
    const flushed: { v: string; k: string; i: number }[][] = [];
    return {
      flushed,
      flush: async (rows: readonly { v: string; k: string; i: number }[]) => {
        flushed.push([...rows]);
        return rows.length;
      },
    };
  }

  it('flushes the live counter value', async () => {
    const { Redis } = await import('ioredis');
    const raw = new Redis(REDIS_URL, { maxRetriesPerRequest: 1 });
    try {
      const key = `${VER}_flush`;
      await counter.next(key);
      await counter.next(key);
      await counter.next(key);

      const t = target();
      const n = await drainRotationCountersOnce(raw, t, [key]);

      expect(n).toBe(1);
      expect(t.flushed[0]).toEqual([{ v: key, k: 'session', i: 3 }]);
    } finally {
      await raw.quit().catch(() => undefined);
    }
  });

  it('does NOT reset the counter — Redis stays the arbiter', async () => {
    // GET, never GETSET. Resetting would mean the counter and the record disagree for as long as it
    // takes the next respondent to arrive, and a ticket issued in that window would duplicate one
    // already recorded. The GREATEST on the far side is what makes reading-without-resetting safe
    // to do on a loop.
    const { Redis } = await import('ioredis');
    const raw = new Redis(REDIS_URL, { maxRetriesPerRequest: 1 });
    try {
      const key = `${VER}_noreset`;
      await counter.next(key);
      await counter.next(key);

      await drainRotationCountersOnce(raw, target(), [key]);

      // The next respondent gets 2, not 0.
      expect(await counter.next(key)).toBe(2);
    } finally {
      await raw.quit().catch(() => undefined);
    }
  });

  it('skips a version nobody has entered, rather than flushing a zero', async () => {
    // `null` is "no counter yet", which is different from "counter at zero". Flushing a 0 would
    // write a row that says nothing and make the table's row count a count of VERSIONS rather than
    // of rotations.
    const { Redis } = await import('ioredis');
    const raw = new Redis(REDIS_URL, { maxRetriesPerRequest: 1 });
    try {
      const t = target();
      expect(await drainRotationCountersOnce(raw, t, [`${VER}_untouched`])).toBe(0);
      expect(t.flushed).toEqual([]);
    } finally {
      await raw.quit().catch(() => undefined);
    }
  });

  it('flushes nothing for an empty version list', async () => {
    const { Redis } = await import('ioredis');
    const raw = new Redis(REDIS_URL, { maxRetriesPerRequest: 1 });
    try {
      const t = target();
      expect(await drainRotationCountersOnce(raw, t, [])).toBe(0);
      expect(t.flushed).toEqual([]);
    } finally {
      await raw.quit().catch(() => undefined);
    }
  });
});


/* ---------------------------------------------------------------- *
 * End to end against real Postgres
 * ---------------------------------------------------------------- */

const DB_URL = process.env['DATABASE_URL'];

describe.skipIf(!HAVE_REDIS || DB_URL === undefined)(
  'the drain and 0025 flush agree, against real Postgres',
  () => {
    /**
     * The drain's contract and the RPC's are stated in two places — a TypeScript row shape and a
     * jsonb key set — and nothing but a round trip proves they match. Two tests each passing against
     * their own fake would prove nothing about the pair.
     */
    /**
     * Its own isolated org → project → survey → version chain, deleted in reverse. NOT
     * `ops.test_seed_two_orgs()`: that commits a shared fixture outside a transaction, and doing so
     * from a vitest suite broke `apps/worker`'s publish tests with a duplicate `organizations_pkey`
     * once already this phase.
     */
    // Crockford base32 excludes I, L, O and U, so the tag is 'R0TAT10NSV1TE' rather than
    // 'ROTATIONSUITE' — the third time that alphabet has bitten a fixture this phase, which is why
    // `crockfordId` below exists instead of a fourth hand-written literal.
    const ORG = crockfordId('org', 'r0tat10nsv1te');
    const PRJ = crockfordId('prj', 'r0tat10nsv1te');
    const SVY = crockfordId('svy', 'r0tat10nsv1te');
    const VER = crockfordId('ver', 'r0tat10nsv1te');
    const ACTOR = '00000000-0000-0000-0000-0000000000ee';

    it('records the counter, and a stale flush cannot move it backwards', async () => {
      const { Pool } = await import('pg');
      const { Redis } = await import('ioredis');
      const pool = new Pool({ connectionString: DB_URL, max: 1 });
      const raw = new Redis(REDIS_URL, { maxRetriesPerRequest: 1 });

      const cleanup = async (): Promise<void> => {
        await pool.query('DELETE FROM runtime.rotation_counters WHERE survey_version_id = $1', [VER]);
        await pool.query('DELETE FROM app.survey_versions WHERE id = $1', [VER]);
        await pool.query('DELETE FROM app.surveys WHERE id = $1', [SVY]);
        await pool.query('DELETE FROM app.projects WHERE id = $1', [PRJ]);
        await pool.query('DELETE FROM app.organizations WHERE id = $1', [ORG]);
        await pool.query('DELETE FROM auth.users WHERE id = $1', [ACTOR]);
      };

      try {
        await cleanup();
        await pool.query('INSERT INTO auth.users (id, email) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [ACTOR, 'rotation-suite@example.test']);
        await pool.query(
          'INSERT INTO app.organizations (id, slug, name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
          [ORG, 'rotation-suite', 'Rotation suite']);
        await pool.query(
          `INSERT INTO app.projects (id, org_id, ref, name, created_by) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT DO NOTHING`, [PRJ, ORG, 'ROT', 'Rot', ACTOR]);
        await pool.query(
          `INSERT INTO app.surveys (id, org_id, project_id, ref, name, created_by)
           VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
          [SVY, ORG, PRJ, 'ROT', 'Rot', ACTOR]);
        await pool.query(
          `INSERT INTO app.survey_versions
             (id, org_id, survey_id, version_no, schema_version, created_by)
           VALUES ($1, $2, $3, 1, 1, $4) ON CONFLICT DO NOTHING`, [VER, ORG, SVY, ACTOR]);

        const flushTarget = {
          flush: async (rows: readonly { v: string; k: string; i: number }[]) => {
            const r = await pool.query<{ n: number }>(
              'SELECT runtime.flush_rotation_counters($1::jsonb) AS n',
              [JSON.stringify(rows)],
            );
            return Number(r.rows[0]?.n ?? 0);
          },
        };

        await raw.del(`${ROTATION_KEY_PREFIX}:${VER}`);
        for (let i = 0; i < 5; i += 1) await counter.next(VER);
        expect(await drainRotationCountersOnce(raw, flushTarget, [VER])).toBe(1);

        const after = await pool.query<{ issued: string }>(
          'SELECT issued FROM runtime.rotation_counters WHERE survey_version_id = $1', [VER]);
        expect(Number(after.rows[0]?.issued)).toBe(5);

        // A STALE batch — the hazard GREATEST exists for. An overwrite would re-issue five tickets
        // already handed out, and the symptom is a rotation quietly no longer even.
        await flushTarget.flush([{ v: VER, k: 'session', i: 2 }]);
        const stale = await pool.query<{ issued: string }>(
          'SELECT issued FROM runtime.rotation_counters WHERE survey_version_id = $1', [VER]);
        expect(Number(stale.rows[0]?.issued)).toBe(5);

        // And the rebuild read returns it, which is what stops a Redis flush restarting at zero.
        const seed = await pool.query<{ counter_key: string; issued: string }>(
          'SELECT counter_key, issued FROM runtime.rotation_seed_from_db($1::app.ulid)', [VER]);
        expect(Number(seed.rows[0]?.issued)).toBe(5);
        expect(seed.rows[0]?.counter_key).toBe('session');
      } finally {
        await cleanup().catch(() => undefined);
        await raw.quit().catch(() => undefined);
        await pool.end().catch(() => undefined);
      }
    }, 30_000);
  },
);
