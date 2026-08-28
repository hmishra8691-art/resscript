/**
 * Quota gate mechanics — E §10, ADR-008.
 *
 * Two counters per cell (`committed`, `in_flight`), Redis as the arbiter, Postgres (the event
 * log) as the record, and ALL-OR-NONE reservation across interlocked dimensions. Atomicity is
 * the entire point: a 3-way interlock must take all three cells or none, because a partial
 * reservation silently skews the achieved sample and is invisible until the data is delivered.
 *
 * ## Key layout (E §10.1)
 *
 * ```
 * q:{scope}:{plan_id}:{cell_key}   HASH { committed, in_flight, target, mode }
 * res:{session_id}                 SET of held cell keys, TTL = reservation_ttl_s
 * {cell}:holders                   ZSET session_id -> expiry_ms, for the sweep
 * ```
 *
 * `scope` is the version id or the survey id per the plan's `counter_scope` — a tracker keeps
 * one set of counters across waves (`survey`), an ad-hoc study starts fresh per publish
 * (`version`). Getting this wrong resets a client's quota mid-field, so it is the caller's
 * explicit input, never inferred.
 *
 * ## Scripts pre-loaded by SHA
 *
 * `SCRIPT LOAD` at first use, `EVALSHA` on the hot path, `NOSCRIPT` fallback that reloads
 * (E §16.4). `EVAL` would ship the script body on every reservation.
 *
 * ## Test mode issues NO Redis mutation
 *
 * E §14.1 is emphatic, and the wrong implementation is named: "reserve, then release at the
 * end" leaks reservations when a test session abandons and briefly blocks real respondents on
 * a nearly-full cell. A test session calls `evaluateOnly`, which READS the counters and
 * reports `would_reserve | would_be_full` — QA sees the decision, the counters never move.
 */

import { Redis } from 'ioredis';
import { createLogger } from '@resscript/observability';

const log = createLogger({ service: 'runtime-quota' });

/* ------------------------------------------------------------------ *
 * Scripts — E §10.2, structured exactly as the spec writes them
 * ------------------------------------------------------------------ */

/**
 * reserve_all_or_none. KEYS = cell hashes; ARGV = [session_id, ttl_s, now_ms, mode...].
 * Returns { ok, soft_full[], blocked[] }.
 *
 * PASS 1 checks every cell before mutating any, and records ALL full hard cells rather than
 * early-returning — the QA panel needs to show every full cell, not just the first one hit.
 * PASS 2 is only reached when every hard cell had room.
 */
/**
 * The write-behind list the mutating scripts append a dirty cell key to.
 *
 * Defined HERE, on the writer side, and imported by `drain.ts` — not the other way round. The
 * drain imports `pg`, and a dependency from this module to that one would pull a Postgres driver
 * into the request path for the sake of one string.
 *
 * That the scripts append at all is new. `drain.ts` has always described this as "the Redis list
 * the reserve/commit/release scripts append dirty cell keys to" and they never did, so
 * `drainOnce` scanned an empty list on every pass and `runtime.quota_counters` was never written —
 * the third and last missing link in ADR-008's record half.
 */
export const WRITE_BEHIND_KEY = 'wb:quota';

const RESERVE = `
local blocked, soft_full = {}, {}

for i = 1, #KEYS do
  local mode      = ARGV[3 + i]
  local h         = redis.call('HMGET', KEYS[i], 'committed', 'in_flight', 'target')
  local committed = tonumber(h[1]) or 0
  local inflight  = tonumber(h[2]) or 0
  local target    = tonumber(h[3]) or 0

  if target > 0 and (committed + inflight) >= target then
    if mode == 'hard' then
      blocked[#blocked + 1] = KEYS[i]
    else
      soft_full[#soft_full + 1] = KEYS[i]
    end
  end
end

if #blocked > 0 then
  return { 0, soft_full, blocked }
end

local reskey = 'res:' .. ARGV[1]
for i = 1, #KEYS do
  redis.call('HINCRBY', KEYS[i], 'in_flight', 1)
  redis.call('SADD', reskey, KEYS[i])
  redis.call('ZADD', KEYS[i] .. ':holders',
             tonumber(ARGV[3]) + tonumber(ARGV[2]) * 1000, ARGV[1])
  -- Mark the cell dirty for the write-behind drain. AFTER the all-or-none decision above, so a
  -- refused reservation never enqueues work; inside the same script, so a mutation and its dirty
  -- mark cannot be separated by a crash.
  redis.call('RPUSH', '${WRITE_BEHIND_KEY}', KEYS[i])
end
redis.call('EXPIRE', reskey, tonumber(ARGV[2]))
return { 1, soft_full, {} }
`;

