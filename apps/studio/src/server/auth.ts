/**
 * Claims parsing and role authorization.
 *
 * Roles and ranks are IMPORTED from `@resscript/schema`'s canonical registry (Deliverable K
 * §1). They are not restated here, and they must never be: K exists because Deliverable B and
 * Deliverable G defined the hierarchy independently with `analyst` and `reviewer` INVERTED,
 * and shipping B's enum with G's policy would have let an external reviewer pass an
 * analyst-level check and export open-ends. `src/server/__tests__/role-rank.test.ts` asserts
 * the ordering against the registry so a local re-definition becomes a failing test.
 */

import { AppError, forbidden, unauthenticated } from '@resscript/observability';
import { ORG_ROLES, roleRank, type OrgRole } from '@resscript/schema';

export interface ActiveClaims {
  readonly userId: string;
  /** `app_metadata.active_org_id`. Null when the user belongs to no org yet (post-signup). */
  readonly activeOrgId: string | null;
  /** Every org the user belongs to, from the claim. A hint for the switcher, never authority. */
  readonly orgs: readonly string[];
  /**
   * The role in `active_org_id` AS THE TOKEN CLAIMS IT. Deliberately a hint: a token minted
   * before a demotion still says `programmer`. The authority is the membership row, read per
   * request in `resolveRequestContext()`, which is also what `app.has_role()` reads.
   */
  readonly claimedRole: OrgRole | null;
  /** `role_v` — the membership version, for revocation (security §2.2). */
  readonly roleVersion: number | null;
  /** `aal2` means MFA satisfied; step-up-required endpoints check it (security §6). */
  readonly assuranceLevel: string | null;
  readonly email: string | null;
}

function isOrgRole(value: unknown): value is OrgRole {
  return typeof value === 'string' && (ORG_ROLES as readonly string[]).includes(value);
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Parse `app_metadata` defensively.
 *
 * Every unknown or malformed value degrades to "no claim", never to a throw: this runs on the
 * authorization path, and a parser that raises turns "you can see nothing" into a 500 on every
 * request — the same reason `app.jwt_claims()` in migration 0001 has an exception handler.
 */
export function claimsFrom(
  userId: string,
  appMetadata: Record<string, unknown> | undefined,
  email?: string | undefined,
): ActiveClaims {
  const meta = appMetadata ?? {};
  const orgsRaw = meta['orgs'];
  const roleVersionRaw = meta['role_v'];
  return {
    userId,
    activeOrgId: readString(meta, 'active_org_id'),
    orgs: Array.isArray(orgsRaw) ? orgsRaw.filter((o): o is string => typeof o === 'string') : [],
    claimedRole: isOrgRole(meta['role']) ? meta['role'] : null,
    roleVersion: typeof roleVersionRaw === 'number' ? roleVersionRaw : null,
    assuranceLevel: readString(meta, 'aal'),
    email: email ?? null,
  };
}

/** True when `actual` is at least `minimum` in K §1's ranking. */
export function meetsRole(actual: OrgRole | null, minimum: OrgRole): boolean {
  if (actual === null) return false;
  return roleRank(actual) >= roleRank(minimum);
}

/**
 * The route guard.
 *
 * WHY it throws rather than returning a boolean: an authorization check whose result can be
 * ignored is an authorization check that will be. The thrown `AppError` carries `details`
 * naming the required role, which API §1.5 mandates for `403 forbidden` ("details names the
 * required role and scope").
 *
 * WHAT IT IS NOT FOR: the two capabilities in K §1 that do not nest — PII in exports and
 * custom-code authoring. A Project Manager (50) outranks an Analyst (30) and must not thereby
 * acquire PII access; an Admin (60) outranks a Programmer (40) and must not thereby acquire
 * the right to author custom JS. Those are explicit grants in `app.capability_grants`, checked
 * with `app.has_capability()`, which contains no `has_role()` call at all. Do not reach for
 * `requireRole` there.
 */
export function requireRole(actual: OrgRole | null, minimum: OrgRole): void {
  if (actual === null) {
    // No membership row for the token's active org. 401 rather than 403 only when there is no
    // user at all; here there is a user with no standing in this org, which is a 403 whose
    // body must not confirm anything about the org.
    throw forbidden('you are not a member of this organization', [
      { path: null, code: 'role_required', message: minimum },
    ]);
  }
  if (!meetsRole(actual, minimum)) {
    throw forbidden(`this action requires the ${minimum} role or higher`, [
      { path: null, code: 'role_required', message: minimum },
      { path: null, code: 'role_actual', message: actual },
    ]);
  }
}

/** Step-up (security §6). Phase 1 has no enrolment UI, so this is checked, never assumed. */
export function requireStepUp(claims: ActiveClaims): void {
  if (claims.assuranceLevel !== 'aal2') {
    throw new AppError('step_up_required', 'step-up authentication required', {
      details: [
        { path: null, code: 'method_available', message: 'totp' },
        { path: null, code: 'method_available', message: 'webauthn' },
      ],
    });
  }
}

export function requireAuthenticated(claims: ActiveClaims | null): ActiveClaims {
  if (claims === null) throw unauthenticated();
  return claims;
}

/**
 * `owner` is not an invitable role.
 *
 * Enforced HERE as well as by `app.invitations.invitations_role_not_owner`, on purpose: the
 * CHECK is the guarantee, and this is the error message a user can act on. Two independent
 * guards, because "takeover by invite" is the class of bug that ends an enterprise deal.
 * Ownership arrives only through `app.create_organization` (at signup, for the caller) or an
 * explicit audited transfer.
 */
export function assertInvitableRole(role: OrgRole): void {
  if (role === 'owner') {
    throw new AppError('validation_failed', '1 field failed validation', {
      details: [
        {
          path: 'role',
          code: 'role_not_invitable',
          message:
            'owner cannot be granted by invitation; create an organization or transfer ownership explicitly',
        },
      ],
    });
  }
}
