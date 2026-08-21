/**
 * D §8.1's forward-reference analysis: `LGC-F001` (no path sets this variable before the rule
 * reads it) and `LGC-F002` (some paths set it, some do not), plus the `VariableSites` index both
 * of them and the never-visible check are stated in terms of.
 *
 * THE ACCEPTANCE CRITERION THIS FILE EXISTS FOR, verbatim from the roadmap: "Publishing a survey
 * whose Q12 display rule reads Q20 fails with a diagnostic naming Q12, Q20, the rule, and the
 * flow positions of both, and no artifact is written." Every field in `detail` below is there
 * because that sentence names it.
 *
 * ## Why this is a dominance query and not a document-order comparison
 *
 * `types.ts` states it on `FlowGraph` and `packages/rescript-dsl`'s `forwardReferences` states
 * the converse — it does compare document positions, and its own comment says why that is only
 * legitimate there: "a DSL document expresses no branches — its order *is* its flow". A survey
 * has branches, and then the two claims come apart:
 *
 *  - "Q20 appears later in the file" is a fact about the document and not about any respondent.
 *    A flow that visits the second block before the first makes it false and harmless.
 *  - "some path reaches Q12 without having asked Q20" is the bug: on that path the read is
 *    UNKNOWN, UNKNOWN collapses to "do not fire" (D §2.5), and the rule silently does nothing.
 *
 * Only the second is checked here, and the mirror cases are both pinned by tests: a branched
 * survey where document order says "fine" and dominance says "forward reference", and one where
 * document order says "forward reference" and dominance says fine (which must be silent).
 *
 * ## Set dominance, not single-site dominance
 *
 * The naive query — "does *a* write site dominate the read" — cries wolf on a correct survey.
 * A variable written on every arm of a branch that joins before the read is available on every
 * path, yet no single arm's node dominates the join; the *branch* does. So the question asked
 * here is the set version: **is every path from `start` to the read cut by at least one write
 * site.** It is answered by a backward walk from the read that refuses to pass through a write
 * site — if `start` is still reachable that way, there is a write-free path and the set does not
 * dominate. `dominates()` from `types.ts` remains the single-site primitive and is what
 * `flow.test.ts` pins against a brute-force oracle; this is its natural generalization and is
 * pinned the same way.
 *
 * ## The F001 / F002 split, stated precisely
 *
 * Let `W` be the read variable's write sites and `R` the flow node the rule is evaluated at.
 *
 *  - `W` cuts every `start → R` path  ⇒ **silence**. The value is always there.
 *  - `W` does not cut every path, but at least one `w ∈ W` lies on some `start → R` path
 *    ⇒ **`LGC-F002`**, a warning. Some respondents have the value and some do not, which is a
 *    legitimate design ("segment those who answered the screener") as often as it is a bug, so
 *    it is acknowledgeable rather than blocking.
 *  - No `w ∈ W` lies on any `start → R` path — including `W` empty ⇒ **`LGC-F001`**, an error.
 *    The read is UNKNOWN for *every* respondent. There is no reading of the survey under which
 *    the rule does what it says, so publish is blocked.
 *
 * The demo case falls in the third bucket: "Rule R14 on Q41 reads Q52, which is asked later in
 * the flow (page 18 vs page 24)" — Q52's write site is downstream of the read on every path, so
 * it lies on no path *to* the read, and the answer is `F001`.
 *
 * ## Three shapes that must not be false positives
 *
 *  1. **A `hidden` or `system` variable.** It exists before any page renders — a vendor
 *     parameter, a URL token, the start timestamp — so its site is `start`, which dominates
 *     everything. These are in `VariableSites.preEntry` and are answered before the graph is
 *     touched at all.
 *  2. **A write on every arm of a branch.** Covered by set dominance, above.
 *  3. **A `derived` variable.** It has no site of its own: it exists as soon as its inputs do
 *     (`compileLogic` makes its expression the writer of its `value` cell). So a read of a
 *     derived variable resolves to a claim about *its inputs*, transitively, and the answer is
 *     the meet — a derived variable is available on exactly the paths where every input is. The
 *     recursion carries a visited set and answers "available" on a cycle rather than looping:
 *     `LGC-CYCLE` already reports the cycle, and a second diagnostic about a symptom of it
 *     would bury the one that names the cause.
 *
 * ## What this module refuses to do
 *
 * It does not report a rule scoped to an unreachable flow node (`LGC-U001` owns that, and it is
 * an error, so publish is blocked either way), and it reports nothing at all when the flow has
 * no start node — `CMP-0001` is then the only diagnostic worth reading, and every rule in the
 * survey would otherwise be a forward reference.
 */

