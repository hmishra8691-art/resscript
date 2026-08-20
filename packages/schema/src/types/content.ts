/**
 * The content tree — Deliverable C §5.
 *
 * `content` is a tree and gives document order (the default path); `flow` is a graph over it
 * (§6). Keeping them separate is deliberate: a survey that is 95% linear should read as a
 * linear list of questions, with the graph made visible only where it actually branches.
 */

import type {
  AssetId,
  BlockId,
  OptionId,
  PageId,
  QuestionId,
  TextNodeId,
  VariableId,
} from '../ids.js';
import type { AnchorSpec, ConditionalValue, Expr, I18nRef, JsonObject, RandomizationSpec } from './common.js';
import type { Mask } from './masks.js';
import type { ValidationRule } from './validation.js';

/* -------------------------------------------------------------------------- */
/* Options, rows, columns — one shape (C §5.1)                                */
/* -------------------------------------------------------------------------- */

export interface OptionBehaviour {
  readonly visible?: ConditionalValue<boolean>;
  readonly enabled?: ConditionalValue<boolean>;
  readonly preselected?: ConditionalValue<boolean>;
  /** Dynamic: select this item when the condition holds (e.g. "None" after a mask empties). */
  readonly auto_select?: ConditionalValue<boolean> | null;
  readonly required_if?: Expr | null;
}

export interface OptionMedia {
  readonly image_asset_id?: AssetId | null;
  readonly alt_key?: string | null;
}

/**
 * An option, row or column. Section 7 of the brief asks for every option to be programmable,
 * so an option is a full object rather than a string and every behavioural field accepts
 * either a literal or a condition.
 */
export interface QuestionItem {
  readonly id: OptionId;
  /** The human handle within the question (`o1`, `r2`, `c3`). Unique per question per kind. */
  readonly ref: string;
  /**
   * The exported value. **Stable and independent of `position`.**
   *
   * Confusing `code` with `position` is a classic data disaster: randomizing display order
   * would silently rewrite exported values, and the client's analyst discovers it, not us.
   * Deliverable B enforces the separation physically — `code` and `sort_key` are different
   * columns with different unique constraints, so the mistake is not even expressible there.
   */
  readonly code: number;
  readonly label?: I18nRef | null;
  readonly media?: OptionMedia | null;
  /**
   * The compiled, dense display position. In the authoring database order is a fractional
   * `sort_key` so that reordering one option is a single-row write; the compiler materializes
   * it into this dense integer. This wire format is the compiled shape.
   */
  readonly position: number;
  readonly anchor?: AnchorSpec;
  /** Selecting this clears all others — "None of these", "Don't know". */
  readonly exclusive?: boolean;
  readonly behaviour?: OptionBehaviour;
  /** A custom exported value distinct from `code`, for legacy tracker compatibility. */
  readonly value_override?: string | null;
  /** Hook for conditional formatting through theme CSS. */
  readonly custom_class?: string | null;
  /**
   * A deliberate escape hatch. Real research needs to attach a price point, a brand id or a
   * segment to an option and carry it into analysis. Without this, programmers encode it in
   * the label ("Brand C |6.99|") and regret it at the analysis stage — and the AST can read
   * these keys directly (`item_attr` with a `meta_key`), so masks and logic can use them.
   */
  readonly meta?: JsonObject;
  /** Marks the item whose selection opens an open-ended "please specify" field. */
  readonly other_specify?: boolean;
}

/* -------------------------------------------------------------------------- */
/* Mixed matrices (C §5.2)                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A per-row (optionally per-cell) control override. Deliberately a *thin* reference to a
 * question type plus config, so a matrix whose row A is numeric, row B is text and row C is
 * single select needs no new engine: each cell emits its own variable with its own type,
 * which is the §1 variable model doing its job.
 */
export interface QuestionCell {
  readonly row_ref: string;
  /** Set only for a true per-cell override in a full row x column grid. */
  readonly column_ref?: string | null;
  readonly control: QuestionCellControl;
}

export interface QuestionCellControl {
  readonly question_type: string;
  readonly config?: JsonObject;
  /** When true the cell renders the matrix's shared column list as its choices. */
  readonly use_columns?: boolean;
}

/* -------------------------------------------------------------------------- */
/* Loops (C §13)                                                              */
/* -------------------------------------------------------------------------- */

export type LoopSource =
  /** The classic: "ask about each brand selected in Q3". */
  | { readonly kind: 'selected_options'; readonly variable_id: VariableId }
  | { readonly kind: 'explicit_list'; readonly items: readonly LoopItem[] }
  | { readonly kind: 'numeric_range'; readonly from: number; readonly to: number };

export interface LoopItem {
  readonly ref: string;
  readonly code: number;
  readonly label_key?: string | null;
  readonly meta?: JsonObject;
}

