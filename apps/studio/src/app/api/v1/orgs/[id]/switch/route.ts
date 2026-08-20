/**
 * `POST /api/v1/orgs/:id/switch`
 *
 * Org switching is an AUTH operation, not a data operation: it re-mints the access token with a
 * new `app_metadata.active_org_id` (security §2.2). That is why there is no `?org_id=`
 * anywhere else in this API — the org a request acts in is a signed claim, so a stale browser
 * tab cannot act in the wrong tenant and every switch is an auditable event.
 *
 * The `:id` here is a REQUESTED target, and it is only honoured after the caller's membership
 * of that org is verified server-side against `app.org_members` (whose `members_select` policy
 * shows a user their own row in every org they belong to). A non-member gets `404` — not `403`,
 * because confirming that an org exists is the information leak.
 */

import { AppError } from '@resscript/observability';
import { requireAuthenticated } from '@/server/auth';
import { route } from '@/server/http/handler';
import { json } from '@/server/http/respond';

export const POST = route<{ id: string }>(async (ctx, _req, params) => {
  const claims = requireAuthenticated(ctx.claims);
  const role = await ctx.repos.members.roleInOrg(params.id, claims.userId);
  if (role === null) {
    throw new AppError('not_found', 'organization not found', {
      context: { requested_org: params.id },
    });
  }
  if (ctx.minter === null) {
    // No service-role key configured: the switch cannot be completed. Fails loudly rather than
    // returning 200 with an unchanged token, which would silently leave the user in org A
    // while the UI told them they were in org B.
    throw new AppError('unavailable', 'org switching is not available in this deployment', {
      context: { missing: 'SUPABASE_SERVICE_ROLE_KEY' },
    });
  }
  await ctx.minter.setActiveOrg({
    userId: claims.userId,
    orgId: params.id,
    role,
    orgs: [...new Set([...claims.orgs, params.id])],
  });
  await ctx.repos.audit.write({
    org_id: params.id,
    action: 'org.switched',
    target_kind: 'organization',
    target_id: params.id,
    summary: 'active org switched',
    diff: { from: claims.activeOrgId, to: params.id },
    request_id: ctx.requestId,
  });
  ctx.logger.info('org switched', { from_org: claims.activeOrgId, to_org: params.id });
  return json(
    {
      org_id: params.id,
      role,
      // The claim changes server-side; the browser must refresh its session for the new access
      // token to be issued. Saying so explicitly beats having the client guess.
      token_refresh_required: true,
    },
    { requestId: ctx.requestId },
  );
});