import {
  type ContentNode,
  type PageId,
  type QuestionNode,
  type Survey,
  type VariableId as SchemaVariableId,
} from '@resscript/schema';
import {
  diagnostic,
  exprsOf,
  readsOf,
  type PageId as LogicPageId,
  type Rule,
  type Target,
  type TypeEnv,
  type VarDecl,
  type VariableId,
  type VariableKind,
} from '@resscript/logic';

import { fromLogicDiagnostic, sortCompileDiagnostics, type CompileDiagnostic } from '../diagnostics.js';
import { flowNodeOfNode, pageOfQuestion } from '../flow.js';
import type { FlowGraph, VariableSites } from '../types.js';
import { rulePointers } from './solver.js';

/* ========================================================================== */
/* 0. The id boundary                                                          */
/* ========================================================================== */

/**
 * The return leg of `registry.ts`' boundary casts.
 *
 * `VariableSites` and `FlowGraph` in `types.ts` are declared in **schema's** id space, because
 * that is the space the artifact and every other compiler pass speak; `TypeEnv` answers in
 * **logic's**, because `packages/logic` cannot import schema (ADR-010) and declares its own
 * nominal brands. `registry.ts` owns the schema→logic direction and validates the prefix while
 * it is there (`asVariableId` throws on a wrong one). These two are the way back, and they are
 * unchecked: the prefix was already checked on the way in, and re-parsing it here would be a
 * second contract for the same string that could disagree with the first.
 */
function schemaVariableId(id: VariableId): SchemaVariableId {
  return id as unknown as SchemaVariableId;
}

function schemaPageId(id: LogicPageId): PageId {
  return id as unknown as PageId;
}

/* ========================================================================== */
/* 1. The variable-site index                                                  */
/* ========================================================================== */

/**
 * Variable kinds whose value exists before the first page renders — `types.ts`' "written at
 * entry (so it dominates everything, and its site is the start node)". An entry parameter, a
 * vendor id, the session's start time.
 */
const ENTRY_KINDS: readonly VariableKind[] = ['hidden', 'system'];

/**
 * Kinds the model gives no flow position at all, treated as entry when nothing else places them.
 *
 * The *conservative* answer rather than a claim: a quota variable is written by the gate and a
 * design variable by the design allocator, and neither is a node this index can name. Between
 * "silence" and "an error on every read" for something the model cannot place, it has to be
 * silence — a false `LGC-F001` is an error the author cannot clear. When quota gating lands
 * (`LGC-Q003` is reserved for exactly the ordering question) `quota` should leave this list and
 * gain a real site.
 */
const UNPLACEABLE_KINDS: readonly VariableKind[] = ['quota', 'design'];

/**
 * Where every variable is written and read, in flow-node terms.
 *
 * Built once and shared, per `VariableSites`' own comment, because the four kinds of write site
 * are easy to conflate and a second derivation is a second chance to conflate them differently.
 * The four, and where each comes from:
 *
 *  - a `response` variable → the flow node laying out its question (`contentSites`);
 *  - a `hidden`/`system` variable → `start`, recorded in `preEntry`;
 *  - a `set_variable` rule → the flow node its rule is scoped to (`Rule.flow_node_id`), which
 *    `rules.ts` resolved and which is deliberately absent for a rule on a hidden variable;
 *  - a `derived` variable → **nowhere of its own, and its entry holds only its explicit
 *    writers** (a `set_variable` rule, or a question site when it is question-sourced, as a
 *    `set_view` over a fan-out is). "Wherever its inputs are complete" is not a set of nodes: it
 *    is a *conjunction* over the inputs, and a dominance query reads a set of sites as a
 *    disjunction ("any one of these cuts the path"). Materializing the union of the inputs'
 *    sites would therefore be read as "the earliest input suffices", which is the permissive
 *    direction and would make `D = A + B` look available wherever `A` alone is. So the union is
 *    deliberately not stored, and `analyzeForwardReferences` recurses through the expression
 *    instead — where the meet is expressible.
 */
