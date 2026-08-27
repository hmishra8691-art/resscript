/**
 * `GET|PUT /api/v1/nodes/:id/cells` — mixed matrices (API §2.5, C §5.2).
 *
 * Row A numeric, row B text, row C single-select: a thin per-cell override of the matrix's default
 * control, so no new engine is needed and each cell emits its own variable with its own type. That
 * is C §1's variable model doing its job, and it is why this route's real output is not the cells —
 * it is the `variables_changed` the recompute produces. Declaring row A numeric is how `Q5r1`
 * becomes a number column.
 *
 * ## Addressed by REF, resolved to ids here
 *
 * The body says `row_ref: 'BRAND_C'` because that is what an author holds; the table stores
 * `row_item_id` because that is what survives a rename. The resolution happens here, once, against
 * the question's own items, and a ref that names nothing is a 422 naming the index — not a foreign
 * key error dressed as a 500.
 *
 * ## PUT is a whole-set replace
 *
 * The resource is the SET, for `PUT /versions/:id/redirects`' reason: the meaning of one override
 * depends on which others exist (a row with no override uses the matrix default), so "add one
 * override" is not an operation an author performs — they edit the grid and save it. Replace also
 * makes deletion expressible without a fourth route.
 *
 * ## `composable` is checked, and by the plugin registry rather than by a list here
 *
 * API §2.5: "child `question_type` must have `meta.composable === true` (F §3)". The registry is
 * the authority — `listComposable` exists for exactly this question — and a hardcoded list of
 * composable types here would be a second answer that drifts the first time a plugin's meta
 * changes. Trust laundering is checked at the same time, because F §3.1 rule 2 says a more trusted
 * parent may not compose a less trusted child without an explicit allowlist entry.
 */

import { AppError } from '@resscript/observability';
import type { JsonObject } from '@resscript/schema';
import { requireRole } from '@/server/auth';
import { versionEtag } from '@/server/http/etag';
import { parseJsonBody, requireActiveOrg, route } from '@/server/http/handler';
import { json } from '@/server/http/respond';
import { replaceCellsSchema } from '@/server/http/schemas';
import { recomputeVariables, takeVersionLock, writableVersion } from '@/server/nodes';
import { questionRegistry } from '@/server/questions';
import type { CellInput } from '@/server/repo/types';

export const GET = route<{ id: string }>(async (ctx, _req, params) => {
  requireRole(ctx.role, 'reviewer');
  requireActiveOrg(ctx);
  const node = await ctx.repos.nodes.get(params.id);
  if (node === null) throw new AppError('not_found', 'node not found');
  const [cells, items] = await Promise.all([
    ctx.repos.nodes.listCells(params.id),
    ctx.repos.nodes.listItems(params.id),
  ]);
  const refOf = new Map(items.map((item) => [item.id, item.ref]));
  // Ids back to refs on the way out, so the read and the write speak the same language.
  return json(
    {
      question_id: node.id,
      cells: cells.map((cell) => ({
        id: cell.id,
        row_ref: refOf.get(cell.row_item_id) ?? null,
        column_ref: cell.column_item_id === null ? null : refOf.get(cell.column_item_id) ?? null,
        control: {
          question_type: cell.question_type,
          config: cell.config,
          use_columns: cell.use_columns,
        },
      })),
    },
    { requestId: ctx.requestId },
  );
});

