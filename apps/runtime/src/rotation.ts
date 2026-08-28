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

import { Redis } from 'ioredis';

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
    (client ??= new Redis(redisUrl, {
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
