/**
 * The repository seam.
 *
 * WHY this interface exists at all: every route handler in this app must be testable without
 * Postgres, and every SQL statement must stay in one layer so that "does this respect RLS?"
 * is a question about five files rather than forty route handlers. `SupabaseRepo` is the real
 * implementation (PostgREST over the `authoring` role, carrying the user's JWT so
 * `app.current_org()` and `app.has_role()` apply); `InMemoryRepo` is the one the test suite
 * runs against.
 *
 * WHY NO METHOD TAKES AN `orgId` ARGUMENT: ADR-009 and security §2.2 — the active org comes
 * from the JWT's `app_metadata.active_org_id` and from nowhere else. A repo built per request
 * from the verified claims, whose methods cannot even express "this org", makes a
 * `?org_id=`-style injection unrepresentable in the type system rather than merely
 * discouraged by review. The one deliberate exception is
 * `InvitationRepo.findByTokenHash()`, which is how an invitee who is not yet a member of the
 * org resolves an invitation (API §2.2: "the only endpoint where org is not from the token").
 *
 * Column names below are the ones in `db/migrations/0004_tenancy/up.sql`, snake_case and
 * verbatim, because the whole point of a repository is that the mapping happens once.
 */

import type { CompileState, JsonObject, JsonValue, OrgRole, VersionStatus } from '@resscript/schema';

/* -------------------------------------------------------------------------- */
/* Rows                                                                        */
/* -------------------------------------------------------------------------- */

export interface OrganizationRow {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly data_region: string;
  readonly settings: JsonObject;
  readonly sso_domain: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly suspended_at: string | null;
  readonly deleted_at: string | null;
}

export interface MemberRow {
  readonly org_id: string;
  readonly user_id: string;
  readonly role: OrgRole;
  readonly project_ids: readonly string[];
  readonly invited_by: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  /**
   * `app.org_members` has no email column — the address lives in `auth.users`, which the
   * `authoring` role is not granted. `SupabaseRepo` therefore returns `null` here until an
   * `app.org_members_with_email` view (or the admin API) lands; the member list renders the
   * user id in that case rather than pretending.
   */
  readonly email: string | null;
}

export interface InvitationRow {
  readonly id: string;
  readonly org_id: string;
  readonly email: string;
  readonly role: OrgRole;
  readonly project_ids: readonly string[];
  readonly status: 'pending' | 'accepted' | 'revoked' | 'expired';
  readonly invited_by: string;
  readonly expires_at: string;
  readonly accepted_at: string | null;
  readonly accepted_by: string | null;
  readonly created_at: string;
}

export interface ProjectRow {
  readonly id: string;
  readonly org_id: string;
  readonly ref: string;
  readonly name: string;
  readonly client_name: string | null;
  readonly tags: readonly string[];
  readonly field_start: string | null;
  readonly field_end: string | null;
  readonly created_by: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly archived_at: string | null;
}

export interface SurveyRow {
  readonly id: string;
  readonly org_id: string;
  readonly project_id: string;
  readonly ref: string;
  readonly name: string;
  readonly description: string | null;
  readonly survey_kind: 'standard' | 'tracker_wave' | 'template';
  readonly parent_survey_id: string | null;
  readonly default_language: string;
  readonly theme_id: string | null;
  readonly created_by: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly archived_at: string | null;
}

/** `status` and `compile_state` are SEPARATE columns — Deliverable K §3. */
export interface SurveyVersionRow {
  readonly id: string;
  readonly org_id: string;
  readonly survey_id: string;
  readonly version_no: number;
  readonly status: VersionStatus;
  readonly compile_state: CompileState;
  readonly artifact_hash: string | null;
  readonly artifact_bytes: number | null;
  readonly schema_version: number;
  readonly revision: number;
  readonly compile_diagnostics: readonly JsonValue[];
  readonly acknowledged_warnings: readonly JsonValue[];
  readonly entitlement_reqs: readonly string[];
  readonly notes: string | null;
  readonly created_by: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly frozen_at: string | null;
  readonly published_at: string | null;
  readonly archived_at: string | null;
  readonly cloned_from_version_id: string | null;
}

/**
 * `ops.jobs`, projected. `progress` is `apps/worker`'s `JobProgress` shape
 * (`{step, total, message, updated_at}`) — the studio's `JobStatus` component renders
 * "step N of M" off these exact keys, so a handler that invents its own is a component that
 * renders nothing.
 */
