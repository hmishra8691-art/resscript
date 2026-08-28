/**
 * The shared ticket counter-backed randomization runs on (E §8.4, roadmap P2-03).
 *
 * ## Why a separate module and not a method on QuotaClient
 *
 * `QuotaClient`'s methods are all `(sessionId, cells, ttl)`-shaped. A `nextIndex(key)` on that
 * interface would be a second meaning on a hot object, and the next reader would have to work out
 * which half of it they were looking at. It shares the connection style and the bounded retry
 * policy, and nothing else.
 *
 * ## One ticket per SESSION, not per axis
 *
 * A respondent gets one ticket and every rotating axis derives its own offset from it — `rotate` is
 * `(ticket + axis offset) mod n`, and `randomize()` takes the ticket and does the modulo per axis.
 * The alternative, a counter per axis, is worse in a way that is not obvious: a survey with a
 * six-question battery would issue six tickets per respondent, so each counter advances six times
 * slower and "even across respondents" stops being true of any of them at low n. One ticket also
 * means one Redis round trip per session rather than one per question.
 *
 * ## Best-effort by design, and why that is acceptable HERE
 *
 * Redis is the arbiter; `runtime.rotation_counters` is written behind it (0025). After a Redis flush
 * the counter resumes from the last recorded value, so a handful of respondents can receive a ticket
 * somebody already had. For a rotation that is a rounding error — two people out of a thousand
 * seeing the same brand order — which is exactly why rotation can live on a best-effort counter and
 * a quota cannot. ADR-008 draws that line and this module stays on the cheap side of it.
 *
 * A counter that is UNREACHABLE yields `null`, and `randomize()` then reports `needs_counter` and
 * leaves the declared order alone. That is the honest degradation: an unrotated survey is visibly
 * unrotated, while a seeded shuffle standing in for a rotation is an unbalanced design nobody
 * notices until fieldwork ends.
 */

import type { Redis } from 'ioredis';
import { Redis as RedisClient } from 'ioredis';

/** `rot:{survey_version_id}` — one counter per fielding version. */
export const ROTATION_KEY_PREFIX = 'rot';

export interface RotationCounter {
  /**
   * This respondent's 0-based ticket, or null when the counter is unreachable.
   *
   * Null rather than a thrown error or a fabricated 0: a zero would put every respondent at offset
   * 0 during an outage, which is a survey with no rotation at all pretending to have one.
   */
  next(surveyVersionId: string): Promise<number | null>;
  close(): Promise<void>;
}

export function createRotationCounter(redisUrl: string): RotationCounter {
  let client: Redis | null = null;
  const redis = () =>
    (client ??= new RedisClient(redisUrl, {
      // The same bounded policy `createQuotaClient` uses, and for the same reason its comment
      // gives: this is on the respondent's critical path, so failing fast is part of the CONTRACT
      // rather than tuning. A hung rotation is a hung respondent.
      maxRetriesPerRequest: 1,
      connectTimeout: 1_000,
      retryStrategy: (times) => (times > 2 ? null : 200),
    }));

  return {
    async next(surveyVersionId: string): Promise<number | null> {
      try {
        // INCR, never a clock and never a random draw. Redis's own counter is monotonic across
        // racing processes, which is the property the whole feature rests on — `drain.ts` makes the
        // same argument for its per-cell epoch.
        const n = await redis().incr(`${ROTATION_KEY_PREFIX}:${surveyVersionId}`);
        // INCR returns 1 for the first caller; tickets are 0-based so the first respondent gets 0
        // and `rotate` leaves the declared order alone for them. That is deliberate: the first
        // respondent of a wave seeing the order the author wrote makes a manual spot-check
        // meaningful.
        return Math.max(0, n - 1);
      } catch {
        return null;
      }
    },

    async close(): Promise<void> {
      if (client) {
        await client.quit().catch(() => undefined);
        client = null;
      }
    },
  };
}

/**
 * Every rotation counter's current value for a version, for the write-behind drain.
 *
 * Read with `GET` rather than tracked in memory: the drain and the entry path are different
 * processes, and a value the drain remembered would be its own, not the cluster's.
 */
