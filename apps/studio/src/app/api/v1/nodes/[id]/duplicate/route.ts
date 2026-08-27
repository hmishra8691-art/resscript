/**
 * `POST /api/v1/nodes/:id/duplicate` — copy a subtree (API §2.5).
 *
 * "New `id`s, new `ref`s by suffix rule, rules within the subtree remapped, rules pointing *into*
 * it not copied." Each clause is a decision, and the last two are the ones that make the endpoint
 * worth having rather than leaving the client to POST the tree back node by node:
 *
 *  * **New ids, not the source's.** Cloning a VERSION reuses ids verbatim (0007's header: that is
 *    what makes `content.clone_version` a flat INSERT … SELECT and version diffing a set
 *    difference). Duplicating a NODE inside one version is the opposite case: two questions in one
 *    version cannot share an id, and their variables cannot share an export column.
 *  * **Rules within the subtree are remapped.** Duplicating a screener block whose Q2 hides Q3
 *    must give a copy whose Q2 hides the COPY's Q3. Anything else silently produces two blocks
 *    wired to one, which is not a copy — it is a fork with a shared brain.
 *  * **Rules pointing INTO the subtree are not copied.** A rule elsewhere that reads the original
 *    Q2 is a statement about the original. Copying it would double every effect it has, and
 *    "duplicating a block changed the logic of a page I did not touch" is not a defensible edit.
 *    A rule whose target is inside and whose reads are OUTSIDE is copied with the outside
 *    references intact, which is the common case for a battery: the copy asks about a second brand
 *    under the same screener condition.
 *
 * The copy's variables are recomputed from the plugin against the copy's own ref, so the new
 * questions emit new columns with new names and new ids — `emits` starts empty on every copied row
 * for that reason. The variable id map that comes out of the recompute is what lets a copied rule's
 * condition AST be rewritten to read the copy's variables.
 */

import { AppError } from '@resscript/observability';
import type { JsonObject, JsonValue } from '@resscript/schema';
import { requireRole } from '@/server/auth';
import { versionEtag } from '@/server/http/etag';
import { parseJsonBody, requireActiveOrg, route } from '@/server/http/handler';
import { json } from '@/server/http/respond';
import { duplicateNodeSchema } from '@/server/http/schemas';
import {
  assertNesting,
  duplicateRefs,
  itemView,
  recomputeVariables,
  remapIds,
  takeVersionLock,
  variableIdMap,
  writableVersion,
} from '@/server/nodes';
import type { CreateRuleInput, DuplicateInput, RuleRow, VariableRow } from '@/server/repo/types';

