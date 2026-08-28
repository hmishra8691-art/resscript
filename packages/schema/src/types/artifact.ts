/**
 * The compiled artifact — Deliverable C §17.
 *
 * **Types only.** The compiler that produces these lives in `packages/compiler` (milestone
 * P1-08). They are declared here because the compiler contract is part of the schema
 * contract: the runtime reads these shapes, the exporter reads the variable manifest, and
 * both must be able to type against them without depending on the compiler.
 *
 * Two guarantees the shapes are designed around:
 *
 * 1. Rendering one page needs `manifest` + `graph` + `logic` + one `page`. The first three are
 *    fetched once per session and cached, so survey size affects the one-time cost and not the
 *    per-page cost. A 2,000-question survey costs the same per page as a 20-question one.
 * 2. The artifact is self-contained: given it and a session's variable state, the next page is
 *    computable with no database read except the session itself.
 */

import type { ContentNodeId, PageId, QuestionId, VariableId } from '../ids.js';
import type { Expr, Iso8601, JsonObject, RandomizationSpec } from './common.js';
import type { FlowNode } from './flow.js';
import type { QuotaConfig } from './quotas.js';
import type { Redirects, Vendor } from './vendors.js';
import type { ScriptHook, ScriptScope, ScriptTarget } from './assets.js';
import type { StringBundle } from './i18n.js';
import type { EnumDomainEntry, VariableKind, VariableType } from './variables.js';
import type { Mask } from './masks.js';
import type { ValidationRule } from './validation.js';
import type { QuestionCell, QuestionItem } from './content.js';

/** One column of the export contract, versioned with the artifact so it cannot shift. */
export interface VariableManifestEntry {
  readonly id: VariableId;
  readonly name: string;
  readonly kind: VariableKind;
  readonly type: VariableType;
  readonly export_column: string;
  readonly export_include: boolean;
  readonly enum_domain?: readonly EnumDomainEntry[] | null;
  readonly pii: boolean;
  readonly persist: boolean;
}

export interface ScriptBindingEntry {
  readonly ref: string;
  readonly scope: ScriptScope;
  readonly hooks: readonly ScriptHook[];
  readonly runs_on: ScriptTarget;
}

export interface ArtifactManifest {
  /** The artifact's own schema version, distinct from the authoring `schema_version`. */
  readonly artifact_schema_version: number;
  readonly survey_id: string;
  readonly survey_version_id: string;
  readonly artifact_hash: string;
  readonly compiled_at: Iso8601;
  readonly base_language: string;
  readonly languages: readonly string[];
  /** `ref → sha256`, so a tampered script fails its integrity check rather than executing. */
  readonly script_hashes: { readonly [ref: string]: string };
  /**
   * Which script runs where — the runtime's dispatch table for E §13 and F's client hooks.
   *
   * **Added in artifact schema version 1, append-only.** `script_hashes` says what the bytes
   * must be; it says nothing about WHEN to run them, and a runtime that had to guess would
   * either run nothing (dead feature) or run everything on every hook (a customer script
   * firing on hooks its author never declared). Absent on artifacts compiled before it existed
   * and on surveys with no scripts — both mean "run nothing", which is the safe reading.
   */
  readonly script_bindings?: readonly ScriptBindingEntry[];
  readonly csp_directives: { readonly [directive: string]: readonly string[] };
  readonly variable_manifest: readonly VariableManifestEntry[];
  readonly entitlements: readonly string[];
  /**
   * `"<plugin id>@<major>" → the exact version that compiled this artifact`.
   *
   * **Added in artifact schema version 1 by milestone P1-08, append-only.** F §5 pins a published
   * survey to the plugin version it compiled against, and until this field existed the only
   * record of that was `CompiledQuestion.question_type` — which carries the *major* and not the
   * version, is per question rather than per plugin, and is absent for a matrix's per-cell
   * controls (`QuestionCell.control.question_type` is resolved too, and its resolution is
   * nowhere in a compiled page). A runtime that has to answer "which build of `matrix` rendered
   * this survey in March" needs the exact version, so the manifest carries it once per key rather
   * than the survey carrying it never.
   *
   * Keyed by the `id@major` form because that is the identity the registry resolves and the
   * identity a compiled question names; the value is opaque to everything but provenance.
   */
  readonly plugin_versions: { readonly [pluginKey: string]: string };
}