export async function readRotationCounter(
  redis: Pick<Redis, 'get'>,
  surveyVersionId: string,
): Promise<number | null> {
  const raw = await redis.get(`${ROTATION_KEY_PREFIX}:${surveyVersionId}`);
  if (raw === null) return null;
  const n = Number(raw);
  // Checked before use: `Number(null)` is 0 and `Number('abc')` is NaN, and a NaN written into
  // `issued` would fail the column's CHECK — later, in the drain, far from here.
  return Number.isFinite(n) ? n : null;
}

/* -------------------------------------------------------------------------- */
/* Write-behind                                                               */
/* -------------------------------------------------------------------------- */

/** What the drain needs from Postgres — one RPC, so the SQL stays in 0025. */
export interface RotationFlushTarget {
  flush(rows: readonly { v: string; k: string; i: number }[]): Promise<number>;
}

/**
 * Push the live Redis counters into `runtime.rotation_counters`.
 *
 * ## Why this exists at all
 *
 * Without it 0025's table has no writer, and a table nobody writes is a migration that looks like a
 * feature — the exact failure this phase found three times over (`theme_id → nothing`,
 * `html_template_ref → nothing`, `content.code_assets → nothing`). The table's whole purpose is
 * that a Redis flush does not restart every rotation at zero, and that purpose is unmet until
 * something records the value.
 *
 * ## Reads, does not reset
 *
 * `GET`, never `GETSET`. Redis stays the arbiter and this is a snapshot: resetting would mean the
 * counter and the record disagree for exactly as long as it takes the next respondent to arrive,
 * and a ticket issued in that window would be a duplicate of one already recorded.
 *
 * The flush is `GREATEST` on the far side (0025), so a snapshot that arrives out of order after a
 * retry cannot move the recorded value backwards. That is what makes reading-without-resetting safe
 * to do on a loop.
 *
 * ## Which versions
 *
 * The caller supplies them, because only the caller knows what is in field — the runtime holds
 * pinned artifact hashes for live tokens. Scanning the keyspace for `rot:*` would work and is what
 * ADR-008 forbids for the quota sweeper too: a `KEYS` on a shared Redis is a stall for every other
 * user of it.
 */
export async function drainRotationCountersOnce(
  redis: Pick<Redis, 'get'>,
  target: RotationFlushTarget,
  surveyVersionIds: readonly string[],
): Promise<number> {
  if (surveyVersionIds.length === 0) return 0;

  const rows: { v: string; k: string; i: number }[] = [];
  for (const versionId of surveyVersionIds) {
    const issued = await readRotationCounter(redis, versionId);
    // `null` is "no counter yet", which is different from "counter at zero": flushing a 0 for a
    // version nobody has entered would write a row that says nothing and make the table's row count
    // a count of versions rather than of rotations.
    if (issued === null || issued <= 0) continue;
    // One counter per version today, so the key column is a constant. It is a COLUMN rather than
    // being folded into the version id because per-axis counters are a plausible future and the
    // table should not need a migration to hold them — 0025's comment says the shape is opaque here
    // on purpose.
    rows.push({ v: versionId, k: 'session', i: issued });
  }

  if (rows.length === 0) return 0;
  return target.flush(rows);
}

/* -------------------------------------------------------------------------- */
/* Least-filled allocation (E §8.5)                                           */
/* -------------------------------------------------------------------------- */

/**
 * `even_distribution: true` on a randomizer flow node.
 *
 * E §8.5 is blunt about what this is: "least-filled cell wins. That is not randomization; it is
 * allocation, and it requires shared state." So it cannot be a function of the ticket either — a
 * ticket says which respondent you are, and allocation needs to know how full every arm currently
 * is, which no per-respondent number can encode.
 *
 * ## Why one Lua round trip
 *
 * Read-then-increment from the client would let two respondents read the same minimum and both
 * increment it, which is exactly the imbalance the feature exists to prevent — and the more traffic,
 * the worse it gets. Redis's single-threaded execution makes the script atomic, which is the same
 * property the quota reserve depends on.
 *
 * ## Ties go to the lowest index, deliberately
 *
 * E §8.5's script says "ties: lowest index, deterministic". At the start of fieldwork every arm is
 * at zero, so ties are the common case rather than an edge one — and a random tie-break would make
 * the first n respondents' assignment unreproducible for no gain, while a deterministic one makes
 * the first respondents fill arms in authored order and every subsequent decision genuinely
 * least-filled.
 */
