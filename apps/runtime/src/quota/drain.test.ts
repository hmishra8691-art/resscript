/**
 * The quota drain — against REAL Redis and REAL Postgres.
 *
 * Not mocked, for the reason `quota.test.ts` gives about the gate: every load-bearing claim here is
 * a claim about the interaction between two systems, and a mock asserts only that the mock was
 * called. The suite skips loudly when either is unreachable, because a silently green drain suite
 * that tested nothing is how a rewound counter ships.
 *
 * The property this file exists for is the roadmap's own P2-07 line: **"an out-of-order
 * write-behind test asserting a stale epoch does not decrement Postgres."** A drain is
 * asynchronous, so two flushes can arrive with the older one second; if the record accepts it, a
 * counter goes backwards and the cell over-admits. Everything else here is in service of that.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import pg from 'pg';
import { createQuotaDrain, splitCounterKey, WRITE_BEHIND_KEY, type QuotaDrain } from './drain.js';

const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
const DB_URL = process.env['DATABASE_URL'] ?? '';

/**
 * Ids shaped like the real thing: `app.ulid` is a prefix plus exactly 26 Crockford base32
 * characters, first in [0-7].
 *
 * Built by a helper rather than written as literals, because hand-written ones get both rules
 * wrong: my first draft mis-counted the padding AND used the tag `PLAN`, whose `L` is not in the
 * Crockford alphabet at all. The terminator `V` is what keeps `s1` and `s10` from colliding — the
 * same trap the pgTAP fixtures hit, documented in migration 0017's test.
 */
function ulid(prefix: string, tag: string): string {
  const safe = tag.toUpperCase().replace(/I|L/g, '1').replace(/O/g, '0').replace(/U/g, 'V');
  return `${prefix}_0${`${safe}V`.padEnd(25, '0')}`;
}

/**
 * This suite's OWN fixture ids, created and dropped by it.
 *
 * Two lessons are baked in here. First, `quota_counters.survey_version_id` has a real FK to
 * `app.survey_versions`, so a made-up version id is rejected — a counter must belong to a survey
 * that exists. Second, and the more important one: the obvious fix was to call
 * `ops.test_seed_two_orgs()`, and because the drain runs on its own pool that seed has to be
 * COMMITTED — which promptly broke `apps/worker`'s publish and export suites, both of which seed
 * the same fixture inside a transaction they roll back. A committed shared fixture is not test
 * isolation. So this file builds the four rows it needs under ids nothing else uses and deletes
 * them afterwards.
 */
const ORG = ulid('org', 'drn');
const PRJ = ulid('prj', 'drn');
const SVY = ulid('svy', 'drn');
const VER = ulid('ver', 'drn');
const PLAN = ulid('qp', 'plan');
const CELL = ulid('qc', 'cella');

let redis: Redis;
let pool: pg.Pool;
let drain: QuotaDrain;
let available = false;

const key = `q:${VER}:${PLAN}:A`;

beforeAll(async () => {
  redis = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 0 });
  try {
    await redis.connect();
    await redis.ping();
    if (DB_URL === '') throw new Error('no DATABASE_URL');
    pool = new pg.Pool({ connectionString: DB_URL, max: 2 });
    await seedIsolatedVersion();
    available = true;
  } catch (err: unknown) {
    // eslint-disable-next-line no-console
    console.error(`drain.test.ts: no Redis at ${REDIS_URL} or no DATABASE_URL — suite did not run: ${String(err)}`);
  }
  if (available) drain = createQuotaDrain({ redis, databaseUrl: DB_URL });
});

afterAll(async () => {
  if (!available) return;
  await drain.close();
  // Reverse dependency order, by hand. The `app` FKs here are NOT ON DELETE CASCADE (a survey is
  // not something an org deletion should silently take with it), and `runtime.quota_counters` has
  // no cascade from `app` at all because of the plane split — so every level is explicit.
  await pool.query('DELETE FROM runtime.quota_counters WHERE survey_version_id = $1', [VER]);
  await pool.query('DELETE FROM app.survey_versions WHERE id = $1', [VER]);
  await pool.query('DELETE FROM app.surveys WHERE id = $1', [SVY]);
  await pool.query('DELETE FROM app.projects WHERE id = $1', [PRJ]);
  await pool.query('DELETE FROM app.organizations WHERE id = $1', [ORG]);
  await pool.query('DELETE FROM auth.users WHERE id = $1', [
    '00000000-0000-0000-0000-0000000000dd',
  ]);
  await pool.end();
  await redis.quit();
});

/**
 * The minimum chain a `survey_versions` row needs: org → project → survey → version.
 *
 * `ON CONFLICT DO NOTHING` throughout so a crashed previous run leaves the suite runnable rather
 * than permanently red.
 */
