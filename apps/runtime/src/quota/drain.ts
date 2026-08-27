/**
 * The quota drain: write-behind to Postgres, the TTL sweeper, reconciliation, and rebuild.
 * Roadmap P2-07 ("write-behind drain from `wb:quota`", "a 30-second sweeper") and P2-08
 * ("a scheduled and on-demand job", "rebuild-Redis-from-Postgres-plus-events as a single job").
 *
 * ## Why these four live in one module
 *
 * They are the same loop's responsibilities and they share one invariant: **Redis is the arbiter
 * and Postgres is the record** (ADR-008). The drain moves the arbiter's numbers into the record;
 * the sweeper stops abandoned reservations from holding the arbiter's cells; reconciliation asks
 * the event log whether the record is right; rebuild puts the record back into the arbiter after
 * an outage. Split across four files they would each need their own copy of the epoch discipline
 * below, and the first one to get it wrong would be silent.
 *
 * ## The epoch is the whole correctness story of write-behind
 *
 * A drain is asynchronous, so two flushes can arrive out of order — the second carrying older
 * numbers than the first. `runtime.flush_quota_counters` refuses any row whose `redis_epoch` is
 * not strictly greater than the stored one, so a late flush is DROPPED rather than rewinding a
 * counter the arbiter has already moved forward. This module's job is to make the epoch it sends
 * monotonic per cell, which it does by reading Redis's own `INCR` counter rather than a clock: two
 * drain processes racing on the same cell would produce interleaved timestamps, and the loser's
 * value would look newer half the time.
 *
 * ## Nothing here decides anything about a respondent
 *
 * A drain that could block a session would be a second gate with different rules. Every function
 * in this file is either a background move of numbers or a read; the gate is `gateDecision` and it
 * stays the only thing that answers a respondent.
 */

import type { Redis } from 'ioredis';
import pg from 'pg';
import { createLogger } from '@resscript/observability';

const log = createLogger({ service: 'runtime-quota-drain' });

/** The Redis list the reserve/commit/release scripts append dirty cell keys to. */
export const WRITE_BEHIND_KEY = 'wb:quota';
/** The per-cell monotonic epoch counter. `INCR`, never a clock — see the module header. */
export const EPOCH_KEY = 'wb:quota:epoch';

export interface DrainDeps {
  readonly redis: Redis;
  readonly databaseUrl: string;
  /** Injected clock. Nothing here reads `Date.now()` directly, so a test can drive the sweeper. */
  readonly now?: () => number;
}

export interface DrainResult {
  /** Cells whose numbers were read from Redis and offered to Postgres. */
  readonly scanned: number;
  /** Rows Postgres actually accepted — fewer than `scanned` when a stale epoch was dropped. */
  readonly written: number;
}

interface CounterRow {
  readonly survey_version_id: string;
  readonly cell_id: string;
  readonly plan_id: string;
  readonly org_id: string;
  readonly target: number;
  readonly committed: number;
  readonly in_flight: number;
  readonly is_test: boolean;
  readonly redis_epoch: number;
}

/**
 * Parse `q:{scope}:{plan_id}:{cell_key}`.
 *
 * A bounded split rather than `split(':')`: bucket refs are validated identifiers joined with `|`,
 * so everything after the third colon is the cell key — and a four-way split would silently
 * truncate a cell key that ever gained a colon.
 */
export function splitCounterKey(
  key: string,
): { readonly scope: string; readonly planId: string; readonly cellKey: string } | undefined {
  if (!key.startsWith('q:')) return undefined;
  const rest = key.slice(2);
  const a = rest.indexOf(':');
  if (a < 0) return undefined;
  const b = rest.indexOf(':', a + 1);
  if (b < 0) return undefined;
  return { scope: rest.slice(0, a), planId: rest.slice(a + 1, b), cellKey: rest.slice(b + 1) };
}

export interface QuotaDrain {
  /** One pass: take the dirty set, read each cell, flush the batch. Safe to call concurrently. */
  drainOnce(): Promise<DrainResult>;
  /** Reclaim expired holders on the given cells. */
  sweepOnce(cellKeys: readonly string[]): Promise<number>;
  /** Recompute `committed` from the event log; returns the per-cell drift. */
  reconcile(surveyVersionId: string): Promise<readonly DriftRow[]>;
  /** Set `committed` to the recomputation for every drifting cell. Returns cells repaired. */
  repair(surveyVersionId: string): Promise<number>;
  /** Put Postgres-plus-events back into Redis after an outage. Returns cells rebuilt. */
  rebuildRedis(surveyVersionId: string): Promise<number>;
  close(): Promise<void>;
}

export interface DriftRow {
  readonly cell_id: string;
  readonly committed: number;
  readonly reconciled_committed: number;
  readonly drift: number;
  readonly in_flight_floor: number;
}