/** A flattened page graph with static edges, so the runtime never scans the whole survey. */
export interface ArtifactGraph {
  readonly page_order: readonly PageId[];
  readonly nodes: readonly FlowNode[];
  /** `page_id → flow node id` entry points, precomputed. */
  readonly page_entry: { readonly [pageId: string]: string };
  /**
   * The canonical item list behind every `RandomizationSpec.group_ref` on the survey — E §8.3's
   * shared order across a battery.
   *
   * **Added in artifact schema version 2, append-only.** Omitted before that, and its absence was
   * not a missing optimization but a silent correctness failure: `packages/runtime-core`'s
   * `randomize` implements the shared-order algorithm correctly and takes the group as an argument,
   * but nothing in the artifact carried one, so every caller in the real request path passed
   * `undefined` and the function fell through to its documented `randomize.group_missing` branch —
   * an INDEPENDENT shuffle per question. A ten-brand list declared as one group across a
   * six-question battery therefore appeared in six different orders, which is precisely the defect
   * `group_ref` exists to prevent, and it was invisible because each question's order was
   * individually valid.
   *
   * **Why this lives in `graph.json` and not on each question.** The group is a survey-wide fact
   * shared by definition — putting the canonical list on a question would store it once per member
   * and make "do these six questions agree" a comparison rather than a lookup. `graph.json` is
   * fetched once and cached for the whole session (C §17), so the cost is paid once no matter how
   * many pages the battery spans.
   *
   * **Why it is language-independent, in a per-language artifact.** Ordering reads only `code`, and
   * `randomize`'s group path matches the group's entries against the question's own items by code —
   * it never renders a group entry. Labels would be dead weight that forked one file per language
   * for a list of integers.
   */
  readonly order_groups?: { readonly [groupRef: string]: OrderGroupEntry };
  /**
   * Derived per-iteration page id → the authored page id it came from (P2-02).
   *
   * **Artifact schema version 2, append-only, and absent for a survey with no loops.** It lives on
   * the graph rather than only on each `CompiledPage` because the consumer is the FLOW machine,
   * which walks `page_order` and asks "is this page visible" before any page file is fetched. Page
   * visibility is keyed on the authored id, since N unrolled iterations share one authored page's
   * rules — see `compiler/src/loops.ts` for why that is exact rather than approximate.
   */
  readonly page_authored?: { readonly [derivedPageId: string]: string };
  /**
   * Page id → the `randomizer` TARGET it belongs to (P2-03), absent when no randomizer lays out
   * pages.
   *
   * **Artifact schema version 2, append-only.** The machine needs it and cannot derive it:
   * `page_entry` says which flow node owns a page, and a randomizer owns every page of every
   * target. Permuting the flat page list would shuffle pages ACROSS blocks, which is not what a
   * block-level randomizer means — `shuffle` reorders the TARGETS and keeps each target's pages in
   * their authored order.
   */
  readonly page_group?: { readonly [pageId: string]: string };
}

/**
 * One `group_ref`'s canonical membership: the union of the items of every axis that declares the
 * group, in ascending `code` order.
 *
 * **The union, not the first member's list.** Two questions can share a brand list and be masked
 * differently, or one can carry a brand the other has retired. Seeding the shared permutation from
 * one member's list would make the order depend on which question the compiler happened to visit
 * first — a compile-order dependency in a value the artifact hash covers. The union is a function
 * of the survey alone.
 *
 * **Ascending `code`, not declared position.** `position` is per-axis and densified independently
 * on each member (`emit/pages.ts`), so two members with the same brands in different authored
 * orders would produce different canonical lists and therefore different shared permutations.
 * `code` is the one identifier the schema guarantees is stable and comparable across questions
 * (`QuestionItem.code`: "stable and independent of `position`").
 */
export interface OrderGroupEntry {
  readonly ref: string;
  /** Ascending, deduplicated item codes — the permutation domain. */
  readonly codes: readonly number[];
  /**
   * The axes that declare this group, as `questionId.axis`, in flow order. Diagnostic payload for
   * the runtime's `randomize.group_missing`/mismatch events and for the studio's future
   * randomization editor; never read by the ordering itself.
   */
  readonly members: readonly string[];
}

