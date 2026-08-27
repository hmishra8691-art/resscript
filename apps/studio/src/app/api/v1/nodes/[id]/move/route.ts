/**
 * `POST /api/v1/nodes/:id/move` — reparent and reorder, as ONE row write (API §2.5, DB §4.6).
 *
 * This is P1-03's headline acceptance criterion: "the database shows one UPDATE on content.nodes
 * per drag". The route contributes nothing to that beyond staying out of the way — it resolves the
 * position, takes the lock, and calls `content.move_node`, which computes the key from the CURRENT
 * neighbours and writes one row. With integer positions this endpoint would be N updates, N audit
 * rows and a write-write conflict with anybody editing a sibling.
 *
 * A verb sub-resource rather than `PATCH /nodes/{id} {parent_id, after_id}` (API §1.2): a move is
 * not a field edit. It has its own two refusals (into its own subtree; C §5's nesting), it takes a
 * position rather than a value, and folding it into PATCH would mean a body that could rename a
 * ref and reparent a subtree in one indivisible write whose failure modes are the union of both.
 *
 * The refusals come from the database function, which the in-memory store reproduces by name, so a
 * "moved a block into its own page" is a 422 naming `parent_id` in both stores.
 */

import { AppError } from '@resscript/observability';
import { requireRole } from '@/server/auth';
import { versionEtag } from '@/server/http/etag';
import { parseJsonBody, requireActiveOrg, route } from '@/server/http/handler';
import { json } from '@/server/http/respond';
import { moveNodeSchema } from '@/server/http/schemas';
import { assertNesting, takeVersionLock, writableVersion } from '@/server/nodes';
import type { MoveNodeInput } from '@/server/repo/types';

export const POST = route<{ id: string }>(async (ctx, req, params) => {
  requireRole(ctx.role, 'programmer');
  requireActiveOrg(ctx);
  const node = await ctx.repos.nodes.get(params.id);
  if (node === null) throw new AppError('not_found', 'node not found');
  const version = await writableVersion(ctx, node.survey_version_id);

  const { value } = await parseJsonBody(req, moveNodeSchema);
  if (value.parent_id !== null) {
    const parent = await ctx.repos.nodes.get(value.parent_id);
    if (parent === null || parent.survey_version_id !== version.id) {
      throw new AppError('validation_failed', '1 field failed validation', {
        details: [
          { path: 'parent_id', code: 'unknown_node', message: 'no such node in this version' },
        ],
      });
    }
    // Answered before the write for the same reason the create path answers it: the message names
    // the two kinds. `content.move_node` refuses it again — that is the guarantee, this is the
    // error text — and the subtree refusal is left entirely to the function, whose recursive
    // ancestor walk is the check and which the memory store mirrors.
    assertNesting(parent.node_kind, node.node_kind);
  } else {
    assertNesting(null, node.node_kind);
  }

  const lock = await takeVersionLock(ctx, req, version);
  if (lock.conflict !== undefined) return lock.conflict;

  const input: MoveNodeInput = {
    parent_id: value.parent_id,
    ...(value.after_id === undefined ? {} : { after_id: value.after_id }),
    ...(value.before_id === undefined ? {} : { before_id: value.before_id }),
  };
  const moved = await ctx.repos.nodes.move(params.id, input);

  await ctx.repos.audit.write({
    action: 'node.moved',
    target_kind: 'content_node',
    target_id: moved.id,
    survey_id: version.survey_id,
    survey_version_id: version.id,
    summary: `moved ${moved.node_kind} ${moved.ref ?? moved.id}`,
    // The parent, not the key: a fractional sort key in an audit row is noise to every reader,
    // and "which parent did it end up under" is the question a diff is actually asked.
    diff: { parent_id: { from: node.parent_id, to: moved.parent_id } },
    request_id: ctx.requestId,
  });

  return json(
    { node: moved },
    { requestId: ctx.requestId, headers: { ETag: versionEtag(lock.locked.revision, ctx.now()) } },
  );
});
