/**
 * Logic rules — Deliverable C §7.
 *
 * Rules live in one top-level registry rather than nested in the nodes they affect. This is a
 * deliberate change from the brief's nesting, for a practical reason: a programmer's most
 * common question is "what affects Q12?" and the second is "what does Q3 affect?" A central
 * registry answers both with an index; nested storage answers neither without a full tree walk.
 */

import type { ContentNodeId, OptionId, RuleId, VariableId } from '../ids.js';
import type { Expr, JsonObject } from './common.js';
import type { Disposition } from '../registries.js';

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

/** Round-trip fidelity reporting: which surface the author actually used (ADR-003). */
export const RULE_AUTHORED_IN = ['visual', 'dsl'] as const;
export type RuleAuthoredIn = (typeof RULE_AUTHORED_IN)[number];

export type RuleTarget =
  | { readonly type: 'question'; readonly id: ContentNodeId }
  | { readonly type: 'page'; readonly id: ContentNodeId }
  | { readonly type: 'block'; readonly id: ContentNodeId }
  | { readonly type: 'option'; readonly id: OptionId }
  | { readonly type: 'variable'; readonly id: VariableId }
  | { readonly type: 'survey' };

export const RULE_ACTIONS = [
  'show',
  'hide',
  'skip_to',
  'require',
  'unrequire',
  'enable',
  'disable',
  'select',
  'deselect',
  'set',
  'fail',
  'terminate',
] as const;
export type RuleAction = (typeof RULE_ACTIONS)[number];

export interface RuleEffect {
  readonly action: RuleAction;
  /** For `set`: the value expression. For `skip_to`: the destination is in `target_id`. */
  readonly value?: Expr | null;
  readonly target_id?: ContentNodeId | VariableId | null;
  readonly disposition?: Disposition | null;
  readonly message_key?: string | null;
  readonly params?: JsonObject;
}

export interface LogicRule {
  readonly id: RuleId;
  readonly kind: RuleKind;
  readonly target: RuleTarget;
  /** Deliverable D's AST. References are variable/question **ids**, never refs (C §3). */
  readonly condition: Expr;
  readonly effect: RuleEffect;
  readonly evaluation?: RuleEvaluation;
  readonly authored_in?: RuleAuthoredIn;
  /**
   * A small thing agencies care about disproportionately. Six months later, "why does this
   * rule exist" is the expensive question, and the answer is usually in a meeting nobody
   * minuted.
   */
  readonly notes?: string | null;
}