export interface CompiledQuestion {
  readonly id: QuestionId;
  readonly ref: string;
  readonly question_type: string;
  readonly required: boolean;
  /** Labels are already resolved to the respondent's language — no key lookup at render. */
  readonly label?: string | null;
  readonly instruction?: string | null;
  readonly config: JsonObject;
  readonly options?: readonly CompiledItem[];
  readonly rows?: readonly CompiledItem[];
  readonly columns?: readonly CompiledItem[];
  readonly cells?: readonly QuestionCell[];
  readonly validation: readonly ValidationRule[];
  readonly masks: readonly Mask[];
  readonly emits: readonly VariableId[];
  /**
   * Per-axis randomization, passed through from the authored `QuestionNode` (C §12).
   *
   * **Added in artifact schema version 1, append-only.** Omitted before that, which meant the
   * runtime could not randomize anything: E §8 and ADR-006 describe seeded option order at length,
   * `packages/runtime-core` implements every mode the schema declares, and the compiled artifact
   * had no field in which to ask for it. Randomization is seed-derived rather than rule-derived, so
   * unlike a mask it has no representation in the logic cell graph to fall back on — dropping it
   * here dropped it entirely.
   *
   * Passed through unresolved, exactly like `masks` and `validation`: the runtime needs the spec
   * (mode, `group_ref`, anchors, sub-blocks) to derive an order from `(seed, salt)`, and resolving
   * it at compile time would fix one order for every respondent.
   */
  readonly randomize_options?: RandomizationSpec;
  readonly randomize_rows?: RandomizationSpec;
  readonly randomize_columns?: RandomizationSpec;
}

/** A compiled item: the authoring item with its label resolved and position densified. */
export type CompiledItem = Omit<QuestionItem, 'label'> & { readonly label?: string | null };

export interface CompiledPage {
  readonly id: PageId;
  readonly ref: string;
  readonly block_path: readonly ContentNodeId[];
  readonly questions: readonly CompiledQuestion[];
  /** Rules whose trigger and target are both on this page, inlined to avoid a fetch. */
  readonly inline_rules: readonly CompiledRule[];
  readonly settings: JsonObject;
  /**
   * The AUTHORED page id, present only on an unrolled loop iteration.
   *
   * **Added in artifact schema version 2 (P2-02), append-only and absent for a page outside a
   * loop** — so a survey with no loops compiles to byte-identical pages, which matters because
   * these bytes are inside the artifact hash.
   *
   * `id` is the derived per-iteration id: it addresses the page file, keys `graph.page_entry`, and
   * is what the machine advances through. `authored_id` is what the LOGIC PROGRAM's cells are
   * keyed on, because N unrolled iterations share one authored page's rules — which is correct and
   * not an approximation: `packages/logic`'s `Expr` union has no node that reads the current
   * iteration, so a rule's verdict is provably iteration-invariant. `compiler/src/loops.ts`'
   * header sets out the full argument and its one failure mode.
   */
  readonly authored_id?: PageId;
  /** 1-based iteration index, present only on an unrolled loop iteration. */
  readonly iteration?: number;
}

/**
 * One rule, in the form the runtime evaluates.
 *
 * **`target_type`, `evaluation`, `authored_in`, `order_key` and the four optional fields below were
 * added in artifact schema version 1.** Without them this shape carried `id`, `kind`, `condition`,
 * `effect` and `target_id` — which is not enough to evaluate anything, so C §17's claim that "the
 * artifact is self-contained: given it and a session's variable state, the next page is computable
 * with no database read except the session itself" was false. `packages/logic`'s `Rule` needs
 * `target` (with its arm, which `writesOf` switches on), `evaluation`, `authored_in` and
 * `order_key`, and none of the four survived serialization.
 *
 * The optional four are each load-bearing for a behaviour the runtime would otherwise silently
 * lose: `on_unknown` is D §2.5's author override of the UNKNOWN collapse, `priority_group` is
 * D §4.6's single `LGC-CONFLICT` exemption (without it two rules the author deliberately let race
 * become a conflict), `flow_node_id` is what D §8.1's dominance analysis keys on, and `label` is the
 * trace's `rule_label` (E §14.2).
 */
export interface CompiledRule {
  readonly id: string;
  readonly kind: string;
  readonly condition: Expr;
  readonly effect: JsonObject;
  /**
   * The arm of `Target`. Kept separate from `target_id` rather than nested so the addition is
   * append-only and a survey-scoped rule — which has no id — still needs only one field.
   */
  readonly target_type: 'question' | 'page' | 'block' | 'option' | 'variable' | 'survey';
  /** Absent for a survey-scoped rule, which carries no id. */
  readonly target_id?: string | null;
  readonly evaluation: string;
  readonly authored_in: 'visual' | 'dsl';
  /** Compiler-assigned deterministic tie-break for independent rules (D §4.4). */
  readonly order_key: number;
  readonly on_unknown?: 'default' | 'fire';
  readonly priority_group?: string;
  readonly flow_node_id?: string;
  readonly label?: string;
}