async function seedIsolatedVersion(): Promise<void> {
  const actor = '00000000-0000-0000-0000-0000000000dd';
  // `created_by` references auth.users, so the actor has to exist. Inserted directly into the
  // Supabase auth table exactly as `ops.test_seed_two_orgs()` does — this suite needs an actor,
  // not an authenticated session.
  await pool.query(
    `INSERT INTO auth.users (id, email) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [actor, 'drain-suite@example.test'],
  );
  await pool.query(
    `INSERT INTO app.organizations (id, slug, name) VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [ORG, 'drain-suite', 'Drain suite'],
  );
  await pool.query(
    `INSERT INTO app.projects (id, org_id, ref, name, created_by) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT DO NOTHING`,
    [PRJ, ORG, 'DRAIN', 'Drain', actor],
  );
  await pool.query(
    `INSERT INTO app.surveys (id, org_id, project_id, ref, name, created_by)
     VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
    [SVY, ORG, PRJ, 'DRAIN', 'Drain', actor],
  );
  await pool.query(
    `INSERT INTO app.survey_versions (id, org_id, survey_id, version_no, schema_version, created_by)
     VALUES ($1, $2, $3, 1, 1, $4) ON CONFLICT DO NOTHING`,
    [VER, ORG, SVY, actor],
  );
}

/** A cell hash shaped exactly as the reserve script leaves it, plus the identity the drain reads. */
async function seedCell(committed: number, inFlight: number, target = 100): Promise<void> {
  await redis.hset(key, {
    committed: String(committed),
    in_flight: String(inFlight),
    target: String(target),
    mode: 'hard',
    cell_id: CELL,
    survey_version_id: VER,
    org_id: ORG,
    is_test: '0',
  });
  await redis.rpush(WRITE_BEHIND_KEY, key);
}

beforeEach(async () => {
  if (!available) return;
  await redis.del(WRITE_BEHIND_KEY, key, `${key}:holders`);
  const stale = await redis.keys('wb:quota:epoch:*');
  if (stale.length > 0) await redis.del(...stale);
  await pool.query('DELETE FROM runtime.quota_counters WHERE survey_version_id = $1', [VER]);
});

/**
 * A skipped suite must not read as a passing one.
 *
 * Every DB/Redis test below early-returns when the services are absent, which is the pattern
 * `quota.test.ts` uses — and on its own it produces a green run that asserted nothing about the
 * drain. This guard makes the absence itself visible: it FAILS unless `QUOTA_SUITE_OPTIONAL=1`
 * says a serviceless environment is expected. A green tick over an untested write-behind is how a
 * rewound counter ships.
 */
describe('the suite actually ran', () => {
  it('had Redis and Postgres available', () => {
    if (process.env['QUOTA_SUITE_OPTIONAL'] === '1' && !available) return;
    expect(
      available,
      'Redis and DATABASE_URL are required for the drain suite. Set QUOTA_SUITE_OPTIONAL=1 to ' +
        'allow skipping in an environment that deliberately has neither.',
    ).toBe(true);
  });
});

describe('splitCounterKey', () => {
  it('splits q:{scope}:{plan}:{cell} and keeps a cell key containing a colon whole', () => {
    // A bounded split, not `split(':')`: everything after the third colon is the cell key, and a
    // four-way split would silently truncate one that ever gained a colon.
    expect(splitCounterKey('q:v1:p1:M|18_24')).toEqual({
      scope: 'v1',
      planId: 'p1',
      cellKey: 'M|18_24',
    });
    expect(splitCounterKey('q:v1:p1:A:B')).toEqual({ scope: 'v1', planId: 'p1', cellKey: 'A:B' });
  });

  it('rejects anything that is not a counter key', () => {
    expect(splitCounterKey('res:session')).toBeUndefined();
    expect(splitCounterKey('q:only')).toBeUndefined();
    expect(splitCounterKey('')).toBeUndefined();
  });
});

describe('write-behind drain', () => {
  it('does nothing when nothing is dirty', async () => {
    if (!available) return;
    expect(await drain.drainOnce()).toEqual({ scanned: 0, written: 0 });
  });

  it('moves a cell\'s numbers from Redis into Postgres', async () => {
    if (!available) return;
    await seedCell(7, 2);

    const result = await drain.drainOnce();

    expect(result).toEqual({ scanned: 1, written: 1 });
    const r = await pool.query(
      'SELECT committed, in_flight, target, redis_epoch FROM runtime.quota_counters WHERE cell_id = $1',
      [CELL],
    );
    expect(r.rows[0]).toMatchObject({ committed: 7, in_flight: 2, target: 100 });
    expect(Number((r.rows[0] as { redis_epoch: string }).redis_epoch)).toBeGreaterThan(0);
  });

  it('empties the dirty list, so a second pass has nothing to do', async () => {
    if (!available) return;
    await seedCell(7, 2);
    await drain.drainOnce();

    expect(await drain.drainOnce()).toEqual({ scanned: 0, written: 0 });
    expect(await redis.llen(WRITE_BEHIND_KEY)).toBe(0);
  });

  it('deduplicates a cell dirtied several times in one interval', async () => {
    if (!available) return;
    await seedCell(7, 2);
    await redis.rpush(WRITE_BEHIND_KEY, key, key, key);

    // Four appends, one cell: a busy cell must cost one flush row, not four.
    expect(await drain.drainOnce()).toEqual({ scanned: 1, written: 1 });
  });

  it('skips a cell hash with no identity rather than guessing one', async () => {
    if (!available) return;
    // What a hash written by something other than the reserve script looks like. Inventing a
    // cell_id here would write a counter row for a cell that may not exist, and the counter table
    // deliberately has no FK into content (ADR-001's plane split) so nothing would catch it.
    await redis.hset(key, { committed: '5', in_flight: '0', target: '10' });
    await redis.rpush(WRITE_BEHIND_KEY, key);

    expect(await drain.drainOnce()).toEqual({ scanned: 1, written: 0 });
  });

  /* ------------------------------------------------------------------ *
   * THE test: a stale epoch must not rewind the record
   * ------------------------------------------------------------------ */
  it('does NOT let an out-of-order flush decrement Postgres', async () => {
    if (!available) return;
    // Pass 1 at committed 40 — the newer truth.
    await seedCell(40, 0);
    await drain.drainOnce();

    const after = await pool.query(
      'SELECT committed, redis_epoch FROM runtime.quota_counters WHERE cell_id = $1',
      [CELL],
    );
    const epochAfter = Number((after.rows[0] as { redis_epoch: string }).redis_epoch);
    expect(after.rows[0]).toMatchObject({ committed: 40 });

    // Now replay an OLDER flush by hand, exactly as a delayed drain process would: same cell,
    // lower committed, lower epoch. This is the shape the roadmap's test names.
    const written = await pool.query('SELECT runtime.flush_quota_counters($1::jsonb) AS written', [
      JSON.stringify([
        {
          survey_version_id: VER,
          cell_id: CELL,
          plan_id: PLAN,
          org_id: ORG,
          target: 100,
          committed: 11,
          in_flight: 9,
          is_test: false,
          redis_epoch: epochAfter - 1,
        },
      ]),
    ]);

    expect(Number((written.rows[0] as { written: number }).written)).toBe(0);
    const final = await pool.query(
      'SELECT committed, in_flight FROM runtime.quota_counters WHERE cell_id = $1',
      [CELL],
    );
    // The counter did not go backwards. A record that accepted this would make the cell
    // over-admit by 29 respondents.
    expect(final.rows[0]).toMatchObject({ committed: 40, in_flight: 0 });
  });

  it('issues a strictly increasing epoch per cell across passes', async () => {
    if (!available) return;
    // Redis's own INCR, not a clock: two drain processes racing on one cell would interleave
    // timestamps and the loser's value would look newer half the time.
    const epochs: number[] = [];
    for (const committed of [1, 2, 3]) {
      await seedCell(committed, 0);
      await drain.drainOnce();
      const r = await pool.query(
        'SELECT redis_epoch FROM runtime.quota_counters WHERE cell_id = $1',
        [CELL],
      );
      epochs.push(Number((r.rows[0] as { redis_epoch: string }).redis_epoch));
    }

    expect(epochs[1]).toBeGreaterThan(epochs[0] as number);
    expect(epochs[2]).toBeGreaterThan(epochs[1] as number);
    const last = await pool.query(
      'SELECT committed FROM runtime.quota_counters WHERE cell_id = $1',
      [CELL],
    );
    expect(last.rows[0]).toMatchObject({ committed: 3 });
  });
});

describe('the TTL sweeper', () => {
  it('reclaims an expired holder and decrements in_flight', async () => {
    if (!available) return;
    await seedCell(0, 1);
    await redis.zadd(`${key}:holders`, String(Date.now() - 1000), 'ses_expired');
    await redis.sadd('res:ses_expired', key);

    expect(await drain.sweepOnce([key])).toBe(1);
    expect(await redis.hget(key, 'in_flight')).toBe('0');
    expect(await redis.zcard(`${key}:holders`)).toBe(0);
    expect(await redis.sismember('res:ses_expired', key)).toBe(0);
  });

  it('leaves a live holder alone', async () => {
    if (!available) return;
    await seedCell(0, 1);
    await redis.zadd(`${key}:holders`, String(Date.now() + 60_000), 'ses_live');

    expect(await drain.sweepOnce([key])).toBe(0);
    expect(await redis.hget(key, 'in_flight')).toBe('1');
  });

  it('clamps in_flight at zero rather than letting it go negative', async () => {
    if (!available) return;
    // A double release would otherwise drive in_flight below zero, and a negative in_flight makes
    // a FULL cell look available — the failure mode is over-admission, not a cosmetic number.
    await seedCell(0, 0);
    await redis.zadd(`${key}:holders`, String(Date.now() - 1000), 'ses_a');

    await drain.sweepOnce([key]);

    expect(await redis.hget(key, 'in_flight')).toBe('0');
  });

  it('marks a swept cell dirty so the record learns about the reclaim', async () => {
    if (!available) return;
    await seedCell(0, 1);
    await redis.del(WRITE_BEHIND_KEY);
    await redis.zadd(`${key}:holders`, String(Date.now() - 1000), 'ses_expired');

    await drain.sweepOnce([key]);

    expect(await redis.lrange(WRITE_BEHIND_KEY, 0, -1)).toContain(key);
  });
});
