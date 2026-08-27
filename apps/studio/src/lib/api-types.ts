/**
 * Wire types for the studio client.
 *
 * `OrgRole`, `VersionStatus` and `CompileState` are IMPORTED from `@resscript/schema` rather
 * than restated: they are the same values the SQL enums and the RLS policies are generated
 * from, and a hand-written copy here is exactly the drift Deliverable K exists to prevent.
 */

import type { CompileState, OrgRole, VersionStatus } from '@resscript/schema';
import type { CompileDiagnostic } from '@resscript/compiler/diagnostics';

export type { CompileState, OrgRole, VersionStatus, CompileDiagnostic };

export interface OrgMembershipView {
  readonly org_id: string;
  readonly role: OrgRole;
  readonly name: string | null;
  readonly slug: string | null;
  readonly is_active: boolean;
}

export interface OrgListView {
  readonly data: readonly OrgMembershipView[];
  readonly active_org_id: string | null;
}

export interface MemberView {
  readonly org_id: string;
  readonly user_id: string;
  readonly role: OrgRole;
  readonly project_ids: readonly string[];
  readonly email: string | null;
  readonly created_at: string;
}

export interface InvitationView {
  readonly id: string;
  readonly email: string;
  readonly role: OrgRole;
  readonly status: 'pending' | 'accepted' | 'revoked' | 'expired';
  readonly expires_at: string;
  readonly created_at: string;
  /** Only on the creation response. Shown once, never stored. */
  readonly token?: string;
}

