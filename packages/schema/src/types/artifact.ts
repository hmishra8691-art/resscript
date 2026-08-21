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
import type { Expr, Iso8601, JsonObject } from './common.js';
import type { FlowNode } from './flow.js';
import type { QuotaConfig } from './quotas.js';
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
}

export interface CompiledRule {
  readonly id: string;
  readonly kind: string;
  readonly condition: Expr;
  readonly effect: JsonObject;
  readonly target_id?: string | null;
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
}

export interface CompiledArtifact {
  readonly manifest: ArtifactManifest;
  readonly graph: ArtifactGraph;
  readonly pages: { readonly [pageId: string]: CompiledPage };
  readonly logic: ArtifactLogic;
  readonly quotas?: QuotaConfig | null;
  readonly designs?: { readonly [designRef: string]: JsonObject };
  readonly i18n: { readonly [languageCode: string]: StringBundle };
  readonly theme_css?: string | null;
  readonly scripts?: { readonly [ref: string]: string };
}