const ASSIGN_LEAST_FILLED = `
local n = tonumber(ARGV[1])
local scored = {}
for i = 1, #KEYS do
  local c = tonumber(redis.call('HGET', KEYS[i], 'assigned') or 0)
  -- The index rides along so the sort below can break ties by it rather than by Lua's
  -- unspecified ordering for equal keys.
  scored[#scored + 1] = { c, i, KEYS[i] }
end
table.sort(scored, function(a, b)
  if a[1] == b[1] then return a[2] < b[2] end
  return a[1] < b[1]
end)
local chosen = {}
for i = 1, math.min(n, #scored) do
  local key = scored[i][3]
  redis.call('HINCRBY', key, 'assigned', 1)
  chosen[#chosen + 1] = key
end
return chosen
`;

export interface Allocator {
  /**
   * The `n` least-filled arms, least first, each incremented — or null when Redis is unreachable.
   *
   * Null rather than a throw or a guess: E §8.5 prescribes the fallback ("falls back to the seeded
   * PRNG, logs a `randomizer.degraded` event, and accepts uneven distribution") and calls it the
   * right one, because "approximate balance beats stalling fieldwork".
   */
  assignLeastFilled(
    nodeId: string,
    targets: readonly string[],
    n: number,
  ): Promise<readonly string[] | null>;
  close(): Promise<void>;
}

/** `alloc:{flow_node_id}:{target_id}` — one hash per arm, holding `assigned`. */
export const ALLOC_KEY_PREFIX = 'alloc';

export function createAllocator(redisUrl: string): Allocator {
  let client: RedisClient | null = null;
  let sha: string | null = null;
  const redis = () =>
    (client ??= new RedisClient(redisUrl, {
      maxRetriesPerRequest: 1,
      connectTimeout: 1_000,
      retryStrategy: (times) => (times > 2 ? null : 200),
    }));

  return {
    async assignLeastFilled(
      nodeId: string,
      targets: readonly string[],
      n: number,
    ): Promise<readonly string[] | null> {
      if (targets.length === 0 || n < 1) return [];
      const keys = targets.map((t) => `${ALLOC_KEY_PREFIX}:${nodeId}:${t}`);
      try {
        const r = redis();
        // EVALSHA with a load-on-NOSCRIPT fallback, the same shape `createQuotaClient`'s `run`
        // helper uses: a Redis restart clears the script cache, and re-sending the source on every
        // call would ship the script's bytes on the respondent's critical path.
        sha ??= await r.script('LOAD', ASSIGN_LEAST_FILLED) as string;
        let raw: unknown;
        try {
          raw = await r.evalsha(sha, keys.length, ...keys, String(n));
        } catch (err: unknown) {
          if (!String(err).includes('NOSCRIPT')) throw err;
          sha = (await r.script('LOAD', ASSIGN_LEAST_FILLED)) as string;
          raw = await r.evalsha(sha, keys.length, ...keys, String(n));
        }
        if (!Array.isArray(raw)) return null;
        // Back from key to target id. Mapped rather than returned as keys, so the caller — and the
        // `design` variable it persists — deals in the author's ids and not in a Redis keyspace
        // detail that could change.
        const byKey = new Map(keys.map((k, i) => [k, targets[i] as string]));
        const out: string[] = [];
        for (const k of raw) {
          const target = byKey.get(String(k));
          if (target !== undefined) out.push(target);
        }
        return out;
      } catch {
        return null;
      }
    },

    async close(): Promise<void> {
      if (client) {
        await client.quit().catch(() => undefined);
        client = null;
      }
    },
  };
}