export function buildVariableSites(
  survey: Survey,
  graph: FlowGraph,
  rules: readonly Rule[],
  env: TypeEnv,
): VariableSites {
  const pageOf = pageOfQuestion(survey);
  const writes = new Map<SchemaVariableId, string[]>();
  const reads = new Map<SchemaVariableId, string[]>();
  const preEntry = new Set<SchemaVariableId>();

  const add = (map: Map<SchemaVariableId, string[]>, id: VariableId, site: string): void => {
    const key = schemaVariableId(id);
    const existing = map.get(key);
    if (existing === undefined) map.set(key, [site]);
    else if (!existing.includes(site)) existing.push(site);
  };

  // 1. Question sites: a response variable is written where its question is asked.
  for (const decl of env.variables()) {
    for (const site of questionSitesOf(decl, graph, pageOf)) add(writes, decl.id, site);
  }

  // 2. `set_variable` rules, at the node the rule is scoped to.
  for (const rule of rules) {
    if (rule.effect.action !== 'set') continue;
    const site = rule.flow_node_id;
    if (site === undefined) continue;
    add(writes, rule.effect.variable_id, site);
  }

  // 3. Entry variables. A hidden or system variable is in `preEntry` even when a `set` rule
  //    also writes it, because `preEntry` answers a different question — "does this exist
  //    before any page" — and the answer is still yes. The unplaceable kinds are added only
  //    when nothing else positioned them.
  for (const decl of env.variables()) {
    const atEntry = ENTRY_KINDS.includes(decl.kind);
    const unplaceable = UNPLACEABLE_KINDS.includes(decl.kind) && !writes.has(schemaVariableId(decl.id));
    if (!atEntry && !unplaceable) continue;
    preEntry.add(schemaVariableId(decl.id));
    if (graph.start !== '') add(writes, decl.id, graph.start);
  }

  // 4. Reads, from every expression a rule evaluates.
  const ctx = context(survey, graph, env);
  for (const rule of rules) {
    const site = readSiteOf(rule, ctx);
    if (site === undefined) continue;
    for (const expr of exprsOf(rule)) {
      for (const id of readsOf(expr)) add(reads, id, site);
    }
  }

  return { writes, reads, preEntry };
}

/**
 * Every flow node at which a question-sourced variable is written.
 *
 * `contentSites` carries question ids as well as page ids — a flow node that lays out a page
 * lays out its children — so the direct lookup answers for every laid-out question, and the
 * page fallback is for a question reached through a site recorded on the page alone. Same
 * two-step as `rules.ts`' `flowSiteOfQuestion`, deliberately: a variable whose write site
 * disagreed with the site of the rules scoped to the same question would make the dominance
 * query compare two different graphs.
 *
 * *Every* site and not `flowNodeOfNode`'s first one, which is the one asymmetry with `rules.ts`
 * and it is in the safe direction. A content node with two sites is a block laid out twice
 * (legal) or a page with two entries (`CMP-0004`, already an error); in both cases the value can
 * exist at either, and a set of write sites can only ever make the dominance query answer
 * "available" where a single site would have answered "missing".
 */
function questionSitesOf(
  decl: VarDecl,
  graph: FlowGraph,
  pageOf: ReadonlyMap<string, PageId>,
): readonly string[] {
  const questionId = decl.question_id;
  if (questionId === undefined) return [];
  const direct = graph.contentSites.get(questionId);
  if (direct !== undefined && direct.length > 0) return direct;
  const page = pageOf.get(questionId);
  return (page === undefined ? undefined : graph.contentSites.get(page)) ?? [];
}

