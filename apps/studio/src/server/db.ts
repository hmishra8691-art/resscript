/**
 * Data access: the Supabase clients and `withOrgContext`.
 *
 * ═══ THE INVARIANT THIS FILE EXISTS TO HOLD ═══
 *
 * There is NO code path in this application that takes an organization id from a query
 * parameter, a request body, a header, or a path segment and uses it to scope data. The active
 * org comes from the verified JWT claim `app_metadata.active_org_id` and from nowhere else
 * (ADR-009, security §2.2, and `app.current_org()` in `db/migrations/0001_bootstrap`). Switching
 * org re-mints the token; it does not change a parameter. A `?org_id=` on any request to this
 * app is inert — `src/server/__tests__/no-org-param.test.ts` asserts both halves of that: that
 * a request carrying `?org_id=<other org>` still resolves to the token's org, and that no file
 * under `src/app/api` reads such a parameter.
 *
 * The two places an org id legitimately appears in a URL are both guards, not selectors:
 *   - `/api/v1/organizations/:id` — the id must EQUAL the token's org or the answer is 404.
 *   - `/api/v1/orgs/:id/switch` — the org-switch operation itself, which verifies membership
 *     server-side and re-mints the token. That is an auth operation, not a data read.
 */

import { createServerClient } from '@supabase/ssr';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { AppError, unauthenticated } from '@resscript/observability';
import { serviceRoleKey, supabaseEnv } from './env.js';
import { claimsFrom, type ActiveClaims } from './auth.js';

/**
 * A cookie-backed server client.
 *
 * `next/headers` is imported dynamically so that this module can be imported by a plain
 * vitest process (route-handler tests replace the context resolver entirely and never reach
 * here) without dragging Next's request-scoped internals into a non-request context.
 */
export async function createSupabaseServerClient(): Promise<SupabaseClient> {
  const env = supabaseEnv();
  if (env === undefined) {
    // Fails closed and names the variable. A misconfigured deployment must not silently
    // degrade into "no claims", because "no claims" reads as "not a member of anything",
    // which looks like an empty org rather than an outage.
    throw new AppError('unavailable', 'Supabase is not configured', {
      context: { missing: 'NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY' },
    });
  }
  const { cookies } = await import('next/headers');
  const store = await cookies();
  return createServerClient(env.url, env.anonKey, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (toSet) => {
        try {
          for (const { name, value, options } of toSet) store.set(name, value, options);
        } catch {
          // A Server Component cannot set cookies. Refresh happens in middleware, which can,
          // so swallowing here is correct rather than lossy — see `src/middleware.ts`.
        }
      },
    },
  });
}

/**
 * The service-role client. Used for exactly one thing — re-minting `app_metadata` on org
 * switch — and for the `ops.jobs` read that has no RLS-mediated path (see `SupabaseRepo.jobs`).
 * Returns `undefined` rather than throwing so a deployment without the key degrades to "org
 * switching is unavailable" instead of "every request 500s".
 */
export function createSupabaseAdminClient(): SupabaseClient | undefined {
  const env = supabaseEnv();
  const key = serviceRoleKey();
  if (env === undefined || key === undefined) return undefined;
  return createClient(env.url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export interface OrgContext {
  /** Carries the user's JWT, so Postgres RLS applies to every statement made through it. */
  readonly client: SupabaseClient;
  readonly claims: ActiveClaims;
}

/**
 * Resolve the caller's session and hand back a client whose requests carry their JWT.
 *
 * Note the signature: it takes NO request-derived input. It cannot be passed an org id, which
 * is the point — there is no argument through which a caller could smuggle one.
 *
 * `getUser()` rather than `getSession()`: `getSession()` decodes the cookie locally and
 * trusts it, while `getUser()` validates the token against the auth server. For an
 * authorization decision, "the cookie says so" is not evidence.
 */
export async function withOrgContext(): Promise<OrgContext> {
  const client = await createSupabaseServerClient();
  const { data, error } = await client.auth.getUser();
  if (error !== null || data.user === null) {
    throw unauthenticated();
  }
  return { client, claims: claimsFrom(data.user.id, data.user.app_metadata, data.user.email) };
}
