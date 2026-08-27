/**
 * `GET|POST /api/v1/nodes/:id/items` — options, matrix rows and matrix columns (API §2.5).
 *
 * ## `code` and display order are two fields, and this route will not let you conflate them
 *
 * C §5.1 calls confusing the two "a classic data disaster": randomizing display order would
 * silently rewrite exported values, and the client's analyst discovers it rather than us. So the
 * body carries `code` (the exported value, required, never defaulted — a server that assigned
 * codes by position would be doing exactly the thing the schema exists to prevent) and, quite
 * separately, `after_id`/`before_id` (the position). `sort_key` is computed by
 * `content.next_item_sort_key`; there is no wire field for it.
 *
 * ## An option is a variable
 *
 * Adding an option to a multi-select adds a column to the export (`Q2r7`), so every write here
 * re-runs the plugin's `declareVariables` and rewrites `content.variables` + `nodes.emits` in the
 * same request. That is why the response carries `variables_changed`: the author needs to see that
 * pasting a brand added 60 columns, and the diff needs to show it a year later.
 *
 * ## `behaviour` ASTs are type-checked on write
 *
 * `visible`, `enabled`, `preselected`, `auto_select`, `required_if` each take `{literal}` or
 * `{condition: AST}` (C §5.1: "every option is programmable"). A condition goes through the same
 * `checkExpr` the rule routes run, against the same version registry, and its `LGC-*` errors are a
 * 422 with the rule vocabulary — one diagnostic language across the compiler, the API and the
 * studio's problems pane.
 */

import { AppError } from '@resscript/observability';
import type { JsonObject } from '@resscript/schema';
import { requireRole } from '@/server/auth';
import { versionEtag } from '@/server/http/etag';
import { parseJsonBody, requireActiveOrg, route } from '@/server/http/handler';
import { json } from '@/server/http/respond';
import { createItemSchema } from '@/server/http/schemas';
import {
  checkBehaviour,
  itemView,
  recomputeVariables,
  takeVersionLock,
  writableVersion,
} from '@/server/nodes';
import type { CreateItemInput, ItemKind } from '@/server/repo/types';

const ITEM_KINDS: readonly string[] = ['option', 'row', 'column'];

export const GET = route<{ id: string }>(async (ctx, req, params) => {
  requireRole(ctx.role, 'reviewer');
  requireActiveOrg(ctx);
  const node = await ctx.repos.nodes.get(params.id);
  if (node === null) throw new AppError('not_found', 'node not found');

  const kind = new URL(req.url).searchParams.get('kind');
  if (kind !== null && !ITEM_KINDS.includes(kind)) {
    throw new AppError('validation_failed', '1 field failed validation', {
      details: [{ path: 'kind', code: 'invalid_value', message: ITEM_KINDS.join(', ') }],
    });
  }
  const items = await ctx.repos.nodes.listItems(
    params.id,
    ...(kind === null ? [] : [kind as ItemKind]),
  );
  return json(
    { survey_version_id: node.survey_version_id, question_id: node.id, data: items.map(itemView) },
    { requestId: ctx.requestId },
  );
});

export const POST = route<{ id: string }>(async (ctx, req, params) => {
  requireRole(ctx.role, 'programmer');
  requireActiveOrg(ctx);
  const node = await ctx.repos.nodes.get(params.id);
  if (node === null) throw new AppError('not_found', 'node not found');
  if (node.node_kind !== 'question') {
    // A block, a page or a text node has no items. 422 and not 404: the node exists and the
    // caller can see it — what is wrong is the request, and naming that is more useful than
    // pretending the node is missing.
    throw new AppError('validation_failed', '1 field failed validation', {
      details: [
        { path: null, code: 'not_a_question', message: `a ${node.node_kind} node has no items` },
      ],
    });
  }
  const version = await writableVersion(ctx, node.survey_version_id);
  const { value } = await parseJsonBody(req, createItemSchema);

  if (value.behaviour !== undefined) {
    const registry = await ctx.repos.registry.forVersion(version.id);
    if (registry === null) throw new AppError('not_found', 'version not found');
    checkBehaviour(value.behaviour as JsonObject, registry);
  }

  const lock = await takeVersionLock(ctx, req, version);
  if (lock.conflict !== undefined) return lock.conflict;

  const input: CreateItemInput = {
    item_kind: value.item_kind,
    ref: value.ref,
    code: value.code,
    ...(value.label === undefined ? {} : { label_key: value.label }),
    ...(value.after_id === undefined ? {} : { after_id: value.after_id }),
    ...(value.before_id === undefined ? {} : { before_id: value.before_id }),
    ...(value.anchor === undefined ? {} : { anchor: value.anchor }),
    ...(value.exclusive === undefined ? {} : { exclusive: value.exclusive }),
    ...(value.behaviour === undefined ? {} : { behaviour: value.behaviour as JsonObject }),
    ...(value.value_override === undefined ? {} : { value_override: value.value_override }),
    ...(value.custom_class === undefined ? {} : { custom_class: value.custom_class }),
    ...(value.meta === undefined ? {} : { meta: value.meta as JsonObject }),
  };
  const item = await ctx.repos.nodes.createItem(params.id, input);
  const variables = await recomputeVariables(ctx, node);

  await ctx.repos.audit.write({
    action: 'item.created',
    target_kind: 'question_item',
    target_id: item.id,
    survey_id: version.survey_id,
    survey_version_id: version.id,
    summary: `added ${item.item_kind} ${item.ref} (code ${String(item.code)}) to ${node.ref ?? node.id}`,
    request_id: ctx.requestId,
  });

  return json(
    { item: itemView(item), variables_changed: variables.emitted },
    {
      status: 201,
      requestId: ctx.requestId,
      headers: { ETag: versionEtag(lock.locked.revision, ctx.now()) },
    },
  );
});
