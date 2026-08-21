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
  readonly survey_id: string;
  readonly survey_version: number;
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
 * The Postgres-backed resolver.
 *
 * Not implemented yet: the write path and the `runtime_reader` connection arrive with P1-10, and
 * a half-wired client that throws on first use is worse than one that says so. `apps/runtime`
 * links no Postgres driver today, and the `runtime-no-supabase` dependency-cruiser rule would
 * fail CI if a Supabase client appeared here.
 */
export function createPgTokenResolver(): TokenResolver {
  return {
    async resolve(): Promise<ResolvedToken | null> {
      throw new Error(
        'P1-10: Postgres token resolution not wired. Set RUNTIME_STATIC_TOKENS for local use.',
      );
    },
  };
}
