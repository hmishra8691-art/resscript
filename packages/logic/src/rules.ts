/**
 * Rules, effects, cells and the effect lattices — D §4.
 *
 * The point of this file is D §4.6's table: two rules writing one cell is common and mostly
 * benign, *but only because some cells form a lattice*. Where a lattice exists the write
 * order cannot matter, so the engine is free to evaluate in any order the dependency graph
 * permits. Where one does not — `set_variable` — two writers is a compile error
 * (`LGC-CONFLICT`), because the alternative is a verdict that depends on insertion order.
 *
 * Hide-wins for visibility is the right default for a reason beyond lattice algebra: in survey
 * programming a hide rule is nearly always a correction or a client-requested suppression
 * layered on top of base logic, and making the correction win is what the author means.
 */

import type { Expr } from './ast.js';
import type { Tri } from './kleene.js';
import type {
  BlockId,
  FlowNodeId,
  OptionId,
  PageId,
  QuestionId,
  RuleId,
  VariableId,
} from './ids.js';
import { LogicInvariant } from './ids.js';

export const RULE_KINDS = [
  'display',
  'skip',
  'mask',
  'set_variable',
  'validate',
  'option_state',
  'terminate',
] as const;
export type RuleKind = (typeof RULE_KINDS)[number];

export const RULE_EVALUATIONS = ['on_change', 'on_page_enter', 'on_submit'] as const;
export type RuleEvaluation = (typeof RULE_EVALUATIONS)[number];

/** schema `DISPOSITIONS` (registry K §2), restated — logic only ever compares them. */
export const DISPOSITIONS = [
  'COMPLETE',
  'SCREENOUT',
  'QUOTA_FULL',
  'QUALITY',
  'DUPLICATE',
  'FRAUD',
  'TERMINATE',
  'CUSTOM',
  'IN_PROGRESS',
  'ABANDONED',
  'TIMED_OUT',
] as const;
export type Disposition = (typeof DISPOSITIONS)[number];

export type OptProp = 'visible' | 'enabled' | 'preselected' | 'auto_select' | 'required';

export type Target =
  | { readonly type: 'question'; readonly id: QuestionId }
  | { readonly type: 'page'; readonly id: PageId }
  | { readonly type: 'block'; readonly id: BlockId }
  | { readonly type: 'option'; readonly id: OptionId }
  | { readonly type: 'variable'; readonly id: VariableId }
  | { readonly type: 'survey' };

export type MaskAxis = 'options' | 'rows' | 'columns';

export type Effect =
  | { readonly action: 'show' | 'hide' }
  | { readonly action: 'skip_to'; readonly node_id: PageId | BlockId }
  | { readonly action: 'skip_this' }
  | {
      readonly action: 'mask';
      readonly applies_to: MaskAxis;
      readonly mode: 'include' | 'exclude';
      readonly per_item: Expr;
      /**
       * No default (schema §15). The engine refuses to run a mask whose fallback is unset —
       * `LGC-T032`. The empty-question dead end is worth a required field.
       */
      readonly fallback: { readonly when_empty: 'skip_question' | 'show_all' | 'terminate' };
    }
  | { readonly action: 'set'; readonly variable_id: VariableId; readonly value: Expr }
  | {
      readonly action: 'require_valid';
      readonly message_key: string;
      readonly scope: 'field' | 'page';
    }
  | {
      readonly action: 'option_state';
      readonly option_id: OptionId;
      readonly prop: OptProp;
      readonly value: Expr;
    }
  | {
      readonly action: 'terminate';
      readonly disposition: Disposition;
      readonly custom_key?: string;
    };

