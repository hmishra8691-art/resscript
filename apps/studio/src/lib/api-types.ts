/**
 * Wire types for the studio client.
 *
 * `OrgRole`, `VersionStatus` and `CompileState` are IMPORTED from `@resscript/schema` rather
 * than restated: they are the same values the SQL enums and the RLS policies are generated
 * from, and a hand-written copy here is exactly the drift Deliverable K exists to prevent.
 */

import type { CompileState, OrgRole, VersionStatus } from '@resscript/schema';

export type { CompileState, OrgRole, VersionStatus };

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
