/**
 * Session state per Deliverable E §3.
 *
 * SessionState is the only authoritative state held by the runtime. Given the artifact,
 * the session's seed, and the session's answers, every decision the runtime has ever made
 * is recomputable. This is what makes replay (ADR-006), divergence detection (ADR-004),
 * and offline CAPI (§15) possible.
 */

import type { Disposition, PageId, FlowNodeId, QuestionId, VariableId } from '@resscript/schema';
import type { Value } from '@resscript/logic';

export interface SessionState {
  // ---- identity -------------------------------------------------------
  session_id: string; // ULID
  respondent_id: string; // ULID, stable across resume
  survey_id: string; // ULID
  survey_version: number;
  artifact_hash: string; // PINNED at entry (§3.3)
  schema_version: number;

  // ---- provenance -----------------------------------------------------
  vendor_ref: string | null;
  entry_params: Record<string, string>; // raw, as received, for audit
  language: string;
  device: { class: 'desktop' | 'tablet' | 'mobile'; ua_class: string };
  geo: { country: string; region: string | null };
  is_test: boolean;

  // ---- the authoritative data -----------------------------------------
  random_seed: string; // 128-bit hex
  vars: Record<VariableId, Value | null>; // variable_id -> Value
  var_provenance: Record<VariableId, Provenance>; // who set each var

  // ---- position -------------------------------------------------------
  machine_state: MachineState; // discriminated union matching E §2.1
  current_page_id: PageId | null;
  history: PageVisit[]; // the back stack
  flow_cursor: FlowCursor;

  // ---- quota ----------------------------------------------------------
  reservations: Reservation[]; // held, not yet committed or released
  quota_cells: Record<string, string>; // per plan_id: cell key
  soft_quota_flags: string[];

  // ---- outcome --------------------------------------------------------
  disposition: Disposition | null;
  custom_key: string | null;
  quality_flags: string[]; // speeder, straightliner, trap_failed

  // ---- timings --------------------------------------------------------
  started_at: number; // epoch ms
  last_activity_at: number;
  finalized_at: number | null;
  page_timings: Record<PageId, PageTiming>;
  server_time_ms: number; // stamped per evaluation

  // ---- integrity ------------------------------------------------------
  revision: number; // optimistic concurrency (§3.4)
  resume_token_hash: string | null;
}

export type MachineState =
  | { state: 'ENTRY' }
  | { state: 'INVALID' }
  | { state: 'CREATED' }
  | { state: 'SCREENING' }
  | { state: 'QUOTA_GATE' }
  | { state: 'PAGE_LOOP'; current_page_id: PageId }
  | { state: 'TERMINATING'; disposition: Disposition; custom_key?: string }
  | { state: 'FLOW_END' }
  | { state: 'COMPLETING' }
  | { state: 'FINALIZED'; disposition: Disposition };

export interface FlowCursor {
  node_id: FlowNodeId;
  iteration_stack: LoopFrame[];
}

export interface LoopFrame {
  loop_id: string;
  iteration: number;
}

export type Provenance =
  | { p: 'respondent'; page_id: PageId; visit: number }
  | { p: 'entry_param'; param: string }
  | { p: 'derived'; rule_id: string }
  | { p: 'set_variable'; rule_id: string }
  | { p: 'script'; asset_ref: string }
  | { p: 'system' }
  | { p: 'quota' }
  | { p: 'design' }
  | { p: 'invalidated'; by_page: PageId; at: number };

export interface PageVisit {
  page_id: PageId;
  entered_at: number;
  submitted_at: number | null;
  wrote: VariableId[];
  shown: QuestionId[];
  attempt: number;
}

export interface PageTiming {
  first_render_ms: number;
  total_ms: number;
  submits: number;
  focus_loss_ms: number;
}

export interface Reservation {
  plan_id: string;
  cell_key: string;
  held_at: number;
  ttl_seconds: number;
}
