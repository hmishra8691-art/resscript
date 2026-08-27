/**
 * `GET /api/v1/versions/:id/tree` — the outline, in ONE request (API §2.5, UI §3.3).
 *
 * "One request for the whole outline", and deliberately not paginated (API §1.3): the editor needs
 * the whole tree to render, and a paginated tree makes "jump to Q1847" a multi-request operation.
 * 2,000 questions plus their pages and blocks is ~200 KB gzipped, which is what caps editor memory
 * on the largest surveys — question BODIES are absent and arrive from `GET /nodes/{id}`.
 *
 * The rows come from `content.tree_rows()`: ONE recursive CTE, in the database. At 2,000 questions
 * across 30 blocks a per-level read would be 30+ queries for one screen (B §13), and a
 * materialized path column would add subtree-wide write amplification to every drag — which is the
 * write pattern this whole model is optimized for (DB §4.1).
 *
 * ## What the query parameters decide
 *
 *  * `fields=summary` (the default) returns §2.5's `TreeRow` with `label_preview: null`.
 *  * `fields=full` resolves the label previews from `content.i18n_strings` in the base language —
 *    one extra read of the version's strings, which is why it is opt-in rather than always: the
 *    tree is fetched on every editor open and most of them do not need the text.
 *  * `include=rules` adds `rule_summaries` per node, from the version's rules read once and
 *    grouped by target (`rules_target_node_idx`). Opt-in for the same reason — a tree render does
 *    not need them until the badges are switched on.
 *  * `include=badges` is accepted and is a no-op: `flags`, `diagnostic_counts` and the counts are
 *    in every row already. Rejecting it would break a client asking for what it already gets; the
 *    parameter exists in §2.5 and the honest implementation is to say it costs nothing.
 *
 * `diagnostic_counts` comes from the version's STORED `compile_diagnostics` (K §3: `compile_state`
 * and `status` are separate axes) rather than from a compile on read. An empty count on
 * `compile_state: 'none'` therefore means "never compiled", not "clean" — which is exactly what
 * `DiagnosticsView` says about the same array, and the studio renders the distinction.
 */

import { AppError } from '@resscript/observability';
import type { JsonValue } from '@resscript/schema';
import type { RequestContext } from '@/server/context';
import { requireRole } from '@/server/auth';
import { requireActiveOrg, route } from '@/server/http/handler';
import { json } from '@/server/http/respond';
import type { RuleRow, TreeRowRecord } from '@/server/repo/types';

const INCLUDES: readonly string[] = ['rules', 'badges'];

