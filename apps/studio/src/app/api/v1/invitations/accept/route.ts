/**
 * `POST /api/v1/invitations/accept`
 *
 * THE ONE ENDPOINT WHERE THE ORG DOES NOT COME FROM THE TOKEN (API §2.2), because the caller
 * is not a member yet — there is nothing for `active_org_id` to say. The org is derived from
 * the hashed invitation token, server-side, and the token is looked up BY HASH so an
 * authenticated user cannot enumerate invitations addressed to somebody else. The org id is
 * still never read from the request body.
 *
 * `role = 'owner'` cannot arrive here: `invitations_role_not_owner` prevents the row existing,
 * and `members_insert`'s `role <> 'owner'` would refuse the membership even if it did. Both are
 * asserted in `invitations.test.ts`.
 */

import { AppError, forbidden } from '@resscript/observability';
import { requireAuthenticated } from '@/server/auth';
import { parseJsonBody, route } from '@/server/http/handler';
import { json } from '@/server/http/respond';
import { acceptInvitationSchema } from '@/server/http/schemas';
import { hashInvitationToken } from '@/server/invitation-token';

export const POST = route(async (ctx, req) => {
  const claims = requireAuthenticated(ctx.claims);
  const { value } = await parseJsonBody(req, acceptInvitationSchema);
  const invitation = await ctx.repos.invitations.findByTokenHash(hashInvitationToken(value.token));

  // A bad token, a revoked token and an expired token are all `not_found`: an invitation is a
  // bearer credential, and distinguishing "wrong" from "expired" tells a guesser they are close.
  if (invitation === null || invitation.status !== 'pending') {
    throw new AppError('not_found', 'invitation not found or no longer valid');
  }
  if (Date.parse(invitation.expires_at) <= ctx.now().getTime()) {
    throw new AppError('not_found', 'invitation not found or no longer valid');
  }
  if (invitation.role === 'owner') {
    // Unreachable through the database, kept as a belt-and-braces refusal so that a future
    // store without the CHECK cannot turn an invitation into an ownership takeover.
    throw forbidden('owner cannot be granted by invitation');
  }
  // The email on the invitation is the addressee. Accepting somebody else's invitation while
  // holding their token is the attack this check closes.
  if (
    claims.email !== null &&
    claims.email.toLowerCase() !== invitation.email.toLowerCase()
  ) {
    throw new AppError('not_found', 'invitation not found or no longer valid', {
      context: { reason: 'addressee_mismatch' },
    });
  }

  const member = await ctx.repos.members.insert({
    org_id: invitation.org_id,
    user_id: claims.userId,
    role: invitation.role,
    project_ids: invitation.project_ids,
    invited_by: invitation.invited_by,
  });
  await ctx.repos.invitations.markAccepted(invitation.id, claims.userId);
  await ctx.repos.audit.write({
    // The org here is the INVITATION's org, not the caller's active org — the documented
    // exception, and the only place `org_id` is passed explicitly.
    org_id: invitation.org_id,
    action: 'invitation.accepted',
    target_kind: 'invitation',
    target_id: invitation.id,
    summary: 'invitation accepted as ' + invitation.role,
    diff: { role: invitation.role, user_id: claims.userId },
    request_id: ctx.requestId,
  });

  if (ctx.minter !== null) {
    // Membership without a token that names the org is membership you cannot use, so accepting
    // re-mints — the same operation as an org switch.
    await ctx.minter.setActiveOrg({
      userId: claims.userId,
      orgId: invitation.org_id,
      role: invitation.role,
      orgs: [...new Set([...claims.orgs, invitation.org_id])],
    });
  }

  return json(
    {
      org_id: invitation.org_id,
      role: member.role,
      project_ids: member.project_ids,
      token_refresh_required: ctx.minter !== null,
    },
    { status: 200, requestId: ctx.requestId },
  );
});
