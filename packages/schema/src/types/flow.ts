/**
 * Flow — Deliverable C §6.
 *
 * `content` gives document order; `flow` overlays the non-linear parts. The important
 * property: a survey with no branches has a trivial flow graph (start → sequence over all
 * blocks → end), so simple surveys are never forced through graph editing.
 */

import type { AssetId, ContentNodeId, FlowNodeId, VariableId } from '../ids.js';
import type { Expr, JsonObject, RandomizationMode } from './common.js';
import type { Disposition } from '../registries.js';

export const FLOW_NODE_TYPES = [
  'start',
  'sequence',
  'branch',
  'quota_gate',
  'randomizer',
  'loop',
  'termination',
  'api_call',
  'end',
] as const;
export type FlowNodeType = (typeof FLOW_NODE_TYPES)[number];

export interface FlowBranch {
  /** `null` is the else arm. Exactly one else arm per branch node, and it must be last. */
  readonly condition: Expr | null;
  readonly next: FlowNodeId | null;
}

export interface StartNode {
  readonly id: FlowNodeId;
  readonly type: 'start';
  readonly next: FlowNodeId | null;
}

/** Traverse a block or page in document order, then continue. */
export interface SequenceNode {
  readonly id: FlowNodeId;
  readonly type: 'sequence';
  readonly target_id: ContentNodeId;
  readonly next: FlowNodeId | null;
}

export interface BranchNode {
  readonly id: FlowNodeId;
  readonly type: 'branch';
  readonly branches: readonly FlowBranch[];
}

export interface QuotaGateNode {
  readonly id: FlowNodeId;
  readonly type: 'quota_gate';
  /** The quota plan's `ref`. Plans are addressed by ref in flow for author readability. */
  readonly quota_ref: string;
  readonly on_pass: FlowNodeId | null;
  readonly on_full: FlowNodeId | null;
}

export interface RandomizerNode {
  readonly id: FlowNodeId;
  readonly type: 'randomizer';
  readonly targets: readonly ContentNodeId[];
  readonly mode: RandomizationMode;
  /** For `subset`: how many of `targets` to present. */
  readonly n?: number | null;
  /**
   * "Least-filled cell wins". This needs a cross-respondent counter, so it is implemented on
   * the quota infrastructure (ADR-008) rather than the seeded PRNG. Worth being explicit
   * about: "randomize evenly" and "randomize" are different features and users conflate them.
   */
  readonly even_distribution?: boolean;
  readonly seed_salt?: string | null;
  readonly next: FlowNodeId | null;
}

export interface LoopFlowNode {
  readonly id: FlowNodeId;
  readonly type: 'loop';
  readonly target_id: ContentNodeId;
  /** The variable whose selected options drive the iteration count. */
  readonly over_variable_id?: VariableId | null;
  readonly next: FlowNodeId | null;
}

export interface TerminationNode {
  readonly id: FlowNodeId;
  readonly type: 'termination';
  readonly disposition: Disposition;
  /** For `disposition: "CUSTOM"`, the named key that selects a redirect. */
  readonly custom_key?: string | null;
}

export interface ApiCallNode {
  readonly id: FlowNodeId;
  readonly type: 'api_call';
  readonly asset_id?: AssetId | null;
  readonly url_template?: string | null;
  readonly method?: 'GET' | 'POST';
  /** Variables to send, named explicitly so a `pii` variable cannot leak by wildcard. */
  readonly send_variable_ids?: readonly VariableId[];
  readonly assign_to_variable_ids?: readonly VariableId[];
  readonly config?: JsonObject;
  readonly on_success: FlowNodeId | null;
  readonly on_error: FlowNodeId | null;
}

export interface EndNode {
  readonly id: FlowNodeId;
  readonly type: 'end';
  readonly disposition: Disposition;
}

export type FlowNode =
  | StartNode
  | SequenceNode
  | BranchNode
  | QuotaGateNode
  | RandomizerNode
  | LoopFlowNode
  | TerminationNode
  | ApiCallNode
  | EndNode;

export interface Flow {
  readonly nodes: readonly FlowNode[];
}