export interface ProjectView {
  readonly id: string;
  readonly ref: string;
  readonly name: string;
  readonly client_name: string | null;
  readonly tags: readonly string[];
  readonly archived_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface SurveyView {
  readonly id: string;
  readonly project_id: string;
  readonly ref: string;
  readonly name: string;
  readonly description: string | null;
  /** The base language previews start in when no `lang` is chosen (P1-11). */
  readonly default_language: string;
  readonly archived_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

/** K §3: two orthogonal axes, never collapsed into one field. */
export interface VersionView {
  readonly id: string;
  readonly survey_id: string;
  readonly version_no: number;
  readonly status: VersionStatus;
  readonly compile_state: CompileState;
  readonly revision: number;
  readonly notes: string | null;
  readonly created_at: string;
}

export interface SurveyDetailView extends SurveyView {
  readonly versions: readonly Pick<VersionView, 'id' | 'version_no' | 'status' | 'compile_state' | 'revision'>[];
}

/**
 * `GET /versions/:id/diagnostics`.
 *
 * `diagnostics` is typed as `CompileDiagnostic[]` here and is `jsonb` on the wire:
 * `survey_versions.compile_diagnostics` is `readonly JsonValue[]` all the way through the route,
 * which returns the stored array unchanged. The narrowing therefore happens exactly once, in the
 * container that fetches this, and it is a cast rather than a parse on purpose — the array was
 * written by `packages/compiler` through `sortCompileDiagnostics`, and a client-side re-validation
 * would be a second opinion about a shape the gate owns. What the client must NOT do is infer
 * anything from it that `compile_state` already answers: an empty array on `compile_state: 'none'`
 * means "never compiled", not "clean".
 */
export interface DiagnosticsView {
  readonly survey_version_id: string;
  readonly status: VersionStatus;
  readonly compile_state: CompileState;
  readonly artifact_hash: string | null;
  readonly artifact_bytes: number | null;
  readonly revision: number;
  /** `acknowledgementKey()` values signed by an earlier publish, sealed with the version. */
  readonly acknowledged_warnings: readonly string[];
  readonly diagnostics: readonly CompileDiagnostic[];
  readonly summary: { readonly total: number; readonly errors: number; readonly warnings: number };
}

/**
 * One row of `GET /surveys/:id/history`.
 *
 * `can_roll_back` is computed SERVER-SIDE (it is exactly `app.rollback_version`'s refusals) and is
 * the only authority on whether the control is offered — a client that re-derived it would
 * eventually offer a button the database refuses. It carries no reason, so a UI that wants to
 * explain a `false` has only the row's own visible fields to go on.
 */
export interface VersionHistoryEntryView {
  readonly id: string;
  readonly version_no: number;
  readonly status: VersionStatus;
  readonly compile_state: CompileState;
  /** `null` until a compile has written an artifact. ADR-002: sha256 of the artifact's own bytes. */
  readonly artifact_hash: string | null;
  readonly artifact_bytes: number | null;
  readonly revision: number;
  readonly created_at: string;
  readonly frozen_at: string | null;
  readonly published_at: string | null;
  readonly can_roll_back: boolean;
}

export interface VersionHistoryView {
  readonly survey_id: string;
  readonly survey_ref: string;
  /** The version the survey token currently points at, or `null` when nothing is live. */
  readonly live_version_id: string | null;
  readonly versions: readonly VersionHistoryEntryView[];
  /** More versions than one response carries. The collection endpoint is the paginated read. */
  readonly truncated: boolean;
}

/** `POST /surveys/:id/rollback`. `artifact_hash` is the hash the token now points at. */
export interface RollbackResultView {
  readonly survey_id: string;
  readonly from_version_id: string;
  readonly to_version_id: string;
  readonly artifact_hash: string | null;
  readonly token: string;
}

export interface JobProgressView {
  readonly step: number;
  readonly total: number;
  readonly message: string;
  readonly updated_at: string;
}

export interface JobView {
  readonly id: string;
  readonly kind: string;
  readonly status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  readonly progress: JobProgressView | null;
  readonly attempts: number;
  readonly max_attempts: number;
  readonly created_at: string;
  readonly finished_at: string | null;
}

/* -------------------------------------------------------------------------- */
/* Preview and the debug session (P1-11)                                      */
/* -------------------------------------------------------------------------- */

/** `POST /versions/:id/preview-token`. The origin of `preview_url` doubles as the value every
 *  incoming preview `postMessage`'s `event.origin` is checked against (security §3.2). */
export interface PreviewTokenView {
  readonly artifact_hash: string;
  readonly preview_token: string;
  readonly expires_at: string;
  readonly preview_url: string;
}

/** One `content.variables` row, projected to what the debug panel's masking needs. */
export interface DebugVariableView {
  readonly name: string;
  readonly kind: string;
  readonly vtype: string;
  readonly pii: boolean;
}

/** One writer inside a trace cell — `packages/logic`'s `TraceWriter`, E §14.2's verdicts. */
export interface DebugTraceWriterView {
  readonly rule_id: string;
  readonly verdict: 'T' | 'F' | 'U' | 'skipped';
  readonly collapsed?: { readonly from: 'U'; readonly to: boolean; readonly reason: string };
  readonly suppressed?: boolean;
}

/** One cell of the E §14.2 trace — `packages/logic`'s `TraceCell`, verbatim off the wire. */
export interface DebugTraceCellView {
  readonly cell: string;
  readonly topo_pos: number;
  readonly writers: readonly DebugTraceWriterView[];
  readonly result: unknown;
  readonly changed: boolean;
}

/** The runtime's `debug` field for one page render (test sessions only, E §14.1). */
export interface DebugTraceView {
  readonly seed?: string;
  readonly artifact_hash?: string;
  /** Randomization decisions: `<question id>.<axis>` → the output item order. */
  readonly orders?: Readonly<Record<string, readonly number[]>>;
  readonly digest?: string;
  readonly cells_evaluated?: number;
  readonly trace?: readonly DebugTraceCellView[];
  readonly validations?: readonly unknown[];
  readonly termination?: {
    readonly rule_id: string;
    readonly disposition: string;
    readonly custom_key?: string;
  } | null;
}

/**
 * One `POST /versions/:id/debug-session` response.
 *
 * Deliberately ONE permissive shape rather than a union per action: the route is a verbatim
 * passthrough of three runtime responses (entry/page, validation failure, final disposition)
 * plus the runtime's own error envelope, and the panel renders whichever fields arrived. Every
 * field is therefore optional except `variables`' host — the one thing the proxy adds itself.
 */
export interface DebugStepView {
  readonly session_id?: string;
  readonly page?: {
    readonly page_id: string;
    readonly questions: readonly unknown[];
    readonly skipped: readonly unknown[];
  };
  readonly progress?: { readonly visited: number; readonly revision: number };
  readonly debug?: DebugTraceView;
  readonly validation_failed?: readonly {
    readonly question_id: string;
    readonly message_key: string;
  }[];
  readonly disposition?: string;
  readonly redirect_url?: string | null;
  /** Attached by the proxy on `start` only. */
  readonly variables?: readonly DebugVariableView[];
  /** `setvars` acknowledgements. */
  readonly ok?: boolean;
  readonly set?: number;
  readonly rejected?: readonly string[];
  readonly page_id?: string | null;
  /** The runtime's error envelope, passed through untranslated. */
  readonly error?: { readonly code: string; readonly [key: string]: unknown };
}

/* -------------------------------------------------------------------------- */
/* Translations, exports and the field dashboard (P1-12)                      */
/* -------------------------------------------------------------------------- */

/** One language row of `GET /versions/:id/translations`, counts included — the gauge's data. */
export interface TranslationLanguageView {
  readonly lang: string;
  readonly is_base: boolean;
  readonly rtl: boolean;
  readonly on_missing: string;
  readonly block_publish_if_incomplete: boolean;
  readonly total_keys: number;
  readonly translated: number;
  readonly reviewed: number;
  readonly machine: number;
  readonly missing: number;
  /** `(translated + reviewed) / total_keys`, 0–100, computed SERVER-side (one denominator). */
  readonly complete_pct: number;
}

/** One per-string row, present when the summary was asked with `?lang=`. */
export interface TranslationStringView {
  readonly key: string;
  readonly value: string | null;
  readonly state: 'missing' | 'machine' | 'translated' | 'reviewed';
}

export interface TranslationsSummaryView {
  readonly survey_version_id: string;
  readonly base_lang: string;
  readonly total_keys: number;
  readonly languages: readonly TranslationLanguageView[];
  readonly strings?: readonly TranslationStringView[];
}

/** `PUT /versions/:id/translations/:lang`'s receipt. */
export interface TranslationImportResultView {
  readonly survey_version_id: string;
  readonly lang: string;
  readonly written: number;
  readonly translated: number;
  readonly cleared: number;
}

/** One `app.exports` row as `GET /versions/:id/exports` lists it. */
export interface ExportView {
  readonly id: string;
  readonly survey_version_id: string;
  readonly requested_by: string;
  readonly status: 'pending' | 'running' | 'succeeded' | 'failed';
  readonly pii_included: boolean;
  readonly include_test: boolean;
  readonly row_count: number | null;
  readonly storage_key: string | null;
  readonly error: unknown;
  readonly created_at: string;
  readonly started_at: string | null;
  readonly finished_at: string | null;
}

/** `GET /versions/:id/field-stats`. `IN_PROGRESS` is the spelling for "no disposition yet". */
export interface FieldStatsView {
  readonly survey_version_id: string;
  readonly include_test: boolean;
  readonly entries: number;
  readonly completes: number;
  readonly screenouts: number;
  readonly by_disposition: Readonly<Record<string, number>>;
}

/* -------------------------------------------------------------------------- */
/* Logic rules (P1-12)                                                        */
/* -------------------------------------------------------------------------- */

/**
 * One `content.logic_rules` row, verbatim off the wire. `condition` and `effect` are typed as
 * opaque records here for `DiagnosticsView`'s reason: the shapes are owned elsewhere
 * (`packages/logic`'s `Expr`; `RuleEffectShape` in `lib/rule-statement.ts`), were validated by
 * the writer (`checkExpr` on every save), and the narrowing happens once, in the builder that
 * consumes them.
 */
export interface RuleView {
  readonly id: string;
  readonly survey_version_id: string;
  readonly kind: 'display' | 'skip' | 'mask' | 'set_variable' | 'validate' | 'option_state' | 'terminate';
  readonly target_kind: 'node' | 'item' | 'variable';
  readonly target_node_id: string | null;
  readonly target_item_id: string | null;
  readonly target_variable_id: string | null;
  readonly condition: Record<string, unknown>;
  readonly effect: Record<string, unknown>;
  readonly evaluation: 'on_change' | 'on_page_enter' | 'on_submit';
  readonly authored_in: 'visual' | 'dsl';
  readonly trivia: Record<string, unknown>;
  readonly notes: string | null;
  readonly depends_on_variable_ids: readonly string[];
  readonly depends_on_node_ids: readonly string[];
  readonly sort_key: string;
  readonly created_at: string;
  readonly updated_at: string;
}

/** One LGC diagnostic as the rules routes return it alongside a saved rule. */
export interface RuleDiagnosticView {
  readonly code: string;
  readonly severity: 'error' | 'warning' | 'info';
  readonly message: string;
  readonly path: string;
}

/** `POST /versions/:id/rules` / `PATCH /rules/:id`. */
export interface RuleSaveView {
  readonly rule: RuleView;
  readonly diagnostics: readonly RuleDiagnosticView[];
}

/** `GET /variables/:id/usages` — the panels' read. Empty arrays are honest placeholders (see the route). */
export interface VariableUsagesView {
  readonly variable_id: string;
  readonly survey_version_id: string;
  readonly rules: readonly RuleView[];
  readonly quotas: readonly unknown[];
  readonly masks: readonly unknown[];
  readonly pipes: readonly unknown[];
  readonly redirects: readonly unknown[];
}

/** One `GET /versions/:id/variables` row — what the builder's pickers need. */
export interface VariablePickView {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly vtype: 'enum' | 'boolean' | 'number' | 'text' | 'date' | 'set' | 'object';
  readonly enum_domain: readonly { readonly code: number; readonly label_key: string }[] | null;
  readonly source_question_id: string | null;
  readonly pii: boolean;
}

/**
 * One `GET /versions/:id/tree` row — API §2.5's `TreeRow`.
 *
 * The six fields at the top were all the route served before P1-03 and keep their names, so a
 * client written against the summary read still compiles. Everything below them is §2.5's list plus
 * the three counts the CTE returns for free: a tree cannot render a "60 options" badge or a
 * collapse chevron without them, and re-deriving either would mean a second read per node.
 *
 * `label_preview` is `null` unless the request asked for `fields=full`, and `rule_summaries` is
 * empty unless it asked for `include=rules`. Both are absences by request, not by failure — a
 * client that renders a badge off an empty array must ask for the data first.
 */
export interface TreeNodeView {
  readonly id: string;
  readonly kind: 'block' | 'page' | 'question' | 'text';
  readonly parent_id: string | null;
  readonly ref: string | null;
  readonly required: boolean | null;
  readonly sort_key: string;
  readonly label_preview: string | null;
  readonly question_type: string | null;
  readonly flags: Record<string, unknown>;
  readonly rule_summaries: readonly TreeRuleSummaryView[];
  readonly diagnostic_counts: { readonly errors: number; readonly warnings: number };
  readonly depth: number;
  readonly ordinal: number;
  readonly item_count: number;
  readonly child_count: number;
  readonly emit_count: number;
  readonly updated_at: string;
}

/** One rule against a node, as the tree's badges render it. */
export interface TreeRuleSummaryView {
  readonly id: string;
  readonly kind: RuleView['kind'];
  readonly action: string | null;
  readonly evaluation: RuleView['evaluation'];
  readonly authored_in: RuleView['authored_in'];
}

/** `GET /versions/:id/tree`. `revision` is the value an `If-Match` for the next edit carries. */
export interface TreeView {
  readonly survey_version_id: string;
  readonly revision: number;
  readonly fields: 'summary' | 'full';
  readonly data: readonly TreeNodeView[];
}

/**
 * One `content.nodes` row on the wire — the lazily-fetched body (API §2.5).
 *
 * `config`, `settings`, `validation`, `masks`, `scripts` and `flags` are opaque here for
 * `RuleView`'s reason: `config`'s shape is the question plugin's own `configSchema` (F §5) and
 * `validation`/`masks` are schema §15's, both validated by their owners on write. The narrowing
 * happens once, in the panel that edits them.
 */
export interface NodeView {
  readonly id: string;
  readonly survey_version_id: string;
  readonly node_kind: 'block' | 'page' | 'question' | 'text';
  readonly parent_id: string | null;
  readonly sort_key: string;
  readonly ref: string | null;
  readonly label_key: string | null;
  readonly instruction_key: string | null;
  readonly title_key: string | null;
  readonly question_type: string | null;
  readonly required: boolean | null;
  readonly config: Record<string, unknown>;
  readonly settings: Record<string, unknown>;
  readonly validation: readonly unknown[];
  readonly masks: readonly unknown[];
  readonly scripts: Record<string, unknown>;
  readonly flags: Record<string, unknown>;
  readonly emits: readonly string[];
  readonly created_at: string;
  readonly updated_at: string;
  /** Non-null means the node is in the undo buffer (API §2.5's soft delete). */
  readonly deleted_at: string | null;
}

/**
 * One option, matrix row or matrix column.
 *
 * `code` and `sort_key` are separate fields here because they are separate columns with separate
 * constraints (C §5.1), and the API "will not let you conflate them": reordering is
 * `POST /items/{id}/move` and recoding is `PATCH /items/{id}`.
 */
export interface ItemView {
  readonly id: string;
  readonly question_id: string;
  readonly item_kind: 'option' | 'row' | 'column';
  readonly ref: string;
  readonly code: number;
  readonly label: string | null;
  readonly sort_key: string;
  readonly anchor: string;
  readonly exclusive: boolean;
  readonly behaviour: Record<string, unknown>;
  readonly value_override: string | null;
  readonly custom_class: string | null;
  readonly meta: Record<string, unknown>;
  readonly deleted_at: string | null;
}

/** One mixed-matrix cell override, addressed by item ref (C §5.2). */
export interface CellView {
  readonly id: string;
  readonly row_ref: string | null;
  readonly column_ref: string | null;
  readonly control: {
    readonly question_type: string;
    readonly config: Record<string, unknown>;
    readonly use_columns: boolean;
  };
}

/** One `content.variables` row as the content routes echo it — the export contract, per column. */
export interface EmittedVariableView {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly vtype: VariablePickView['vtype'];
  readonly source_question_id: string | null;
  readonly source_item_id: string | null;
  readonly export_include: boolean;
  readonly export_column: string;
  readonly export_label_key: string | null;
  readonly pii: boolean;
  readonly persist: boolean;
  readonly sort_key: string;
}

/** `POST /versions/:id/nodes`. */
export interface NodeCreatedView {
  readonly node: NodeView;
  readonly variables_created: readonly EmittedVariableView[];
}

/** `PATCH /nodes/:id` — `variables_changed` is empty when the edit moved no derived name. */
export interface NodeSavedView {
  readonly node: NodeView;
  readonly variables_changed: readonly EmittedVariableView[];
}

/**
 * `DELETE /nodes/:id`.
 *
 * `rules_affected[].outcome` is what actually happened to each rule — `orphaned` under the default
 * `?cascade_rules=orphan`, `deleted` under `delete` — so the studio's undo dialog can say which,
 * rather than the client re-deriving it from the query parameter it sent.
 */
export interface NodeDeletedView {
  readonly deleted: readonly NodeView[];
  readonly rules_affected: readonly {
    readonly id: string;
    readonly kind: RuleView['kind'];
    readonly target_node_id: string | null;
    readonly target_item_id: string | null;
    readonly outcome: 'orphaned' | 'deleted';
  }[];
}

/** `POST /nodes/:id/duplicate` — the whole copy, in one response. */
export interface NodeDuplicatedView {
  readonly nodes: readonly NodeView[];
  readonly items: readonly ItemView[];
  readonly cells: readonly CellView[];
  readonly variables_created: readonly EmittedVariableView[];
  readonly rules_created: readonly RuleView[];
}