/**
 * One cell of the dependency graph, in its serialized form.
 *
 * A cell is any piece of derived state a rule can write and another can read: a variable's
 * value, a node's visibility, a question's item set on one axis, one property of one option, a
 * validation verdict, a termination, a flow decision. `key` is the canonical string form
 * (`value(var_x)`, `visible(qst_x)`, `items(qst_x.options)`, …) and `cell` is the tagged union
 * itself, so the runtime can rehydrate without parsing the key.
 */
export interface ArtifactLogicCell {
  readonly key: string;
  readonly kind: string;
  readonly cell: JsonObject;
}

/**
 * `base_option`'s defaults — schema §5.1's literals: an option is visible and enabled, nothing else.
 *
 * Part of the **wire contract**, not of either side's implementation, which is why it lives here
 * rather than in the compiler that writes the sparse encoding or the runtime that reads it. An
 * `optionKey` absent from `base_option` means *this*; a reader that guessed `false` would render
 * every option hidden.
 */
export const BASE_OPTION_DEFAULT = {
  visible: true,
  enabled: true,
  preselected: false,
  auto_select: false,
  required: false,
} as const;

/** `base_visible`'s default. Absent ⇒ the node is visible. Same wire-contract argument. */
export const BASE_VISIBLE_DEFAULT = true;

/**
 * The type-environment views the evaluator needs, materialized at publish.
 *
 * **Added in artifact schema version 1.** `packages/logic`'s `EvalSchema` is a set of closures over
 * the authoring type environment, and ADR-001 forbids the runtime from reading authoring tables —
 * so without this section the runtime could not build one and `evaluate()` could not be called.
 *
 * Every map here is *cross-page*: a rule on page 5 can ask `SHOWN(Q2r3)` or `ASKED(Q2)`, so the
 * answer cannot come from the page being rendered. Deriving them from compiled pages would mean
 * reading all of them, which is precisely the per-page cost C §17 forbids — the same reason
 * `graph.page_entry` is precomputed rather than resolved from each page's `block_path`.
 *
 * The maps are small: id-to-id, one entry per question, page and variable. They ship in
 * `logic.json`, which is already fetched once per session with the manifest and the graph.
 */
export interface ArtifactLogicSchema {
  /**
   * Question id → the variables it emits.
   *
   * `EvalSchema.ownerQuestion` is the inverse and is derived on read rather than emitted, so the two
   * cannot disagree — a variable listed under two questions would be a contradiction the artifact
   * could otherwise carry.
   */
  readonly question_variables: { readonly [questionId: string]: readonly string[] };
  /** Page id → its questions, in document order, for a page-scoped probe. */
  readonly page_questions: { readonly [pageId: string]: readonly string[] };
  /**
   * Question or block id → the page it sits on, so `ASKED(Q5)` can ask whether that page was
   * submitted. A block spanning more than one page is absent rather than pointing at an arbitrary
   * one of them.
   */
  readonly page_of: { readonly [nodeId: string]: string };
  /**
   * `<domain id>` → `<code>` → label key, for `label_of` to reach `ctx.labels`.
   *
   * Nested rather than keyed by a joined string: a separator has to be a character that cannot
   * appear in a domain id, and nesting needs no such argument.
   */
  readonly label_keys: { readonly [domainId: string]: { readonly [code: string]: string } };
}

/**
 * The compiled logic program: the cell graph, its evaluation order, and the flattened AST.
 *
 * WHY THE CELL GRAPH IS IN THE ARTIFACT rather than rebuilt at runtime. Building it needs the
 * type environment, which needs the authoring variable registry — and ADR-001 says the runtime
 * may not read authoring tables. Recomputing it per session would also make the topological
 * order a function of runtime code rather than of the published bytes, which is exactly the
 * property ADR-002's content addressing exists to pin: two respondents on one artifact must
 * evaluate rules in the same order, in the same order they did six months ago.
 *
 * EVERY INDEX IN THIS STRUCTURE IS POSITIONAL and fixed by `rules` being in canonical
 * (`order_key`, then `id`) order and `cells` being sorted by (phase rank, key). Neither is
 * discovery order. That is what turns "identical verdicts under 1,000 randomized rule
 * orderings" from an assertion about behaviour into an assertion about bytes.
 */