/** commit: called once, at COMPLETING. Converts every held reservation. */
const COMMIT = `
local reskey = 'res:' .. ARGV[1]
local held = redis.call('SMEMBERS', reskey)
for i = 1, #held do
  redis.call('HINCRBY', held[i], 'committed', 1)
  redis.call('HINCRBY', held[i], 'in_flight', -1)
  redis.call('ZREM', held[i] .. ':holders', ARGV[1])
  redis.call('RPUSH', '${WRITE_BEHIND_KEY}', held[i])
end
redis.call('DEL', reskey)
return #held
`;

/** release: any non-COMPLETE disposition, and the expiry sweep. */
const RELEASE = `
local reskey = 'res:' .. ARGV[1]
local held = redis.call('SMEMBERS', reskey)
for i = 1, #held do
  local v = redis.call('HINCRBY', held[i], 'in_flight', -1)
  if v < 0 then redis.call('HSET', held[i], 'in_flight', 0) end
  redis.call('ZREM', held[i] .. ':holders', ARGV[1])
  redis.call('RPUSH', '${WRITE_BEHIND_KEY}', held[i])
end
redis.call('DEL', reskey)
return #held
`;

/**
 * release-then-reserve, ONE script (E §7.4): a back-navigation that moved the respondent to a
 * different cell. Two round trips would leave a millisecond window where they hold nothing and
 * a competing session takes the new cell — at 500 submits/sec that window fires daily. In one
 * script the only failure mode is "the new cell was full", which is a correct outcome rather
 * than a lost reservation. Note the old reservation is NOT restored on failure: they moved out
 * of it honestly.
 *
 * KEYS = new cell hashes; ARGV = [session_id, ttl_s, now_ms, modes...].
 */
const REASSIGN = `
local reskey = 'res:' .. ARGV[1]
local held = redis.call('SMEMBERS', reskey)
for i = 1, #held do
  local v = redis.call('HINCRBY', held[i], 'in_flight', -1)
  if v < 0 then redis.call('HSET', held[i], 'in_flight', 0) end
  redis.call('ZREM', held[i] .. ':holders', ARGV[1])
end
redis.call('DEL', reskey)

local blocked, soft_full = {}, {}
for i = 1, #KEYS do
  local mode      = ARGV[3 + i]
  local h         = redis.call('HMGET', KEYS[i], 'committed', 'in_flight', 'target')
  local committed = tonumber(h[1]) or 0
  local inflight  = tonumber(h[2]) or 0
  local target    = tonumber(h[3]) or 0
  if target > 0 and (committed + inflight) >= target then
    if mode == 'hard' then blocked[#blocked + 1] = KEYS[i]
    else soft_full[#soft_full + 1] = KEYS[i] end
  end
end
if #blocked > 0 then
  return { 0, soft_full, blocked }
end
for i = 1, #KEYS do
  redis.call('HINCRBY', KEYS[i], 'in_flight', 1)
  redis.call('SADD', reskey, KEYS[i])
  redis.call('ZADD', KEYS[i] .. ':holders',
             tonumber(ARGV[3]) + tonumber(ARGV[2]) * 1000, ARGV[1])
end
redis.call('EXPIRE', reskey, tonumber(ARGV[2]))
return { 1, soft_full, {} }
`;

/**
 * The expiry sweep for ONE cell (E §10.3 mechanism 1): expired holders found by score,
 * decremented, removed. Bounded work per cell, no keyspace scan. The caller iterates known
 * cells; the reconciliation job (ADR-008) repairs anything this missed from the event log.
 */
