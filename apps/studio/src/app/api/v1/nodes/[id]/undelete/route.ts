/**
 * `POST /api/v1/nodes/:id/undelete` — the other half of the undo buffer (API §2.5).
 *
 * Soft delete is only useful if something can undo it, and undo has to restore the SUBTREE: a
 * deleted page took its questions with it (they were soft-deleted with it, in one statement), and
 * restoring the page alone would leave the questions invisible with no route that names them —
 * `content.tree_rows` drops a node whose parent is deleted, so they would be unreachable rows.
 *
 * What it does NOT restore is the logic. `DELETE ?cascade_rules=delete` soft-deletes the rules too,
 * and an undelete cannot tell which rules that cascade removed from which were already gone —
 * `deleted_at` records when, not why. Undo that restores MORE than the delete removed is worse
 * than undo that restores less, so the rules stay for `PATCH /rules/{id}` to bring back
 * deliberately, and the delete response named them for exactly this reason.
 *
 * The ref can have been taken in the meantime: `nodes_ref_key` is partial on `deleted_at`, so
 * deleting `Q7` releases the name immediately and a new `Q7` is legal. The undelete then fails
 * with `already_exists` on the ref, which is the honest answer — the alternative is two live nodes
 * called `Q7` and an export with two columns of that name.
 */

import { AppError } from '@resscript/observability';
import { requireRole } from '@/server/auth';
import { versionEtag } from '@/server/http/etag';
import { requireActiveOrg, route } from '@/server/http/handler';
import { json } from '@/server/http/respond';
import { recomputeVariables, takeVersionLock, writableVersion } from '@/server/nodes';

export const POST = route<{ id: string }>(async (ctx, req, params) => {
  requireRole(ctx.role, 'programmer');
  requireActiveOrg(ctx);
  const node = await ctx.repos.nodes.getDeleted(params.id);
  if (node === null) throw new AppError('not_found', 'node not found');
  if (node.deleted_at === null) {
    // Idempotent-looking but not idempotent: a live node has nothing to restore, and answering
    // 200 would tell a client its undo worked when the row it meant was a different one.
    throw new AppError('illegal_transition', 'this node is not deleted', {
      details: [{ path: null, code: 'not_deleted', message: node.id }],
    });
  }
  const version = await writableVersion(ctx, node.survey_version_id);

  // The subtree INCLUDING deleted rows, narrowed to the ones this DELETE touched: the cascade was
  // one statement, so its rows share one `deleted_at`, and a descendant deleted separately last
  // week has a different one. Restoring the whole subtree would restore more than the delete
  // removed, which is the failure mode this route's header warns about in the other direction.
  const subtree = (await ctx.repos.nodes.subtree(params.id, true)).filter(
    (row) => row.deleted_at === node.deleted_at,
  );

  const lock = await takeVersionLock(ctx, req, version);
  if (lock.conflict !== undefined) return lock.conflict;

  const restored = await ctx.repos.nodes.undelete(subtree.map((row) => row.id));
  // The variables came back with their rows — they were never deleted, because a soft-deleted
  // question keeps its emitted variables so an undelete does not have to recreate columns with new
  // ids. The recompute runs anyway for the restored questions, because the SET can legitimately
  // have changed underneath: `PUT /nodes/:id/cells` on a matrix, or a plugin config migration.
  for (const row of restored) {
    if (row.node_kind === 'question') await recomputeVariables(ctx, row);
  }

  await ctx.repos.audit.write({
    action: 'node.undeleted',
    target_kind: 'content_node',
    target_id: node.id,
    survey_id: version.survey_id,
    survey_version_id: version.id,
    summary: `restored ${node.node_kind} ${node.ref ?? node.id} (${restored.length} node${restored.length === 1 ? '' : 's'})`,
    request_id: ctx.requestId,
  });

  const head = (await ctx.repos.nodes.get(params.id)) ?? restored[0];
  return json(
    { node: head, restored },
    { requestId: ctx.requestId, headers: { ETag: versionEtag(lock.locked.revision, ctx.now()) } },
  );
});