export interface JobRow {
  readonly id: string;
  readonly org_id: string | null;
  readonly project_id: string | null;
  readonly survey_version_id: string | null;
  readonly kind: string;
  readonly status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  readonly progress: JobProgressShape | null;
  readonly result: JsonValue | null;
  readonly error: JsonValue | null;
  readonly attempts: number;
  readonly max_attempts: number;
  readonly idempotency_key: string | null;
  readonly created_by: string | null;
  readonly created_at: string;
  readonly started_at: string | null;
  readonly finished_at: string | null;
  readonly heartbeat_at: string | null;
}

/**
 * Structurally identical to `@resscript/worker`'s `JobProgress`. Restated rather than
 * imported because `apps/studio` must not depend on `apps/worker` — app-to-app imports are
 * what `.dependency-cruiser.cjs` forbids, and the shape is the wire contract of
 * `ops.jobs.progress`, not the worker's internal type. If this ever needs to be shared it
 * belongs in `@resscript/observability` or `@resscript/schema`, not in an app.
 */
export interface JobProgressShape {
  readonly step: number;
  readonly total: number;
  readonly message: string;
  readonly updated_at: string;
}

/* -------------------------------------------------------------------------- */
/* Keyset pagination (API §1.3)                                               */
/* -------------------------------------------------------------------------- */

/** The decoded cursor: the sort tuple `(created_at DESC, id DESC)`. */
export interface KeysetPosition {
  readonly created_at: string;
  readonly id: string;
}

export interface PageQuery {
  readonly limit: number;
  /** Strictly after this position in the collection's fixed sort order. */
  readonly after?: KeysetPosition;
}

export interface PageResult<T> {
  readonly rows: readonly T[];
  /** True when the store held at least one more row past `rows`. */
  readonly hasMore: boolean;
}

/* -------------------------------------------------------------------------- */
/* Inputs                                                                     */
/* -------------------------------------------------------------------------- */

export interface CreateOrganizationInput {
  readonly slug: string;
  readonly name: string;
  readonly data_region?: string;
}

export interface UpdateOrganizationInput {
  readonly name?: string;
  readonly settings?: JsonObject;
}

export interface UpdateMemberInput {
  readonly role?: OrgRole;
  readonly project_ids?: readonly string[];
}

export interface CreateInvitationInput {
  readonly email: string;
  readonly role: OrgRole;
  readonly project_ids?: readonly string[];
  /** sha256 of the emailed token. The plaintext is never persisted (B §1). */
  readonly token_hash: string;
  readonly expires_at: string;
}

export interface CreateProjectInput {
  readonly ref: string;
  readonly name: string;
  readonly client_name?: string;
  readonly tags?: readonly string[];
  readonly field_start?: string;
  readonly field_end?: string;
}

export interface UpdateProjectInput {
  readonly name?: string;
  readonly client_name?: string;
  readonly tags?: readonly string[];
  readonly field_start?: string;
  readonly field_end?: string;
  /** Archive is a soft delete (B §0 ground rule 5); `null` un-archives. */
  readonly archived_at?: string | null;
}

export interface CreateSurveyInput {
  readonly project_id: string;
  readonly ref: string;
  readonly name: string;
  readonly description?: string;
  readonly survey_kind?: 'standard' | 'tracker_wave' | 'template';
  readonly default_language?: string;
  readonly parent_survey_id?: string;
}

export interface UpdateSurveyInput {
  readonly name?: string;
  readonly description?: string;
  readonly ref?: string;
  readonly theme_id?: string | null;
  readonly archived_at?: string | null;
}

export interface CreateVersionInput {
  readonly survey_id: string;
  readonly from_version_id?: string;
  readonly notes?: string;
  readonly schema_version: number;
}

export interface UpdateVersionInput {
  readonly notes?: string;
}

export interface ListProjectsQuery extends PageQuery {
  readonly q?: string;
  readonly include_archived?: boolean;
}

export interface ListSurveysQuery extends PageQuery {
  readonly project_id?: string;
  readonly q?: string;
  readonly include_archived?: boolean;
}

/* -------------------------------------------------------------------------- */
/* Audit                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Mirrors `app.write_audit_event(...)`. Writes go through that SECURITY DEFINER function
 * because `app.audit_log` has a SELECT policy and no INSERT policy (B §12) — an actor who can
 * write their own audit trail can rewrite history.
 */