export function createQuotaDrain(deps: DrainDeps): QuotaDrain {
  const pool = new pg.Pool({
    connectionString: deps.databaseUrl,
    max: 4,
    statement_timeout: 60_000,
    // Same reasoning as every other pool in this app: the backend starts as runtime_writer before
    // its first query, so ADR-001 is enforced in the process rather than only in CI.
    options: '-c role=runtime_writer',
  });
  const now = deps.now ?? (() => Date.now());

  async function drainOnce(): Promise<DrainResult> {
    // RENAME, not read-then-delete. A concurrent drain (or a redeploy overlapping the old
    // process) would otherwise read the same keys and flush them twice — harmless for the
    // numbers, because the epoch guard makes a duplicate a no-op, but it doubles the work under
    // exactly the load where the drain is already behind. RENAME hands this pass its own private
    // list atomically and leaves later writers appending to a fresh one.
    const batchKey = `${WRITE_BEHIND_KEY}:batch:${String(now())}`;
    const renamed = await deps.redis
      .rename(WRITE_BEHIND_KEY, batchKey)
      .then(() => true)
      // `no such key` simply means nothing is dirty, which is the common case and not an error.
      .catch(() => false);
    if (!renamed) return { scanned: 0, written: 0 };

    const keys = [...new Set(await deps.redis.lrange(batchKey, 0, -1))];
    await deps.redis.del(batchKey);
    if (keys.length === 0) return { scanned: 0, written: 0 };

    const rows: CounterRow[] = [];
    for (const key of keys) {
      const parsed = splitCounterKey(key);
      if (!parsed) {
        log.warn('quota_drain_bad_key', { key });
        continue;
      }
      const hash = await deps.redis.hmget(
        key, 'committed', 'in_flight', 'target', 'cell_id', 'survey_version_id', 'org_id', 'is_test',
      );
      const cellId = hash[3];
      const versionId = hash[4];
      const orgId = hash[5];
      if (!cellId || !versionId || !orgId) {
        // A cell hash without its identity was written by something that is not the reserve
        // script. Skipped rather than guessed: inventing a cell_id here would write a counter row
        // for a cell that may not exist, and the FK would not catch it (the counter table
        // deliberately does not reference content, per ADR-001's plane split).
        log.warn('quota_drain_incomplete_hash', { key });
        continue;
      }
      // The epoch: Redis's own INCR, so it is monotonic across drain processes. A clock would
      // interleave between two racing drains and the loser's value would look newer half the time.
      const epoch = await deps.redis.incr(`${EPOCH_KEY}:${cellId}`);
      rows.push({
        survey_version_id: versionId,
        cell_id: cellId,
        plan_id: parsed.planId,
        org_id: orgId,
        target: Number(hash[2] ?? 0),
        committed: Number(hash[0] ?? 0),
        in_flight: Number(hash[1] ?? 0),
        is_test: hash[6] === '1' || hash[6] === 'true',
        redis_epoch: epoch,
      });
    }
    if (rows.length === 0) return { scanned: keys.length, written: 0 };

    const r = await pool.query('SELECT runtime.flush_quota_counters($1::jsonb) AS written', [
      JSON.stringify(rows),
    ]);
    const written = Number((r.rows[0] as { written: number } | undefined)?.written ?? 0);
    if (written < rows.length) {
      // Not an error: the epoch guard dropped a row a later flush had already superseded, which is
      // the guard doing its job. Logged at info because a persistent gap means two drains are
      // fighting and someone should know.
      log.info('quota_drain_epoch_drops', { offered: rows.length, written });
    }
    return { scanned: keys.length, written };
  }

  async function sweepOnce(cellKeys: readonly string[]): Promise<number> {
    let reclaimed = 0;
    const cutoff = now();
    for (const key of cellKeys) {
      // The holders ZSET is scored by expiry, so the expired members are a range query rather than
      // a scan — which is what lets a 30-second sweeper stay cheap on a survey with thousands of
      // cells.
      const expired = await deps.redis.zrangebyscore(`${key}:holders`, '-inf', String(cutoff));
      for (const sessionId of expired) {
        await deps.redis.zrem(`${key}:holders`, sessionId);
        const value = await deps.redis.hincrby(key, 'in_flight', -1);
        // Clamped, because a double release would otherwise drive in_flight negative and a
        // negative in_flight makes a full cell look available.
        if (value < 0) await deps.redis.hset(key, 'in_flight', 0);
        await deps.redis.srem(`res:${sessionId}`, key);
        reclaimed += 1;
      }
      if (expired.length > 0) await deps.redis.rpush(WRITE_BEHIND_KEY, key);
    }
    if (reclaimed > 0) log.info('quota_swept', { reclaimed, cells: cellKeys.length });
    return reclaimed;
  }

  return {
    drainOnce,
    sweepOnce,

    async reconcile(surveyVersionId): Promise<readonly DriftRow[]> {
      const r = await pool.query(
        `SELECT cell_id, committed, reconciled_committed, drift, in_flight_floor
           FROM runtime.reconcile_quota_counters($1)`,
        [surveyVersionId],
      );
      const rows = r.rows as DriftRow[];
      const drifting = rows.filter(row => row.drift !== 0);
      if (drifting.length > 0) {
        // The `quota.drift` signal the roadmap asks for. Emitted here rather than inside the SQL
        // function, because a database function that talked to an alert sink would be untestable
        // and would fire during a rolled-back transaction.
        log.error('quota.drift', {
          survey_version_id: surveyVersionId,
          cells: drifting.length,
          worst: Math.max(...drifting.map(row => Math.abs(row.drift))),
          detail: drifting.map(row => ({ cell_id: row.cell_id, drift: row.drift })),
        });
      }
      return rows;
    },

    async repair(surveyVersionId): Promise<number> {
      const r = await pool.query('SELECT runtime.repair_quota_counters($1) AS repaired', [
        surveyVersionId,
      ]);
      const repaired = Number((r.rows[0] as { repaired: number } | undefined)?.repaired ?? 0);
      if (repaired > 0) log.warn('quota_repaired', { survey_version_id: surveyVersionId, repaired });
      return repaired;
    },

    async rebuildRedis(surveyVersionId): Promise<number> {
      // The Redis half of "rebuild-Redis-from-Postgres-plus-events as a single job". The SQL half
      // (`quota_rebuild_state`) recomputes committed from the EVENT LOG rather than reading the
      // counter, because a rebuild exists precisely because the counters are suspect.
      const r = await pool.query(
        `SELECT plan_id, cell_id, cell_key, mode, target, committed, holders
           FROM runtime.quota_rebuild_state($1)`,
        [surveyVersionId],
      );
      const rows = r.rows as {
        plan_id: string;
        cell_id: string;
        cell_key: string;
        mode: string;
        target: number;
        committed: number;
        holders: string[];
      }[];

      for (const row of rows) {
        const key = `q:${surveyVersionId}:${row.plan_id}:${row.cell_key}`;
        // A pipeline per cell, so one cell is restored atomically enough that a gate reading it
        // mid-rebuild sees either the old state or the new one, never a target without a
        // committed. Cells are independent, so no cross-cell transaction is needed.
        const pipe = deps.redis.multi();
        pipe.hset(key, {
          committed: String(row.committed),
          // in_flight is rebuilt from the holders the record knows about, which is a FLOOR — the
          // same honesty the SQL side applies. A reservation that existed only in the lost Redis
          // is gone, and inventing it would block a cell nobody holds.
          in_flight: String(row.holders.length),
          target: String(row.target),
          mode: row.mode,
          cell_id: row.cell_id,
          survey_version_id: surveyVersionId,
          org_id: '',
        });
        pipe.del(`${key}:holders`);
        for (const sessionId of row.holders) {
          // Restored with a fresh expiry rather than the original: the original is unknowable
          // after the outage, and a hold restored already-expired would be swept before the
          // respondent could finish.
          pipe.zadd(`${key}:holders`, String(now() + 5_400_000), sessionId);
          pipe.sadd(`res:${sessionId}`, key);
        }
        await pipe.exec();
      }
      log.warn('quota_redis_rebuilt', { survey_version_id: surveyVersionId, cells: rows.length });
      return rows.length;
    },

    async close(): Promise<void> {
      await pool.end();
    },
  };
}

