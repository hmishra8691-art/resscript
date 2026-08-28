/**
 * `GET|PATCH|DELETE /api/v1/nodes/:id` — one node (API §2.5).
 *
 * Addressed by node id alone, as §1.2 spells it: the caller got the id from a version-scoped tree
 * read that already scoped it, and the store re-derives the version (and RLS re-derives the org)
 * from the row. `ref` is never a path segment — it is renameable, and a URL built on it breaks the
 * moment a programmer renames `Q1` to `S1`, which they do constantly.
 *
 * ## GET is the lazily-fetched body, and issues the ETag
 *
 * UI §3.3 caps editor memory by loading the outline once (`GET /versions/:id/tree`) and the BODY
 * per node on selection. `?include=` decides how much of the body: items, cells, validation,
 * masks, scripts, rules. This is the second ETag issuer in the API — the diagnostics and redirects
 * routes both argue for keeping the issuer singular, and §2.5 overrides that for nodes explicitly
 * ("The lazily-fetched body. `ETag`"), because a client that edits a node must be able to lock the
 * version from the read it actually made. The value is the same `W/"<revision>.<ms>"` the version
 * route issues, off the same column, so there is one lock and two places that hand it out.
 *
 * ## PATCH: a ref rename is a variable rename, and `question_type` is not patchable
 *
 * Renaming `ref` renames every variable the question emits, because `content.variables.name` is
 * derived from `(ref, part)` and STORED (0007). The recompute runs through the plugin again and
 * matches by source signature, so the names change and the ids do not — which is what keeps every
 * rule, quota and mask that points at those ids working. Changing `question_type` is refused
 * (API §2.5: "delete and recreate — the emitted variables differ"), and refused with an
 * explanation rather than as an unknown field, because it IS a field of the resource.
 *
 * ## DELETE is soft, and says what it broke
 *
 * `deleted_at`, never a row removal: this is the editor's undo buffer and the reason undo can
 * restore logic that referenced the node (UI §5.4). `?cascade_rules=orphan` (the default) leaves
 * the rules alone — they point at a soft-deleted node, which is exactly what makes undo whole —
 * and `delete` soft-deletes them too. Either way the response NAMES them, because a delete that
 * silently broke three display rules is how a survey reaches field with a question nobody can see.
 */

import { AppError } from '@resscript/observability';
import type { JsonObject } from '@resscript/schema';
import { requireRole } from '@/server/auth';
import { versionEtag } from '@/server/http/etag';
import { parseJsonBody, requireActiveOrg, route } from '@/server/http/handler';
import { json } from '@/server/http/respond';
import { updateNodeSchema } from '@/server/http/schemas';
import { itemView, recomputeVariables, takeVersionLock, writableVersion } from '@/server/nodes';
import { initialQuestionConfig } from '@/server/questions';
import type { UpdateNodeInput } from '@/server/repo/types';

const INCLUDES = ['items', 'cells', 'validation', 'masks', 'scripts', 'rules'] as const;

export const GET = route<{ id: string }>(async (ctx, req, params) => {
  // Reviewer floor — `nodes_select`'s own. A review link reads questions; that is what a review is.
  requireRole(ctx.role, 'reviewer');
  requireActiveOrg(ctx);
  const node = await ctx.repos.nodes.get(params.id);
  if (node === null) throw new AppError('not_found', 'node not found');
  const version = await ctx.repos.surveys.getVersion(node.survey_version_id);
  if (version === null) throw new AppError('not_found', 'node not found');

  const url = new URL(req.url);
  const include = parseInclude(url.searchParams.get('include'));

  const body: Record<string, unknown> = { node };
  if (include.has('items')) {
    body['items'] = (await ctx.repos.nodes.listItems(node.id)).map(itemView);
  }
  if (include.has('cells')) body['cells'] = await ctx.repos.nodes.listCells(node.id);
  // `validation`, `masks` and `scripts` are columns of the node row, so they are already in
  // `node`. Naming them in `?include=` is still meaningful: it is what the client asked for, and
  // the fields are listed separately here so a future projection that DROPS them from the summary
  // row does not silently change what `?include=validation` means.
  if (include.has('validation')) body['validation'] = node.validation;
  if (include.has('masks')) body['masks'] = node.masks;
  if (include.has('scripts')) body['scripts'] = node.scripts;
  if (include.has('rules')) {
    const { rows } = await ctx.repos.rules.list(node.survey_version_id, {
      limit: 200,
      target_node_id: node.id,
    });
    body['rules'] = rows;
  }
  // The variables the question emits, always: `emits` is a list of ids and the panel that renders
  // beside a question needs the names. One indexed read (`variables_source_idx`).
  body['variables'] = await ctx.repos.nodes.listVariables(node.id);

  return json(body, {
    requestId: ctx.requestId,
    headers: { ETag: versionEtag(version.revision, ctx.now()) },
  });
});

