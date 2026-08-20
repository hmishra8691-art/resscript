/**
 * The per-request context, and the one seam the tests use.
 *
 * Every route handler in `src/app/api/v1` is `route(async (ctx, req) => …)`. `ctx` carries the
 * verified claims, the authoritative role, the repositories, the logger bound to this
 * request's `request_id`, and the token minter. Because the context is produced by a
 * replaceable resolver, a route handler is callable as a plain function in a test — no HTTP
 * server, no Supabase, no cookies — while production goes through `withOrgContext()`.
 *
 * The resolver takes the `Request` only so it can read correlation headers. It does not read
 * the URL for tenancy. See the header comment in `src/server/db.ts`.
 */

import { createLogger, requestIdFrom, type Logger } from '@resscript/observability';
import type { OrgRole } from '@resscript/schema';
import { claimsFrom, type ActiveClaims } from './auth.js';
import { createSupabaseAdminClient, withOrgContext } from './db.js';
import { createSupabaseRepos } from './repo/supabase.js';
import type { Repos } from './repo/types.js';

/**
 * Re-minting the access token is what an org switch IS (security §2.2: "switching orgs mints a
 * new token, which means an org switch is an auditable event and a stale tab cannot act in the
 * wrong tenant"). Behind an interface because it needs the service-role key, which tests must
 * never need.
 */
export interface TokenMinter {
  setActiveOrg(input: {
    readonly userId: string;
    readonly orgId: string;
    readonly role: OrgRole;
    readonly orgs: readonly string[];
  }): Promise<void>;
}

export interface RequestContext {
  readonly requestId: string;
  readonly logger: Logger;
  readonly claims: ActiveClaims;
  /**
   * The role from the MEMBERSHIP ROW, not from the token. A token minted before a demotion
   * still claims the old role; `app.has_role()` reads the row, so this must too or the API
   * would authorize what the database then refuses.
   */
  readonly role: OrgRole | null;
  readonly repos: Repos;
  readonly minter: TokenMinter | null;
  /** Injectable clock: ETags and expiry windows are asserted in tests. */
  now(): Date;
}

export type ContextResolver = (req: Request) => Promise<RequestContext>;

async function defaultResolver(req: Request): Promise<RequestContext> {
  const requestId = requestIdFrom(req.headers);
  const logger = createLogger({ service: 'studio', requestId });
  const { client, claims } = await withOrgContext();
  const admin = createSupabaseAdminClient();
  const repos = createSupabaseRepos({
    client,
    userId: claims.userId,
    activeOrgId: claims.activeOrgId,
    requestId,
    ...(admin === undefined ? {} : { admin }),
  });
  const role =
    claims.activeOrgId === null
      ? null
      : await repos.members.roleInOrg(claims.activeOrgId, claims.userId);
  const minter: TokenMinter | null =
    admin === undefined
      ? null
      : {
          setActiveOrg: async ({ userId, orgId, role: nextRole, orgs }) => {
            const { error } = await admin.auth.admin.updateUserById(userId, {
              app_metadata: {
                active_org_id: orgId,
                role: nextRole,
                orgs,
                // Bumping `role_v` on every mint is what invalidates the previous token.
                role_v: Date.now(),
              },
            });
            if (error !== null) throw error;
          },
        };
  return {
    requestId,
    logger: logger.child({
      user_id: claims.userId,
      org_id: claims.activeOrgId ?? 'none',
    }),
    claims,
    role,
    repos,
    minter,
    now: () => new Date(),
  };
}

let resolver: ContextResolver = defaultResolver;

/** Tests install their own resolver; nothing in `src/app` may call this. */
export function setContextResolver(next: ContextResolver): void {
  resolver = next;
}

export function resetContextResolver(): void {
  resolver = defaultResolver;
}

export function resolveRequestContext(req: Request): Promise<RequestContext> {
  return resolver(req);
}

/** Convenience for tests and for the org-creation path, where there is no membership yet. */
export function emptyClaims(userId: string): ActiveClaims {
  return claimsFrom(userId, {});
}