/* ========================================================================== */
/* 2. Set dominance                                                            */
/* ========================================================================== */

/**
 * `true` when every path from `start` to `read` passes through at least one node in `sites`.
 *
 * A backward walk from `read` that declines to expand a write site: reaching `start` means a
 * write-free path exists. Unreachable predecessors are skipped for the reason `computeIdom`
 * skips them — they contribute no path from `start`, and letting one vote would weaken the
 * answer behind a dead edge.
 *
 * Reflexive: a write at the read's own node counts. That is not a technicality — a display rule
 * on Q13 reading Q12 on the same page is a live in-page dependency, which the cell graph
 * recomputes on change (D §4.4), and reporting it would make every matrix cross-reference a
 * publish error.
 */
export function writeSetDominates(
  graph: FlowGraph,
  sites: ReadonlySet<string>,
  read: string,
): boolean {
  if (sites.has(read)) return true;
  if (read === graph.start) return false;
  const seen = new Set<string>([read]);
  const stack: string[] = [read];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) break;
    for (const pred of graph.predecessors.get(node) ?? []) {
      if (!graph.reachable.has(pred)) continue;
      if (sites.has(pred)) continue;
      if (pred === graph.start) return false;
      if (seen.has(pred)) continue;
      seen.add(pred);
      stack.push(pred);
    }
  }
  return true;
}

/** Every reachable node with a path to `read`, plus `read` itself. */
function ancestorsOf(graph: FlowGraph, read: string): ReadonlySet<string> {
  const seen = new Set<string>([read]);
  const stack: string[] = [read];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) break;
    for (const pred of graph.predecessors.get(node) ?? []) {
      if (!graph.reachable.has(pred) || seen.has(pred)) continue;
      seen.add(pred);
      stack.push(pred);
    }
  }
  return seen;
}

/* ========================================================================== */
/* 3. Availability                                                             */
/* ========================================================================== */

/** How much of the path space has the value by the time the read happens. */
type Availability = 'all' | 'some' | 'none';

interface Resolution {
  readonly availability: Availability;
  /**
   * The variable actually missing. Equal to the read variable except through a derived chain,
   * where the read is fine and one of its inputs is not — and naming the derived variable there
   * would send the author to a definition that has nothing wrong with it.
   */
  readonly blocking: VariableId;
}

/** Meet: a derived variable is available only where every input is. */
function meet(a: Availability, b: Availability): Availability {
  if (a === 'none' || b === 'none') return 'none';
  if (a === 'some' || b === 'some') return 'some';
  return 'all';
}

const RANK: { readonly [K in Availability]: number } = { none: 0, some: 1, all: 2 };

interface Ctx {
  readonly survey: Survey;
  readonly graph: FlowGraph;
  readonly env: TypeEnv;
  readonly sites: VariableSites;
  readonly pageOf: ReadonlyMap<string, PageId>;
  readonly questionOfOption: ReadonlyMap<string, string>;
  readonly pagesOfNode: ReadonlyMap<string, readonly PageId[]>;
  readonly pageIndex: ReadonlyMap<string, number>;
  readonly ancestors: Map<string, ReadonlySet<string>>;
}