export const PATCH = route<{ id: string }>(async (ctx, req, params) => {
  requireRole(ctx.role, 'programmer');
  requireActiveOrg(ctx);
  const current = await ctx.repos.nodes.get(params.id);
  if (current === null) throw new AppError('not_found', 'node not found');
  const version = await writableVersion(ctx, current.survey_version_id);

  const { value } = await parseJsonBody(req, updateNodeSchema);
  if (value.question_type !== undefined && value.question_type !== current.question_type) {
    throw new AppError('validation_failed', '1 field failed validation', {
      details: [
        {
          path: 'question_type',
          code: 'question_type_immutable',
          message:
            'a question type cannot change: the emitted variables differ, so the export columns ' +
            'would change identity. Delete the question and create the new one.',
        },
      ],
    });
  }

  // A config edit goes through the plugin's own schema before the row is written, with the
  // plugin's defaults under it: a `PATCH {config: {display: 'horizontal'}}` on a multi-select must
  // not store an object missing `other`, because the next `declareVariables` would throw on it.
  // Same call, same order as the create path, so the two cannot disagree about what a valid config
  // for this type is.
  let config: JsonObject | undefined;
  if (value.config !== undefined) {
    if (current.node_kind === 'question' && current.question_type !== null && current.ref !== null) {
      const survey = await ctx.repos.surveys.get(version.survey_id);
      const initial = initialQuestionConfig({
        questionType: current.question_type,
        ref: value.ref ?? current.ref,
        supplied: value.config as JsonObject,
        lang: survey?.default_language ?? 'en',
      });
      if (initial.issues.length > 0) {
        throw new AppError(
          'validation_failed',
          `${initial.issues.length} field${initial.issues.length === 1 ? '' : 's'} failed validation`,
          { details: initial.issues.map((issue) => ({ ...issue })) },
        );
      }
      config = initial.config;
    } else {
      config = value.config as JsonObject;
    }
  }

  const lock = await takeVersionLock(ctx, req, version);
  if (lock.conflict !== undefined) return lock.conflict;

  const patch: UpdateNodeInput = {
    ...(value.ref === undefined ? {} : { ref: value.ref }),
    ...(value.label === undefined ? {} : { label_key: value.label }),
    ...(value.instruction === undefined ? {} : { instruction_key: value.instruction }),
    ...(value.title === undefined ? {} : { title_key: value.title }),
    ...(value.required === undefined ? {} : { required: value.required }),
    ...(config === undefined ? {} : { config }),
    ...(value.settings === undefined ? {} : { settings: value.settings as JsonObject }),
    ...(value.flags === undefined ? {} : { flags: value.flags as JsonObject }),
  };
  const updated = await ctx.repos.nodes.update(params.id, patch);

  /*
   * The `_text` forms, each one call into `content.set_node_label`.
   *
   * AFTER the ordinary patch, not merged into it: the function owns both the key and the
   * base-language string and returns the key it chose, so folding it into the column patch above
   * would mean guessing that key here. Every field is independent, so three separate calls is the
   * honest shape rather than a batched one that would need its own transaction.
   *
   * The schema refuses `label` and `label_text` together, so these cannot fight the patch above.
   */
  for (const [field, text] of [
    ['label', value.label_text],
    ['instruction', value.instruction_text],
    ['title', value.title_text],
  ] as const) {
    if (text === undefined) continue;
    await ctx.repos.nodes.setLabelText(version.id, params.id, field, text);
  }

  // The recompute runs when the DECLARATION INPUTS moved: the ref (every name derives from it),
  // the config (a plugin's fan-out reads it) or the flags (`pii` and `exclude_from_export` are
  // carried into every emitted row). A label edit changes no column and pays nothing.
  const recompute =
    updated.node_kind === 'question' &&
    (value.ref !== undefined || value.config !== undefined || value.flags !== undefined);
  const variables = recompute
    ? await recomputeVariables(ctx, updated)
    : { created: [], updated: [], removed: [], emitted: [] };
  const node = (await ctx.repos.nodes.get(params.id)) ?? updated;

  await ctx.repos.audit.write({
    action: 'node.updated',
    target_kind: 'content_node',
    target_id: node.id,
    survey_id: version.survey_id,
    survey_version_id: version.id,
    summary:
      value.ref === undefined
        ? `updated ${node.node_kind} ${node.ref ?? node.id}`
        : `renamed ${current.ref ?? current.id} to ${value.ref}`,
    ...(value.ref === undefined
      ? {}
      : {
          diff: {
            ref: { from: current.ref, to: value.ref },
            // The renamed columns, by name: "which export columns did that rename move" is the
            // question somebody asks six months later with a client's data file open.
            variables_renamed: variables.updated.map((row) => row.name),
          },
        }),
    request_id: ctx.requestId,
  });

  return json(
    { node, variables_changed: variables.emitted },
    {
      requestId: ctx.requestId,
      headers: { ETag: versionEtag(lock.locked.revision, ctx.now()) },
    },
  );
});

