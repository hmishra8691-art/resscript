/**
 * `GET /api/v1/organizations/:id/members`
 *
 * Floor is `admin`, not `reviewer`.
 *
 * API §2.2's role column says `OWN…REV` may list members, but `members_select` in
 * `0004_tenancy` grants other people's rows to admins only (your OWN row is always visible, in
 * every org, which is what the switcher needs). Where the policy and the doc disagree the
 * policy is what runs, and an API that returns 200-with-one-row to a reviewer would be a
 * worse lie than a 403. Flagged as a doc inconsistency in the milestone report.
 */

import { requireRole } from '@/server/auth';
import { requireActiveOrg, route } from '@/server/http/handler';
import { pageEnvelope, pageQueryFrom } from '@/server/http/pagination';
import { json } from '@/server/http/respond';
import { assertPathOrgMatchesToken } from '@/server/http/org-guard';

export const GET = route<{ id: string }>(async (ctx, req, params) => {
  assertPathOrgMatchesToken(params.id, ctx.claims.activeOrgId);
  requireRole(ctx.role, 'admin');
  requireActiveOrg(ctx);
  const query = pageQueryFrom(new URL(req.url));
  const { rows, hasMore } = await ctx.repos.members.list(query);
  return json(
    pageEnvelope(rows, hasMore, query.limit, (m) => ({
      created_at: m.created_at,
      // `app.org_members` is keyed (org_id, user_id); the cursor's tiebreaker is user_id.
      id: m.user_id,
    })),
    { requestId: ctx.requestId },
  );
});