export interface AuditEventInput {
  /**
   * Almost always omitted: the org is the caller's active org. Set ONLY by invitation
   * acceptance and org switching, where the org is derived server-side from the hashed
   * invitation token or from a verified membership row rather than from the caller's claims —
   * the caller may not be a member of it yet. It is never read from a request body.
   */
  readonly org_id?: string;
  readonly action: string;
  readonly target_kind?: string;
  readonly target_id?: string;
  readonly project_id?: string;
  readonly survey_id?: string;
  readonly survey_version_id?: string;
  readonly summary?: string;
  readonly diff?: JsonObject;
  readonly request_id?: string;
}

export interface AuditRow extends AuditEventInput {
  readonly id: string;
  readonly org_id: string;
  readonly actor_user_id: string | null;
  readonly actor_kind: 'user' | 'api_key' | 'system' | 'support';
  readonly created_at: string;
}

/* -------------------------------------------------------------------------- */
/* Repositories                                                               */
/* -------------------------------------------------------------------------- */

/** One org the caller belongs to. `organization` is null when RLS cannot show it — see below. */
export interface MembershipSummary {
  readonly org_id: string;
  readonly role: OrgRole;
  /**
   * `organizations_select` restricts reads to `id = app.current_org()`, so a member of orgs A
   * and B whose token is scoped to A can read their membership row for B but NOT B's name.
   * This is correct RLS and an honest limitation of the switcher: it renders the id for orgs
   * it cannot name. The fix is an `app.my_organizations()` SECURITY DEFINER function, which
   * does not exist in 0004 — reported rather than invented here.
   */
  readonly organization: OrganizationRow | null;
}

export interface OrgRepo {
  /** Every org the caller is a member of. Reads `app.org_members` (own rows always visible). */
  listMine(): Promise<readonly MembershipSummary[]>;
  /** The ACTIVE org, from the token. There is no `get(orgId)` on purpose. */
  getActive(): Promise<OrganizationRow | null>;
  /** `app.create_organization(slug, name, region)` — the only path that mints an `owner`. */
  create(input: CreateOrganizationInput): Promise<OrganizationRow>;
  /** Updates the ACTIVE org. */
  updateActive(input: UpdateOrganizationInput): Promise<OrganizationRow>;
}

export interface MemberRepo {
  list(query: PageQuery): Promise<PageResult<MemberRow>>;
  get(userId: string): Promise<MemberRow | null>;
  /** The caller's own role in a given org — used by the org-switch membership check. */
  roleInOrg(orgId: string, userId: string): Promise<OrgRole | null>;
  update(userId: string, input: UpdateMemberInput): Promise<MemberRow>;
  remove(userId: string): Promise<void>;
  /** Used by invitation acceptance. `role = 'owner'` must be rejected by the store. */
  insert(input: {
    readonly org_id: string;
    readonly user_id: string;
    readonly role: OrgRole;
    readonly project_ids: readonly string[];
    readonly invited_by: string | null;
  }): Promise<MemberRow>;
}

export interface InvitationRepo {
  list(query: PageQuery): Promise<PageResult<InvitationRow>>;
  create(input: CreateInvitationInput): Promise<InvitationRow>;
  /**
   * The documented exception to "org comes from the token": the caller is not yet a member,
   * so the org is derived from the hashed token. Keyed on the hash, never on the email, so an
   * authenticated user cannot enumerate invitations addressed to somebody else.
   */
  findByTokenHash(tokenHash: string): Promise<InvitationRow | null>;
  markAccepted(id: string, userId: string): Promise<InvitationRow>;
}

export interface ProjectRepo {
  list(query: ListProjectsQuery): Promise<PageResult<ProjectRow>>;
  get(id: string): Promise<ProjectRow | null>;
  create(input: CreateProjectInput): Promise<ProjectRow>;
  update(id: string, input: UpdateProjectInput): Promise<ProjectRow>;
  /** Hard delete. The policy requires `archived_at IS NOT NULL` first. */
  remove(id: string): Promise<void>;
}

