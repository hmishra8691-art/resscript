/**
 * The Postgres `QuotaStore` — the correctness baseline (E §10, ADR-008, roadmap P2-06).
 *
 * Roadmap P2-06 ships this deliberately, and says why: *"This is not wasted work: it gives a
 * correctness baseline against which the Redis implementation is diffed, and it is the fallback
 * path for a Redis outage."* Both halves matter, and the second is the operationally important
 * one — ADR-008's `fail_closed` screens every respondent out while Redis is down, which protects
 * the client's budget and stops the field dead. A store that can still answer, more slowly, is
 * strictly better than a survey that cannot run.
 *
 * ## Atomicity comes from one statement, not from a transaction wrapper
 *
 * The property that matters is E §10's ALL-OR-NONE across an interlock: a 3-way interlock must
 * take all three cells or none, because a partial reservation silently skews the achieved sample
 * and is invisible until the data is delivered. Redis gets that from a Lua script; here it comes
 * from a single `UPDATE … WHERE NOT EXISTS (a full cell in the set)`. One statement, so there is
 * no window between the check and the mutation for a concurrent reservation to slip through, and
 * no possibility of committing two of three cells.
 *
 * `SELECT … FOR UPDATE` then `UPDATE` would also be correct under `READ COMMITTED`, and is what
 * most implementations reach for. It is avoided because it takes locks in row order and two
 * concurrent interlocks touching the same cells in different orders deadlock — which under load
 * is a 40001 storm rather than a wrong answer, but a respondent still sees a failed gate. The
 * single-statement form takes its locks in one pass in a fixed order (the ORDER BY inside the
 * CTE), which is the standard cure and costs nothing.
 *
 * ## What this store does NOT try to be
 *
 * It is not fast. A reservation is a round trip to Postgres and a row lock per cell, against
 * Redis's sub-millisecond EVALSHA — that gap is exactly what P2-09's load rig measures and what
 * ADR-008 rests on. It also does not implement the `:holders` sweep: a Postgres reservation's
 * expiry is a column (`held_until`), so an abandoned hold is reclaimed by the same predicate
 * that reads it rather than by a background sweeper. Fewer moving parts for the fallback path is
 * the right trade; the sweeper exists on the Redis side because a ZSET has no TTL per member.
 */

import pg from 'pg';
import { createLogger } from '@resscript/observability';
import type { CellSpec, QuotaClient, ReserveResult } from './index.js';

const log = createLogger({ service: 'runtime-quota-pg' });

/** Parsed back out of `q:{scope}:{plan_id}:{cell_key}` — see `CellSpec.key`. */
export interface ParsedCellKey {
  readonly scope: string;
  readonly planId: string;
  readonly cellKey: string;
}

/**
 * Split a counter key into its three parts.
 *
 * The cell key may itself contain `:`? No — bucket refs are validated identifiers (schema §3) and
 * joined with `|`, so the first three segments are unambiguous and everything after the third
 * colon is the cell key. Written as a bounded split rather than `split(':')` for exactly that
 * reason: a four-segment split would silently truncate a cell key that ever gained a colon.
 */
export function parseCellKey(key: string): ParsedCellKey | undefined {
  if (!key.startsWith('q:')) return undefined;
  const rest = key.slice(2);
  const firstColon = rest.indexOf(':');
  if (firstColon < 0) return undefined;
  const secondColon = rest.indexOf(':', firstColon + 1);
  if (secondColon < 0) return undefined;
  return {
    scope: rest.slice(0, firstColon),
    planId: rest.slice(firstColon + 1, secondColon),
    cellKey: rest.slice(secondColon + 1),
  };
}

export interface PgQuotaStoreOptions {
  readonly databaseUrl: string;
  /**
   * The version whose counters these are. Required, and NOT derived from the key's `scope`:
   * `counter_scope: 'survey'` makes the scope a survey id, while the counter table is keyed by
   * version — so the two are different identifiers and conflating them would write a tracker's
   * shared counters into one wave's rows.
   *
   * There is deliberately no `orgId` here. B §2 forbids a runtime RPC from taking an org id — a
   * caller-supplied one is a cross-tenant write vector — so every function derives it from the
   * version row inside its definer body. 0004's and 0009's pgTAP suites scan the catalog and fail
   * the build if any function in schema runtime grows such a parameter, which is how the first
   * draft of this store was caught.
   */
  readonly surveyVersionId: string;
  /** Injected clock, so the expiry predicate is testable without waiting. */
  readonly now?: () => number;
}

/**
 * A Postgres-backed quota store.
 *
 * Reservations are rows in `runtime.quota_holds` with an expiry; `committed` and `in_flight` on
 * `runtime.quota_counters` are maintained by the same statements, so the durable record and the
 * live state are the same thing here — which is precisely what makes this the baseline the Redis
 * implementation is diffed against.
 */
