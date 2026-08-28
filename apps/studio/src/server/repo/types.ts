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

import type {
  CompileState,
  JsonObject,
  JsonValue,
  OrgRole,
  RuleAuthoredIn,
  RuleEvaluation,
  RuleKind,
  VersionStatus,
} from '@resscript/schema';

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

/**
 * The language a version is born speaking.
 *
 * A default and not a decision. A per-org default belongs in `app.organizations.settings` the
 * first time a customer needs one; hardcoding `en` here is better than the state this replaced,
 * which was no base language at all and therefore a version that could never compile.
 */
export const DEFAULT_BASE_LANGUAGE = 'en';

export interface CreateVersionInput {
  readonly survey_id: string;
  readonly from_version_id?: string;
  readonly notes?: string;
  readonly schema_version: number;
  /**
   * BCP-47 code for the base language, defaulting to `DEFAULT_BASE_LANGUAGE`. Ignored when
   * `from_version_id` is set: a clone inherits its languages from the source version, base
   * included (`content.clone_version_core`, 0023).
   */
  readonly base_language?: string;
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
   * Take the version's optimistic lock without changing a field, and bump `revision`.
   *
   * This is what makes API §1.7 true for CONTENT: "every version-scoped content resource shares
   * ONE optimistic lock … and every content mutation touches that row in the same transaction".
   * A content route cannot express its lock as `updateVersion`, because it has no version field
   * to write, and an `updateVersion(id, rev, {})` would reach PostgREST as an empty payload.
   *
   * A compare-and-swap, not a read-then-write: the expected revision is a WHERE clause, so two
   * editors racing on one version produce a `412` for the loser rather than two silent writes.
   * `null` on a mismatch, for `updateVersion`'s reason — the route needs the CURRENT row to
   * build `changed_since`.
   */
  touchVersion(id: string, expectedRevision: number): Promise<SurveyVersionRow | null>;
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
/* Redirects — where a terminated respondent is sent (API §2.9, 0010)          */
/* -------------------------------------------------------------------------- */

/**
 * `content.redirects`, flattened exactly as 0010 stores it: one row per
 * (scope, scope key, disposition, custom key).
 *
 * `scope_key` is `''` for the default scope and `custom_key` is `''` for every disposition but
 * `CUSTOM` — both pinned by 0010's biconditional CHECKs, so the empty strings are the table's
 * own encoding of "not applicable" rather than a convention this layer defends. No
 * `survey_version_id` on the row: the version is the method argument, and API §2.9 returns the
 * rows flattened so "is every disposition covered" is a join, not a JSONB walk — which is also
 * why this shape is field-for-field the worker's `AuthoringRedirectRow`: a row written here is
 * a row `apps/worker`'s `redirectsOf` reassembles into `Survey.redirects` verbatim.
 */
export interface RedirectRow {
  readonly scope: 'default' | 'vendor' | 'language';
  readonly scope_key: string;
  readonly disposition: string;
  readonly custom_key: string;
  readonly url_template: string;
}

/**
 * One vendor, as the wire and the worker both see it.
 *
 * Field-for-field `apps/worker`'s `AuthoringVendorRow` — the same rule `RedirectRow` follows, and
 * for the same reason: a row written here is a row the worker's `vendorsOf` reassembles into
 * `Survey.vendors` verbatim, so a divergence between the two shapes is a survey that publishes
 * differently from how it was authored.
 *
 * `variable_ref` and not `variable_id`: 0024 STORES the id (a foreign key can hold one and cannot
 * hold a name, because content.variables' name uniqueness is a partial expression index) while the
 * document and this wire deal in refs, per schema §9. The repo resolves between them.
 */
export interface VendorInboundParamRow {
  readonly param: string;
  readonly variable_ref: string;
  readonly required: boolean;
}

export interface VendorRow {
  readonly id: string;
  readonly ref: string;
  readonly name: string;
  readonly entry_url_template: string | null;
  readonly max_completes: number | null;
  readonly quota_plan_overrides: readonly string[];
  readonly inbound_params: readonly VendorInboundParamRow[];
  /**
   * Present only for a SIGNED vendor. `secret_ref` is a POINTER into the secrets store and never
   * the secret — 0024 refuses a secret-shaped value at write time, because every other layer that
   * forbids one (the schema type, the compiler's assertNoSecrets, the artifact type) sits
   * downstream of a paste into this console.
   */
  readonly security: {
    readonly hash_param: string;
    readonly algorithm: 'sha256' | 'sha1' | 'md5';
    readonly secret_ref: string;
    readonly signed_params: readonly string[];
    readonly max_skew_s?: number;
    readonly timestamp_param?: string;
    readonly nonce_param?: string;
  } | null;
}

export interface VendorRepo {
  /** Every vendor of one version, in 0024's sort order. Empty when none are configured. */
  listVendors(versionId: string): Promise<readonly VendorRow[]>;
  /**
   * Whole-set replace, like `replaceRedirects`.
   *
   * A vendor set is small and authored as a unit, and a per-row API would need the client to track
   * ids it did not mint. The same bounded weakness applies: delete-then-insert is two statements
   * rather than one transaction, so a crash between them leaves the version with NO vendors — which
   * publishes fine (a survey with no panels is a valid survey) rather than half-merged.
   */
  replaceVendors(versionId: string, rows: readonly VendorRow[]): Promise<readonly VendorRow[]>;
}

export interface RedirectRepo {
  /** Every redirect row of one version, in 0010's key order. Empty when none are configured. */
  listRedirects(versionId: string): Promise<readonly RedirectRow[]>;
  /**
   * Whole-set replace — PUT semantics (API §2.9): delete every row of the version, insert the
   * given set, scoped to the version and the caller's org. The route validates every template
   * BEFORE calling this (security §12.3: "failures are 422, never stored"), so a row reaching
   * here is one the CHECKs will accept; the store's own draft-only and role guards still apply,
   * because `content.tg_draft_only` and the `programmer` write policies are the guarantee.
   */
  replaceRedirects(versionId: string, rows: readonly RedirectRow[]): Promise<readonly RedirectRow[]>;
}

/* -------------------------------------------------------------------------- */
/* Languages and i18n strings — the translation surface (API §2.10, 0007 §8)   */
/* -------------------------------------------------------------------------- */

/**
 * `content.languages`, projected to the wire. Field-for-field the worker's
 * `AuthoringLanguageRow`, for the same reason `RedirectRow` mirrors `AuthoringRedirectRow`:
 * what the translation routes store is literally what the publish read assembles into
 * `Survey.languages`, and a second shape would disagree with that reassembly eventually.
 */
export interface LanguageRow {
  readonly lang: string;
  readonly is_base: boolean;
  readonly rtl: boolean;
  readonly on_missing: string;
  readonly block_publish_if_incomplete: boolean;
}

/**
 * `content.i18n_strings`, projected. `value` is `null` exactly when `state = 'missing'` —
 * 0007's `i18n_missing_has_no_value` CHECK is the table's encoding of "not translated yet",
 * and this layer preserves it rather than inventing `''`-vs-`null` semantics of its own.
 */
export interface I18nStringRow {
  readonly lang: string;
  readonly key: string;
  readonly value: string | null;
  readonly state: 'missing' | 'machine' | 'translated' | 'reviewed';
}

/** One upserted string. The route derives `state` from the value; see the translations PUT. */
export interface UpsertStringInput {
  readonly key: string;
  readonly value: string | null;
  readonly state: I18nStringRow['state'];
}

export interface I18nRepo {
  /** Every language of one version, base first then tag order. Empty when none configured. */
  listLanguages(versionId: string): Promise<readonly LanguageRow[]>;
  /**
   * Add one non-base language. `languages_insert` is programmer-floor + draft-only; the base
   * language is never added here — it is born with the version (0007's clone copies it), and
   * `languages_one_base` makes a second one a constraint error, not a request.
   */
  addLanguage(versionId: string, lang: string): Promise<LanguageRow>;
  /**
   * Every i18n string row of one version, all languages, `(lang, key)` order. One method for
   * the summary, the flat export and the import's base-key validation, because all three need
   * the same rows and three shapes would be three chances to disagree about what "the key set"
   * is. Phase-1 sizes (a few thousand keys × a handful of languages) make this one read.
   */
  listStrings(versionId: string): Promise<readonly I18nStringRow[]>;
  /**
   * Upsert by `(survey_version_id, lang, key)` — the table's PRIMARY KEY. The route validates
   * every key against the base language's key set BEFORE calling this (a typo'd key must be a
   * 422 naming it, never a silently invented row); the store's reviewer-floor and draft-only
   * guards still apply, because the policies and `content.tg_draft_only` are the guarantee.
   */
  upsertStrings(versionId: string, lang: string, rows: readonly UpsertStringInput[]): Promise<number>;
}

/* -------------------------------------------------------------------------- */
/* Exports — who exported what, with or without PII (API §2.15, 0012)          */
/* -------------------------------------------------------------------------- */

/** `app.exports`, verbatim columns. `error` is `AppError.toJSON()` when status = failed. */
export interface ExportRow {
  readonly id: string;
  readonly survey_version_id: string;
  readonly requested_by: string;
  readonly status: 'pending' | 'running' | 'succeeded' | 'failed';
  readonly pii_included: boolean;
  readonly include_test: boolean;
  readonly row_count: number | null;
  readonly storage_key: string | null;
  readonly error: JsonValue | null;
  readonly created_at: string;
  readonly started_at: string | null;
  readonly finished_at: string | null;
}

/**
 * No `requested_by` input, per this file's header rule in miniature: `exports_insert` pins it
 * to `app.current_user_id()`, so a body that could set it would launder the PII audit trail
 * through a colleague.
 */
export interface CreateExportInput {
  readonly survey_version_id: string;
  readonly pii_included: boolean;
  readonly include_test: boolean;
}

export interface ExportRepo {
  /**
   * Insert one born-pending row. The PII gate is NOT re-tested in TypeScript: 0012's
   * `app.tg_exports_pii_guard` (capability, never rank) is the guarantee, and the API's job is
   * honest defaults plus translating the trigger's `42501` into a 403 naming the grant.
   */
  create(input: CreateExportInput): Promise<ExportRow>;
  /** One version's export history, newest first — the dialog's list. Capped, not paginated. */
  listForVersion(versionId: string): Promise<readonly ExportRow[]>;
}

/* -------------------------------------------------------------------------- */
/* Field stats — response counts by disposition (roadmap P1-12, 0013)          */
/* -------------------------------------------------------------------------- */

/**
 * One group of `app.field_stats(version, include_test)` — counts over `runtime.sessions`.
 * `disposition` is `runtime.disposition`'s spelling with one normalization made IN THE
 * FUNCTION: a session still in flight stores `disposition = NULL`, and the function returns it
 * as `'IN_PROGRESS'` (K §2's own name for that state) so the studio never renders "null".
 */
export interface DispositionCount {
  readonly disposition: string;
  readonly sessions: number;
}

export interface FieldStatsRepo {
  /**
   * Counts grouped by disposition for one version. `includeTest` defaults OFF everywhere —
   * P1-11's acceptance: `is_test` rows "are excluded from the default response count shown in
   * studio" — and the exclusion lives in the SQL, not in a filter a caller could forget.
   */
  forVersion(versionId: string, includeTest: boolean): Promise<readonly DispositionCount[]>;
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

/* -------------------------------------------------------------------------- */
/* Logic rules — the central registry (API §2.7, 0007 §4.4, roadmap P1-12)     */
/* -------------------------------------------------------------------------- */

/**
 * `content.logic_rules`, verbatim columns minus `org_id` (the header rule of this file).
 *
 * `condition` and `effect` stay `JsonObject` at this layer for the reason `dslPrintSchema`
 * gives: the AST's shape is `packages/logic`'s to define, and the route validates it by
 * CHECKING it (`checkExpr`), never by restating 58 node kinds as a second schema. The two
 * `depends_on_*` arrays are the dependency closure DB §4.4 says is "recomputed from the AST on
 * save" — computed by the route from the stored condition (`readsOf` + `probesOf`), written
 * here, and served back by the two GIN indexes.
 */
export interface RuleRow {
  readonly id: string;
  readonly survey_version_id: string;
  readonly kind: RuleKind;
  readonly target_kind: 'node' | 'item' | 'variable';
  readonly target_node_id: string | null;
  readonly target_item_id: string | null;
  readonly target_variable_id: string | null;
  readonly condition: JsonObject;
  readonly effect: JsonObject;
  readonly evaluation: RuleEvaluation;
  readonly authored_in: RuleAuthoredIn;
  /** D §6.4's `Trivia`, kept only for DSL-authored rules (`rules_trivia_dsl_only`). */
  readonly trivia: JsonObject;
  readonly notes: string | null;
  readonly depends_on_variable_ids: readonly string[];
  readonly depends_on_node_ids: readonly string[];
  readonly sort_key: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface CreateRuleInput {
  readonly survey_version_id: string;
  readonly kind: RuleKind;
  readonly target_kind: 'node' | 'item' | 'variable';
  readonly target_node_id?: string;
  readonly target_item_id?: string;
  readonly target_variable_id?: string;
  readonly condition: JsonObject;
  readonly effect: JsonObject;
  readonly evaluation?: RuleEvaluation;
  readonly authored_in?: RuleAuthoredIn;
  readonly trivia?: JsonObject;
  readonly notes?: string;
  readonly depends_on_variable_ids: readonly string[];
  readonly depends_on_node_ids: readonly string[];
}

/**
 * A partial edit. The `depends_on_*` arrays are REQUIRED whenever `condition` is present and
 * forbidden otherwise — the closure is derived state, and an update that could change the AST
 * without rewriting the closure is exactly the drift DB §4.4's "recomputed on save" forbids.
 * The route owns that pairing; the type spells both halves as optional and the store trusts it.
 */
export interface UpdateRuleInput {
  readonly kind?: RuleKind;
  readonly target_kind?: 'node' | 'item' | 'variable';
  readonly target_node_id?: string | null;
  readonly target_item_id?: string | null;
  readonly target_variable_id?: string | null;
  readonly condition?: JsonObject;
  readonly effect?: JsonObject;
  readonly evaluation?: RuleEvaluation;
  readonly authored_in?: RuleAuthoredIn;
  readonly trivia?: JsonObject;
  readonly notes?: string | null;
  readonly depends_on_variable_ids?: readonly string[];
  readonly depends_on_node_ids?: readonly string[];
}

/**
 * The two questions 03 §7 centralized rules to answer, as filters (API §2.7): "what affects
 * Q12" is `target_node_id`; "what does Q3 affect" is `depends_on_node_id` /
 * `depends_on_variable_id` — array-containment reads the two GIN indexes serve.
 */
export interface ListRulesQuery extends PageQuery {
  readonly target_node_id?: string;
  readonly depends_on_node_id?: string;
  readonly depends_on_variable_id?: string;
  readonly kind?: RuleKind;
}

export interface RuleRepo {
  /** One version's rules, filtered. Soft-deleted rows never appear. Reviewer-floor read. */
  list(versionId: string, query: ListRulesQuery): Promise<PageResult<RuleRow>>;
  /**
   * By rule id alone (API §2.7's `/v1/rules/{id}` shape). The version is discovered, not
   * supplied, because the client that holds a rule id got it from a list that already scoped it.
   */
  get(ruleId: string): Promise<RuleRow | null>;
  create(input: CreateRuleInput): Promise<RuleRow>;
  update(ruleId: string, input: UpdateRuleInput): Promise<RuleRow>;
  /** Soft delete (`deleted_at`), per API §2.7 — the editor's undo buffer, like every content row. */
  remove(ruleId: string): Promise<void>;
  /**
   * `GET /v1/variables/{id}/usages`' backing read: the variable's version plus every rule whose
   * `depends_on_variable_ids` contains it (the `rules_depends_var_gin` lookup). `null` when the
   * variable is not visible to the caller — a 404 upstream, never an empty list, for the same
   * cross-tenant reason `RegistryRepo.forVersion` returns `null`.
   */
  usagesOfVariable(variableId: string): Promise<{
    readonly survey_version_id: string;
    readonly rules: readonly RuleRow[];
  } | null>;
}

/* -------------------------------------------------------------------------- */
/* Content nodes, items and cells — the tree (API §2.5, 0007 §3/§4/§5/§7)      */
/* -------------------------------------------------------------------------- */

export type NodeKind = 'block' | 'page' | 'question' | 'text';
export type ItemKind = 'option' | 'row' | 'column';
export type VarKind = 'response' | 'hidden' | 'derived' | 'system' | 'quota' | 'design';
export type VarType = 'enum' | 'boolean' | 'number' | 'text' | 'date' | 'set' | 'object';

/**
 * `content.nodes`, verbatim columns minus `org_id` (the header rule of this file).
 *
 * `deleted_at` IS on the wire, unlike `RuleRow`'s, and the difference is the point: API §2.5's
 * delete is soft and its `undelete` is a first-class endpoint, so "is this node in the undo
 * buffer" is part of what a client asks about a node. A rule has no undelete route.
 *
 * `config`, `settings`, `validation`, `masks`, `scripts` and `flags` stay opaque JSON at this
 * layer for `RuleRow`'s reason: `config`'s shape belongs to the question plugin's own
 * `configSchema` (F §5) and `validation`/`masks` to schema §15, and restating either here would
 * be a second definition that eventually accepts what the real validator rejects.
 */
export interface NodeRow {
  readonly id: string;
  readonly survey_version_id: string;
  readonly node_kind: NodeKind;
  readonly parent_id: string | null;
  readonly sort_key: string;
  readonly ref: string | null;
  readonly label_key: string | null;
  readonly instruction_key: string | null;
  readonly title_key: string | null;
  readonly question_type: string | null;
  readonly required: boolean | null;
  readonly config: JsonObject;
  readonly settings: JsonObject;
  readonly validation: readonly JsonValue[];
  readonly masks: readonly JsonValue[];
  readonly scripts: JsonObject;
  readonly flags: JsonObject;
  readonly emits: readonly string[];
  readonly created_at: string;
  readonly updated_at: string;
  readonly deleted_at: string | null;
}

/** `content.question_items`, same treatment. */
export interface ItemRow {
  readonly id: string;
  readonly survey_version_id: string;
  readonly question_id: string;
  readonly item_kind: ItemKind;
  readonly ref: string;
  /** C §5.1: THE EXPORTED VALUE, and a different column from `sort_key`. Never conflated. */
  readonly code: number;
  readonly label_key: string | null;
  readonly sort_key: string;
  readonly anchor: string;
  readonly exclusive: boolean;
  readonly behaviour: JsonObject;
  readonly value_override: string | null;
  readonly custom_class: string | null;
  readonly meta: JsonObject;
  readonly created_at: string;
  readonly updated_at: string;
  readonly deleted_at: string | null;
}

/** `content.question_cells` — one mixed-matrix override (C §5.2). No soft delete: PUT replaces. */
export interface CellRow {
  readonly id: string;
  readonly survey_version_id: string;
  readonly question_id: string;
  readonly row_item_id: string;
  readonly column_item_id: string | null;
  readonly question_type: string;
  readonly config: JsonObject;
  readonly use_columns: boolean;
}

/** One `content.variables.enum_domain` entry, as 0007 stores it. */
export interface EnumDomainEntryRow {
  readonly code: number;
  readonly label_key: string;
}

/**
 * `content.variables`, fuller than `RegistryVariableRow`.
 *
 * Two projections of one table, deliberately: the registry read is the DSL endpoints' type
 * environment and carries only what a type check needs, whereas a question save has to write —
 * and echo back as `variables_created` / `variables_changed` — the export half (`export_column`,
 * `export_include`, `export_label_key`) that IS the export contract (ADR-007).
 */
export interface VariableRow {
  readonly id: string;
  readonly survey_version_id: string;
  readonly name: string;
  readonly kind: VarKind;
  readonly vtype: VarType;
  readonly source_question_id: string | null;
  readonly source_item_id: string | null;
  readonly source_part: JsonObject | null;
  readonly enum_domain: readonly EnumDomainEntryRow[] | null;
  readonly export_include: boolean;
  readonly export_column: string;
  readonly export_label_key: string | null;
  readonly pii: boolean;
  readonly persist: boolean;
  readonly sort_key: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly deleted_at: string | null;
}

/**
 * One row of `content.tree_rows(version)` — UI §3.3's whole outline in one round trip.
 *
 * Field-for-field the SQL function's `RETURNS TABLE`, because that function is the one
 * definition of the tree read (B §13: "ONE recursive CTE — not N+1 per level") and a second
 * shape here would be a second projection to keep in step. The route maps this onto API §2.5's
 * `TreeRow`; the mapping is in the route, once.
 */
export interface TreeRowRecord {
  readonly id: string;
  readonly node_kind: NodeKind;
  readonly parent_id: string | null;
  readonly sort_key: string;
  readonly depth: number;
  readonly ordinal: number;
  readonly ref: string | null;
  readonly label_key: string | null;
  readonly instruction_key: string | null;
  readonly title_key: string | null;
  readonly question_type: string | null;
  readonly required: boolean | null;
  readonly settings: JsonObject;
  readonly flags: JsonObject;
  readonly emits: readonly string[];
  readonly item_count: number;
  readonly child_count: number;
  readonly emit_count: number;
  readonly pii: boolean;
  readonly has_custom_js: boolean;
  readonly updated_at: string;
}

/**
 * Where a new sibling goes. NEVER a `sort_key`: API §3 item 6 — "a client never sees a
 * fractional key and cannot corrupt the ordering by inventing one".
 *
 * THREE STATES, and the difference between two of them is the reason `after_id` is nullable
 * rather than merely optional:
 *
 *   * `after_id: "<id>"` — immediately after that sibling.
 *   * `after_id: null` — FIRST. `content.next_sort_key`'s own meaning for a NULL anchor.
 *   * neither field — APPEND, at the end of the sibling set.
 *
 * Append is the default because "add a question" in an editor means "at the end", and a default
 * of "first" would make every new question land above the one before it — which is what happens
 * if the store passes an absent `after_id` straight through to the SQL function. The store
 * resolves absence to the last sibling's id, so the function still receives an anchor and there is
 * still exactly one definition of how a key is computed.
 *
 * `before_id` is resolved to an `after_id` by the store (the predecessor of that sibling), because
 * `content.next_sort_key` takes only an "after" and giving it a second parameter would be a second
 * definition of insertion position.
 */
export interface SiblingPosition {
  readonly after_id?: string | null;
  readonly before_id?: string;
}

export interface CreateNodeInput extends SiblingPosition {
  readonly survey_version_id: string;
  readonly node_kind: NodeKind;
  readonly parent_id: string | null;
  readonly ref?: string;
  readonly question_type?: string;
  readonly label_key?: string;
  readonly instruction_key?: string;
  readonly title_key?: string;
  readonly required?: boolean;
  readonly config?: JsonObject;
  readonly settings?: JsonObject;
  readonly flags?: JsonObject;
}

/**
 * A partial node edit. `question_type` is ABSENT and that is API §2.5's rule, not an oversight:
 * "changing `question_type` is rejected (delete and recreate — the emitted variables differ)".
 * A field the type cannot express is a field a route cannot forget to reject.
 */
export interface UpdateNodeInput {
  readonly ref?: string;
  readonly label_key?: string | null;
  readonly instruction_key?: string | null;
  readonly title_key?: string | null;
  readonly required?: boolean;
  readonly config?: JsonObject;
  readonly settings?: JsonObject;
  readonly flags?: JsonObject;
  readonly validation?: readonly JsonValue[];
  readonly masks?: readonly JsonValue[];
  readonly scripts?: JsonObject;
}

export interface MoveNodeInput extends SiblingPosition {
  readonly parent_id: string | null;
}

export interface CreateItemInput extends SiblingPosition {
  readonly item_kind: ItemKind;
  readonly ref: string;
  readonly code: number;
  readonly label_key?: string;
  readonly anchor?: string;
  readonly exclusive?: boolean;
  readonly behaviour?: JsonObject;
  readonly value_override?: string;
  readonly custom_class?: string;
  readonly meta?: JsonObject;
}

export interface UpdateItemInput {
  readonly ref?: string;
  readonly code?: number;
  readonly label_key?: string | null;
  readonly anchor?: string;
  readonly exclusive?: boolean;
  readonly behaviour?: JsonObject;
  readonly value_override?: string | null;
  readonly custom_class?: string | null;
  readonly meta?: JsonObject;
}

/** One row of the paste-60-brands body. Position is the array index; `code` is separate. */
export interface BulkItemInput {
  readonly ref: string;
  readonly code: number;
  readonly label_key?: string;
  readonly anchor?: string;
  readonly exclusive?: boolean;
  readonly behaviour?: JsonObject;
  readonly value_override?: string;
  readonly custom_class?: string;
  readonly meta?: JsonObject;
}

/** One `PUT /nodes/:id/cells` row, resolved from refs to item ids by the route. */
export interface CellInput {
  readonly row_item_id: string;
  readonly column_item_id?: string | null;
  readonly question_type: string;
  readonly config?: JsonObject;
  readonly use_columns?: boolean;
}

/**
 * One variable a question save wants to exist, id and all.
 *
 * The `id` is supplied by the CALLER, and that is the whole mechanism behind "renaming a ref
 * changes exactly the derived variable names and no id": the recompute matches the plugin's
 * declarations against the question's existing rows by schema's `variableSignature` and carries
 * the matched row's id forward. A store that minted ids here could not preserve one.
 */
export interface WriteVariableInput {
  readonly id: string;
  readonly name: string;
  readonly kind: VarKind;
  readonly vtype: VarType;
  readonly source_item_id: string | null;
  readonly source_part: JsonObject;
  readonly enum_domain: readonly EnumDomainEntryRow[] | null;
  readonly export_include: boolean;
  readonly export_column: string;
  readonly export_label_key: string | null;
  readonly pii: boolean;
  readonly persist: boolean;
}

/** What `replaceQuestionVariables` did, split the way API §2.5's response fields are. */
export interface VariableWriteResult {
  readonly created: readonly VariableRow[];
  readonly updated: readonly VariableRow[];
  /** Soft-deleted: the declaration set no longer contains them (an option was removed). */
  readonly removed: readonly VariableRow[];
}

/** What `duplicate` copied, plus the old→new id map the rule remap needs. */
export interface DuplicatedSubtree {
  readonly nodes: readonly NodeRow[];
  readonly items: readonly ItemRow[];
  readonly cells: readonly CellRow[];
  /** Old id → new id, for nodes AND items, so a rule inside the subtree can be rewritten. */
  readonly id_map: ReadonlyMap<string, string>;
}

/** One node of a subtree copy, as the route asks for it (refs are the route's suffix rule). */
export interface DuplicateNodeSpec {
  readonly id: string;
  readonly ref: string | null;
}

export interface DuplicateInput extends SiblingPosition {
  /** The subtree root. */
  readonly node_id: string;
  readonly into_parent_id?: string | null;
  /** Every node of the subtree with the ref its copy must carry — computed by the route. */
  readonly refs: readonly DuplicateNodeSpec[];
}

/**
 * The content tree: nodes, their items, their cells and the variables their questions emit.
 *
 * ONE repo rather than four, because the operations are not separable: creating a question
 * writes `content.nodes`, `content.variables` and `content.nodes.emits`; a bulk option paste
 * rewrites items and then the variables those items fan out into. Four repos would put the
 * ordering of those writes at four call sites.
 *
 * Every method is version-scoped through the row it names — never through an `orgId` argument
 * (this file's header rule) — and every write is subject to `content.tg_draft_only` plus the
 * programmer-floor write policies. As with `RedirectRepo`, nothing here re-tests the role or
 * the org in TypeScript: zero rows written is the policy declining, and the routes answer the
 * two states a caller can see (403 role, 409 frozen) before the store is reached.
 */
export interface NodeRepo {
  /**
   * `content.tree_rows(version)`. `null` when the version is not visible — a 404 upstream,
   * never an empty tree, for `RegistryRepo.forVersion`'s reason: an empty tree is a plausible
   * answer for a real version and would make a cross-tenant probe indistinguishable from a
   * survey with no content yet.
   */
  tree(versionId: string): Promise<readonly TreeRowRecord[] | null>;
  /** One live node. Soft-deleted rows are invisible here — `getDeleted` is the undo path. */
  get(nodeId: string): Promise<NodeRow | null>;
  /** One node INCLUDING a soft-deleted one, for `POST /nodes/:id/undelete`. */
  getDeleted(nodeId: string): Promise<NodeRow | null>;
  /** The node and every descendant, in document order. `includeDeleted` for the undo path. */
  subtree(nodeId: string, includeDeleted?: boolean): Promise<readonly NodeRow[]>;
  create(input: CreateNodeInput): Promise<NodeRow>;
  update(nodeId: string, patch: UpdateNodeInput): Promise<NodeRow>;
  /**
   * `content.move_node` — ONE `sort_key` write, and the two refusals an FK cannot express (a
   * node into its own subtree; C §5's nesting rules). The row count the function returns is
   * what P1-03's "one UPDATE per drag" criterion is measured on, so the store must not do the
   * move as a read-modify-write of the whole sibling set.
   */
  move(nodeId: string, input: MoveNodeInput): Promise<NodeRow>;
  /** Soft delete, the given ids (a subtree the route computed). Returns the rows as written. */
  softDelete(nodeIds: readonly string[]): Promise<readonly NodeRow[]>;
  undelete(nodeIds: readonly string[]): Promise<readonly NodeRow[]>;
  /** Copy a subtree with new ids. Rules are the ROUTE's job — see `DuplicatedSubtree.id_map`. */
  duplicate(input: DuplicateInput): Promise<DuplicatedSubtree>;