export interface SurveyRepo {
  list(query: ListSurveysQuery): Promise<PageResult<SurveyRow>>;
  get(id: string): Promise<SurveyRow | null>;
  /** Always creates the survey AND its `draft` version: a survey with no version is not addressable (API §2.3). */
  create(input: CreateSurveyInput): Promise<{ survey: SurveyRow; draft_version: SurveyVersionRow }>;
  update(id: string, input: UpdateSurveyInput): Promise<SurveyRow>;
  remove(id: string): Promise<void>;
  listVersions(surveyId: string, query: PageQuery): Promise<PageResult<SurveyVersionRow>>;
  getVersion(id: string): Promise<SurveyVersionRow | null>;
  createVersion(input: CreateVersionInput): Promise<SurveyVersionRow>;
  /**
   * Optimistic concurrency (API §1.7): the caller passes the revision it read via `If-Match`.
   * A mismatch resolves to `null` so the route can answer `412` with the CURRENT row, which is
   * what the client needs to recover — an exception here would lose that.
   */
  updateVersion(
    id: string,
    expectedRevision: number,
    input: UpdateVersionInput,
  ): Promise<SurveyVersionRow | null>;
  /**
   * `app.rollback_version(p_to_version_id, p_request_id)` — `archived → production` plus
   * repointing the survey's token, in one transaction.
   *
   * A repo method and not two updates, because 0009 makes it a `SECURITY DEFINER` function for
   * three reasons the API cannot reproduce: it writes `runtime.survey_tokens`, which `authoring`
   * cannot reach at all; it must demote before it promotes, in that order, or `sv_one_production`
   * refuses the second row with a message about an index; and it is the project_manager
   * capability. Note what it does NOT do: rewrite any version's `artifact_hash`. The target still
   * names the artifact it named while it was live, and ADR-002 addresses an artifact by the sha256
   * of its own content — which is what makes "the runtime serves byte-identical bytes to what was
   * live before" follow from the hash never having been touched rather than from copying bytes.
   */
  rollback(toVersionId: string, requestId: string): Promise<RollbackResult>;
}

/** `app.rollback_version`'s jsonb return, mapped. */
export interface RollbackResult {
  readonly token: string;
  readonly survey_id: string;
  readonly from_version_id: string;
  readonly to_version_id: string;
  readonly artifact_hash: string;
}

/**
 * What `ops.enqueue_job` takes, minus the two things a caller must not choose.
 *
 * No `org_id` (the header rule of this file) and no `created_by`: migration 0005 dropped the
 * latter from the function's signature and said why — "a nullable 'who did this' that can be
 * spoofed by the caller is worse than one derived from the session". That is not a detail here.
 * Migration 0009's calling convention has the compile worker ASSUME the enqueuing user's identity
 * from `ops.jobs.org_id` / `created_by` before it calls `app.publish_version`, so those two
 * columns are the publish capability check's only input. A request body that could set them would
 * be a way to publish as somebody else.
 */
export interface EnqueueJobInput {
  readonly kind: string;
  readonly payload: JsonObject;
  /**
   * `jobs_idem_key`. API §4: "double-clicking Publish returns the running job", answered as
   * `200` rather than `201` — which is why the result carries `created`.
   */
  readonly idempotency_key?: string;
  readonly project_id?: string;
  readonly survey_version_id?: string;
  readonly max_attempts?: number;
}

export interface EnqueuedJob {
  readonly id: string;
  /** False when an existing row under the same `(kind, idempotency_key)` was returned. */
  readonly created: boolean;
}

export interface JobRepo {
  get(id: string): Promise<JobRow | null>;
  /**
   * Enqueue one job, through `app.enqueue_job` (migration 0010).
   *
   * This entry used to read "MISSING DATABASE OBJECT", and the gap it named was fatal rather than
   * cosmetic: `ops.enqueue_job` is `SECURITY DEFINER` and 0005's comment says "the API enqueues
   * through this function and cannot touch the table", but `authoring` holds no USAGE on schema
   * `ops` (0001, asserted by 0001's and 0003's suites), and EXECUTE without schema USAGE is inert
   * — so `GRANT EXECUTE ON FUNCTION ops.enqueue_job` would still have failed with "permission
   * denied for schema ops" and the studio could not queue its own publish job. 0005 had solved
   * exactly this on the READ side by putting `app.get_job` in schema `app` (see the comment on
   * `SupabaseRepo.jobs.get`); 0010 §1 does the same for the write side, granted to `authoring`
   * only, deriving `org_id` and `created_by` inside the definer, and delegating to
   * `ops.enqueue_job` so the idempotency contract has one implementation.
   *
   * The alternative that was rejected then and is recorded here because it will be proposed
   * again: a service-role write leaves `created_by` NULL, and a compile job with no creating user
   * is refused by `app.publish_version` with `insufficient_privilege`, which 0009 calls correct.
   * It does not merely skip a check — it produces a job that can never succeed.
   */
  enqueue(input: EnqueueJobInput): Promise<EnqueuedJob>;
}

export interface AuditRepo {
  write(event: AuditEventInput): Promise<void>;
  /** `changed_since` for a `412` body: audit rows for a version after a timestamp. */
  since(surveyVersionId: string, afterIso: string): Promise<readonly AuditRow[]>;
}