export interface Rule {
  readonly id: RuleId;
  readonly kind: RuleKind;
  readonly target: Target;
  /** Typed bool. */
  readonly condition: Expr;
  readonly effect: Effect;
  readonly evaluation: RuleEvaluation;
  /** D §2.5's author override of the collapse. */
  readonly on_unknown?: 'default' | 'fire';
  readonly authored_in: 'visual' | 'dsl';
  /** Compiler-assigned. Deterministic tie-break for independent rules (D §4.4). */
  readonly order_key: number;
  /**
   * D §4.6's single `LGC-CONFLICT` exemption: rules in an explicit `PRIORITY GROUP` block,
   * where last-writer-wins is the author's stated intent. Absent for ordinary rules.
   */
  readonly priority_group?: string;
  /** The flow node this rule is evaluated at. Used by the D §8.1 dominance analysis. */
  readonly flow_node_id?: FlowNodeId;
  /** Human label, for the trace (E §14.2 `rule_label`). */
  readonly label?: string;
}

/* ========================================================================== */
/* Cells (D §4.4)                                                             */
/* ========================================================================== */

/** A cell is any piece of derived state a rule can write and another can read. */
export type Cell =
  | { readonly c: 'value'; readonly variable_id: VariableId }
  | { readonly c: 'visible'; readonly node_id: QuestionId | PageId | BlockId }
  | { readonly c: 'items'; readonly question_id: QuestionId; readonly axis: MaskAxis }
  | { readonly c: 'opt'; readonly option_id: OptionId; readonly prop: OptProp }
  | { readonly c: 'valid'; readonly rule_id: RuleId }
  | { readonly c: 'terminate'; readonly rule_id: RuleId }
  | { readonly c: 'flow'; readonly node_id: FlowNodeId };

export type CellKind = Cell['c'];

/**
 * The deterministic tie-break layering from D §4.4.
 *
 * Phases are **not** a separate evaluation pass — they are only a tie-break between cells the
 * graph leaves unordered. A `value` cell that genuinely depends on a `visible` cell (the R3
 * rule in D §4.3) is ordered after it by the graph, overriding its phase rank. Implementations
 * that make phases primary cannot express R3 at all, and end up with a `shown` probe that
 * reads last page's answer.
 */
export const PHASE_RANK: { readonly [K in CellKind]: number } = {
  value: 0,
  items: 1,
  opt: 2,
  visible: 3,
  valid: 4,
  terminate: 5,
  flow: 6,
};

/** A stable string key for a cell, used for interning and for the trace (E §14.2). */
export function cellKey(cell: Cell): string {
  switch (cell.c) {
    case 'value':
      return `value(${cell.variable_id})`;
    case 'visible':
      return `visible(${cell.node_id})`;
    case 'items':
      return `items(${cell.question_id}.${cell.axis})`;
    case 'opt':
      return `opt(${cell.option_id}.${cell.prop})`;
    case 'valid':
      return `valid(${cell.rule_id})`;
    case 'terminate':
      return `terminate(${cell.rule_id})`;
    case 'flow':
      return `flow(${cell.node_id})`;
    default: {
      const never: never = cell;
      throw new LogicInvariant(`unhandled cell kind ${JSON.stringify(never)}`);
    }
  }
}

/* ========================================================================== */
/* The single coercion point (D §2.5)                                         */
/* ========================================================================== */

export interface Collapse {
  readonly fired: boolean;
  /** Set when the condition was `U` and therefore collapsed; drives the trace annotation. */
  readonly collapsed?: { readonly from: 'U'; readonly to: boolean; readonly reason: string };
}