export const GET = route<{ id: string }>(async (ctx, req, params) => {
  requireRole(ctx.role, 'reviewer');
  requireActiveOrg(ctx);
  const url = new URL(req.url);
  const fields = url.searchParams.get('fields') ?? 'summary';
  if (fields !== 'summary' && fields !== 'full') {
    throw new AppError('validation_failed', '1 field failed validation', {
      details: [{ path: 'fields', code: 'invalid_value', message: 'summary or full' }],
    });
  }
  const include = (url.searchParams.get('include') ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
  const unknown = include.filter((part) => !INCLUDES.includes(part));
  if (unknown.length > 0) {
    throw new AppError('validation_failed', '1 field failed validation', {
      details: unknown.map((part) => ({
        path: 'include',
        code: 'invalid_value',
        message: `${part} is not one of ${INCLUDES.join(', ')}`,
      })),
    });
  }

  const version = await ctx.repos.surveys.getVersion(params.id);
  if (version === null) throw new AppError('not_found', 'version not found');
  const rows = await ctx.repos.nodes.tree(params.id);
  if (rows === null) throw new AppError('not_found', 'version not found');

  const previews =
    fields === 'full' ? await labelPreviews(ctx, params.id) : new Map<string, string>();
  const rulesByNode = include.includes('rules')
    ? await rulesByTarget(ctx, params.id)
    : new Map<string, readonly RuleRow[]>();
  const diagnostics = diagnosticCounts(version.compile_diagnostics);

  return json(
    {
      survey_version_id: version.id,
      revision: version.revision,
      fields,
      data: rows.map((row) => treeRow(row, { previews, rulesByNode, diagnostics })),
    },
    { requestId: ctx.requestId },
  );
});

interface TreeRowContext {
  readonly previews: ReadonlyMap<string, string>;
  readonly rulesByNode: ReadonlyMap<string, readonly RuleRow[]>;
  readonly diagnostics: ReadonlyMap<string, { errors: number; warnings: number }>;
}

/**
 * §2.5's `TreeRow`, with the field names it names.
 *
 * `kind` and not `node_kind`, because that is what the table says and what the pre-P1-03 version of
 * this route already served — a rename here would break the clients written against it for no gain.
 * The counts (`item_count`, `child_count`, `emit_count`) are additions on top of §2.5's list, which
 * §1.1 permits: they come free out of the CTE and the tree cannot render a "60 options" badge or a
 * collapse chevron without them.
 */
function treeRow(row: TreeRowRecord, ctx: TreeRowContext): JsonValue {
  const rules = ctx.rulesByNode.get(row.id) ?? [];
  const counts = ctx.diagnostics.get(row.id) ?? { errors: 0, warnings: 0 };
  return {
    id: row.id,
    kind: row.node_kind,
    parent_id: row.parent_id,
    sort_key: row.sort_key,
    ref: row.ref,
    label_preview: row.label_key === null ? null : ctx.previews.get(row.label_key) ?? null,
    question_type: row.question_type,
    required: row.required,
    flags: row.flags,
    rule_summaries: rules.map((rule) => ({
      id: rule.id,
      kind: rule.kind,
      // The effect's action, which is what a one-line summary is: "hides this", "requires this".
      action: (rule.effect as Record<string, JsonValue>)['action'] ?? null,
      evaluation: rule.evaluation,
      authored_in: rule.authored_in,
    })),
    diagnostic_counts: counts,
    depth: row.depth,
    ordinal: row.ordinal,
    item_count: row.item_count,
    child_count: row.child_count,
    emit_count: row.emit_count,
    updated_at: row.updated_at,
  };
}

/** Base-language label text by key. One read of the version's strings; `fields=full` only. */
async function labelPreviews(
  ctx: RequestContext,
  versionId: string,
): Promise<ReadonlyMap<string, string>> {
  const languages = await ctx.repos.i18n.listLanguages(versionId);
  const base = languages.find((language) => language.is_base)?.lang;
  if (base === undefined) return new Map();
  const strings = await ctx.repos.i18n.listStrings(versionId);
  const out = new Map<string, string>();
  for (const row of strings) {
    if (row.lang !== base || row.value === null) continue;
    out.set(row.key, row.value);
  }
  return out;
}

/** The version's rules grouped by `target_node_id` — one read, then a group-by. */
async function rulesByTarget(
  ctx: RequestContext,
  versionId: string,
): Promise<ReadonlyMap<string, readonly RuleRow[]>> {
  // 1,000 is far past any real survey's rule count and is a guard rather than a limit; the tree is
  // not paginated, so neither is this — a partial grouping would render badges on some nodes and
  // silently not on others, which is worse than a slow response.
  const { rows } = await ctx.repos.rules.list(versionId, { limit: 1000 });
  const out = new Map<string, RuleRow[]>();
  for (const rule of rows) {
    if (rule.target_node_id === null) continue;
    const bucket = out.get(rule.target_node_id);
    if (bucket === undefined) out.set(rule.target_node_id, [rule]);
    else bucket.push(rule);
  }
  return out;
}

/**
 * `{errors, warnings}` per node, from the version's stored compile diagnostics.
 *
 * The diagnostics carry `node_id` (API §1.5's `compile_errors` shape), which is what makes the
 * tree's problem badges an index into an array the compiler already produced rather than a second
 * analysis. Diagnostics with no `node_id` are version-level and are not counted against any node.
 */
function diagnosticCounts(
  diagnostics: readonly JsonValue[],
): ReadonlyMap<string, { errors: number; warnings: number }> {
  const out = new Map<string, { errors: number; warnings: number }>();
  for (const entry of diagnostics) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, JsonValue>;
    const nodeId = record['node_id'];
    if (typeof nodeId !== 'string') continue;
    const counts = out.get(nodeId) ?? { errors: 0, warnings: 0 };
    if (record['severity'] === 'error') counts.errors += 1;
    else if (record['severity'] === 'warning') counts.warnings += 1;
    out.set(nodeId, counts);
  }
  return out;
}
