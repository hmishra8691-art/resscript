/**
 * The content-tree routes' shared server logic (API §2.5).
 *
 * Four things live here because they are each needed by two or more routes and each is a
 * decision that must have exactly one implementation:
 *
 *  1. **The version lock** (`takeVersionLock`). API §1.7: every version-scoped content resource
 *     shares ONE optimistic lock, `app.survey_versions.revision`, and "every content mutation
 *     touches that row in the same transaction". A content route has no version field to write,
 *     so the lock is taken as a compare-and-swap through `SurveyRepo.touchVersion` — see that
 *     method. Taken AFTER the frozen check, because ADR-002 makes a non-draft immutable and
 *     "clone a new draft" is the actionable answer regardless of which revision the client holds.
 *  2. **The variable recompute** (`recomputeVariables`). The plugin's `declareVariables` decides
 *     what a question emits; `src/server/questions.ts` plans the rows; this writes them and
 *     turns a plugin diagnostic into a 422. Called by create, patch, the item routes and the
 *     cells route, because all five change the shape a question emits from.
 *  3. **The nesting rule** (`assertNesting`). C §5: blocks hold blocks and pages; pages hold
 *     questions and text. `content.move_node` enforces it for MOVES and no database object
 *     enforces it for INSERTS — 0007 has no such CHECK, and a CHECK could not express it (it
 *     spans two rows). So the create path checks it here, and the note is the honest half: this
 *     is the one structural rule in §2.5 whose only enforcement is application code.
 *  4. **The duplicate's ref rule and id remap** (`duplicateRefs`, `remapIds`). A subtree copy
 *     has to rename every ref it carries and rewrite every internal reference; a rule inside the
 *     copy must point at the copy.
 */

import { AppError, frozenVersion, prefixedId } from '@resscript/observability';
import { assertExprShape, isExprShape } from '@resscript/logic';
import type { JsonObject, JsonValue } from '@resscript/schema';
import { variableSignature } from '@resscript/schema';
import type { QuestionId, VariablePart } from '@resscript/schema';
import type { RequestContext } from '@/server/context';
import { requireIfMatch } from '@/server/http/etag';
import { revisionConflictResponse } from '@/server/http/respond';
import { planQuestionVariables } from '@/server/questions';
import { checkRuleCondition } from '@/server/rules';
import type {
  ItemRow,
  NodeKind,
  NodeRow,
  SurveyVersionRow,
  VariableRow,
  VariableWriteResult,
  VersionRegistryRows,
} from '@/server/repo/types';

/* ========================================================================== */
/* 1. The version lock                                                         */
/* ========================================================================== */

export type VersionLock =
  | { readonly locked: SurveyVersionRow; readonly conflict?: undefined }
  | { readonly conflict: Response; readonly locked?: undefined };

/**
 * `If-Match` → the version's revision, bumped.
 *
 * Order matters and is API §1.7's: the frozen check has already run in the route (409 before the
 * lock is even looked at), then `If-Match` is mandatory (`428` when absent — "a client that does
 * not participate in the lock is a client that overwrites a colleague"), then the CAS.
 *
 * The lock is taken BEFORE the content write, and that direction is deliberate. A failure between
 * the two leaves the revision bumped with nothing written, which invalidates every other editor's
 * ETag for no reason — conservative, and self-correcting on their next GET. The other order would
 * let two writers both write and both then discover the conflict, which is not recoverable.
 */
export async function takeVersionLock(
  ctx: RequestContext,
  req: Request,
  version: SurveyVersionRow,
): Promise<VersionLock> {
  const ifMatch = requireIfMatch(req);
  const locked = await ctx.repos.surveys.touchVersion(version.id, ifMatch.revision);
  if (locked !== null) return { locked };
  const latest = await ctx.repos.surveys.getVersion(version.id);
  const changed = await ctx.repos.audit.since(
    version.id,
    // The ETag's timestamp is what gives `changed_since` a range to query; the revision alone
    // would give none. This is why the ETag carries both (API §1.7).
    new Date(ifMatch.issuedAtMs).toISOString(),
  );
  return {
    conflict: revisionConflictResponse({
      requestId: ctx.requestId,
      currentRevision: latest?.revision ?? version.revision,
      changedSince: changed.map(
        (row): JsonValue => ({
          action: row.action,
          actor: row.actor_user_id,
          at: row.created_at,
          target_id: row.target_id ?? null,
        }),
      ),
      expected: String(ifMatch.revision),
    }),
  };
}