  listItems(nodeId: string, kind?: ItemKind): Promise<readonly ItemRow[]>;
  getItem(itemId: string): Promise<ItemRow | null>;
  createItem(nodeId: string, input: CreateItemInput): Promise<ItemRow>;
  updateItem(itemId: string, patch: UpdateItemInput): Promise<ItemRow>;
  /** `content.move_question_item` — one row, `code` untouched (C §5.1's whole point). */
  moveItem(itemId: string, position: SiblingPosition): Promise<ItemRow>;
  removeItem(itemId: string): Promise<void>;
  /**
   * `POST /nodes/:id/items:bulk`. Atomic (API §1.6's default): the whole set is validated and
   * written together, because a half-pasted brand list is a question that fails publish for a
   * reason the author did not cause.
   */
  bulkItems(
    nodeId: string,
    kind: ItemKind,
    mode: 'replace' | 'append',
    items: readonly BulkItemInput[],
  ): Promise<readonly ItemRow[]>;

  listCells(nodeId: string): Promise<readonly CellRow[]>;
  /** Whole-set replace — PUT semantics, for the reason `replaceRedirects` gives. */
  replaceCells(nodeId: string, cells: readonly CellInput[]): Promise<readonly CellRow[]>;

  /** The variables one question emits, live rows only, in manifest order. */
  listVariables(nodeId: string): Promise<readonly VariableRow[]>;
  /**
   * Make the question's emitted variables exactly these rows, and rewrite `nodes.emits`.
   *
   * The plugin's `declareVariables` is the authority on the set (F §1, ADR-007) and the caller
   * has already resolved ids by signature, so this method is deliberately dumb: upsert what it
   * is given, soft-delete the question's other variables, store the id list on the node.
   */
  replaceQuestionVariables(
    nodeId: string,
    rows: readonly WriteVariableInput[],
  ): Promise<VariableWriteResult>;

