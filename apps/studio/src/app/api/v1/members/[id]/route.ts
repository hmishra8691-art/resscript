/**
 * `PATCH|DELETE /api/v1/members/:id` — `:id` is the member's `user_id`.
 *
 * Flat-by-id per API §1.2 (nested for creation and listing, flat for read/update/delete). The
 * org is the token's; there is no member of another org addressable through this route because
 * the repository is org-bound by construction.
 *
 * P1-01 acceptance: "changing a member from `programmer` to `viewer` … produces one
 * `app.audit_log` row naming the actor, target and old/new role." That is the `diff` written
 * below, and `role-change.test.ts` asserts exactly one row with both values.
 */

import { AppError } from '@resscript/observability';
import { requireRole } from '@/server/auth';
import { parseJsonBody, requireActiveOrg, route } from '@/server/http/handler';
import { json, noContent } from '@/server/http/respond';
import { updateMemberSchema } from '@/server/http/schemas';

export const PATCH = route<{ id: string }>(async (ctx, req, params) => {
  requireRole(ctx.role, 'admin');
  requireActiveOrg(ctx);
  const { value } = await parseJsonBody(req, updateMemberSchema);
  const nextRole = value.role;

  // `owner` is unreachable from this route in BOTH directions, mirroring `members_update`'s
  // `role <> 'owner'` in USING (an admin cannot demote an owner) and in WITH CHECK (an admin
  // cannot promote anyone, including themselves, to owner). One without the other is a
  // privilege-escalation path.
  if (nextRole === 'owner') {
    throw new AppError('validation_failed', '1 field failed validation', {
      details: [
        {
          path: 'role',
          code: 'role_not_assignable',
          message: 'ownership is transferred by an explicit audited action, not a role change',
        },
      ],
    });
  }

  const before = await ctx.repos.members.get(params.id);
  if (before === null) {
    throw new AppError('not_found', 'member not found', { context: { user_id: params.id } });
  }
  if (before.role === 'owner') {
    throw new AppError('forbidden', 'an owner cannot be modified through this endpoint', {
      details: [{ path: null, code: 'owner_immutable', message: 'transfer ownership instead' }],
    });
  }

  const member = await ctx.repos.members.update(params.id, {
    ...(nextRole === undefined ? {} : { role: nextRole }),
    ...(value.project_ids === undefined ? {} : { project_ids: value.project_ids }),
  });

  await ctx.repos.audit.write({
    action: 'member.role_changed',
    target_kind: 'user',
    target_id: params.id,
    summary: 'member role changed from ' + before.role + ' to ' + member.role,
    diff: {
      role: { from: before.role, to: member.role },
      project_ids: { from: [...before.project_ids], to: [...member.project_ids] },
    },
    request_id: ctx.requestId,
  });
  ctx.logger.info('member role changed', {
    target_user_id: params.id,
    from_role: before.role,
    to_role: member.role,
  });
  // The demoted member's next save fails because `app.has_role()` reads the ROW, not their
  // token — which is why `RequestContext.role` is also read from the row.
  return json(member, { requestId: ctx.requestId });
});

export const DELETE = route<{ id: string }>(async (ctx, _req, params) => {
  requireRole(ctx.role, 'admin');
  requireActiveOrg(ctx);
  const before = await ctx.repos.members.get(params.id);
  if (before === null) {
    throw new AppError('not_found', 'member not found', { context: { user_id: params.id } });
  }
  // `members_delete`'s USING clause carries `role <> 'owner'`, so removing an owner affects
  // zero rows — silently. The route refuses it explicitly instead, because a 204 that deleted
  // nothing is the worst possible answer, and because the actionable message is "transfer
  // ownership first". Removing the LAST owner is additionally impossible via the deferred
  // `org_has_owner` trigger; neither check is the guarantee on its own.
  if (before.role === 'owner') {
    throw new AppError('forbidden', 'an owner cannot be removed through this endpoint', {
      details: [
        { path: null, code: 'owner_immutable', message: 'transfer ownership before removing' },
      ],
    });
  }
  await ctx.repos.members.remove(params.id);
  await ctx.repos.audit.write({
    action: 'member.removed',
    target_kind: 'user',
    target_id: params.id,
    summary: 'member removed',
    diff: { role: { from: before.role, to: null } },
    request_id: ctx.requestId,
  });
  return noContent(ctx.requestId);
});
