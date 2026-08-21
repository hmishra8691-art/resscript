/**
 * Survey token resolution — the entry step that turns a URL into an artifact.
 *
 * Reads `runtime.survey_tokens` (migration 0009), which is in the `runtime` schema and therefore
 * inside ADR-001's plane boundary. The runtime never reads an authoring table; a token row is
 * written by `app.publish_version` at publish time and is immutable afterwards, so resolving one
 * is a single-row lookup with no join.
 */

export type TokenStatus = 'live' | 'paused' | 'closed' | 'test';

export interface ResolvedToken {
  readonly token: string;
  /**
   * The ONLY identity the token resolves to. runtime.resolve_token deliberately returns no
   * survey_id, no org, no name — its comment: "every extra column is a cross-tenant leak
   * waiting for a bug". The survey_id a session needs comes from the artifact manifest,
   * which the hash already authorizes the holder to read.
   */
  readonly survey_version_id: string;
  /**
   * PINNED at entry (E §3.3). A session keeps the hash it started on for its whole life, so
   * republishing mid-field cannot change the questionnaire under a respondent who is halfway
   * through it.
   */
  readonly artifact_hash: string;
  readonly status: TokenStatus;
  /** Test tokens run with quotas read-only and the full trace on (E §13). */
  readonly is_test: boolean;
}

export interface TokenResolver {
  /** Resolve a survey token, or null when it does not exist. */
  resolve(token: string): Promise<ResolvedToken | null>;
}

/**
 * An in-memory resolver, for tests and for local development without Postgres.
 *
 * Exported rather than hidden in a test file because the HTTP handler takes its dependencies by
 * injection, and an end-to-end test of the entry path is worth far more than a mock of each
 * layer separately.
 */
export function createStaticTokenResolver(
  rows: readonly ResolvedToken[],
): TokenResolver {
  const byToken = new Map(rows.map(r => [r.token, r]));
  return {
    async resolve(token: string): Promise<ResolvedToken | null> {
      return byToken.get(token) ?? null;
    },
  };
}

/**
 * The Postgres-backed resolver: `runtime.resolve_token`, through the writer's pool.
 *
 * A 60-second in-process cache, keyed by token. E §4 step 2 wants Redis in front with the same
 * TTL; in-process is the same freshness bound with one fewer hop, and the trade is that a
 * revocation propagates per instance within a minute rather than globally at once — which is
 * also true of the Redis design, since it caches with the same TTL.
 */
export function createPgTokenResolver(query: {
  resolveToken(token: string): Promise<{
    survey_version_id: string; artifact_hash: string; is_test: boolean; status: string;
  } | null>;
}): TokenResolver {
  const cache = new Map<string, { at: number; row: ResolvedToken | null }>();
  const TTL_MS = 60_000;

  return {
    async resolve(token: string): Promise<ResolvedToken | null> {
      const hit = cache.get(token);
      if (hit && Date.now() - hit.at < TTL_MS) return hit.row;

      const raw = await query.resolveToken(token);
      const row: ResolvedToken | null = raw
        ? {
            token,
            survey_version_id: raw.survey_version_id,
            artifact_hash: raw.artifact_hash,
            // The DB status axis is app.version_status (production/staging/...); the runtime's
            // TokenStatus is the serving axis. A resolvable, unrevoked token serves; is_test
            // routes it into test mode.
            status: raw.is_test ? 'test' : 'live',
            is_test: raw.is_test,
          }
        : null;
      cache.set(token, { at: Date.now(), row });
      return row;
    },
  };
}