const SWEEP_CELL = `
local expired = redis.call('ZRANGEBYSCORE', KEYS[1] .. ':holders', '-inf', ARGV[1])
for i = 1, #expired do
  local v = redis.call('HINCRBY', KEYS[1], 'in_flight', -1)
  if v < 0 then redis.call('HSET', KEYS[1], 'in_flight', 0) end
  redis.call('ZREM', KEYS[1] .. ':holders', expired[i])
  redis.call('SREM', 'res:' .. expired[i], KEYS[1])
end
return #expired
`;

/* ------------------------------------------------------------------ *
 * The client
 * ------------------------------------------------------------------ */

export interface CellSpec {
  /** `q:{scope}:{plan_id}:{cell_key}` — built by the caller, who knows counter_scope. */
  readonly key: string;
  readonly mode: 'hard' | 'soft';
}

export interface ReserveResult {
  readonly ok: boolean;
  readonly soft_full: readonly string[];
  readonly blocked: readonly string[];
}

export interface QuotaDecision {
  readonly decision:
    | 'reserved' | 'full' | 'soft_full'
    | 'would_reserve' | 'would_be_full'
    | 'unavailable_fail_open' | 'unavailable_fail_closed';
  readonly soft_full: readonly string[];
  readonly blocked: readonly string[];
}

export interface QuotaClient {
  /** All-or-none across every cell the respondent occupies. Production sessions only. */
  reserve(sessionId: string, cells: readonly CellSpec[], ttlSeconds: number): Promise<ReserveResult>;
  /** Read-only evaluation for test mode (E §14.1): the counters never move. */
  evaluateOnly(cells: readonly CellSpec[]): Promise<ReserveResult>;
  commit(sessionId: string): Promise<number>;
  release(sessionId: string): Promise<number>;
  /** E §7.4's one-script release-then-reserve for a quota-moving back-navigation. */
  reassign(sessionId: string, newCells: readonly CellSpec[], ttlSeconds: number): Promise<ReserveResult>;
  /** Seed a cell's target — the publish path's job in production; tests and dev use it too. */
  setTarget(cellKey: string, target: number): Promise<void>;
  readCell(cellKey: string): Promise<{ committed: number; in_flight: number; target: number }>;
  sweep(cellKeys: readonly string[], nowMs: number): Promise<number>;
  close(): Promise<void>;
}

/**
 * The gate decision, with ADR-008's fail-open/fail-closed applied when Redis is unreachable.
 *
 * There is no safe default; the survey owner chose (`on_store_unavailable`) and the choice is
 * in the artifact. Fail-open MUST flag the session `quota_unverified` — the caller's duty —
 * because overshoot that cannot be identified afterwards is indistinguishable from data.
 */
export async function gateDecision(
  client: QuotaClient,
  sessionId: string,
  cells: readonly CellSpec[],
  opts: {
    readonly isTest: boolean;
    readonly ttlSeconds: number;
    readonly onUnavailable: 'fail_open' | 'fail_closed';
  },
): Promise<QuotaDecision> {
  try {
    if (opts.isTest) {
      // No mutation, ever, in test mode — see the module header for why reserve-then-release
      // is the named wrong answer.
      const r = await client.evaluateOnly(cells);
      return {
        decision: r.ok ? 'would_reserve' : 'would_be_full',
        soft_full: r.soft_full,
        blocked: r.blocked,
      };
    }
    const r = await client.reserve(sessionId, cells, opts.ttlSeconds);
    return {
      decision: r.ok ? (r.soft_full.length > 0 ? 'soft_full' : 'reserved') : 'full',
      soft_full: r.soft_full,
      blocked: r.blocked,
    };
  } catch (err) {
    log.error('quota_store_unavailable', { session_id: sessionId, err: String(err) });
    return {
      decision: opts.onUnavailable === 'fail_open'
        ? 'unavailable_fail_open'
        : 'unavailable_fail_closed',
      soft_full: [],
      blocked: [],
    };
  }
}