/**
 * The version a content route is about to write, or the right refusal.
 *
 * One helper because every write in §2.5 opens the same three lines, and the ORDER of the three
 * is the contract: 404 for a version that is not visible (a cross-tenant read is 404, never 403 —
 * confirming existence leaks), then 409 for a frozen one, then the caller takes the lock.
 */
export async function writableVersion(
  ctx: RequestContext,
  versionId: string,
): Promise<SurveyVersionRow> {
  const version = await ctx.repos.surveys.getVersion(versionId);
  if (version === null) throw new AppError('not_found', 'version not found');
  if (version.status !== 'draft') throw frozenVersion(version.id);
  return version;
}

/* ========================================================================== */
/* 2. The variable recompute                                                   */
/* ========================================================================== */

export interface RecomputeResult extends VariableWriteResult {
  /** Every variable the question now emits, in the order the plugin declared them. */
  readonly emitted: readonly VariableRow[];
}

/**
 * Recompute one question's emitted variables from its plugin, and write them.
 *
 * Called on every edit that can change the declaration set: creating the question, renaming its
 * `ref` (the names are derived from it), editing its `config` (a plugin's fan-out depends on it),
 * and every item or cell write (an option IS a variable in a multi-select). Not called for blocks,
 * pages or text nodes, which emit nothing — `planQuestionVariables` returns an empty plan for
 * those rather than being guarded at four call sites.
 *
 * A plugin diagnostic is a `422` naming the plugin's own code: F §9's kit runs in the plugin
 * author's CI and an `org_custom` plugin never ran it, so this is the last place a bad
 * declaration can be stopped before it becomes a column in a client's data file.
 */
export async function recomputeVariables(
  ctx: RequestContext,
  node: NodeRow,
): Promise<RecomputeResult> {
  if (node.node_kind !== 'question') {
    return { created: [], updated: [], removed: [], emitted: [] };
  }
  const [items, cells, existing] = await Promise.all([
    ctx.repos.nodes.listItems(node.id),
    ctx.repos.nodes.listCells(node.id),
    ctx.repos.nodes.listVariables(node.id),
  ]);
  const plan = planQuestionVariables({
    question: { node, items, cells },
    existing,
    newId: () => prefixedId('var'),
  });
  if (plan.issues.length > 0) {
    // A question with NO ITEMS AT ALL is incomplete, not invalid, and the difference is the
    // editor's own flow: you create the question, then you add its options. Every choice type
    // refuses to declare at that moment for a good reason — a `single_select`'s enum and a
    // `multi_select`'s set view have no domain until an option exists (`missing_enum_domain`,
    // schema's SCH-1007) — so a 422 here would make "add a dropdown" impossible without pasting
    // its options in the same request.
    //
    // So an itemless question emits nothing and the refusal is deferred to the first item write,
    // where the author is looking at the option list, and to the publish gate, which has to refuse
    // "a multi-select with no options" regardless of how it got there. A question that HAS items
    // and still cannot declare is a genuine 422: something the author just changed is wrong.
    if (items.length > 0 || !plan.issues.every(isIncompleteness)) {
      throw new AppError(
        'validation_failed',
        `${plan.issues.length} field${plan.issues.length === 1 ? '' : 's'} failed validation`,
        { details: plan.issues.map((issue) => ({ ...issue })) },
      );
    }
    const cleared = await ctx.repos.nodes.replaceQuestionVariables(node.id, []);
    return { ...cleared, emitted: [] };
  }
  const written = await ctx.repos.nodes.replaceQuestionVariables(node.id, plan.rows);
  const byId = new Map([...written.created, ...written.updated].map((row) => [row.id, row]));
  return {
    ...written,
    // Declaration order, not store order: `variables_created` is what the studio renders next to
    // the question, and the plugin's order is the export order within the question (F §1.1's
    // `export.order`).
    emitted: plan.rows.flatMap((row) => {
      const hit = byId.get(row.id);
      return hit === undefined ? [] : [hit];
    }),
  };
}

/**
 * The two diagnostics that mean "this question has no options YET", not "this question is wrong".
 *
 * Both are `verifyDeclarations`' and both are unavoidable for an itemless choice question: an enum
 * or set with no domain has no meaning (`missing_enum_domain`, schema's SCH-1007), and a
 * `multi_select` whose only declaration is its `set` view has nothing scalar to export
 * (`non_analysable_declaration`, F §4). Anything else — an unknown plugin, an invalid config, a
 * name a plugin built by hand — is a real refusal at any item count.
 *
 * Matched on the local half of the code, because the kit namespaces it as `QK-<pluginId>-<code>`
 * and the plugin id is not part of what makes these two deferrable.
 */