export const DELETE = route<{ id: string }>(async (ctx, req, params) => {
  requireRole(ctx.role, 'programmer');
  requireActiveOrg(ctx);
  const node = await ctx.repos.nodes.get(params.id);
  if (node === null) throw new AppError('not_found', 'node not found');
  const version = await writableVersion(ctx, node.survey_version_id);

  const cascade = new URL(req.url).searchParams.get('cascade_rules') ?? 'orphan';
  if (cascade !== 'orphan' && cascade !== 'delete') {
    throw new AppError('validation_failed', '1 field failed validation', {
      details: [
        { path: 'cascade_rules', code: 'invalid_value', message: 'orphan or delete' },
      ],
    });
  }

  const subtree = await ctx.repos.nodes.subtree(params.id);
  const nodeIds = subtree.map((row) => row.id);
  const itemIds = (
    await Promise.all(subtree.map((row) => ctx.repos.nodes.listItems(row.id)))
  ).flatMap((items) => items.map((item) => item.id));
  const affected = await ctx.repos.nodes.rulesTouching(version.id, nodeIds, itemIds);

  const lock = await takeVersionLock(ctx, req, version);
  if (lock.conflict !== undefined) return lock.conflict;

  const deleted = await ctx.repos.nodes.softDelete(nodeIds);
  if (cascade === 'delete') {
    // Soft too, so an undelete of the node can be followed by an undelete of its logic. The route
    // does NOT undelete rules automatically on `POST /undelete`: which rules were deleted BY the
    // cascade and which were already gone is not recoverable from `deleted_at` alone, and undo
    // that restores more than it removed is worse than undo that restores less.
    for (const rule of affected) await ctx.repos.rules.remove(rule.id);
  }

  await ctx.repos.audit.write({
    action: 'node.deleted',
    target_kind: 'content_node',
    target_id: node.id,
    survey_id: version.survey_id,
    survey_version_id: version.id,
    summary: `deleted ${node.node_kind} ${node.ref ?? node.id} (${deleted.length} node${deleted.length === 1 ? '' : 's'})`,
    diff: { cascade_rules: cascade, rules_affected: affected.map((rule) => rule.id) },
    request_id: ctx.requestId,
  });

  return json(
    {
      deleted,
      rules_affected: affected.map((rule) => ({
        id: rule.id,
        kind: rule.kind,
        target_node_id: rule.target_node_id,
        target_item_id: rule.target_item_id,
        // What actually happened to it, so the studio's undo dialog can say so.
        outcome: cascade === 'delete' ? 'deleted' : 'orphaned',
      })),
    },
    {
      requestId: ctx.requestId,
      headers: { ETag: versionEtag(lock.locked.revision, ctx.now()) },
    },
  );
});

function parseInclude(raw: string | null): ReadonlySet<string> {
  if (raw === null || raw.trim() === '') return new Set();
  const parts = raw.split(',').map((part) => part.trim());
  const unknown = parts.filter((part) => !(INCLUDES as readonly string[]).includes(part));
  if (unknown.length > 0) {
    throw new AppError('validation_failed', '1 field failed validation', {
      details: unknown.map((part) => ({
        path: 'include',
        code: 'invalid_value',
        message: `${part} is not one of ${INCLUDES.join(', ')}`,
      })),
    });
  }
  return new Set(parts);
}