export function createQuotaClient(redisUrl: string): QuotaClient {
  let client: Redis | null = null;
  // Bounded failure is part of the CONTRACT, not tuning: ioredis defaults retry forever,
  // which converts a Redis outage at a quota gate into a hung respondent request — the exact
  // situation on_store_unavailable exists to decide. One retry per command, a 1 s dial
  // timeout, reconnection attempts capped at 2: the gate learns the store is down inside the
  // request budget and fails per the survey's chosen policy instead of per a socket's
  // patience. The offline queue stays ON — it is what lets the first command ride out the
  // initial lazy dial — and the capped retryStrategy is what drains it with errors when the
  // dial cannot succeed.
  const redis = () =>
    (client ??= new Redis(redisUrl, {
      maxRetriesPerRequest: 1,
      connectTimeout: 1_000,
      retryStrategy: times => (times > 2 ? null : 200),
    }));

  // SHA cache per script. ioredis defineCommand would also work; explicit EVALSHA keeps the
  // NOSCRIPT fallback visible, which is the part that breaks at 3 a.m. after a failover.
  const shas = new Map<string, string>();
  async function run(name: string, script: string, keys: readonly string[], argv: readonly (string | number)[]) {
    let sha = shas.get(name);
    if (!sha) {
      sha = (await redis().script('LOAD', script)) as string;
      shas.set(name, sha);
    }
    try {
      return await redis().evalsha(sha, keys.length, ...keys, ...argv);
    } catch (err) {
      if (String(err).includes('NOSCRIPT')) {
        // A failover or FLUSHSCRIPT emptied the cache: reload once and retry. Never EVAL on
        // the hot path — that ships the body every call.
        sha = (await redis().script('LOAD', script)) as string;
        shas.set(name, sha);
        return await redis().evalsha(sha, keys.length, ...keys, ...argv);
      }
      throw err;
    }
  }

  const toResult = (raw: unknown): ReserveResult => {
    const [ok, soft, blocked] = raw as [number, string[], string[]];
    return { ok: ok === 1, soft_full: soft ?? [], blocked: blocked ?? [] };
  };

  return {
    async reserve(sessionId, cells, ttlSeconds) {
      return toResult(await run('reserve', RESERVE,
        cells.map(c => c.key),
        [sessionId, ttlSeconds, Date.now(), ...cells.map(c => c.mode)]));
    },

    async evaluateOnly(cells) {
      // A plain pipeline of HMGETs — reads, no script, no mutation.
      const pipe = redis().pipeline();
      for (const c of cells) pipe.hmget(c.key, 'committed', 'in_flight', 'target');
      const rows = (await pipe.exec()) ?? [];
      const soft_full: string[] = [];
      const blocked: string[] = [];
      rows.forEach((row, i) => {
        const [committed, inflight, target] = ((row?.[1] ?? []) as (string | null)[]).map(
          v => Number(v) || 0,
        );
        const cell = cells[i]!;
        if ((target ?? 0) > 0 && (committed ?? 0) + (inflight ?? 0) >= (target ?? 0)) {
          (cell.mode === 'hard' ? blocked : soft_full).push(cell.key);
        }
      });
      return { ok: blocked.length === 0, soft_full, blocked };
    },

    async commit(sessionId) {
      return (await run('commit', COMMIT, [], [sessionId])) as number;
    },

    async release(sessionId) {
      return (await run('release', RELEASE, [], [sessionId])) as number;
    },

    async reassign(sessionId, newCells, ttlSeconds) {
      return toResult(await run('reassign', REASSIGN,
        newCells.map(c => c.key),
        [sessionId, ttlSeconds, Date.now(), ...newCells.map(c => c.mode)]));
    },

    async setTarget(cellKey, target) {
      await redis().hset(cellKey, 'target', target);
    },

    async readCell(cellKey) {
      const [committed, in_flight, target] = await redis().hmget(
        cellKey, 'committed', 'in_flight', 'target',
      );
      return {
        committed: Number(committed) || 0,
        in_flight: Number(in_flight) || 0,
        target: Number(target) || 0,
      };
    },

    async sweep(cellKeys, nowMs) {
      let total = 0;
      for (const key of cellKeys) {
        total += (await run('sweep', SWEEP_CELL, [key], [nowMs])) as number;
      }
      return total;
    },

    async close() {
      if (client) await client.quit();
    },
  };
}