const INCOMPLETE_CODES: readonly string[] = ['missing_enum_domain', 'non_analysable_declaration'];

function isIncompleteness(issue: { readonly code: string }): boolean {
  return INCOMPLETE_CODES.some((code) => issue.code.endsWith(code));
}

/* ========================================================================== */
/* 3. The nesting rule (C §5)                                                  */
/* ========================================================================== */

const NESTING: Readonly<Record<NodeKind, readonly NodeKind[]>> = {
  block: ['block', 'page'],
  page: ['question', 'text'],
  question: [],
  text: [],
};

/**
 * C §5's nesting, checked on the INSERT path.
 *
 * `content.move_node` makes the identical check for moves and raises `check_violation`; 0007 has
 * no equivalent for inserts, and a CHECK could not have one — the rule relates a row to its
 * parent row. So a create goes through here, and this comment is the record that the insert
 * path's only enforcement is application code. `content.insert_node` would close it, and does
 * not exist.
 */
export function assertNesting(parentKind: NodeKind | null, childKind: NodeKind): void {
  if (parentKind === null) {
    if (childKind === 'block') return;
    throw new AppError('validation_failed', '1 field failed validation', {
      details: [
        { path: 'parent_id', code: 'root_is_block', message: 'only a block may be a root node' },
      ],
    });
  }
  if (NESTING[parentKind].includes(childKind)) return;
  throw new AppError('validation_failed', '1 field failed validation', {
    details: [
      {
        path: 'parent_id',
        code: 'illegal_nesting',
        message: `a ${parentKind} may not contain a ${childKind}; C §5: blocks nest and hold pages, pages hold questions and text`,
      },
    ],
  });
}

/* ========================================================================== */
/* 4. The duplicate: refs and internal references                              */
/* ========================================================================== */

/**
 * The suffix rule: the smallest integer suffix that frees the name.
 *
 * `Q7` → `Q7_2` → `Q7_3`, and `Q7_2` → `Q7_3` rather than `Q7_2_2`, so duplicating a duplicate
 * does not grow a tail. Case-insensitive against the taken set, because `nodes_ref_key` indexes
 * `lower(ref)` — a copy called `q7_2` would collide with `Q7_2` at the index and nowhere earlier.
 * Truncated to `app.ref`'s 64 characters from the LEFT of the stem, so the suffix always survives.
 */
export function nextFreeRef(ref: string, taken: ReadonlySet<string>): string {
  const match = /^(.*?)_(\d+)$/.exec(ref);
  const stem = match?.[1] ?? ref;
  let next = match?.[2] === undefined ? 2 : Number(match[2]) + 1;
  for (;;) {
    const suffix = `_${next}`;
    const candidate = stem.slice(0, 64 - suffix.length) + suffix;
    if (!taken.has(candidate.toLowerCase())) return candidate;
    next += 1;
  }
}

/**
 * A ref for every node of a subtree copy: the root's from the request, the rest by suffix rule.
 *
 * `taken` grows as the walk assigns, so two descendants that shared a stem cannot both claim
 * `X_2`. Text nodes have no ref (`nodes_ref_key` exempts them) and get `null`.
 */
export function duplicateRefs(
  subtree: readonly NodeRow[],
  rootRef: string,
  registry: VersionRegistryRows,
): readonly { readonly id: string; readonly ref: string | null }[] {
  const taken = new Set<string>(
    registry.nodes.flatMap((node) => (node.ref === null ? [] : [node.ref.toLowerCase()])),
  );
  const out: { id: string; ref: string | null }[] = [];
  const root = subtree[0];
  for (const node of subtree) {
    if (node.ref === null) {
      out.push({ id: node.id, ref: null });
      continue;
    }
    const ref = root !== undefined && node.id === root.id ? rootRef : nextFreeRef(node.ref, taken);
    taken.add(ref.toLowerCase());
    out.push({ id: node.id, ref });
  }
  return out;
}

/**
 * Rewrite every id in a JSON value through a map.
 *
 * A blunt instrument on purpose. The alternative is a typed AST rewriter, and `packages/logic`
 * has no such visitor (`readsOf` and `probesOf` READ ids; nothing writes them) — writing one here
 * would be a second definition of the AST's shape at the API boundary, which is exactly what
 * `dslPrintSchema` refuses to do for the same reason. What makes the blunt version safe is that
 * ids are prefixed ULIDs: a 26-character Crockford string with a `qst_`/`opt_`/`var_` prefix does
 * not occur as an i18n key, a label or an operator name, so replacing exact string matches
 * touches ids and nothing else.
 */