export interface LoopSpec {
  readonly source: LoopSource;
  /**
   * Hard cap. The compiler unrolls loop iterations into concrete variables (`Q7_1`…`Q7_5`),
   * which is what keeps aggregation over a loop statically bounded — and therefore what makes
   * the logic engine's evaluation budget a provable property rather than an aspiration.
   */
  readonly max_iterations: number;
  readonly order?: RandomizationSpec | null;
  /** Pipeable inside the loop as `{{BRAND.label}}`. */
  readonly iteration_variable_ref: string;
  /**
   * The export contract for loops, stated explicitly in the schema because loop column
   * naming is the thing analysts complain about most and it must be predictable and stable.
   * `{ref}` expands to the derived base name, `{iteration}` to the 1-based index.
   */
  readonly variable_naming: string;
}

/** The default and only naming template Phase 1 supports; see `deriveVariableName`. */
export const DEFAULT_LOOP_NAMING = '{ref}_{iteration}';

/* -------------------------------------------------------------------------- */
/* Nodes                                                                      */
/* -------------------------------------------------------------------------- */

export const PAGE_LAYOUTS = ['stacked', 'single_question', 'custom'] as const;
export type PageLayout = (typeof PAGE_LAYOUTS)[number];

export const MIN_TIME_ACTIONS = ['flag', 'block'] as const;
/** `flag` scores quality and lets the respondent through; `block` prevents submission. */
export type MinTimeAction = (typeof MIN_TIME_ACTIONS)[number];

export interface BlockSettings {
  readonly randomize_children?: RandomizationSpec;
  /** Nesting plus a loop on the block is what makes looping composable (C §13). */
  readonly loop?: LoopSpec | null;
  readonly on_enter_scripts?: readonly AssetId[];
  readonly on_exit_scripts?: readonly AssetId[];
}

export interface PageSettings {
  readonly layout?: PageLayout;
  /** Override the page shell HTML. */
  readonly html_template_ref?: AssetId | null;
  readonly css_ref?: AssetId | null;
  readonly back_allowed?: boolean;
  readonly auto_advance?: boolean;
  /**
   * Speeder-detection input. It lives on the page rather than in a separate quality module
   * because straight-liner and speeder detection need per-page timing, and per-page timing
   * only exists if the runtime captures it from the first release.
   */
  readonly min_time_s?: number | null;
  readonly min_time_action?: MinTimeAction;
  readonly randomize_children?: RandomizationSpec;
}

export interface QuestionScripts {
  readonly on_load?: readonly AssetId[];
  readonly on_answer?: readonly AssetId[];
  readonly on_validate?: readonly AssetId[];
}

export interface QuestionFlags {
  /**
   * Computed at save time, not authored. It drives the ADR-003 badge in the studio: a
   * programmer must be able to see at a glance that the visual view is not the whole truth.
   */
  readonly has_custom_js?: boolean;
  readonly pii?: boolean;
  readonly exclude_from_export?: boolean;
}

export interface BlockNode {
  readonly id: BlockId;
  readonly type: 'block';
  readonly ref: string;
  readonly title?: I18nRef | null;
  readonly settings?: BlockSettings;
  /** Blocks nest: this is how a 2,000-question tracker stays navigable. */
  readonly children: readonly ContentNode[];
}

export interface PageNode {
  readonly id: PageId;
  readonly type: 'page';
  readonly ref: string;
  readonly title?: I18nRef | null;
  readonly settings?: PageSettings;
  readonly children: readonly PageChild[];
}

export interface QuestionNode {
  readonly id: QuestionId;
  readonly type: 'question';
  readonly ref: string;
  /** Plugin identifier (Deliverable F). Not an enum: the plugin registry is open. */
  readonly question_type: string;
  readonly label?: I18nRef | null;
  readonly instruction?: I18nRef | null;
  readonly required: boolean;
  /** Plugin-specific, validated against the plugin's own JSON Schema at the API boundary. */
  readonly config?: JsonObject;
  readonly options?: readonly QuestionItem[];
  readonly rows?: readonly QuestionItem[];
  readonly columns?: readonly QuestionItem[];
  readonly cells?: readonly QuestionCell[];
  readonly validation?: readonly ValidationRule[];
  readonly masks?: readonly Mask[];
  /**
   * Variable ids this question produces. Computed by `buildVariableRegistry`, stored so that
   * a diff of two versions shows "Q12 stopped emitting Q12r4" without re-deriving anything.
   */
  readonly emits?: readonly VariableId[];
  readonly scripts?: QuestionScripts;
  readonly flags?: QuestionFlags;
  readonly randomize_options?: RandomizationSpec;
  readonly randomize_rows?: RandomizationSpec;
  readonly randomize_columns?: RandomizationSpec;
}

/**
 * Instruction / display copy. Deliverable B models this as `content.node_kind = 'text'` with
 * a `label_key` and no `ref`, so it is a first-class node here rather than a question with a
 * special question_type — a text node emits no variables and has no answer to validate.
 */
export interface TextNode {
  readonly id: TextNodeId;
  readonly type: 'text';
  readonly label: I18nRef;
  readonly html_template_ref?: AssetId | null;
}

export type PageChild = QuestionNode | TextNode;
export type ContentNode = BlockNode | PageNode | PageChild;

/** The kinds a content node can be. Exhaustive `switch` over this is the house style. */
export type ContentNodeType = ContentNode['type'];