/**
 * Idempotency-Key storage (API §1.4).
 *
 * Phase 1 deliberately has no general request/response replay table — API §14 lists
 * `app.idempotency_keys` as an open item. `InMemoryStore` gives the tests a real
 * implementation, and the Supabase-backed variant is a per-process LRU with the same
 * interface: correct for a single instance, documented as insufficient for a fleet, and
 * swappable for the table when it lands. Keys are scoped to `(org, endpoint)` and expire.
 */
/**
 * A JSON-serializable response body.
 *
 * `unknown` and not `JsonValue`: the row interfaces above are `readonly` and carry no index
 * signature, so they are not assignable to `JsonValue` even though they serialize perfectly.
 * Widening the rows with an index signature to satisfy a type here would let any key be read
 * off a row without a compile error, which is a much worse trade than one `unknown` at the
 * serialization boundary. The REQUEST body, which actually gets hashed, stays `JsonValue`.
 */
export type ResponseBody = unknown;

export interface IdempotencyRecord {
  readonly key: string;
  readonly endpoint: string;
  readonly org_id: string;
  /** Hash of the canonicalized request body, so a replay with a DIFFERENT body is a 422. */
  readonly request_hash: string;
  readonly status: number;
  readonly body: ResponseBody;
  readonly created_at: string;
}

export interface IdempotencyStore {
  get(orgId: string, endpoint: string, key: string): Promise<IdempotencyRecord | null>;
  put(record: IdempotencyRecord): Promise<void>;
}

/* -------------------------------------------------------------------------- */
/* The variable registry — the type environment for the DSL endpoints          */
/* -------------------------------------------------------------------------- */

/**
 * `content.variables`, projected to what a type environment needs (D §3.2: "the checker is
 * parameterized by the registry from schema §4 — nothing else").
 *
 * Columns are 0007's, verbatim. `enum_domain` is a per-variable copy of `[{code, label_key}]`,
 * which is why the mapper in `src/server/dsl/registry.ts` has to synthesize a domain *identity*
 * from the emitting question — see that file.
 */
export interface RegistryVariableRow {
  readonly id: string;
  readonly name: string;
  readonly kind: 'response' | 'hidden' | 'derived' | 'system' | 'quota' | 'design';
  readonly vtype: 'enum' | 'boolean' | 'number' | 'text' | 'date' | 'set' | 'object';
  readonly enum_domain: readonly { readonly code: number; readonly label_key: string }[] | null;
  readonly source_question_id: string | null;
  readonly source_item_id: string | null;
  readonly source_part: JsonObject | null;
  readonly pii: boolean;
  readonly persist: boolean;
  readonly sort_key: string;
}

/** `content.nodes`, projected: only what a ref → id lookup and a question decl need. */
export interface RegistryNodeRow {
  readonly id: string;
  readonly node_kind: 'block' | 'page' | 'question' | 'text';
  readonly parent_id: string | null;
  readonly ref: string | null;
  readonly required: boolean | null;
  readonly emits: readonly string[];
  readonly sort_key: string;
}

/** `content.question_items`, projected. */
export interface RegistryItemRow {
  readonly id: string;
  readonly question_id: string;
  readonly item_kind: 'option' | 'row' | 'column';
  readonly ref: string;
  readonly code: number;
  readonly label_key: string | null;
  readonly sort_key: string;
}

export interface VersionRegistryRows {
  readonly survey_version_id: string;
  readonly variables: readonly RegistryVariableRow[];
  readonly nodes: readonly RegistryNodeRow[];
  readonly items: readonly RegistryItemRow[];
}

/**
 * Reads one version's registry.
 *
 * One method, one shape: the DSL endpoints (API §5) need `ref → id` resolution and type inference
 * in a single request, and issuing three round trips per keystroke-driven `POST /v1/dsl/compile`
 * would make the editor's own API the slowest thing in the loop. No `orgId` argument, per the
 * header rule of this file — RLS on `content.*` scopes it to the caller's active org.
 */
export interface RegistryRepo {
  forVersion(versionId: string): Promise<VersionRegistryRows | null>;
}

/** The bundle a route handler receives. One object so adding a repo is not 40 signatures. */
export interface Repos {
  readonly registry: RegistryRepo;
  readonly orgs: OrgRepo;
  readonly members: MemberRepo;
  readonly invitations: InvitationRepo;
  readonly projects: ProjectRepo;
  readonly surveys: SurveyRepo;
  readonly jobs: JobRepo;
  readonly audit: AuditRepo;
  readonly idempotency: IdempotencyStore;
}