/**
 * **The single coercion point.**
 *
 * An effect must fire or not fire; there is no three-valued show. So exactly once, at the boundary
 * between a rule's condition and its effect, `U` collapses — per rule kind, chosen so that
 * unknown is always the *safe* direction (D §2.5's table):
 *
 * | kind          | U → | consequence                                                     |
 * |---------------|-----|-----------------------------------------------------------------|
 * | display       | F   | effect does not fire; target keeps its declared default          |
 * | skip          | F   | no skip — skipping on unknown silently drops content             |
 * | mask          | F   | the mask does not apply; per-item `U` is handled separately      |
 * | option_state  | F   | option falls back to its authored literal `behaviour` default    |
 * | set_variable  | F   | the assignment does not fire; see `setVariableOutcome`           |
 * | validate      | **T** | the requirement is treated as satisfied — no error is shown    |
 * | terminate     | F   | never terminate on unknown. This is the rule that saves a sample |
 *
 * Two rows need their reasoning stated, because both look like exceptions and neither is:
 *
 * **`validate` collapses to `true`, not `false`.** A `validate` rule's condition *is* the
 * requirement (`VALIDATE REQUIRE expr`, D §6.2), so "the safe direction" — D §2.5's "passes",
 * "No error shown" — is the requirement holding. Collapsing it to `false` would raise a
 * validation error the respondent cannot clear, and D §2.5 is explicit that this is worse than a
 * missing datum: "blocking a respondent on an unknown is an unrecoverable dead end in field."
 * This is the one effect whose safe direction is `true`, and it is why this function is a table
 * and not a constant.
 *
 * **`set_variable` is not fully described by a boolean.** "Does the assignment fire" is false on
 * `U`, but D §2.5 also says the effect "assigns `null`" — so the *cell* changes even though the
 * effect did not fire. That third outcome is `setVariableOutcome` below, kept separate so no
 * caller can accidentally treat "did not fire" as "left the value alone".
 */
export function collapseUnknown(kind: RuleKind, verdict: Tri, onUnknown?: 'default' | 'fire'): Collapse {
  if (verdict !== 'U') return { fired: verdict === 'T' };
  const safe = SAFE_ON_UNKNOWN[kind];
  const to = onUnknown === 'fire' ? true : safe;
  return {
    fired: to,
    collapsed: {
      from: 'U',
      to,
      reason:
        onUnknown === 'fire'
          ? `kind=${kind}, ON UNKNOWN override`
          : `kind=${kind}, no ON UNKNOWN override`,
    },
  };
}

/**
 * The safe direction per rule kind. Exhaustive over `RuleKind` by mapped type, so a new effect
 * kind cannot be added without deciding which way its unknowns fall — which is exactly the
 * decision that must not be made by default.
 */
export const SAFE_ON_UNKNOWN: { readonly [K in RuleKind]: boolean } = {
  display: false,
  skip: false,
  mask: false,
  set_variable: false,
  validate: true,
  option_state: false,
  terminate: false,
};

/**
 * What a `set_variable` rule does to its target's cell — the one row of D §2.5's table that a
 * boolean cannot express.
 *
 *  - `T` → assign the effect's value.
 *  - `U` → assign `null`. "Nullity propagates, visibly", because *fabricating a value here is how
 *    bad data is born* — a hidden segment variable silently set to `"old"` for everyone who
 *    skipped the age question is indistinguishable in the export from a real answer.
 *  - `F` → no write: the variable keeps whatever the respondent or an earlier writer put there.
 */
export type SetVariableOutcome = 'assign' | 'assign_null' | 'no_write';

export function setVariableOutcome(verdict: Tri, onUnknown?: 'default' | 'fire'): SetVariableOutcome {
  if (verdict === 'T') return 'assign';
  if (verdict === 'F') return 'no_write';
  return onUnknown === 'fire' ? 'assign' : 'assign_null';
}

/* ========================================================================== */
/* Effect lattices (D §4.6)                                                   */
/* ========================================================================== */

/**
 * Visibility. `hide` is absorbing:
 *
 *     visible = (base OR any show-rule fired) AND NOT (any hide-rule fired)
 *
 * D §4.6 states the meet as "AND(all show-rule verdicts default-true) AND NOT(OR(hide
 * verdicts))". The "default-true" part is what `base` carries: a question with no display
 * rule is visible, and a question that has a `show` rule is base-hidden and revealed by it —
 * otherwise a `show` rule could never hide anything and `IF x THEN SHOW Q12` would show Q12
 * unconditionally, which is not what any author means by it. `compileLogic` derives `base`
 * from the rule set (`show` present ⇒ base false) unless the caller declares it, and both
 * forms are order-independent because OR and AND are commutative.
 */
export function combineVisible(base: boolean, showFired: boolean, hideFired: boolean): boolean {
  return (base || showFired) && !hideFired;
}

