/**
 * The adaptive reservation TTL (E §10.3, roadmap P2-07).
 *
 * ## Why this exists
 *
 * `handler.ts` read `config.policy.reservation_ttl_s` and nothing measured anything, so both
 * failure modes E §10.3 names were live: "Too short and a slow respondent's reservation vanishes
 * and the cell overfills; too long and abandons hold cells for hours and fieldwork stalls." An
 * author who guessed 20 minutes for a 45-minute survey overfilled every cell; one who guessed four
 * hours stalled fieldwork behind abandons. The roadmap's own note is that making it adaptive
 * "removes a whole category of 'why is my quota stuck at 94%' support ticket."
 *
 * ## The policy lives here, the measurement lives in Postgres
 *
 * `runtime.measured_loi` returns a count and a median and takes no view on whether either is
 * enough. The ≥50 threshold and the 3× multiplier are here, in application code, deliberately: a
 * measurement and a policy about the measurement are different things, and baking the threshold
 * into SQL would make changing it a migration.
 *
 * ## Why the authored value is the floor AND the fallback
 *
 * Below 50 completes the authored estimate is used unchanged — a deliberate estimate beats an
 * unstable measurement, and a median over three completes swings on the fourth respondent, which
 * fieldwork operations cannot reason about.
 *
 * Above 50 the measured value is used, bounded ONLY by absolute limits — deliberately not by a
 * factor of the authored value, and that took a correction.
 *
 * My first version clamped the measurement to [0.5x, 4x] the authored TTL, reasoning that an
 * adaptive number needs bounds. It does. But anchoring those bounds to the AUTHORED value anchors
 * them to the least reliable number in the calculation — the guess this whole mechanism exists to
 * replace. A test made it concrete: E §10.3's stalled-fieldwork case is a four-hour authored TTL on
 * a ten-minute survey, and a 0.5x floor clamped the fix to two hours, which is still absurd for a
 * ten-minute survey. The guard was preventing exactly the repair it was written to make safe.
 *
 * The real risk in the shortening direction is not "far from the author's guess", it is "the
 * measurement is unrepresentative" — the first fifty completes are all speeders. Two things already
 * address that and neither involves the authored value: the >= 50 threshold, and the fact that the
 * TTL is 3x the MEDIAN, which in any realistic completion-time distribution sits well above the
 * slowest respondents. What remains is a degenerate median, which the absolute floor catches.
 */

/** E §10.3's multiplier: "3x median completion time". */
export const LOI_MULTIPLIER = 3;

/** Below this many completes, the measurement is noise and the authored estimate wins. */
export const MIN_COMPLETES_FOR_MEASUREMENT = 50;

/**
 * Absolute bounds, whatever the author or the measurement says.
 *
 * The floor is what catches a degenerate measurement — fifty sessions that all completed in twenty
 * seconds because somebody load-tested against a live version — and it is set where it is because
 * ten minutes is longer than any single page takes and shorter than any real survey. Below it, a
 * reservation would expire while a respondent was still reading.
 *
 * Overfilling is the unrecoverable direction (extra completes are paid for and cannot be
 * un-collected) so the floor is the bound that matters; the ceiling only prevents an absurdity,
 * because a reservation held too long merely delays fieldwork, which an operator can see and wait
 * out.
 */
export const ABSOLUTE_MIN_TTL_S = 600;
export const ABSOLUTE_MAX_TTL_S = 6 * 3600; // past this an abandon is an abandon

export interface LoiSample {
  readonly completes: number;
  /** Median seconds, or null when nothing has been measured. */
  readonly medianSeconds: number | null;
}

export interface TtlDecision {
  readonly ttlSeconds: number;
  /** `authored` | `measured` | `measured_clamped`, for the trace and the dashboard. */
  readonly basis: 'authored' | 'measured' | 'measured_clamped';
  readonly completes: number;
}

/**
 * Decide the TTL. Pure, so the policy is testable without a database — which matters because every
 * interesting case here is a boundary and none of them needs a session.
 */
export function decideTtl(authoredTtlSeconds: number, sample: LoiSample): TtlDecision {
  const authored = clampAbsolute(authoredTtlSeconds);

  // `medianSeconds === null` is distinguished from 0 by the RPC on purpose: "nothing measured" and
  // "measured zero" are different facts, and treating a null as zero would compute a TTL of zero.
  if (sample.completes < MIN_COMPLETES_FOR_MEASUREMENT || sample.medianSeconds === null) {
    return { ttlSeconds: authored, basis: 'authored', completes: sample.completes };
  }

  const measured = Math.round(sample.medianSeconds * LOI_MULTIPLIER);
  const bounded = clampAbsolute(measured);

  return {
    ttlSeconds: bounded,
    basis: bounded === measured ? 'measured' : 'measured_clamped',
    completes: sample.completes,
  };
}

