/**
 * `GET /api/v1/organizations` — the orgs the caller belongs to (the org switcher's data).
 * `POST /api/v1/organizations` — create one, becoming its `owner`.
 *
 * Note the absence of an `?org_id=` anywhere: the LIST is derived from the caller's membership
 * rows, and CREATE mints a new org for the caller. Neither takes an org from the request.
 *
 * API §2.1 words this differently ("there is no `GET /v1/orgs` list; org switching is an auth
 * operation") — see the route-map note in the milestone report. The switcher still needs to
 * know which orgs exist for this user, and `app.org_members`'s own-row policy is the only
 * source for that, so the list is membership-derived rather than org-derived.
 */

import { requireAuthenticated } from '@/server/auth';
import { parseJsonBody, route } from '@/server/http/handler';
import { idempotencyKeyOf, withIdempotency } from '@/server/http/idempotency';
import { json } from '@/server/http/respond';
import { createOrganizationSchema } from '@/server/http/schemas';

export const GET = route(async (ctx) => {
  requireAuthenticated(ctx.claims);
  const memberships = await ctx.repos.orgs.listMine();
  return json(
    {
      data: memberships.map((m) => ({
        org_id: m.org_id,
        role: m.role,
        // Null for every org except the active one: `organizations_select` restricts reads to
        // `id = app.current_org()`. The switcher renders the id in that case rather than
        // inventing a name.
        name: m.organization?.name ?? null,
        slug: m.organization?.slug ?? null,
        is_active: m.org_id === ctx.claims.activeOrgId,
      })),
      active_org_id: ctx.claims.activeOrgId,
    },
    { requestId: ctx.requestId },
  );
});

export const POST = route(async (ctx, req) => {
  const claims = requireAuthenticated(ctx.claims);
  const { value, raw } = await parseJsonBody(req, createOrganizationSchema);
  return withIdempotency(
    {
      store: ctx.repos.idempotency,
      // Scoped to the CALLER when there is no active org yet: the key's scope is
      // `(org, endpoint)` and a user creating their first org has no org to scope to.
      orgId: claims.activeOrgId ?? claims.userId,
      endpoint: 'POST /organizations',
      key: idempotencyKeyOf(req),
      body: raw,
      requestId: ctx.requestId,
      now: ctx.now,
    },
    async () => {
      const org = await ctx.repos.orgs.create({
        slug: value.slug,
        name: value.name,
        ...(value.data_region === undefined ? {} : { data_region: value.data_region }),
      });
      if (ctx.minter !== null) {
        // The caller is now this org's owner but their token still says otherwise. Re-minting
        // here means the next request lands in the new org without a second round trip; the
        // client must refresh its session to pick the claim up (see `token_refresh_required`).
        await ctx.minter.setActiveOrg({
          userId: claims.userId,
          orgId: org.id,
          role: 'owner',
          orgs: [...new Set([...claims.orgs, org.id])],
        });
      }
      ctx.logger.info('organization created', { org_id: org.id, slug: org.slug });
      // The audit row is written INSIDE `app.create_organization` (SECURITY DEFINER), not here:
      // `app.audit_log` has no INSERT policy, so a write from this layer would fail and a
      // second write would double-count.
      return {
        status: 201,
        body: { ...org, token_refresh_required: ctx.minter !== null },
      };
    },
  );
});