export interface ArtifactLogic {
  /** Cell registry. A cell's index is its position here. */
  readonly cells: readonly ArtifactLogicCell[];
  /** Cell indices in evaluation order. Empty iff the graph was cyclic — which blocks publish. */
  readonly topo: readonly number[];
  /** Cell index → its position in `topo`; `-1` for a cell absent from it. */
  readonly topo_pos: readonly number[];
  /** Forward edges, for propagation: cell index → the cells it can dirty. */
  readonly dependents: readonly (readonly number[])[];
  /** Reverse edges, for explaining a cycle and for the trace: cell index → its inputs. */
  readonly inputs: readonly (readonly number[])[];
  /** Cell index → indices into `rules`, in application order. */
  readonly writers: readonly (readonly number[])[];
  /**
   * Variable id → the transitively downstream cells, topo-ordered. This is the "what could
   * this answer affect" index: a page submit dirties a handful of variables, and only their
   * downstream cells are considered, which is what keeps evaluation cost proportional to the
   * change rather than to the survey.
   */
  readonly by_trigger_variable: { readonly [variableId: string]: readonly number[] };
  /** Node/variable id → the `valid(rule)` cell indices scoped to it. */
  readonly valid_by_target: { readonly [targetId: string]: readonly number[] };
  /** The rules, in the canonical order that fixes every index above. */
  readonly rules: readonly CompiledRule[];
  /**
   * The flattened, common-subexpression-eliminated AST. `nodes[i].n === i` and the array is
   * dense, so a node id is an index and memoization is an array lookup rather than a map hit.
   */
  readonly nodes: readonly Expr[];
  /** Authored defaults, resolved once so the runtime never needs the authoring model. */
  readonly base_visible: { readonly [nodeId: string]: boolean };
  /** Key is `${questionId}.${axis}`; value is the unmasked item codes in canonical order. */
  readonly base_items: { readonly [questionAxis: string]: readonly number[] };
  /** Key is `${optionId}.${prop}`. */
  readonly base_option: { readonly [optionProp: string]: boolean };
  /** Cell index (as a decimal string) → index into `nodes` of its defining expression. */
  readonly derived: { readonly [cellIndex: string]: number };
  /**
   * The type-environment views `EvalSchema` is built from.
   *
   * **Added in artifact schema version 1.** Optional so an artifact compiled before it existed still
   * parses; a reader that finds it absent has an artifact whose rules cannot be evaluated, which is
   * a republish rather than a fallback.
   */
  readonly schema?: ArtifactLogicSchema;
}

export interface CompiledArtifact {
  readonly manifest: ArtifactManifest;
  readonly graph: ArtifactGraph;
  readonly pages: { readonly [pageId: string]: CompiledPage };
  readonly logic: ArtifactLogic;
  readonly quotas?: QuotaConfig | null;
  /**
   * Disposition → URL template maps (E §11). In the artifact for the same reason as `quotas`:
   * the runtime resolves the exit redirect at finalization and ADR-001 bars it from
   * `content.redirects`. Absent when the survey declares none.
   */
  readonly redirects?: Redirects | null;
  /**
   * Vendor configuration (C §9). In the artifact because the runtime binds inbound parameters to
   * hidden variables and verifies an entry signature BEFORE a session exists — so there is nothing
   * to read the control plane with, and ADR-001 would bar it anyway.
   *
   * Carries `security.secret_ref`, never a secret: the artifact is served from a CDN, and
   * `emit/bundle.ts`'s `assertNoSecrets` enforces that mechanically (security §10).
   */
  readonly vendors?: readonly Vendor[] | null;
  readonly designs?: { readonly [designRef: string]: JsonObject };
  readonly i18n: { readonly [languageCode: string]: StringBundle };
  readonly theme_css?: string | null;
  /**
   * Author-supplied stylesheets, concatenated in ref order. Absent when the survey has none.
   *
   * Separate from `theme_css` on purpose: the two have different provenance and different trust,
   * the served `<link>` order states the cascade explicitly, and the theme's own rules — the
   * `.rs-target` touch-target contract in particular — stay identifiable as ours.
   */
  readonly author_css?: string | null;
  readonly scripts?: { readonly [ref: string]: string };
}