/**
 * The 30-second loop (P2-07's own number).
 *
 * Returns a stop function rather than running forever, because a process that cannot be shut down
 * cleanly leaks a connection pool on every redeploy. `unref` so the timer never holds the process
 * open by itself — a drain is a background chore, not a reason to stay alive.
 */
export function startQuotaDrainLoop(
  drain: QuotaDrain,
  opts: { readonly intervalMs?: number; readonly cellKeys?: () => readonly string[] } = {},
): () => void {
  const intervalMs = opts.intervalMs ?? 30_000;
  let running = false;
  const timer = setInterval(() => {
    // Skipped rather than queued if the previous pass is still going: overlapping drains are
    // safe (the epoch guard makes a duplicate flush a no-op) but they multiply load at exactly
    // the moment the drain is already struggling to keep up.
    if (running) return;
    running = true;
    void (async () => {
      try {
        await drain.drainOnce();
        const cells = opts.cellKeys?.() ?? [];
        if (cells.length > 0) await drain.sweepOnce(cells);
      } catch (err: unknown) {
        // A failed drain is not a respondent-facing failure: Redis is still the arbiter and the
        // gate still works. Logged and retried next tick.
        log.error('quota_drain_failed', { err: String(err) });
      } finally {
        running = false;
      }
    })();
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
