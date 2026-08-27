/**
 * `POST /api/v1/nodes/:id/items:bulk` — the paste-60-brands path (API §2.5).
 *
 * ## Atomic, and why that is the whole point
 *
 * API §1.6: bulk endpoints are all-or-nothing by default, "because survey content has cross-row
 * invariants … and half-applied content is a survey that fails publish for reasons the user did
 * not cause". Here the invariant is `qitems_code_key`: 60 pasted options with a duplicated code
 * are 60 rejected rows and a 422 naming the offender, never 41 inserted options and a question
 * whose brand list stops at "Nescafé". `mode: 'replace'` makes that sharper still — a partial
 * replace would leave the question with the tail of the old list and the head of the new one.
 *
 * The duplicate check runs over the FINAL set before anything is written: in `append` mode that is
 * the existing items plus the body, in `replace` mode the body alone. Both are the store's, so the
 * check and the constraint cannot disagree.
 *
 * ## The API will not renumber for you
 *
 * Every row carries its own `code`, and reordering the array does not change any of them. Nothing
 * here assigns a code from an array index, which is `POST /items`' rule applied 60 times: `code`
 * is the exported value, and a client that wanted "1..60 in the order I pasted" says so by sending
 * those numbers.
 *
 * ## `replace` is a soft delete
 *
 * The old items get `deleted_at`, not a row removal, for the reason every content delete is soft:
 * a rule can target an option (`rules_one_target`'s `item` arm) and the undo buffer is what lets
 * that rule survive a mistaken paste. Their variables go with them — `replaceQuestionVariables`
 * soft-deletes the declarations the plugin no longer makes — so the export columns disappear from
 * the manifest while the rows stay recoverable.
 */

import { AppError } from '@resscript/observability';
import type { JsonObject } from '@resscript/schema';
import { requireRole } from '@/server/auth';
import { versionEtag } from '@/server/http/etag';
import { parseJsonBody, requireActiveOrg, route } from '@/server/http/handler';
import { json } from '@/server/http/respond';
import { bulkItemsSchema } from '@/server/http/schemas';
import {
  checkBehaviour,
  itemView,
  recomputeVariables,
  takeVersionLock,
  writableVersion,
} from '@/server/nodes';
import type { BulkItemInput } from '@/server/repo/types';

export const POST = route<{ id: string }>(async (ctx, req, params) => {
  requireRole(ctx.role, 'programmer');
  requireActiveOrg(ctx);
  const node = await ctx.repos.nodes.get(params.id);
  if (node === null) throw new AppError('not_found', 'node not found');
  if (node.node_kind !== 'question') {
    throw new AppError('validation_failed', '1 field failed validation', {
      details: [
        { path: null, code: 'not_a_question', message: `a ${node.node_kind} node has no items` },
      ],
    });
  }
  const version = await writableVersion(ctx, node.survey_version_id);
  const { value } = await parseJsonBody(req, bulkItemsSchema);

  // Duplicates WITHIN the body, before the store sees it, so the 422 names both indexes rather
  // than reporting whichever row the unique index happened to reach first. The store checks the
  // same thing against the final set — this is the message, that is the guarantee.
  const details: { path: string; code: string; message: string }[] = [];
  const codeAt = new Map<number, number>();
  const refAt = new Map<string, number>();
  value.items.forEach((row, index) => {
    const firstCode = codeAt.get(row.code);
    if (firstCode !== undefined) {
      details.push({
        path: `items.${String(index)}.code`,
        code: 'duplicate_code',
        message: `code ${String(row.code)} is already used by items.${String(firstCode)}`,
      });
    } else codeAt.set(row.code, index);
    const firstRef = refAt.get(row.ref.toLowerCase());
    if (firstRef !== undefined) {
      details.push({
        path: `items.${String(index)}.ref`,
        code: 'duplicate_ref',
        message: `ref ${row.ref} is already used by items.${String(firstRef)}`,
      });
    } else refAt.set(row.ref.toLowerCase(), index);
  });
  if (details.length > 0) {
    throw new AppError(
      'validation_failed',
      `${details.length} field${details.length === 1 ? '' : 's'} failed validation`,
      { details },
    );
  }

  const withBehaviour = value.items.filter((row) => row.behaviour !== undefined);
  if (withBehaviour.length > 0) {
    const registry = await ctx.repos.registry.forVersion(version.id);
    if (registry === null) throw new AppError('not_found', 'version not found');
    for (const row of withBehaviour) checkBehaviour(row.behaviour as JsonObject, registry);
  }

  const lock = await takeVersionLock(ctx, req, version);
  if (lock.conflict !== undefined) return lock.conflict;

  const items: readonly BulkItemInput[] = value.items.map((row) => ({
    ref: row.ref,
    code: row.code,
    ...(row.label === undefined ? {} : { label_key: row.label }),
    ...(row.anchor === undefined ? {} : { anchor: row.anchor }),
    ...(row.exclusive === undefined ? {} : { exclusive: row.exclusive }),
    ...(row.behaviour === undefined ? {} : { behaviour: row.behaviour as JsonObject }),
    ...(row.value_override === undefined ? {} : { value_override: row.value_override }),
    ...(row.custom_class === undefined ? {} : { custom_class: row.custom_class }),
    ...(row.meta === undefined ? {} : { meta: row.meta as JsonObject }),
  }));
  const written = await ctx.repos.nodes.bulkItems(params.id, value.item_kind, value.mode, items);
  const variables = await recomputeVariables(ctx, node);

  await ctx.repos.audit.write({
    action: 'items.bulk_written',
    target_kind: 'content_node',
    target_id: node.id,
    survey_id: version.survey_id,
    survey_version_id: version.id,
    summary: `${value.mode === 'replace' ? 'replaced' : 'appended'} ${String(written.length)} ${value.item_kind}${written.length === 1 ? '' : 's'} on ${node.ref ?? node.id}`,
    // Counts and column names, not 60 refs: the audit row answers "what changed in this survey
    // today", and the item list is what `GET /nodes/:id/items` is for.
    diff: { mode: value.mode, item_kind: value.item_kind, written: written.length, variables: variables.emitted.length },
    request_id: ctx.requestId,
  });

  return json(
    { data: written.map(itemView), variables_changed: variables.emitted },
    {
      status: 201,
      requestId: ctx.requestId,
      headers: { ETag: versionEtag(lock.locked.revision, ctx.now()) },
    },
  );
});
