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