export const POST = route<{ id: string }>(async (ctx, req, params) => {
  requireRole(ctx.role, 'programmer');
  requireActiveOrg(ctx);
  const origin = await ctx.repos.nodes.get(params.id);
  if (origin === null) throw new AppError('not_found', 'node not found');
  const version = await writableVersion(ctx, origin.survey_version_id);
  const { value } = await parseJsonBody(req, duplicateNodeSchema);

  const parentId = value.into_parent_id === undefined ? origin.parent_id : value.into_parent_id;
  if (parentId !== null) {
    const parent = await ctx.repos.nodes.get(parentId);
    if (parent === null || parent.survey_version_id !== version.id) {
      throw new AppError('validation_failed', '1 field failed validation', {
        details: [
          { path: 'into_parent_id', code: 'unknown_node', message: 'no such node in this version' },
        ],
      });
    }
    assertNesting(parent.node_kind, origin.node_kind);
  } else {
    assertNesting(null, origin.node_kind);
  }

  const registry = await ctx.repos.registry.forVersion(version.id);
  if (registry === null) throw new AppError('not_found', 'version not found');
  const subtree = await ctx.repos.nodes.subtree(params.id);
  const refs = duplicateRefs(subtree, value.ref, registry);

  // Read the rules BEFORE the write, so "which rules were inside the subtree" is answered against
  // the tree as it was — after the copy lands, every one of them matches the copy too.
  const originalNodeIds = subtree.map((row) => row.id);
  const originalItems = await Promise.all(subtree.map((row) => ctx.repos.nodes.listItems(row.id)));
  const originalItemIds = originalItems.flatMap((items) => items.map((item) => item.id));
  const touching = await ctx.repos.nodes.rulesTouching(version.id, originalNodeIds, originalItemIds);
  const originalVariables = new Map<string, readonly VariableRow[]>();
  for (const row of subtree) {
    if (row.node_kind !== 'question') continue;
    originalVariables.set(row.id, await ctx.repos.nodes.listVariables(row.id));
  }

  const lock = await takeVersionLock(ctx, req, version);
  if (lock.conflict !== undefined) return lock.conflict;

  const input: DuplicateInput = {
    node_id: params.id,
    refs,
    ...(value.into_parent_id === undefined ? {} : { into_parent_id: value.into_parent_id }),
    ...(value.after_id === undefined ? {} : { after_id: value.after_id }),
  };
  const copied = await ctx.repos.nodes.duplicate(input);

  // The full old→new map: nodes and items from the store, variables from the recompute. One map,
  // because a rule's AST does not distinguish the three — it holds ids.
  const idMap = new Map(copied.id_map);
  const createdVariables: VariableRow[] = [];
  for (const copy of copied.nodes) {
    if (copy.node_kind !== 'question') continue;
    const variables = await recomputeVariables(ctx, copy);
    createdVariables.push(...variables.emitted);
    const originalId = [...copied.id_map.entries()].find(([, to]) => to === copy.id)?.[0];
    if (originalId === undefined) continue;
    const mapped = variableIdMap({
      original: originalVariables.get(originalId) ?? [],
      copy: variables.emitted,
      originalQuestionId: originalId,
      copyQuestionId: copy.id,
      idMap: copied.id_map,
    });
    for (const [from, to] of mapped) idMap.set(from, to);
  }

  const rulesCreated: RuleRow[] = [];
  for (const rule of touching) {
    if (!targetsInside(rule, idMap)) continue;
    rulesCreated.push(await ctx.repos.rules.create(copyOf(rule, idMap)));
  }

  await ctx.repos.audit.write({
    action: 'node.duplicated',
    target_kind: 'content_node',
    target_id: copied.nodes[0]?.id ?? origin.id,
    survey_id: version.survey_id,
    survey_version_id: version.id,
    summary: `duplicated ${origin.node_kind} ${origin.ref ?? origin.id} as ${value.ref}`,
    diff: {
      from: origin.id,
      nodes: copied.nodes.length,
      items: copied.items.length,
      rules: rulesCreated.length,
      variables: createdVariables.length,
    },
    request_id: ctx.requestId,
  });

  return json(
    {
      nodes: copied.nodes,
      items: copied.items.map(itemView),
      cells: copied.cells,
      variables_created: createdVariables,
      rules_created: rulesCreated,
    },
    {
      status: 201,
      requestId: ctx.requestId,
      headers: { ETag: versionEtag(lock.locked.revision, ctx.now()) },
    },
  );
});

/** "Within the subtree" means the rule's TARGET was copied. See the header. */
function targetsInside(rule: RuleRow, idMap: ReadonlyMap<string, string>): boolean {
  if (rule.target_node_id !== null) return idMap.has(rule.target_node_id);
  if (rule.target_item_id !== null) return idMap.has(rule.target_item_id);
  // A variable-targeted rule (`SET V = …`) belongs to the version, not to the subtree: the
  // variable it writes is a hidden or derived one that the copy does not own a second instance of.
  return false;
}

/**
 * One rule, rewritten for the copy.
 *
 * The dependency closure is remapped rather than recomputed, and that is deliberate: recomputing
 * it from the rewritten AST would be the correct thing to do and would give the same answer, but
 * `dependencyClosureOf` needs a typed `Expr` and the AST here has just been through a generic id
 * rewrite. Remapping the stored arrays through the same map keeps the two derivations from
 * disagreeing about a rule neither of them authored — and the next `PATCH /rules/{id}` recomputes
 * from the AST anyway, which is where DB §4.4's "recomputed on save" applies.
 */
function copyOf(rule: RuleRow, idMap: ReadonlyMap<string, string>): CreateRuleInput {
  const remap = (id: string): string => idMap.get(id) ?? id;
  return {
    survey_version_id: rule.survey_version_id,
    kind: rule.kind,
    target_kind: rule.target_kind,
    ...(rule.target_node_id === null ? {} : { target_node_id: remap(rule.target_node_id) }),
    ...(rule.target_item_id === null ? {} : { target_item_id: remap(rule.target_item_id) }),
    ...(rule.target_variable_id === null
      ? {}
      : { target_variable_id: remap(rule.target_variable_id) }),
    condition: remapIds(rule.condition as unknown as JsonValue, idMap) as JsonObject,
    effect: remapIds(rule.effect as unknown as JsonValue, idMap) as JsonObject,
    evaluation: rule.evaluation,
    authored_in: rule.authored_in,
    ...(rule.authored_in === 'dsl' ? { trivia: rule.trivia } : {}),
    ...(rule.notes === null ? {} : { notes: rule.notes }),
    depends_on_variable_ids: rule.depends_on_variable_ids.map(remap),
    depends_on_node_ids: rule.depends_on_node_ids.map(remap),
  };
}