export function createPgQuotaStore(opts: PgQuotaStoreOptions): QuotaClient {
  const pool = new pg.Pool({
    connectionString: opts.databaseUrl,
    max: 8,
    statement_timeout: 5_000,
    // Same reasoning as `createPgWriter`: every backend starts as runtime_writer before its
    // first query, so ADR-001 is enforced in the process and not only in CI. A GUC rather than
    // a connect hook, because the hook does not await and its query would race the caller's.
    options: '-c role=runtime_writer',
  });
  const now = opts.now ?? (() => Date.now());

  async function call<T = unknown>(sql: string, params: readonly unknown[]): Promise<T[]> {
    const r = await pool.query(sql, params as unknown[]);
    return r.rows as T[];
  }

  return {
    async reserve(sessionId, cells, ttlSeconds): Promise<ReserveResult> {
      if (cells.length === 0) return { ok: true, soft_full: [], blocked: [] };
      const rows = await call<{ ok: boolean; soft_full: string[]; blocked: string[] }>(
        'SELECT ok, soft_full, blocked FROM runtime.quota_reserve($1,$2,$3,$4,$5)',
        [
          opts.surveyVersionId,
          sessionId,
          cells.map(c => c.key),
          cells.map(c => c.mode),
          ttlSeconds,
        ],
      );
      const row = rows[0];
      if (!row) {
        // A function that returned no row is a bug, not a full cell — and reporting "full" here
        // would screen a respondent out for an internal failure. Fail loudly instead; the caller's
        // `gateDecision` turns a throw into the survey's declared `on_store_unavailable` policy,
        // which is the author's decision rather than ours.
        throw new Error('quota_reserve returned no row');
      }
      return { ok: row.ok, soft_full: row.soft_full ?? [], blocked: row.blocked ?? [] };
    },

    async evaluateOnly(cells): Promise<ReserveResult> {
      if (cells.length === 0) return { ok: true, soft_full: [], blocked: [] };
      // E §14.1: a test session must issue NO mutation. This is a pure read, and the named wrong
      // answer — reserve then release — would leak a hold and briefly block real respondents on a
      // nearly-full cell.
      const rows = await call<{ ok: boolean; soft_full: string[]; blocked: string[] }>(
        'SELECT ok, soft_full, blocked FROM runtime.quota_evaluate($1,$2,$3)',
        [opts.surveyVersionId, cells.map(c => c.key), cells.map(c => c.mode)],
      );
      const row = rows[0];
      if (!row) throw new Error('quota_evaluate returned no row');
      return { ok: row.ok, soft_full: row.soft_full ?? [], blocked: row.blocked ?? [] };
    },

    async commit(sessionId): Promise<number> {
      const rows = await call<{ cells: number }>(
        'SELECT runtime.quota_commit($1,$2) AS cells',
        [opts.surveyVersionId, sessionId],
      );
      return rows[0]?.cells ?? 0;
    },

    async release(sessionId): Promise<number> {
      const rows = await call<{ cells: number }>(
        'SELECT runtime.quota_release($1,$2) AS cells',
        [opts.surveyVersionId, sessionId],
      );
      return rows[0]?.cells ?? 0;
    },

    async reassign(sessionId, newCells, ttlSeconds): Promise<ReserveResult> {
      // E §7.4's release-then-reserve, in ONE statement for the same reason `reserve` is one:
      // a back-navigation that released the old cells and then failed to take the new ones would
      // leave the respondent counted against nothing, which is worse than either outcome.
      const rows = await call<{ ok: boolean; soft_full: string[]; blocked: string[] }>(
        'SELECT ok, soft_full, blocked FROM runtime.quota_reassign($1,$2,$3,$4,$5)',
        [
          opts.surveyVersionId,
          sessionId,
          newCells.map(c => c.key),
          newCells.map(c => c.mode),
          ttlSeconds,
        ],
      );
      const row = rows[0];
      if (!row) throw new Error('quota_reassign returned no row');
      return { ok: row.ok, soft_full: row.soft_full ?? [], blocked: row.blocked ?? [] };
    },

    async setTarget(cellKey, target): Promise<void> {
      const parsed = parseCellKey(cellKey);
      if (!parsed) throw new Error(`not a quota cell key: ${cellKey}`);
      await call('SELECT runtime.quota_set_target($1,$2,$3,$4)', [
        opts.surveyVersionId,
        parsed.planId,
        parsed.cellKey,
        target,
      ]);
    },

    async readCell(cellKey): Promise<{ committed: number; in_flight: number; target: number }> {
      const parsed = parseCellKey(cellKey);
      if (!parsed) throw new Error(`not a quota cell key: ${cellKey}`);
      const rows = await call<{ committed: number; in_flight: number; target: number }>(
        `SELECT committed, in_flight, target
           FROM runtime.quota_read_cell($1,$2,$3)`,
        [opts.surveyVersionId, parsed.planId, parsed.cellKey],
      );
      return rows[0] ?? { committed: 0, in_flight: 0, target: 0 };
    },

    async sweep(_cellKeys, nowMs): Promise<number> {
      // No `:holders` ZSET to walk: a Postgres hold carries `held_until`, so expiry is a
      // predicate the reservation path already applies. This call exists to satisfy the
      // interface and to let an operator force the reclaim, and it returns the number of holds
      // actually reclaimed so a caller can see whether it did anything.
      const rows = await call<{ reclaimed: number }>(
        'SELECT runtime.quota_sweep($1,$2) AS reclaimed',
        [opts.surveyVersionId, new Date(nowMs ?? now()).toISOString()],
      );
      const reclaimed = rows[0]?.reclaimed ?? 0;
      if (reclaimed > 0) log.info('quota_pg_swept', { reclaimed });
      return reclaimed;
    },

    async close(): Promise<void> {
      await pool.end();
    },
  };
}