export function remapIds(value: JsonValue, idMap: ReadonlyMap<string, string>): JsonValue {
  if (typeof value === 'string') return idMap.get(value) ?? value;
  if (Array.isArray(value)) return value.map((entry) => remapIds(entry, idMap));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value)) out[key] = remapIds(entry, idMap);
    return out;
  }
  return value;
}

/**
 * Old variable id → new variable id, for the copies of one question.
 *
 * Matched by SOURCE SIGNATURE with the item ids rewritten into the copy's namespace — never by
 * name, because the copy's names differ by construction (that is what the ref suffix is for) and
 * never by position, because a plugin is free to declare in any order as long as it is
 * deterministic. This is the same `variableSignature` match that keeps ids stable across a
 * rename, applied across a copy instead of across an edit.
 */
export function variableIdMap(input: {
  readonly original: readonly VariableRow[];
  readonly copy: readonly VariableRow[];
  readonly originalQuestionId: string;
  readonly copyQuestionId: string;
  readonly idMap: ReadonlyMap<string, string>;
}): ReadonlyMap<string, string> {
  const bySignature = new Map<string, string>();
  for (const row of input.copy) {
    if (row.source_part === null) continue;
    bySignature.set(
      variableSignature(
        input.copyQuestionId as QuestionId,
        row.source_part as unknown as VariablePart,
      ),
      row.id,
    );
  }
  const out = new Map<string, string>();
  for (const row of input.original) {
    if (row.source_part === null) continue;
    const remapped = remapIds(row.source_part as unknown as JsonValue, input.idMap);
    const signature = variableSignature(
      input.copyQuestionId as QuestionId,
      remapped as unknown as VariablePart,
    );
    const hit = bySignature.get(signature);
    if (hit !== undefined) out.set(row.id, hit);
  }
  return out;
}

/* ========================================================================== */
/* Option behaviour: `{literal}` or `{condition: AST}` (API §2.5, C §5.1)      */
/* ========================================================================== */

/**
 * Type-check every `condition` AST in a `behaviour` object, and reject with `LGC-*`.
 *
 * The same `checkExpr` the rule routes run, against the same version registry — API §2.5 says
 * option behaviour ASTs "are type-checked on write and rejected with `LGC-*` codes", and a second
 * checker would be a second opinion about a language the evaluator owns. A literal arm is passed
 * through untouched: it is a value, not an expression.
 */
export function checkBehaviour(behaviour: JsonObject, registry: VersionRegistryRows): void {
  const details: { path: string; code: string; message: string }[] = [];
  for (const [key, entry] of Object.entries(behaviour)) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const condition = (entry as Record<string, JsonValue>)['condition'];
    if (condition === undefined) continue;
    if (!isExprShape(condition)) {
      details.push({
        path: `behaviour.${key}.condition`,
        code: 'invalid_ast',
        message: 'not an AST node',
      });
      continue;
    }
    const check = checkRuleCondition(assertExprShape(condition), registry);
    for (const diagnostic of check.diagnostics) {
      if (diagnostic.severity !== 'error') continue;
      details.push({
        path: `behaviour.${key}.condition${diagnostic.path}`,
        code: diagnostic.code,
        message: diagnostic.message,
      });
    }
  }
  if (details.length > 0) {
    throw new AppError('validation_failed', 'the condition failed the type check', { details });
  }
}

/* ========================================================================== */
/* Wire shapes                                                                 */
/* ========================================================================== */

/**
 * One item, as the routes return it.
 *
 * `label_key` is renamed to `label` on the way out, matching the write shape — the wire never
 * carries the `_key` suffix (see `schemas.ts`) and a response that did would make the read and
 * the write two different vocabularies for one field.
 */
export function itemView(row: ItemRow): JsonObject {
  return {
    id: row.id,
    question_id: row.question_id,
    item_kind: row.item_kind,
    ref: row.ref,
    code: row.code,
    label: row.label_key,
    sort_key: row.sort_key,
    anchor: row.anchor,
    exclusive: row.exclusive,
    behaviour: row.behaviour,
    value_override: row.value_override,
    custom_class: row.custom_class,
    meta: row.meta,
    deleted_at: row.deleted_at,
  };
}