export const PUT = route<{ id: string }>(async (ctx, req, params) => {
  requireRole(ctx.role, 'programmer');
  requireActiveOrg(ctx);
  const node = await ctx.repos.nodes.get(params.id);
  if (node === null) throw new AppError('not_found', 'node not found');
  if (node.node_kind !== 'question') {
    throw new AppError('validation_failed', '1 field failed validation', {
      details: [
        { path: null, code: 'not_a_question', message: `a ${node.node_kind} node has no cells` },
      ],
    });
  }
  const version = await writableVersion(ctx, node.survey_version_id);
  const { value } = await parseJsonBody(req, replaceCellsSchema);

  const items = await ctx.repos.nodes.listItems(params.id);
  const rowId = new Map(items.filter((i) => i.item_kind === 'row').map((i) => [i.ref, i.id]));
  const columnId = new Map(items.filter((i) => i.item_kind === 'column').map((i) => [i.ref, i.id]));
  const registry = questionRegistry();

  // The whole set, validated to completion, BEFORE the store is touched — `PUT /redirects`' rule,
  // and for the same reason: the row is not stored, so the index into the submitted array is the
  // only address the client has.
  const details: { path: string; code: string; message: string }[] = [];
  const cells: CellInput[] = [];
  value.cells.forEach((cell, index) => {
    const row = rowId.get(cell.row_ref);
    if (row === undefined) {
      details.push({
        path: `cells.${String(index)}.row_ref`,
        code: 'unknown_item',
        message: `${cell.row_ref} is not a row of this question`,
      });
    }
    let column: string | null = null;
    if (cell.column_ref !== undefined) {
      const hit = columnId.get(cell.column_ref);
      if (hit === undefined) {
        details.push({
          path: `cells.${String(index)}.column_ref`,
          code: 'unknown_item',
          message: `${cell.column_ref} is not a column of this question`,
        });
      } else column = hit;
    }
    const resolved = registry.resolveForCompile(cell.control.question_type);
    if (resolved === undefined) {
      details.push({
        path: `cells.${String(index)}.control.question_type`,
        code: 'unknown_question_type',
        message: `${cell.control.question_type} is not a registered question type`,
      });
    } else if (!resolved.meta.composable) {
      details.push({
        path: `cells.${String(index)}.control.question_type`,
        code: 'not_composable',
        message: `${cell.control.question_type} may not be used as a cell control (F §3.1 rule 1)`,
      });
    } else if (
      node.question_type !== null &&
      !registry.isComposeTrustAllowed(
        registry.resolveForCompile(node.question_type)?.meta.trust ?? 'org_custom',
        resolved.meta.trust,
        resolved.meta.id,
      )
    ) {
      details.push({
        path: `cells.${String(index)}.control.question_type`,
        code: 'compose_trust_violation',
        message: 'trust may only go down through a cell control (F §3.1 rule 2)',
      });
    }
    if (cell.control.use_columns === true && cell.column_ref !== undefined) {
      details.push({
        path: `cells.${String(index)}.control.use_columns`,
        code: 'use_columns_is_row_level',
        message: 'use_columns is only meaningful on a whole-row override',
      });
    }
    if (row !== undefined) {
      cells.push({
        row_item_id: row,
        column_item_id: column,
        question_type: cell.control.question_type,
        ...(cell.control.config === undefined ? {} : { config: cell.control.config as JsonObject }),
        ...(cell.control.use_columns === undefined ? {} : { use_columns: cell.control.use_columns }),
      });
    }
  });
  if (details.length > 0) {
    throw new AppError(
      'validation_failed',
      `${details.length} cell${details.length === 1 ? '' : 's'} failed validation`,
      { details },
    );
  }

  const lock = await takeVersionLock(ctx, req, version);
  if (lock.conflict !== undefined) return lock.conflict;

  const stored = await ctx.repos.nodes.replaceCells(params.id, cells);
  // The point of the endpoint: each cell's control decides its cell's variable TYPE, so the
  // manifest changes shape here even though no item and no ref moved.
  const variables = await recomputeVariables(ctx, node);

  await ctx.repos.audit.write({
    action: 'cells.replaced',
    target_kind: 'content_node',
    target_id: node.id,
    survey_id: version.survey_id,
    survey_version_id: version.id,
    summary: `replaced the cell overrides on ${node.ref ?? node.id} with ${String(stored.length)} row${stored.length === 1 ? '' : 's'}`,
    diff: { cells: stored.length, variables: variables.emitted.length },
    request_id: ctx.requestId,
  });

  return json(
    { cells: stored, variables_changed: variables.emitted },
    { requestId: ctx.requestId, headers: { ETag: versionEtag(lock.locked.revision, ctx.now()) } },
  );
});