/** `opt.visible` / `opt.enabled` — the same absorbing lattice: a false write wins. */
export function combineAbsorbingFalse(base: boolean, writes: readonly boolean[]): boolean {
  let out = base;
  for (const w of writes) if (!w) out = false;
  return out;
}

/** `opt.preselected` / `opt.auto_select` / `required` — boolean OR. */
export function combineOr(base: boolean, writes: readonly boolean[]): boolean {
  let out = base;
  for (const w of writes) if (w) out = true;
  return out;
}

export function optPropCombiner(prop: OptProp): (base: boolean, writes: readonly boolean[]) => boolean {
  switch (prop) {
    case 'visible':
    case 'enabled':
      return combineAbsorbingFalse;
    case 'preselected':
    case 'auto_select':
    case 'required':
      return combineOr;
    default: {
      const never: never = prop;
      throw new LogicInvariant(`unhandled option property ${JSON.stringify(never)}`);
    }
  }
}

/**
 * Masks: successive masks intersect (include) or subtract (exclude) against the running set.
 * Set intersection and difference are both order-independent *given the same partition of
 * masks into include/exclude*, and the compiler additionally orders masks on a question by
 * `order_key` and records that order in the artifact, so a mixed include/exclude chain is
 * deterministic too.
 *
 * `pinned` — schema §5.1's `QuestionItem.pin` — survives BOTH directions: an include mask keeps a
 * pinned item it did not match, and an exclude mask keeps one it did. That is what makes "None of
 * the above" survive a filter that removes every substantive option, and it preserves the
 * order-independence above, because a code no mask can remove is unaffected by the order the
 * masks run in. It does not make the item unconditionally visible: `opt.visible` is a different
 * cell, and an explicit rule still hides it.
 */
export function applyMask(
  current: readonly number[],
  itemCodes: readonly number[],
  mode: 'include' | 'exclude',
  pinned: ReadonlySet<number> = EMPTY_PINS,
): readonly number[] {
  const filter = new Set(itemCodes);
  return mode === 'include'
    ? current.filter((code) => filter.has(code) || pinned.has(code))
    : current.filter((code) => !filter.has(code) || pinned.has(code));
}

/** Shared empty set, so the default argument allocates nothing on the hot path. */
const EMPTY_PINS: ReadonlySet<number> = new Set<number>();

/** Which cell a rule writes. Exactly one, except a mask, which writes an `items` cell. */
export function writesOf(rule: Rule): readonly Cell[] {
  const effect = rule.effect;
  switch (effect.action) {
    case 'show':
    case 'hide': {
      const target = rule.target;
      if (target.type === 'question' || target.type === 'page' || target.type === 'block') {
        return [{ c: 'visible', node_id: target.id }];
      }
      return [];
    }
    case 'skip_to':
    case 'skip_this':
      return rule.flow_node_id === undefined ? [] : [{ c: 'flow', node_id: rule.flow_node_id }];
    case 'mask': {
      const target = rule.target;
      if (target.type !== 'question') return [];
      return [{ c: 'items', question_id: target.id, axis: effect.applies_to }];
    }
    case 'set':
      return [{ c: 'value', variable_id: effect.variable_id }];
    case 'require_valid':
      return [{ c: 'valid', rule_id: rule.id }];
    case 'option_state':
      return [{ c: 'opt', option_id: effect.option_id, prop: effect.prop }];
    case 'terminate':
      return [{ c: 'terminate', rule_id: rule.id }];
    default: {
      const never: never = effect;
      throw new LogicInvariant(`unhandled effect ${JSON.stringify(never)}`);
    }
  }
}

/** Every expression a rule evaluates: its condition plus any effect-carried expressions. */
export function exprsOf(rule: Rule): readonly Expr[] {
  const effect = rule.effect;
  switch (effect.action) {
    case 'mask':
      return [rule.condition, effect.per_item];
    case 'set':
      return [rule.condition, effect.value];
    case 'option_state':
      return [rule.condition, effect.value];
    default:
      return [rule.condition];
  }
}