function clampAbsolute(seconds: number): number {
  if (!Number.isFinite(seconds)) return ABSOLUTE_MIN_TTL_S;
  return Math.min(Math.max(Math.round(seconds), ABSOLUTE_MIN_TTL_S), ABSOLUTE_MAX_TTL_S);
}

/* -------------------------------------------------------------------------- */
/* The cached provider                                                        */
/* -------------------------------------------------------------------------- */

export interface TtlProviderOptions {
  /** Reads `runtime.measured_loi`. Absent = never measure, always use the authored value. */
  readonly loadSample?: (surveyVersionId: string) => Promise<LoiSample>;
  /** How long a sample is reused. Default 5 minutes. */
  readonly cacheMs?: number;
  readonly now?: () => number;
}

export interface TtlProvider {
  decide(surveyVersionId: string, authoredTtlSeconds: number): Promise<TtlDecision>;
}

/**
 * A TTL provider that measures at most once every `cacheMs` per version.
 *
 * Cached because this is on the reservation path, which E §10.3's acceptance criteria hold to a p99
 * under 10 ms — a median over a growing sessions table is not a query to run per respondent. Five
 * minutes is far shorter than the timescale on which a median over ≥50 completes moves, so the
 * staleness costs nothing measurable.
 *
 * A FAILED measurement returns the authored value and does not cache the failure. That direction is
 * deliberate: a database blip must not pin every survey to its authored TTL until the process
 * restarts, and retrying next reservation costs one query.
 */
export function createTtlProvider(options: TtlProviderOptions = {}): TtlProvider {
  const now = options.now ?? Date.now;
  const cacheMs = options.cacheMs ?? 5 * 60_000;
  const cache = new Map<string, { at: number; sample: LoiSample }>();

  return {
    async decide(surveyVersionId: string, authoredTtlSeconds: number): Promise<TtlDecision> {
      const load = options.loadSample;
      if (load === undefined) {
        return decideTtl(authoredTtlSeconds, { completes: 0, medianSeconds: null });
      }

      const hit = cache.get(surveyVersionId);
      if (hit !== undefined && now() - hit.at < cacheMs) {
        return decideTtl(authoredTtlSeconds, hit.sample);
      }

      try {
        const sample = await load(surveyVersionId);
        cache.set(surveyVersionId, { at: now(), sample });
        return decideTtl(authoredTtlSeconds, sample);
      } catch {
        // Not cached — see the header. The authored value is a correct answer, just not the best
        // one, so a measurement failure degrades rather than fails.
        return decideTtl(authoredTtlSeconds, { completes: 0, medianSeconds: null });
      }
    },
  };
}


/* -------------------------------------------------------------------------- */
/* The Postgres loader                                                        */
/* -------------------------------------------------------------------------- */

/** Minimal query surface, so this module does not depend on a pool type. */
export interface LoiQuerier {
  query<R>(sql: string, params: readonly unknown[]): Promise<{ rows: R[] }>;
}

/**
 * `runtime.measured_loi` as a `loadSample`.
 *
 * One RPC, no SQL of its own: the measurement's definition — median not mean, test sessions
 * excluded, screenouts excluded, the sanity bounds on `duration_s` — lives in 0022 where its own
 * pgTAP assertions exercise it. A second definition here would be a second thing to keep in step.
 *
 * A NULL median comes back as `null` rather than 0, which `decideTtl` distinguishes: "nothing
 * measured" and "measured zero" are different facts, and the second would compute a TTL of zero.
 */
export function pgLoiLoader(db: LoiQuerier): (surveyVersionId: string) => Promise<LoiSample> {
  return async (surveyVersionId: string): Promise<LoiSample> => {
    const res = await db.query<{ completes: number | string; median_s: number | string | null }>(
      'SELECT completes, median_s FROM runtime.measured_loi($1::app.ulid)',
      [surveyVersionId],
    );
    const row = res.rows[0];
    if (row === undefined) return { completes: 0, medianSeconds: null };
    const median = row.median_s;
    return {
      completes: Number(row.completes) || 0,
      // `Number(null)` is 0, so the null is checked BEFORE the coercion — the same mistake
      // vendor/verify.ts had with a missing timestamp, where it read as epoch 1970.
      medianSeconds: median === null ? null : Number(median),
    };
  };
}