  /**
   * Every live rule that TARGETS or DEPENDS ON any of these nodes/items.
   *
   * The delete path's `rules_affected` and the duplicate path's "rules within the subtree
   * remapped, rules pointing *into* it not copied" are the same question asked twice, so it is
   * one read: `rules_target_node_idx` plus the two `depends_on_*` GIN indexes (DB §4.4).
   */
  rulesTouching(
    versionId: string,
    nodeIds: readonly string[],
    itemIds: readonly string[],
  ): Promise<readonly RuleRow[]>;
}

/** The bundle a route handler receives. One object so adding a repo is not 40 signatures. */
export interface Repos {
  readonly nodes: NodeRepo;
  readonly registry: RegistryRepo;
  readonly rules: RuleRepo;
  readonly redirects: RedirectRepo;
  readonly vendors: VendorRepo;
  readonly i18n: I18nRepo;
  readonly exports: ExportRepo;
  readonly fieldStats: FieldStatsRepo;
  readonly orgs: OrgRepo;
  readonly members: MemberRepo;
  readonly invitations: InvitationRepo;
  readonly projects: ProjectRepo;
  readonly surveys: SurveyRepo;
  readonly jobs: JobRepo;
  readonly audit: AuditRepo;
  readonly idempotency: IdempotencyStore;
}
