/**
 * `PATCH|DELETE /api/v1/items/:id` — one option, row or column (API §2.5).
 *
 * Flat by id, like every other resource in §1.2: the caller got the id from
 * `GET /nodes/{id}/items`, which already scoped it, and the store re-derives the question and the
 * version from the row.
 *
 * PATCH can change `code`, and it is the only place in the API that can. That is deliberate and it
 * is not the same operation as a reorder: `POST /items/{id}/move` changes what position the option
 * appears in and touches no exported value, while `PATCH {code}` changes the exported value and
 * touches no position. C §5.1 keeps them in separate columns with separate constraints so the
 * mistake is not expressible in the database; keeping them in separate ENDPOINTS is the same
 * decision at the API boundary. A code change renames the derived variable (`Q2r3` → `Q2r7`),
 * which is why the recompute runs and why the response says which columns moved.
 *
 * DELETE is soft and returns 204. The option's variable goes with it — the plugin stops declaring
 * it, so `replaceQuestionVariables` soft-deletes the row — and the item id stays alive, so a rule
 * targeting the option survives for undo.
 */

import { AppError } from '@resscript/observability';
import type { JsonObject } from '@resscript/schema';
import { requireRole } from '@/server/auth';
import { versionEtag } from '@/server/http/etag';
import { parseJsonBody, requireActiveOrg, route } from '@/server/http/handler';
import { json, noContent } from '@/server/http/respond';
import { updateItemSchema } from '@/server/http/schemas';
import {
  checkBehaviour,
  itemView,
  recomputeVariables,
  takeVersionLock,
  writableVersion,
} from '@/server/nodes';
import type { UpdateItemInput } from '@/server/repo/types';

export const PATCH = route<{ id: string }>(async (ctx, req, params) => {
  requireRole(ctx.role, 'programmer');
  requireActiveOrg(ctx);
  const item = await ctx.repos.nodes.getItem(params.id);
  if (item === null) throw new AppError('not_found', 'item not found');
  const node = await ctx.repos.nodes.get(item.question_id);
  if (node === null) throw new AppError('not_found', 'item not found');
  const version = await writableVersion(ctx, item.survey_version_id);

  const { value } = await parseJsonBody(req, updateItemSchema);
  if (value.behaviour !== undefined) {
    const registry = await ctx.repos.registry.forVersion(version.id);
    if (registry === null) throw new AppError('not_found', 'version not found');
    checkBehaviour(value.behaviour as JsonObject, registry);
  }

  const lock = await takeVersionLock(ctx, req, version);
  if (lock.conflict !== undefined) return lock.conflict;

  const patch: UpdateItemInput = {
    ...(value.ref === undefined ? {} : { ref: value.ref }),
    ...(value.code === undefined ? {} : { code: value.code }),
    ...(value.label === undefined ? {} : { label_key: value.label }),
    ...(value.anchor === undefined ? {} : { anchor: value.anchor }),
    ...(value.exclusive === undefined ? {} : { exclusive: value.exclusive }),
    ...(value.behaviour === undefined ? {} : { behaviour: value.behaviour as JsonObject }),
    ...(value.value_override === undefined ? {} : { value_override: value.value_override }),
    ...(value.custom_class === undefined ? {} : { custom_class: value.custom_class }),
    ...(value.meta === undefined ? {} : { meta: value.meta as JsonObject }),
  };
  const updated = await ctx.repos.nodes.updateItem(params.id, patch);
  // `code` is in the derived name (`Q2r{code}`) and `ref` is what the plugin's namer resolves a
  // part by, so either one moves columns. The other fields do not, and pay nothing.
  const variables =
    value.code !== undefined || value.ref !== undefined
      ? await recomputeVariables(ctx, node)
      : { created: [], updated: [], removed: [], emitted: [] };

  await ctx.repos.audit.write({
    action: 'item.updated',
    target_kind: 'question_item',
    target_id: updated.id,
    survey_id: version.survey_id,
    survey_version_id: version.id,
    summary:
      value.code === undefined
        ? `updated ${updated.item_kind} ${updated.ref}`
        : `recoded ${updated.item_kind} ${updated.ref} from ${String(item.code)} to ${String(updated.code)}`,
    ...(value.code === undefined
      ? {}
      : { diff: { code: { from: item.code, to: updated.code } } }),
    request_id: ctx.requestId,
  });

  return json(
    { item: itemView(updated), variables_changed: variables.emitted },
    { requestId: ctx.requestId, headers: { ETag: versionEtag(lock.locked.revision, ctx.now()) } },
  );
});

export const DELETE = route<{ id: string }>(async (ctx, req, params) => {
  requireRole(ctx.role, 'programmer');
  requireActiveOrg(ctx);
  const item = await ctx.repos.nodes.getItem(params.id);
  if (item === null) throw new AppError('not_found', 'item not found');
  const node = await ctx.repos.nodes.get(item.question_id);
  if (node === null) throw new AppError('not_found', 'item not found');
  const version = await writableVersion(ctx, item.survey_version_id);

  const lock = await takeVersionLock(ctx, req, version);
  if (lock.conflict !== undefined) return lock.conflict;

  await ctx.repos.nodes.removeItem(params.id);
  await recomputeVariables(ctx, node);

  await ctx.repos.audit.write({
    action: 'item.deleted',
    target_kind: 'question_item',
    target_id: item.id,
    survey_id: version.survey_id,
    survey_version_id: version.id,
    summary: `deleted ${item.item_kind} ${item.ref} (code ${String(item.code)}) from ${node.ref ?? node.id}`,
    request_id: ctx.requestId,
  });

  // 204, as API §2.5 spells it. The emitted-variable change is observable through
  // `GET /nodes/{id}` — a 204 that carried a body would be a 200 with a lie in the status line.
  return noContent(ctx.requestId);
});
