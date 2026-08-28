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
  session_id: string; // ses_ ULID — the app.ulid shape, so the DB can hold it unmodified
  respondent_id: string; // ULID, stable across resume
  survey_id: string; // ULID, from the artifact manifest (the token deliberately omits it)
  /**
   * The version id, not a version NUMBER: runtime.resolve_token returns survey_version_id
   * and nothing else (its comment: every extra column is a cross-tenant leak waiting for a
   * bug), and the write path keys every table by it. E §3.1 spells this field
   * `survey_version`; the id is what every consumer actually needs.
   */
  survey_version_id: string;
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
  /**
   * This respondent's ticket for the counter-backed randomization modes (E §8.4, P2-03), or null
   * when no counter was reachable at entry.
   *
   * PERSISTED, not re-read. E §8.5 requires the chosen offset be stored because — unlike a seeded
   * order — it is not recoverable from `random_seed`: the ticket came from a shared counter, and a
   * replay that re-read that counter would get a different number and reconstruct a different
   * survey. `durable.ts` calls `random_seed` "ADR-006's replay key. Without it a replay would be a
   * re-simulation with fresh randomness"; an unpersisted ticket reintroduces exactly that.
   *
   * Issued ONCE at entry, for the whole session, so every rotating axis derives from one number —
   * see `rotation.ts` on why one ticket per session beats one per axis.
   */
  rotation_index: number | null;
  /**
   * Which arms each `even_distribution` randomizer allocated, by flow-node id (E §8.5, P2-03).
   *
   * PERSISTED for the reason E §8.5 gives: the assignment "depends on global fill state at the
   * moment of assignment", so it is "the only place the runtime stores a random decision rather
   * than deriving it. Without that, the session is not replayable and the data is not analyzable."
   * A replay that re-ran the allocator would get a different arm and reconstruct a different survey.
   *
   * `{}` means there were no such nodes; a node MISSING from a non-empty map means the allocator
   * was unreachable when this session entered, and the machine falls back to the seeded permutation.
   */
  randomizer_assignments: Record<string, readonly string[]>;
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
  /**
   * The seq of the last event persisted for this session — the counter
   * runtime.submit_page's guard compares. Lives on the session so the Redis copy and the
   * document cannot drift silently: every persist sends last_event_seq + 1 and the database
   * refuses anything else.
   */
  last_event_seq: number;
  /**
   * The last submit's idempotency key and the response it produced, for E §3.4's replay:
   * a mobile retry of an already-applied POST returns the identical body and appends
   * nothing. ONE entry, not E's eight — the dominant retry is the immediately preceding
   * request, and eight bodies of stored response is Redis weight for a tail that has not
   * been observed yet. Widen when measured.
   */
  last_submit: { key: string; response: unknown } | null;
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
  /**
   * Digest of the page as it was actually rendered — visibility, resolved item sets, and piped
   * text — produced by `renderPage`.
   *
   * Invalidate-forward (E §7.2 step 3) has to answer "did this page's rendering drift" for every
   * visit downstream of a back-submit. It cannot re-derive what the respondent saw without
   * replaying the session against an earlier variable state, and E §7.1 rejects replay precisely
   * because it fabricates answers to differently-masked questions. So the render records a
   * digest and the drift test is a string comparison.
   *
   * Optional because a visit written before this field existed has none, and the survival test
   * treats a missing digest as drifted — re-asking is recoverable, keeping a stale answer to a
   * question whose options changed is not.
   */
  render_digest?: string | null;
  /**
   * Set once a back-submit invalidated this visit's answers. Kept rather than deleted: history
   * is a log, and the old values live in the emitted event (ADR-007).
   */
  invalidated?: boolean;
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
