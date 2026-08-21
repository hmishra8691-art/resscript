/**
 * Quota gate tests — against REAL Redis.
 *
 * Deliberately not mocked: every load-bearing claim here (all-or-none atomicity, the one-script
 * reassign, NOSCRIPT recovery, the sweep's bounded walk) is a claim about Redis semantics, and a
 * mock asserts only that the mock was called. CI runs a Redis service; locally `redis-server
 * --daemonize yes` suffices. The suite skips with a loud message when none is reachable, because
 * a silently green quota suite that tested nothing is how a partial reservation ships.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import { createQuotaClient, gateDecision, type QuotaClient } from './index.js';

const URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';

let available = false;
let client: QuotaClient;
let raw: Redis;

beforeAll(async () => {
  raw = new Redis(URL, { lazyConnect: true, maxRetriesPerRequest: 0 });
  try {
    await raw.connect();
    await raw.ping();
    available = true;
  } catch {
    // eslint-disable-next-line no-console
    console.error('quota.test.ts: NO REDIS at ' + URL + ' — the quota suite did not run');
  }
  client = createQuotaClient(URL);
});

afterAll(async () => {
  if (available) {
    await client.close();
    await raw.quit();
  }
});

// Per-test namespace, so tests cannot see each other's counters and the suite needs no FLUSHDB
// (which would be hostile to a shared dev Redis).
let ns = '';
beforeEach(() => {
  ns = `q:test${Date.now()}${Math.floor(Math.random() * 1e6)}`;
});
const cell = (name: string) => `${ns}:MAIN:${name}`;
const hard = (name: string) => ({ key: cell(name), mode: 'hard' as const });
const soft = (name: string) => ({ key: cell(name), mode: 'soft' as const });

function skippable(name: string, fn: () => Promise<void>) {
  it(name, async ctx => {
    if (!available) return ctx.skip();
    await fn();
  });
}

describe('reserve_all_or_none (E §10.2)', () => {
  skippable('reserves every cell of an interlock together', async () => {
    await client.setTarget(cell('m_25'), 10);
    await client.setTarget(cell('ne'), 10);

    const r = await client.reserve('ses_a', [hard('m_25'), hard('ne')], 60);

    expect(r.ok).toBe(true);
    expect((await client.readCell(cell('m_25'))).in_flight).toBe(1);
    expect((await client.readCell(cell('ne'))).in_flight).toBe(1);
  });

  skippable('THE INTERLOCK: one full hard cell blocks, and NOTHING mutates', async () => {
    // The failure this prevents is invisible until delivery: a 3-way interlock that took two
    // of three cells skews the achieved sample silently.
    await client.setTarget(cell('open'), 10);
    await client.setTarget(cell('full'), 1);
    await client.reserve('ses_first', [hard('full')], 60);

    const r = await client.reserve('ses_b', [hard('open'), hard('full')], 60);

    expect(r.ok).toBe(false);
    expect(r.blocked).toEqual([cell('full')]);
    expect((await client.readCell(cell('open'))).in_flight).toBe(0); // pass 1 touched nothing
  });

  skippable('records EVERY full hard cell, not just the first', async () => {
    // The QA panel needs the complete list — an early return would report one cell per
    // attempt and QA would fix them one reload at a time.
    await client.setTarget(cell('f1'), 1);
    await client.setTarget(cell('f2'), 1);
    await client.reserve('ses_x', [hard('f1'), hard('f2')], 60);

    const r = await client.reserve('ses_y', [hard('f1'), hard('f2')], 60);

    expect([...r.blocked].sort()).toEqual([cell('f1'), cell('f2')].sort());
  });

  skippable('a soft-full cell never blocks (ADR-008)', async () => {
    await client.setTarget(cell('soft_ne'), 1);
    await client.reserve('ses_1', [soft('soft_ne')], 60);

    const r = await client.reserve('ses_2', [soft('soft_ne')], 60);

    expect(r.ok).toBe(true);
    expect(r.soft_full).toEqual([cell('soft_ne')]);
    // It still counts — soft quotas report, they do not gate.
    expect((await client.readCell(cell('soft_ne'))).in_flight).toBe(2);
  });

  skippable('a zero-target cell is uncapped', async () => {
    const r = await client.reserve('ses_z', [hard('untargeted')], 60);
    expect(r.ok).toBe(true);
  });
});

describe('the reservation lifecycle (E §10.3)', () => {
  skippable('commit converts in_flight to committed, once', async () => {
    await client.setTarget(cell('c'), 10);
    await client.reserve('ses_c', [hard('c')], 60);

    expect(await client.commit('ses_c')).toBe(1);
    expect(await client.readCell(cell('c'))).toMatchObject({ committed: 1, in_flight: 0 });
    // A second commit finds nothing — the res: set is gone, so a retried COMPLETING is inert.
    expect(await client.commit('ses_c')).toBe(0);
    expect((await client.readCell(cell('c'))).committed).toBe(1);
  });

  skippable('release returns the slot without committing', async () => {
    await client.setTarget(cell('r'), 10);
    await client.reserve('ses_r', [hard('r')], 60);

    await client.release('ses_r');

    expect(await client.readCell(cell('r'))).toMatchObject({ committed: 0, in_flight: 0 });
  });

  skippable('release floors in_flight at zero', async () => {
    // The sweep and a race can double-release; a negative in_flight would under-report fill
    // and overshoot the cell.
    await client.setTarget(cell('fl'), 10);
    await client.reserve('ses_f', [hard('fl')], 60);
    await client.release('ses_f');
    await raw.sadd('res:ses_f', cell('fl')); // simulate a stale res: entry
    await client.release('ses_f');

    expect((await client.readCell(cell('fl'))).in_flight).toBe(0);
  });

  skippable('the sweep reclaims expired holders and only expired ones', async () => {
    await client.setTarget(cell('s'), 10);
    await client.reserve('ses_old', [hard('s')], 60);
    await client.reserve('ses_new', [hard('s')], 60);
    // Backdate ses_old's holder entry to the past.
    await raw.zadd(`${cell('s')}:holders`, Date.now() - 1000, 'ses_old');

    const reclaimed = await client.sweep([cell('s')], Date.now());

    expect(reclaimed).toBe(1);
    expect((await client.readCell(cell('s'))).in_flight).toBe(1); // ses_new survives
  });
});

describe('reassign — E §7.4, one script', () => {
  skippable('moves a respondent between cells atomically', async () => {
    await client.setTarget(cell('age_25'), 10);
    await client.setTarget(cell('age_35'), 10);
    await client.reserve('ses_m', [hard('age_25')], 60);

    const r = await client.reassign('ses_m', [hard('age_35')], 60);

    expect(r.ok).toBe(true);
    expect((await client.readCell(cell('age_25'))).in_flight).toBe(0);
    expect((await client.readCell(cell('age_35'))).in_flight).toBe(1);
  });

  skippable('when the new cell is full, the old reservation is NOT restored', async () => {
    // They moved out of it honestly (E §7.4): restoring would hold a cell their answers no
    // longer qualify them for.
    await client.setTarget(cell('from'), 10);
    await client.setTarget(cell('to'), 1);
    await client.reserve('ses_other', [hard('to')], 60);
    await client.reserve('ses_mv', [hard('from')], 60);

    const r = await client.reassign('ses_mv', [hard('to')], 60);

    expect(r.ok).toBe(false);
    expect((await client.readCell(cell('from'))).in_flight).toBe(0); // released, not restored
    expect((await client.readCell(cell('to'))).in_flight).toBe(1);  // the incumbent keeps it
  });
});

describe('test mode and fail policy (E §14.1, ADR-008)', () => {
  skippable('evaluateOnly reports the decision and moves NOTHING', async () => {
    await client.setTarget(cell('t'), 1);
    await client.reserve('ses_real', [hard('t')], 60);

    const d = await gateDecision(client, 'ses_test', [hard('t')], {
      isTest: true, ttlSeconds: 60, onUnavailable: 'fail_closed',
    });

    expect(d.decision).toBe('would_be_full');
    const after = await client.readCell(cell('t'));
    expect(after).toMatchObject({ committed: 0, in_flight: 1 }); // only the real session's
    expect(await raw.exists('res:ses_test')).toBe(0);            // no reservation set at all
  });

  skippable('would_reserve when the cell has room — still nothing moves', async () => {
    await client.setTarget(cell('t2'), 5);
    const d = await gateDecision(client, 'ses_test2', [hard('t2')], {
      isTest: true, ttlSeconds: 60, onUnavailable: 'fail_closed',
    });

    expect(d.decision).toBe('would_reserve');
    expect((await client.readCell(cell('t2'))).in_flight).toBe(0);
  });

  it('an unreachable store fails per the survey policy, not per a default', async () => {
    // A client pointed at nothing: both policies must produce their named decision, because
    // ADR-008 says there is no safe default and the owner chose.
    const dead = createQuotaClient('redis://127.0.0.1:1');
    const open = await gateDecision(dead, 'ses_o', [hard('x')], {
      isTest: false, ttlSeconds: 60, onUnavailable: 'fail_open',
    });
    const closed = await gateDecision(dead, 'ses_c', [hard('x')], {
      isTest: false, ttlSeconds: 60, onUnavailable: 'fail_closed',
    });
    await dead.close().catch(() => {});

    expect(open.decision).toBe('unavailable_fail_open');
    expect(closed.decision).toBe('unavailable_fail_closed');
  }, 15_000);

  skippable('scripts survive a SCRIPT FLUSH (the NOSCRIPT fallback)', async () => {
    await client.setTarget(cell('ns'), 10);
    await client.reserve('ses_n1', [hard('ns')], 60); // loads the script
    await raw.script('FLUSH');                        // a failover empties the cache

    const r = await client.reserve('ses_n2', [hard('ns')], 60);

    expect(r.ok).toBe(true);
    expect((await client.readCell(cell('ns'))).in_flight).toBe(2);
  });
});