function resolve(id: VariableId, read: string, ctx: Ctx, seen: ReadonlySet<VariableId>): Resolution {
  const here: Resolution = { availability: 'all', blocking: id };
  const decl = ctx.env.byId(id);
  // An unknown variable is `LGC-T001`, reported by the checker with the id in hand. Claiming a
  // forward reference on top of it would name the same typo twice under a scarier code.
  if (decl === undefined) return here;
  if (ctx.sites.preEntry.has(schemaVariableId(id))) return here;

  const sites = new Set(ctx.sites.writes.get(schemaVariableId(id)) ?? []);
  const bySites: Availability = sites.size === 0 ? 'none' : dominanceAvailability(ctx, sites, read);

  if (decl.kind !== 'derived') return { availability: bySites, blocking: id };
  if (decl.expression === undefined) {
    // `registry.ts` already reports this as `CMP-0103` ("its value cell would have no writer"),
    // which is the diagnostic that explains it. Silence here.
    return here;
  }
  if (seen.has(id)) return here; // cycle: `LGC-CYCLE` owns it.

  const next = new Set(seen);
  next.add(id);
  // The meet over the inputs, remembering the worst one so the diagnostic can name it. An
  // expression with no variable inputs is a constant and is available everywhere.
  let byInputs: Availability = 'all';
  let blocking = id;
  for (const input of readsOf(decl.expression)) {
    const resolved = resolve(input, read, ctx, next);
    if (RANK[resolved.availability] < RANK[byInputs]) blocking = resolved.blocking;
    byInputs = meet(byInputs, resolved.availability);
  }

  // An explicit writer (a `set_variable` rule, or the question a `set_view` belongs to) is an
  // independent source, so the better of the two answers is the honest one. A tie goes to the
  // inputs, because their answer carries the more useful `blocking`: telling the author that
  // `SEG` is missing sends them to a definition with nothing wrong with it, and telling them
  // `QB` is missing sends them to the question they have to move.
  if (RANK[bySites] > RANK[byInputs]) return { availability: bySites, blocking: id };
  return { availability: byInputs, blocking };
}

function dominanceAvailability(
  ctx: Ctx,
  sites: ReadonlySet<string>,
  read: string,
): Availability {
  if (writeSetDominates(ctx.graph, sites, read)) return 'all';
  let ancestors = ctx.ancestors.get(read);
  if (ancestors === undefined) {
    ancestors = ancestorsOf(ctx.graph, read);
    ctx.ancestors.set(read, ancestors);
  }
  for (const site of sites) {
    if (ancestors.has(site)) return 'some';
  }
  return 'none';
}

/* ========================================================================== */
/* 4. The analysis                                                             */
/* ========================================================================== */

export interface ForwardRefInput {
  readonly survey: Survey;
  readonly graph: FlowGraph;
  /** `buildRules`' output: `Rule.flow_node_id` is what positions the read. */
  readonly rules: readonly Rule[];
  readonly env: TypeEnv;
  readonly sites: VariableSites;
}

export function analyzeForwardReferences(input: ForwardRefInput): readonly CompileDiagnostic[] {
  // No start node means every read is a forward reference and none of it is news: `CMP-0001` is
  // the diagnostic that explains the flow, and `flow.ts` declines to storm for the same reason.
  if (input.graph.start === '') return [];

  const ctx = { ...context(input.survey, input.graph, input.env), sites: input.sites };
  const out: CompileDiagnostic[] = [];
  const paths = rulePointers(input.survey);

  for (const rule of input.rules) {
    const read = readSiteOf(rule, ctx);
    if (read === undefined) continue; // survey-scoped: no position, so no claim.
    if (!input.graph.reachable.has(read)) continue; // `LGC-U001` owns a dead site.

    const seen = new Set<VariableId>();
    for (const expr of exprsOf(rule)) {
      for (const id of readsOf(expr)) {
        if (seen.has(id)) continue;
        seen.add(id);
        const resolved = resolve(id, read, ctx, new Set());
        if (resolved.availability === 'all') continue;
        out.push(report(rule, id, resolved, read, ctx, paths));
      }
    }
  }

  return sortCompileDiagnostics(out);
}

