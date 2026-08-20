/**
 * `GET|PATCH /api/v1/organizations/:id` — the ACTIVE org.
 *
 * The `:id` segment is a guard, not a selector: it must equal the token's `active_org_id` or
 * the answer is 404. Reading the org that `:id` names would be exactly the `?org_id=` hole in
 * a different syntax.
 */

import { AppError } from '@resscript/observability';
import { requireRole } from '@/server/auth';
import { parseJsonBody, requireActiveOrg, route } from '@/server/http/handler';
import { json } from '@/server/http/respond';
import { updateOrganizationSchema } from '@/server/http/schemas';
import { assertPathOrgMatchesToken } from '@/server/http/org-guard';
import type { JsonObject } from '@resscript/schema';

export const GET = route<{ id: string }>(async (ctx, _req, params) => {
  assertPathOrgMatchesToken(params.id, ctx.claims.activeOrgId);
  // The floor is `client`, the lowest rank: "is a member at all", matching
  // `organizations_select`'s `app.has_role('client')`.
  requireRole(ctx.role, 'client');
  const org = await ctx.repos.orgs.getActive();
  // Throw rather than hand-building a body: there is exactly one error envelope in this system
  // (`AppError.toEnvelope()`), and a second one assembled inline is how `details` and
  // `docs_url` go missing from one endpoint.
  if (org === null) throw new AppError('not_found', 'organization not found');
  return json(org, { requestId: ctx.requestId });
});

export const PATCH = route<{ id: string }>(async (ctx, req, params) => {
  assertPathOrgMatchesToken(params.id, ctx.claims.activeOrgId);
  requireRole(ctx.role, 'admin');
  const orgId = requireActiveOrg(ctx);
  const { value } = await parseJsonBody(req, updateOrganizationSchema);
  const before = await ctx.repos.orgs.getActive();
  const org = await ctx.repos.orgs.updateActive({
    ...(value.name === undefined ? {} : { name: value.name }),
    ...(value.settings === undefined ? {} : { settings: value.settings as JsonObject }),
  });
  await ctx.repos.audit.write({
    action: 'organization.updated',
    target_kind: 'organization',
    target_id: orgId,
    summary: 'organization settings updated',
    diff: {
      name: { from: before?.name ?? null, to: org.name },
    },
    request_id: ctx.requestId,
  });
  return json(org, { requestId: ctx.requestId });
});
