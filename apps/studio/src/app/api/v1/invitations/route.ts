/**
 * `GET  /api/v1/invitations` — open invitations for the active org (admin only).
 * `POST /api/v1/invitations` — issue one.
 *
 * The plaintext token is returned ONCE, in this response, and is never persisted: what the
 * database stores is `sha256(token)`. An `owner` invitation is refused twice over — here with
 * a field-level message, and by `app.invitations.invitations_role_not_owner` if anything ever
 * reaches the table another way.
 */

import { assertInvitableRole, requireRole } from '@/server/auth';
import { parseJsonBody, requireActiveOrg, route } from '@/server/http/handler';
import { idempotencyKeyOf, withIdempotency } from '@/server/http/idempotency';
import { pageEnvelope, pageQueryFrom, idPosition } from '@/server/http/pagination';
import { json } from '@/server/http/respond';
import { createInvitationSchema } from '@/server/http/schemas';
import { hashInvitationToken, invitationExpiry, newInvitationToken } from '@/server/invitation-token';

export const GET = route(async (ctx, req) => {
  requireRole(ctx.role, 'admin');
  requireActiveOrg(ctx);
  const query = pageQueryFrom(new URL(req.url));
  const { rows, hasMore } = await ctx.repos.invitations.list(query);
  return json(pageEnvelope(rows, hasMore, query.limit, idPosition), { requestId: ctx.requestId });
});

export const POST = route(async (ctx, req) => {
  requireRole(ctx.role, 'admin');
  const orgId = requireActiveOrg(ctx);
  const { value, raw } = await parseJsonBody(req, createInvitationSchema);
  const role = value.role;
  // Guard #1 of 2. The DB CHECK is the guarantee; this is the message a user can act on.
  assertInvitableRole(role);

  return withIdempotency(
    {
      store: ctx.repos.idempotency,
      orgId,
      endpoint: 'POST /invitations',
      key: idempotencyKeyOf(req),
      body: raw,
      requestId: ctx.requestId,
      now: ctx.now,
    },
    async () => {
      const token = newInvitationToken();
      const invitation = await ctx.repos.invitations.create({
        email: value.email,
        role,
        ...(value.project_ids === undefined ? {} : { project_ids: value.project_ids }),
        token_hash: hashInvitationToken(token),
        expires_at: invitationExpiry(ctx.now()),
      });
      await ctx.repos.audit.write({
        action: 'invitation.created',
        target_kind: 'invitation',
        target_id: invitation.id,
        summary: 'invited ' + value.email + ' as ' + role,
        diff: { email: value.email, role },
        request_id: ctx.requestId,
      });
      return {
        status: 201,
        body: {
          ...invitation,
          // Shown once. The emailed link carries this value; the row carries only its hash.
          token,
          token_shown_once: true,
        },
      };
    },
  );
});