function report(
  rule: Rule,
  id: VariableId,
  resolved: Resolution,
  read: string,
  ctx: Ctx,
  paths: ReadonlyMap<string, string>,
): CompileDiagnostic {
  const readVariable = ctx.env.byId(id);
  const blocking = ctx.env.byId(resolved.blocking);
  const owner = ctx.env.ownerQuestion(resolved.blocking);
  const writeQuestion = owner?.id ?? blocking?.question_id;
  const writeSites = ctx.sites.writes.get(schemaVariableId(resolved.blocking)) ?? [];
  const writeSite = writeSites[0];
  const writePage = writeQuestion === undefined ? undefined : ctx.pageOf.get(writeQuestion);
  const readPage = readPageOf(rule.target, read, ctx);

  const readName = readVariable?.name ?? id;
  const blockingName = blocking?.name ?? resolved.blocking;
  const via = resolved.blocking === id ? '' : ` (through ${readName})`;
  const base = paths.get(rule.id);
  // A rule with no authoring row — one synthesized from `QuestionNode.masks[]` — points at its
  // mask, which has no `/condition`; `detail.rule_id` is the identity either way.
  const path = base === undefined ? '' : `${base}/condition`;
  const at = (page: PageId | undefined, site: string | undefined): string => {
    const position = site === undefined ? undefined : ctx.graph.position.get(site);
    const index = page === undefined ? undefined : ctx.pageIndex.get(page);
    const pageText = index === undefined ? (page ?? 'no page') : `page ${String(index + 1)}`;
    return `${pageText}, flow position ${position === undefined ? 'none' : String(position)}`;
  };

  const detail = {
    rule_id: rule.id,
    rule_kind: rule.kind,
    rule_target_type: rule.target.type,
    rule_target_id: 'id' in rule.target ? rule.target.id : null,
    variable_id: id,
    variable_name: readName,
    blocking_variable_id: resolved.blocking,
    blocking_variable_name: blockingName,
    read_flow_node_id: read,
    read_flow_position: ctx.graph.position.get(read) ?? null,
    read_page_id: readPage ?? null,
    read_page_index: readPage === undefined ? null : (ctx.pageIndex.get(readPage) ?? null),
    write_question_id: writeQuestion ?? null,
    write_question_ref: owner?.ref ?? null,
    write_flow_node_id: writeSite ?? null,
    write_flow_position: writeSite === undefined ? null : (ctx.graph.position.get(writeSite) ?? null),
    write_page_id: writePage ?? null,
    write_page_index: writePage === undefined ? null : (ctx.pageIndex.get(writePage) ?? null),
    write_flow_node_ids: [...writeSites],
    availability: resolved.availability,
  };

  if (resolved.availability === 'none') {
    return fromLogicDiagnostic(
      diagnostic(
        'LGC-F001',
        `Rule ${rule.id} reads ${blockingName}${via} at ${at(readPage, read)}, and no path ` +
          `reaches that point with ${blockingName} set — it is collected at ` +
          `${at(writePage, writeSite)}. The read is UNKNOWN for every respondent, and UNKNOWN ` +
          'collapses to "do not fire" (D §2.5), so the rule can never do what it says. Move the ' +
          'question earlier in the flow, or the rule later.',
        path,
        detail,
      ),
    );
  }
  return fromLogicDiagnostic(
    diagnostic(
      'LGC-F002',
      `Rule ${rule.id} reads ${blockingName}${via} at ${at(readPage, read)}, which is set on ` +
        `some paths that reach it and not on others (it is collected at ` +
        `${at(writePage, writeSite)}). Respondents who took the other branch evaluate this rule ` +
        'against UNKNOWN, which collapses to "do not fire". Deliberate on a screener; a bug ' +
        'when the branch was meant to be exhaustive.',
      path,
      detail,
    ),
  );
}

/* ========================================================================== */
/* 5. Positioning a read                                                       */
/* ========================================================================== */

/**
 * The flow node a rule is evaluated at.
 *
 * `Rule.flow_node_id` is the answer whenever `rules.ts` resolved one, and it is preferred
 * unconditionally: it is the field `writesOf` keys a `flow` cell on and the field D §8.1 names,
 * so re-deriving it here could position the read somewhere the compiled rule is not. The target
 * fallback exists for a `Rule` built by hand — the studio's editor path, or a test — and mirrors
 * `rules.ts`' own resolution so the two cannot disagree.
 */
function readSiteOf(rule: Rule, ctx: Omit<Ctx, 'sites' | 'ancestors'>): string | undefined {
  if (rule.flow_node_id !== undefined) return rule.flow_node_id;
  const target = rule.target;
  switch (target.type) {
    case 'question':
      return siteOfQuestion(target.id, ctx);
    case 'page':
    case 'block':
      return flowNodeOfNode(ctx.graph, target.id);
    case 'option': {
      const question = ctx.questionOfOption.get(target.id);
      return question === undefined ? undefined : siteOfQuestion(question, ctx);
    }
    case 'variable': {
      const question = ctx.env.byId(target.id)?.question_id;
      return question === undefined ? undefined : siteOfQuestion(question, ctx);
    }
    case 'survey':
      return undefined;
    default: {
      const never: never = target;
      throw new Error(`Unhandled rule target: ${JSON.stringify(never)}`);
    }
  }
}

