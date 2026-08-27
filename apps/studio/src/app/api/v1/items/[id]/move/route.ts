/**
 * `POST /api/v1/items/:id/move` — reorder one option, row or column (API §2.5).
 *
 * The endpoint P1-03's acceptance criterion is measured on: "reorders a 60-option list by dragging,
 * and the database shows ONE UPDATE per drag". `content.move_question_item` writes one row and
 * leaves `code` untouched, which is C §5.1's whole point — the exported value does not move when
 * the display order does — and it is why this is a separate endpoint from `PATCH /items/{id}`
 * rather than a `position` field on it.
 *
 * No variable recompute, and that absence is the assertion: a reorder changes no name, no code and
 * no declaration, so nothing about the export contract moves. If this route ever needs to
 * recompute, something has started deriving a column from a position.
 */

import { AppError } from '@resscript/observability';
import { requireRole } from '@/server/auth';
import { versionEtag } from '@/server/http/etag';
import { parseJsonBody, requireActiveOrg, route } from '@/server/http/handler';
import { json } from '@/server/http/respond';
import { moveItemSchema } from '@/server/http/schemas';
import { itemView, takeVersionLock, writableVersion } from '@/server/nodes';
import type { SiblingPosition } from '@/server/repo/types';

export const POST = route<{ id: string }>(async (ctx, req, params) => {
  requireRole(ctx.role, 'programmer');
  requireActiveOrg(ctx);
  const item = await ctx.repos.nodes.getItem(params.id);
  if (item === null) throw new AppError('not_found', 'item not found');
  const version = await writableVersion(ctx, item.survey_version_id);
  const { value } = await parseJsonBody(req, moveItemSchema);

  const lock = await takeVersionLock(ctx, req, version);
  if (lock.conflict !== undefined) return lock.conflict;

  const position: SiblingPosition = {
    ...(value.after_id === undefined ? {} : { after_id: value.after_id }),
    ...(value.before_id === undefined ? {} : { before_id: value.before_id }),
  };
  const moved = await ctx.repos.nodes.moveItem(params.id, position);

  await ctx.repos.audit.write({
    action: 'item.moved',
    target_kind: 'question_item',
    target_id: moved.id,
    survey_id: version.survey_id,
    survey_version_id: version.id,
    summary: `reordered ${moved.item_kind} ${moved.ref}`,
    request_id: ctx.requestId,
  });

  return json(
    { item: itemView(moved) },
    { requestId: ctx.requestId, headers: { ETag: versionEtag(lock.locked.revision, ctx.now()) } },
  );
});
