/**
 * `POST /api/v1/versions/:id/nodes` — the only way a question comes into existence (API §2.5).
 *
 * Three things happen here and they are not separable, which is why this is one route and not
 * three:
 *
 *  1. **The server computes `sort_key`.** The body says `after_id` or `before_id`; the store calls
 *     `content.next_sort_key` and ONE row is written (DB §4.6). A client cannot send a sort key —
 *     `createNodeSchema` has no field for one — because a fractional index a client invented is
 *     an ordering only that client agrees with.
 *  2. **The plugin's `declareVariables` runs in the same request** and its result becomes rows in
 *     `content.variables` plus the id list in `nodes.emits`. `variables_created` in the response
 *     is that set, in declaration order, and the names in it are the export columns this question
 *     will produce (ADR-007) — which is why they come from `deriveVariableName` and not from
 *     anything this route spells.
 *  3. **The kind's shape is checked before the store sees it.** `nodes_kind_shape` is the
 *     guarantee ("a question with no question_type" is not storable), and these are the errors an
 *     author can act on: which field their node kind requires.
 *
 * `If-Match` is required, as on every §2.5 write, and 409 `frozen_version` comes first: the body
 * is irrelevant to a version that cannot change.
 */

import { AppError } from '@resscript/observability';
import type { JsonObject } from '@resscript/schema';
import { requireRole } from '@/server/auth';
import { parseJsonBody, requireActiveOrg, route } from '@/server/http/handler';
import { versionEtag } from '@/server/http/etag';
import { json } from '@/server/http/respond';
import { createNodeSchema } from '@/server/http/schemas';
import { assertNesting, recomputeVariables, takeVersionLock, writableVersion } from '@/server/nodes';
import { initialQuestionConfig } from '@/server/questions';
import type { CreateNodeInput, NodeKind } from '@/server/repo/types';

export const POST = route<{ id: string }>(async (ctx, req, params) => {
  requireRole(ctx.role, 'programmer');
  requireActiveOrg(ctx);
  const version = await writableVersion(ctx, params.id);
  const { value } = await parseJsonBody(req, createNodeSchema);

  let parentKind: NodeKind | null = null;
  if (value.parent_id !== null) {
    const parent = await ctx.repos.nodes.get(value.parent_id);
    if (parent === null || parent.survey_version_id !== version.id) {
      throw new AppError('validation_failed', '1 field failed validation', {
        details: [
          { path: 'parent_id', code: 'unknown_node', message: 'no such node in this version' },
        ],
      });
    }
    parentKind = parent.node_kind;
  }
  // C §5, on the insert path. See `assertNesting` for why this is application code.
  assertNesting(parentKind, value.node_kind);
  assertShape(value.node_kind, value);

  // The plugin's `defaultConfig` becomes data HERE, before the row is written, and the type is
  // resolved with it. Both halves matter: a question stored with `config: {}` cannot declare its
  // variables (its plugin reads `ctx.config.other.enabled` and there is no such key), and an
  // unknown `question_type` must be refused BEFORE the insert — there is no transaction around
  // the node write and the variable write, so a node created against a plugin that does not exist
  // would survive the 422 that follows it.
  let config: JsonObject | undefined;
  if (value.node_kind === 'question' && value.question_type !== undefined && value.ref !== undefined) {
    const survey = await ctx.repos.surveys.get(version.survey_id);
    const initial = initialQuestionConfig({
      questionType: value.question_type,
      ref: value.ref,
      supplied: value.config as JsonObject | undefined,
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
  } else if (value.config !== undefined) {
    config = value.config as JsonObject;
  }

  const lock = await takeVersionLock(ctx, req, version);
  if (lock.conflict !== undefined) return lock.conflict;

  const input: CreateNodeInput = {
    survey_version_id: version.id,
    node_kind: value.node_kind,
    parent_id: value.parent_id,
    ...(value.after_id === undefined ? {} : { after_id: value.after_id }),
    ...(value.before_id === undefined ? {} : { before_id: value.before_id }),
    ...(value.ref === undefined ? {} : { ref: value.ref }),
    ...(value.question_type === undefined ? {} : { question_type: value.question_type }),
    ...(value.label === undefined ? {} : { label_key: value.label }),
    ...(value.instruction === undefined ? {} : { instruction_key: value.instruction }),
    ...(value.title === undefined ? {} : { title_key: value.title }),
    // `nodes_kind_shape` makes `required` NOT NULL for a question, and false is the honest
    // default: a question nobody marked required is optional, not unanswerable.
    ...(value.node_kind === 'question' ? { required: value.required ?? false } : {}),
    ...(config === undefined ? {} : { config }),
  };
  const created = await ctx.repos.nodes.create(input);
  const variables = await recomputeVariables(ctx, created);
  // Re-read: `replaceQuestionVariables` rewrote `emits`, and the response must carry the node as
  // it now is rather than as it was one statement ago.
  const node = (await ctx.repos.nodes.get(created.id)) ?? created;

  await ctx.repos.audit.write({
    action: 'node.created',
    target_kind: 'content_node',
    target_id: node.id,
    survey_id: version.survey_id,
    survey_version_id: version.id,
    summary: `created ${node.node_kind} ${node.ref ?? node.id}`,
    diff: { variables_created: variables.emitted.map((row) => row.name) },
    request_id: ctx.requestId,
  });

  return json(
    { node, variables_created: variables.emitted },
    {
      status: 201,
      requestId: ctx.requestId,
      // The new revision, so a client can make its next edit without a GET first — the same
      // courtesy `POST /surveys/:id/versions` extends.
      headers: { ETag: versionEtag(lock.locked.revision, ctx.now()) },
    },
  );
});

/**
 * The `nodes_kind_shape` CHECK, as field-level errors.
 *
 * The CHECK is the guarantee; this is the message. A question needs a plugin, a ref and a
 * required flag; a text node needs a label and no plugin; a block or a page needs a ref and no
 * plugin. Reported per field, because "nodes_kind_shape violated" is not something an author can
 * do anything with.
 */
function assertShape(
  kind: NodeKind,
  value: {
    readonly ref?: string | undefined;
    readonly question_type?: string | undefined;
    readonly label?: string | undefined;
  },
): void {
  const details: { path: string; code: string; message: string }[] = [];
  if (kind === 'question') {
    if (value.question_type === undefined) {
      details.push({
        path: 'question_type',
        code: 'required',
        message: 'a question names the plugin that renders it',
      });
    }
    if (value.ref === undefined) {
      details.push({ path: 'ref', code: 'required', message: 'a question is named; its ref is what its variables derive from' });
    }
  } else if (value.question_type !== undefined) {
    details.push({
      path: 'question_type',
      code: 'not_applicable',
      message: `a ${kind} node has no question type`,
    });
  }
  if (kind === 'text' && value.label === undefined) {
    details.push({ path: 'label', code: 'required', message: 'a text node is its label' });
  }
  if (kind === 'text' && value.ref !== undefined) {
    details.push({
      path: 'ref',
      code: 'not_applicable',
      message: 'a text node emits nothing and therefore has nothing to name (C §3)',
    });
  }
  if ((kind === 'block' || kind === 'page') && value.ref === undefined) {
    details.push({ path: 'ref', code: 'required', message: `a ${kind} is named` });
  }
  if (details.length > 0) {
    throw new AppError(
      'validation_failed',
      `${details.length} field${details.length === 1 ? '' : 's'} failed validation`,
      { details },
    );
  }
}