function siteOfQuestion(
  questionId: string,
  ctx: Omit<Ctx, 'sites' | 'ancestors'>,
): string | undefined {
  const direct = flowNodeOfNode(ctx.graph, questionId);
  if (direct !== undefined) return direct;
  const page = ctx.pageOf.get(questionId);
  return page === undefined ? undefined : flowNodeOfNode(ctx.graph, page);
}

/**
 * The page a diagnostic should quote for the read.
 *
 * The rule's target first, because that is the page the author is looking at. A flow node can
 * lay out several pages (a `sequence` over a block), so falling back to "the first page this
 * node lays out" is a weaker but still true statement, and it is the one the demo script quotes.
 */
function readPageOf(
  target: Target,
  read: string,
  ctx: Omit<Ctx, 'sites' | 'ancestors'>,
): PageId | undefined {
  switch (target.type) {
    case 'question':
      return ctx.pageOf.get(target.id) ?? firstPageOf(read, ctx);
    case 'page':
      return schemaPageId(target.id);
    case 'option': {
      const question = ctx.questionOfOption.get(target.id);
      return (question === undefined ? undefined : ctx.pageOf.get(question)) ?? firstPageOf(read, ctx);
    }
    case 'variable': {
      const question = ctx.env.byId(target.id)?.question_id;
      return (question === undefined ? undefined : ctx.pageOf.get(question)) ?? firstPageOf(read, ctx);
    }
    case 'block':
    case 'survey':
      return firstPageOf(read, ctx);
    default: {
      const never: never = target;
      throw new Error(`Unhandled rule target: ${JSON.stringify(never)}`);
    }
  }
}

function firstPageOf(flowNodeId: string, ctx: Omit<Ctx, 'sites' | 'ancestors'>): PageId | undefined {
  return ctx.pagesOfNode.get(flowNodeId)?.[0];
}

/* ========================================================================== */
/* 6. Shared indexes                                                           */
/* ========================================================================== */

function context(survey: Survey, graph: FlowGraph, env: TypeEnv): Omit<Ctx, 'sites'> {
  const pagesOfNode = new Map<string, PageId[]>();
  // `pageOrder` is flow order, so the first page a node lays out is the first a respondent sees.
  for (const page of graph.pageOrder) {
    const node = graph.pageEntry.get(page);
    if (node === undefined) continue;
    const existing = pagesOfNode.get(node);
    if (existing === undefined) pagesOfNode.set(node, [page]);
    else existing.push(page);
  }
  const pageIndex = new Map<string, number>();
  graph.pageOrder.forEach((page, i) => pageIndex.set(page, i));

  return {
    survey,
    graph,
    env,
    pageOf: pageOfQuestion(survey),
    questionOfOption: optionOwners(survey),
    pagesOfNode,
    pageIndex,
    ancestors: new Map(),
  };
}

/** Option / row / column id → the question that declares it. Iterative: content blocks nest. */
function optionOwners(survey: Survey): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  const stack: ContentNode[] = [];
  const pushAll = (nodes: readonly ContentNode[]): void => {
    for (let i = nodes.length - 1; i >= 0; i -= 1) {
      const node = nodes[i];
      if (node !== undefined) stack.push(node);
    }
  };
  pushAll(survey.content);
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) break;
    if (node.type === 'block' || node.type === 'page') {
      pushAll(node.children);
      continue;
    }
    if (node.type !== 'question') continue;
    const question: QuestionNode = node;
    for (const item of [
      ...(question.options ?? []),
      ...(question.rows ?? []),
      ...(question.columns ?? []),
    ]) {
      if (!out.has(item.id)) out.set(item.id, question.id);
    }
  }
  return out;
}

