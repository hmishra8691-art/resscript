/**
 * `InMemoryRepo` — the implementation the test suite runs against.
 *
 * WHY it exists: Supabase is not running in this container, and a route-handler suite that
 * needs Postgres is a suite nobody runs. But an in-memory store that is merely a `Map` would
 * let the tests pass while the real system fails, so this file reproduces the parts of
 * `db/migrations/0004_tenancy/up.sql` that the API's behaviour depends on:
 *
 *  - every read is filtered to `app.current_org()` and returns ZERO ROWS across a tenant
 *    boundary rather than raising (P1-01 acceptance: an error is an oracle);
 *  - `app.can_see_project()`, including K §1's inversion for `client` (empty `project_ids`
 *    means org-wide for staff roles and NOTHING for a client);
 *  - `invitations_role_not_owner` and `members_insert`'s `role <> 'owner'`;
 *  - the deferred `org_has_owner` trigger;
 *  - `sv_one_draft`, and `tg_version_guard`'s `revision := OLD.revision + 1`.
 *
 * Where a constraint is reproduced, the constraint's name is in the thrown error so a failing
 * test names the same thing a failing `INSERT` would.
 */

import { prefixedId } from '@resscript/observability';
import { roleRank } from '@resscript/schema';
import type { JsonObject, OrgRole, VersionStatus } from '@resscript/schema';
import type {
  AuditEventInput,
  AuditRepo,
  AuditRow,
  CreateExportInput,
  DispositionCount,
  EnqueueJobInput,
  EnqueuedJob,
  ExportRepo,
  ExportRow,
  FieldStatsRepo,
  CreateInvitationInput,
  CreateOrganizationInput,
  CreateProjectInput,
  CreateSurveyInput,
  CreateVersionInput,
  I18nRepo,
  I18nStringRow,
  IdempotencyRecord,
  IdempotencyStore,
  InvitationRepo,
  InvitationRow,
  JobRepo,
  JobRow,
  LanguageRow,
  ListProjectsQuery,
  ListSurveysQuery,
  MemberRepo,
  MemberRow,
  MembershipSummary,
  OrganizationRow,
  OrgRepo,
  PageQuery,
  PageResult,
  ProjectRepo,
  ProjectRow,
  CreateRuleInput,
  ListRulesQuery,
  RedirectRepo,
  RedirectRow,
  RegistryRepo,
  Repos,
  RollbackResult,
  RuleRepo,
  RuleRow,
  UpdateRuleInput,
  SurveyRepo,
  SurveyRow,
  SurveyVersionRow,
  UpdateMemberInput,
  UpdateOrganizationInput,
  UpdateProjectInput,
  UpdateSurveyInput,
  UpdateVersionInput,
  UpsertStringInput,
  VersionRegistryRows,
} from './types.js';

/**
 * A constraint the database would have enforced. Carries the constraint or policy name so the
 * API layer can map it to the right envelope code (`already_exists`, `validation_failed`, …)
 * the same way it maps a PostgREST error.
 */
export class StoreConstraintError extends Error {
  constructor(
    readonly constraint: string,
    message: string,
  ) {
    super(message);
    this.name = 'StoreConstraintError';
  }
}

export interface Actor {
  readonly userId: string;
  /** From `app_metadata.active_org_id`. Never from a request parameter. */
  readonly activeOrgId: string | null;
}

/** One row of `content.redirects`: the wire shape plus the columns the wire omits. */
export interface MemoryRedirectRow extends RedirectRow {
  readonly survey_version_id: string;
  readonly org_id: string;
}

/** One row of `content.logic_rules`: the wire shape plus `org_id` and the soft-delete column. */
export interface MemoryRuleRow extends RuleRow {
  readonly org_id: string;
  readonly deleted_at: string | null;
}

/** `content.languages`: the wire shape plus the columns the wire omits. */
export interface MemoryLanguageRow extends LanguageRow {
  readonly survey_version_id: string;
  readonly org_id: string;
}

/** `content.i18n_strings`, same treatment. Mutable: an upsert edits value and state in place. */
export interface MemoryStringRow {
  readonly survey_version_id: string;
  readonly org_id: string;
  readonly lang: string;
  readonly key: string;
  value: string | null;
  state: I18nStringRow['state'];
}

/** One live row of `app.capability_grants`, reduced to what `app.has_capability` reads. */
export interface MemoryCapabilityGrant {
  readonly org_id: string;
  readonly user_id: string;
  readonly capability: 'pii_access' | 'custom_code';
}

/** One row of `app.exports`, plus the org the wire omits. Mutable: the worker advances it. */
export interface MemoryExportRow extends ExportRow {
  readonly org_id: string;
}

/**
 * `runtime.sessions`, reduced to the four columns `app.field_stats` groups over. Modelled here
 * even though `authoring` cannot read the real table (ADR-001's plane boundary) for the same
 * reason `tokens` is: 0013's counter is a definer function crossing that boundary, and a store
 * with no sessions would make "is_test excluded by default" an untestable sentence.
 */
export interface MemorySessionRow {
  readonly survey_version_id: string;
  readonly org_id: string;
  readonly is_test: boolean;
  /** `null` while the session is in flight — the function returns it as `'IN_PROGRESS'`. */
  readonly disposition: string | null;
}

/** One live row of `runtime.survey_tokens`. `tokens_live_key`: one per (survey, is_test). */
export interface MemoryTokenRow {
  token: string;
  org_id: string;
  survey_id: string;
  survey_version_id: string;
  artifact_hash: string;
  status: VersionStatus;
  is_test: boolean;
  revoked_at: string | null;
}

interface MemberRecord {
  org_id: string;
  user_id: string;
  role: OrgRole;
  project_ids: string[];
  invited_by: string | null;
  created_at: string;
  updated_at: string;
  email: string | null;
}

/**
 * Mutable twin of `InvitationRow`, plus the column the API never returns. Spelled out rather
 * than `Omit<InvitationRow, …>` because the row type is `readonly` end to end — which is what
 * stops a route handler mutating a row it read, and is worth more than the brevity here.
 */
interface InvitationRecord {
  id: string;
  org_id: string;
  email: string;
  role: OrgRole;
  project_ids: string[];
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
  invited_by: string;
  expires_at: string;
  accepted_at: string | null;
  accepted_by: string | null;
  created_at: string;
  /** Never returned by any repo method. `toInvitationRow` drops it. */
  token_hash: string;
}

/**
 * The shared mutable store. One per test (or per seeded fixture): construct it, hand it to as
 * many `InMemoryRepos` as there are actors, and the actors see each other's writes exactly as
 * two API requests against one database would.
 */
export class MemoryDataset {
  readonly organizations: OrganizationRow[] = [];
  readonly members: MemberRecord[] = [];
  readonly invitations: InvitationRecord[] = [];
  readonly projects: ProjectRow[] = [];
  readonly surveys: SurveyRow[] = [];
  readonly versions: SurveyVersionRow[] = [];
  readonly jobs: JobRow[] = [];
  /**
   * `runtime.survey_tokens`, reduced to what the control plane can observe.
   *
   * Modelled here even though `authoring` cannot read the real table (ADR-001's plane boundary:
   * schema `runtime` carries no USAGE for it), because `app.rollback_version` writes it in the
   * same transaction as the status flip and a rollback that moved the status without repointing
   * the URL is the exact bug 0009 exists to make impossible. A store that dropped the token would
   * let a route test assert the visible half of rollback and miss the half a respondent sees.
   */
  readonly tokens: MemoryTokenRow[] = [];
  readonly audit: AuditRow[] = [];
  readonly idempotency: IdempotencyRecord[] = [];
  /**
   * `content.variables` + `content.nodes` + `content.question_items`, per version.
   *
   * Held as the projected rows the `RegistryRepo` returns rather than as three full tables: the
   * content model's own routes are P1-03's, not this milestone's, and a half-modelled
   * `content.nodes` here would be a second definition of the tree that P1-03 then has to
   * reconcile. What the DSL endpoints need is the registry, and this is exactly that.
   */
  readonly registries: VersionRegistryRows[] = [];
  /**
   * `content.redirects` (0010), held as the flattened wire rows plus the two columns the wire
   * omits (`survey_version_id`, `org_id`). Flattened here as in the table, because the API's
   * whole reason for the shape — "is every disposition covered is a join, not a JSONB walk" —
   * is only testable against a store that holds rows rather than a reassembled map.
   */
  readonly redirects: MemoryRedirectRow[] = [];
  /**
   * `content.logic_rules` (0007 §4.4), one row per rule with the two dependency-closure arrays
   * the GIN indexes serve. Held as full rows — unlike the registry above, the rules routes ARE
   * this milestone's (P1-12), so the store models the columns the filters actually read.
   */
  readonly rules: MemoryRuleRow[] = [];
  /** `content.languages` + `content.i18n_strings` (0007 §8), the translation surface. */
  readonly languages: MemoryLanguageRow[] = [];
  readonly strings: MemoryStringRow[] = [];
  /** `app.capability_grants`, reduced to what `app.has_capability` reads (K §1). */
  readonly capabilities: MemoryCapabilityGrant[] = [];
  /** `app.exports` (0012). */
  readonly exports: MemoryExportRow[] = [];
  /** `runtime.sessions`, reduced to what `app.field_stats` (0013) groups over. */
  readonly sessions: MemorySessionRow[] = [];
  /**
   * What each `enqueue` was HANDED, kept beside the job rows because `JobRow` deliberately
   * omits `payload` (`app.get_job` never returns it — a compile payload can carry survey
   * content). A suite asserting "the route enqueued the right payload" reads it here, the way
   * it would read `ops.jobs.payload` with a superuser psql.
   */
  readonly enqueuedPayloads: { readonly job_id: string; readonly kind: string; readonly payload: JsonObject }[] = [];

  /**
   * Monotonic clock so `created_at DESC, id DESC` ordering is deterministic in tests.
   *
   * The BASE comes from the injected clock — the same one the request context reads — because
   * the API's `412` body filters audit rows by `created_at > <the timestamp in the client's
   * ETag>`. Two independent clocks in the fixture would make that filter drop rows for reasons
   * that have nothing to do with the code under test.
   */
  private tick = 0;
  private readonly clock: () => number;

  constructor(options: { readonly now?: () => number } = {}) {
    this.clock = options.now ?? ((): number => Date.UTC(2026, 7, 20, 12, 0, 0, 0));
  }

  now(): string {
    // One millisecond per write keeps the ordering strict without needing a real clock.
    this.tick += 1;
    return new Date(this.clock() + this.tick).toISOString();
  }

  id(prefix: string): string {
    this.tick += 1;
    return prefixedId(prefix);
  }

  seedOrg(input: {
    id?: string;
    slug: string;
    name: string;
    ownerUserId: string;
    settings?: JsonObject;
  }): OrganizationRow {
    const at = this.now();
    const org: OrganizationRow = {
      id: input.id ?? this.id('org'),
      slug: input.slug,
      name: input.name,
      data_region: 'eu-west-1',
      settings: input.settings ?? {},
      sso_domain: null,
      created_at: at,
      updated_at: at,
      suspended_at: null,
      deleted_at: null,
    };
    this.organizations.push(org);
    this.members.push({
      org_id: org.id,
      user_id: input.ownerUserId,
      role: 'owner',
      project_ids: [],
      invited_by: null,
      created_at: at,
      updated_at: at,
      email: null,
    });
    return org;
  }

  seedMember(input: {
    orgId: string;
    userId: string;
    role: OrgRole;
    projectIds?: readonly string[];
    email?: string;
  }): MemberRow {
    const at = this.now();
    const record: MemberRecord = {
      org_id: input.orgId,
      user_id: input.userId,
      role: input.role,
      project_ids: [...(input.projectIds ?? [])],
      invited_by: null,
      created_at: at,
      updated_at: at,
      email: input.email ?? null,
    };
    this.members.push(record);
    return toMemberRow(record);
  }

  seedProject(input: { orgId: string; ref: string; name: string; createdBy: string; id?: string }): ProjectRow {
    const at = this.now();
    const row: ProjectRow = {
      id: input.id ?? this.id('prj'),
      org_id: input.orgId,
      ref: input.ref,
      name: input.name,
      client_name: null,
      tags: [],
      field_start: null,
      field_end: null,
      created_by: input.createdBy,
      created_at: at,
      updated_at: at,
      archived_at: null,
    };
    this.projects.push(row);
    return row;
  }

  seedSurvey(input: {
    orgId: string;
    projectId: string;
    ref: string;
    name: string;
    createdBy: string;
    id?: string;
  }): { survey: SurveyRow; draft: SurveyVersionRow } {
    const at = this.now();
    const survey: SurveyRow = {
      id: input.id ?? this.id('svy'),
      org_id: input.orgId,
      project_id: input.projectId,
      ref: input.ref,
      name: input.name,
      description: null,
      survey_kind: 'standard',
      parent_survey_id: null,
      default_language: 'en',
      theme_id: null,
      created_by: input.createdBy,
      created_at: at,
      updated_at: at,
      archived_at: null,
    };
    this.surveys.push(survey);
    const draft = this.insertVersion({
      orgId: input.orgId,
      surveyId: survey.id,
      versionNo: 1,
      createdBy: input.createdBy,
    });
    return { survey, draft };
  }

  insertVersion(input: {
    orgId: string;
    surveyId: string;
    versionNo: number;
    createdBy: string;
    clonedFrom?: string;
    notes?: string;
    id?: string;
  }): SurveyVersionRow {
    // `sv_one_draft`: one editable draft per survey, expressed as a partial unique index
    // precisely because two concurrent "clone a draft" requests would otherwise both succeed.
    if (this.versions.some((v) => v.survey_id === input.surveyId && v.status === 'draft')) {
      throw new StoreConstraintError('sv_one_draft', 'a draft version already exists for this survey');
    }
    const at = this.now();
    const row: SurveyVersionRow = {
      id: input.id ?? this.id('ver'),
      org_id: input.orgId,
      survey_id: input.surveyId,
      version_no: input.versionNo,
      status: 'draft',
      compile_state: 'none',
      artifact_hash: null,
      artifact_bytes: null,
      schema_version: 1,
      revision: 1,
      compile_diagnostics: [],
      acknowledged_warnings: [],
      entitlement_reqs: [],
      notes: input.notes ?? null,
      created_by: input.createdBy,
      created_at: at,
      updated_at: at,
      frozen_at: null,
      published_at: null,
      archived_at: null,
      cloned_from_version_id: input.clonedFrom ?? null,
    };
    this.versions.push(row);
    return row;
  }

  /**
   * A version in a NON-draft state, for the publish and rollback suites.
   *
   * Separate from `insertVersion` because that one reproduces `sv_insert`'s WITH CHECK ("a new
   * version is always born a draft") and `sv_one_draft`, both of which are correct and both of
   * which make an already-published version unrepresentable. A fixture needs one: rollback is
   * `archived → production`, so it cannot be reached from a draft by any legal transition
   * (`app.tg_version_guard` permits draft→review, draft→staging, review→staging,
   * staging→production, staging→archived, review→archived, production→archived and
   * archived→production, and nothing else). Enforces `sv_one_production` and
   * `sv_compiled_needs_artifact` so a fixture cannot seed a state the database refuses.
   */
  seedVersionAt(input: {
    orgId: string;
    surveyId: string;
    versionNo: number;
    createdBy: string;
    status: VersionStatus;
    compileState?: 'none' | 'compiling' | 'compiled' | 'failed';
    artifactHash?: string;
    artifactBytes?: number;
    id?: string;
  }): SurveyVersionRow {
    const compileState = input.compileState ?? (input.status === 'draft' ? 'none' : 'compiled');
    const hash = input.artifactHash ?? (compileState === 'compiled' ? sha256Fixture(input.versionNo) : null);
    if (compileState === 'compiled' && hash === null) {
      throw new StoreConstraintError('sv_compiled_needs_artifact', 'compiled without an artifact');
    }
    if (
      input.status === 'production' &&
      this.versions.some((v) => v.survey_id === input.surveyId && v.status === 'production')
    ) {
      throw new StoreConstraintError('sv_one_production', 'a production version already exists');
    }
    const at = this.now();
    const row: SurveyVersionRow = {
      id: input.id ?? this.id('ver'),
      org_id: input.orgId,
      survey_id: input.surveyId,
      version_no: input.versionNo,
      status: input.status,
      compile_state: compileState,
      artifact_hash: hash,
      artifact_bytes: input.artifactBytes ?? (hash === null ? null : 4096),
      schema_version: 1,
      revision: 1,
      compile_diagnostics: [],
      acknowledged_warnings: [],
      entitlement_reqs: [],
      notes: null,
      created_by: input.createdBy,
      created_at: at,
      updated_at: at,
      frozen_at: input.status === 'draft' ? null : at,
      published_at: input.status === 'production' ? at : null,
      archived_at: null,
      cloned_from_version_id: null,
    };
    this.versions.push(row);
    return row;
  }

  /** A live token, as `runtime.upsert_survey_token` would have written it at publish time. */
  seedToken(input: {
    token: string;
    orgId: string;
    surveyId: string;
    versionId: string;
    artifactHash: string;
    status: VersionStatus;
    isTest?: boolean;
  }): MemoryTokenRow {
    const row: MemoryTokenRow = {
      token: input.token,
      org_id: input.orgId,
      survey_id: input.surveyId,
      survey_version_id: input.versionId,
      artifact_hash: input.artifactHash,
      status: input.status,
      is_test: input.isTest ?? false,
      revoked_at: null,
    };
    this.tokens.push(row);
    return row;
  }

  /** One `content.logic_rules` row, as `POST /versions/:id/rules` would have written it. */
  seedRule(
    input: Partial<MemoryRuleRow> & {
      readonly org_id: string;
      readonly survey_version_id: string;
      readonly kind: RuleRow['kind'];
      readonly condition: JsonObject;
      readonly effect: JsonObject;
    },
  ): MemoryRuleRow {
    const at = this.now();
    const row: MemoryRuleRow = {
      id: input.id ?? this.id('rul'),
      survey_version_id: input.survey_version_id,
      org_id: input.org_id,
      kind: input.kind,
      target_kind: input.target_kind ?? 'node',
      target_node_id: input.target_node_id ?? null,
      target_item_id: input.target_item_id ?? null,
      target_variable_id: input.target_variable_id ?? null,
      condition: input.condition,
      effect: input.effect,
      evaluation: input.evaluation ?? 'on_change',
      authored_in: input.authored_in ?? 'visual',
      trivia: input.trivia ?? {},
      notes: input.notes ?? null,
      depends_on_variable_ids: input.depends_on_variable_ids ?? [],
      depends_on_node_ids: input.depends_on_node_ids ?? [],
      sort_key: input.sort_key ?? `r${String(this.rules.length).padStart(4, '0')}`,
      created_at: input.created_at ?? at,
      updated_at: input.updated_at ?? at,
      deleted_at: input.deleted_at ?? null,
    };
    this.rules.push(row);
    return row;
  }

  /** Attach a variable registry to a version, for the `/v1/dsl/*` suite. */
  seedRegistry(rows: VersionRegistryRows): VersionRegistryRows {
    const index = this.registries.findIndex((r) => r.survey_version_id === rows.survey_version_id);
    if (index >= 0) this.registries[index] = rows;
    else this.registries.push(rows);
    return rows;
  }

  seedJob(input: Partial<JobRow> & { id: string; org_id: string; kind: string }): JobRow {
    const at = this.now();
    const row: JobRow = {
      id: input.id,
      org_id: input.org_id,
      project_id: input.project_id ?? null,
      survey_version_id: input.survey_version_id ?? null,
      kind: input.kind,
      status: input.status ?? 'running',
      progress: input.progress ?? null,
      result: input.result ?? null,
      error: input.error ?? null,
      attempts: input.attempts ?? 1,
      max_attempts: input.max_attempts ?? 3,
      idempotency_key: input.idempotency_key ?? null,
      created_by: input.created_by ?? null,
      created_at: input.created_at ?? at,
      started_at: input.started_at ?? at,
      finished_at: input.finished_at ?? null,
      heartbeat_at: input.heartbeat_at ?? at,
    };
    this.jobs.push(row);
    return row;
  }

  /** One `content.languages` row. `languages_one_base` is enforced so a fixture cannot lie. */
  seedLanguage(input: {
    versionId: string;
    orgId: string;
    lang: string;
    isBase?: boolean;
    rtl?: boolean;
    onMissing?: string;
    blockPublishIfIncomplete?: boolean;
  }): MemoryLanguageRow {
    if (
      input.isBase === true &&
      this.languages.some((l) => l.survey_version_id === input.versionId && l.is_base)
    ) {
      throw new StoreConstraintError('languages_one_base', 'a base language already exists');
    }
    const row: MemoryLanguageRow = {
      survey_version_id: input.versionId,
      org_id: input.orgId,
      lang: input.lang,
      is_base: input.isBase ?? false,
      rtl: input.rtl ?? false,
      on_missing: input.onMissing ?? 'fallback_to_base',
      block_publish_if_incomplete: input.blockPublishIfIncomplete ?? true,
    };
    this.languages.push(row);
    return row;
  }

  /** One `content.i18n_strings` row. Reproduces `i18n_missing_has_no_value`. */
  seedString(input: {
    versionId: string;
    orgId: string;
    lang: string;
    key: string;
    value?: string | null;
    state?: I18nStringRow['state'];
  }): MemoryStringRow {
    const state = input.state ?? (input.value == null ? 'missing' : 'translated');
    const value = input.value ?? null;
    if (state === 'missing' && value !== null && value !== '') {
      throw new StoreConstraintError('i18n_missing_has_no_value', 'a missing string has no value');
    }
    const row: MemoryStringRow = {
      survey_version_id: input.versionId,
      org_id: input.orgId,
      lang: input.lang,
      key: input.key,
      value: state === 'missing' ? null : value,
      state,
    };
    this.strings.push(row);
    return row;
  }

  /** One live `app.capability_grants` row (K §1's explicit grants, never rank). */
  seedCapability(input: MemoryCapabilityGrant): MemoryCapabilityGrant {
    this.capabilities.push(input);
    return input;
  }

  /** One `runtime.sessions` row, reduced to what `app.field_stats` reads. */
  seedSession(input: {
    versionId: string;
    orgId: string;
    disposition?: string | null;
    isTest?: boolean;
  }): MemorySessionRow {
    const row: MemorySessionRow = {
      survey_version_id: input.versionId,
      org_id: input.orgId,
      is_test: input.isTest ?? false,
      disposition: input.disposition ?? null,
    };
    this.sessions.push(row);
    return row;
  }

  /**
   * `app.has_capability()`: a live grant AND, for pii_access, the org setting — the function's
   * own conjunction (0004), reproduced so 0012's trigger emulation refuses for the same two
   * independent reasons the real one does. NO `has_role()` call, deliberately (K §1).
   */
  hasCapability(orgId: string, userId: string, capability: MemoryCapabilityGrant['capability']): boolean {
    const granted = this.capabilities.some(
      (c) => c.org_id === orgId && c.user_id === userId && c.capability === capability,
    );
    if (!granted) return false;
    if (capability !== 'pii_access') return true;
    const org = this.organizations.find((o) => o.id === orgId);
    return org?.settings['pii_exports_enabled'] === true;
  }

  /** `app.tg_org_has_owner()`: a live org must retain at least one owner. */
  assertOrgHasOwner(orgId: string): void {
    const org = this.organizations.find((o) => o.id === orgId);
    if (org === undefined || org.deleted_at !== null) return;
    if (!this.members.some((m) => m.org_id === orgId && m.role === 'owner')) {
      throw new StoreConstraintError(
        'org_has_owner',
        `organization ${orgId} must retain at least one owner`,
      );
    }
  }
}

/**
 * A deterministic, distinct sha256-shaped string per version number.
 *
 * Deterministic because the rollback assertion is a HASH COMPARISON — "the runtime serves
 * byte-identical bytes to what was live before, verified by hash comparison in the test" — and a
 * random fixture hash would make that assertion pass for the wrong reason on a store that
 * recomputed it.
 */
function sha256Fixture(versionNo: number): string {
  return String(versionNo).padStart(4, '0').repeat(16);
}

function toMemberRow(record: MemberRecord): MemberRow {
  return {
    org_id: record.org_id,
    user_id: record.user_id,
    role: record.role,
    project_ids: [...record.project_ids],
    invited_by: record.invited_by,
    created_at: record.created_at,
    updated_at: record.updated_at,
    email: record.email,
  };
}

/** Strip the columns the wire omits (`org_id`, `deleted_at`); copy the arrays so a route cannot mutate the store. */
function toRuleRow(record: MemoryRuleRow): RuleRow {
  const { org_id: _org, deleted_at: _deleted, ...rest } = record;
  return {
    ...rest,
    depends_on_variable_ids: [...record.depends_on_variable_ids],
    depends_on_node_ids: [...record.depends_on_node_ids],
  };
}

/** `rules_one_target`: the target kind and exactly the matching id column, biconditionally. */
function assertOneTarget(
  kind: RuleRow['target_kind'],
  nodeId: string | null,
  itemId: string | null,
  variableId: string | null,
): void {
  const ok =
    (kind === 'node') === (nodeId !== null) &&
    (kind === 'item') === (itemId !== null) &&
    (kind === 'variable') === (variableId !== null);
  if (!ok) {
    throw new StoreConstraintError('rules_one_target', 'target kind and target id disagree');
  }
}

function toInvitationRow(record: InvitationRecord): InvitationRow {
  const { token_hash: _tokenHash, ...rest } = record;
  return { ...rest, project_ids: [...record.project_ids] };
}

/**
 * `(created_at DESC, id DESC)` — the fixed sort of every collection in API §1.3, and the
 * shape of `projects_recent_idx` / `audit_org_time_idx`. Keyset, never offset: these
 * collections are appended to while being read, and with offset a new row at the head shifts
 * every later page so the client silently skips records.
 *
 * `key` is explicit because not every collection's identity column is called `id` —
 * `app.org_members` is keyed `(org_id, user_id)`.
 */
function paginate<T>(
  rows: readonly T[],
  query: PageQuery,
  key: (row: T) => { readonly created_at: string; readonly id: string },
): PageResult<T> {
  const sorted = [...rows].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    if (ka.created_at !== kb.created_at) return ka.created_at < kb.created_at ? 1 : -1;
    return ka.id < kb.id ? 1 : -1;
  });
  const after = query.after;
  const start =
    after === undefined
      ? 0
      : sorted.findIndex((row) => {
          const k = key(row);
          return (
            k.created_at < after.created_at ||
            (k.created_at === after.created_at && k.id < after.id)
          );
        });
  const from = start === -1 ? sorted.length : start;
  const window = sorted.slice(from, from + query.limit + 1);
  return {
    rows: window.slice(0, query.limit),
    hasMore: window.length > query.limit,
  };
}

/** Identity key for the row types whose primary key is literally `id`. */
function idKey(row: { readonly created_at: string; readonly id: string }): {
  readonly created_at: string;
  readonly id: string;
} {
  return row;
}

class InMemoryRepos implements Repos {
  constructor(
    private readonly data: MemoryDataset,
    private readonly actor: Actor,
  ) {}

  /* --- RLS emulation ---------------------------------------------------- */

  private membership(): MemberRecord | undefined {
    const org = this.actor.activeOrgId;
    if (org === null) return undefined;
    // A forged `active_org_id` with no matching membership row lands here as `undefined`,
    // which every read below turns into zero rows — never an error.
    return this.data.members.find((m) => m.org_id === org && m.user_id === this.actor.userId);
  }

  /** `app.can_see_project()`, including K §1's client inversion. */
  private canSeeProject(projectId: string): boolean {
    const m = this.membership();
    if (m === undefined) return false;
    if (m.role === 'client') return m.project_ids.includes(projectId);
    return m.project_ids.length === 0 || m.project_ids.includes(projectId);
  }

  /**
   * `app.has_role()`, reading the MEMBERSHIP ROW.
   *
   * The store's own check, not the route's. `requireRole` in `src/server/auth.ts` is the API's
   * message-producing guard; this is the one the definer functions make, and having both is the
   * point — 0009's `publish_version` and `rollback_version` refuse a caller the API let through,
   * so a store that trusted the route would let a test prove a floor the database does not have.
   */
  private hasRole(minimum: OrgRole): boolean {
    const m = this.membership();
    return m !== undefined && roleRank(m.role) >= roleRank(minimum);
  }

  private orgScoped<T extends { org_id: string }>(rows: readonly T[]): readonly T[] {
    const org = this.actor.activeOrgId;
    if (org === null || this.membership() === undefined) return [];
    return rows.filter((r) => r.org_id === org);
  }

  /* --- orgs ------------------------------------------------------------- */

  readonly orgs: OrgRepo = {
    listMine: async (): Promise<readonly MembershipSummary[]> =>
      this.data.members
        .filter((m) => m.user_id === this.actor.userId)
        .map((m) => ({
          org_id: m.org_id,
          role: m.role,
          // `organizations_select` only shows the ACTIVE org — see MembershipSummary's comment.
          organization:
            m.org_id === this.actor.activeOrgId
              ? this.data.organizations.find((o) => o.id === m.org_id && o.deleted_at === null) ?? null
              : null,
        })),

    getActive: async (): Promise<OrganizationRow | null> => {
      const rows = this.orgScoped(this.data.organizations.map((o) => ({ ...o, org_id: o.id })));
      const found = rows[0];
      if (found === undefined || found.deleted_at !== null) return null;
      const { org_id: _orgId, ...org } = found;
      return org;
    },

    create: async (input: CreateOrganizationInput): Promise<OrganizationRow> => {
      // `app.create_organization`: inserts the org AND the caller as `owner` in one
      // transaction, which is how the deferred org_has_owner trigger is satisfiable at all.
      if (this.data.organizations.some((o) => o.slug === input.slug && o.deleted_at === null)) {
        throw new StoreConstraintError('org_slug_key', `slug ${input.slug} is taken`);
      }
      if (!/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(input.slug)) {
        throw new StoreConstraintError('org_slug_fmt', `slug ${input.slug} is malformed`);
      }
      const org = this.data.seedOrg({
        slug: input.slug,
        name: input.name,
        ownerUserId: this.actor.userId,
      });
      return input.data_region === undefined ? org : { ...org, data_region: input.data_region };
    },

    updateActive: async (input: UpdateOrganizationInput): Promise<OrganizationRow> => {
      const org = await this.orgs.getActive();
      if (org === null) throw new StoreConstraintError('organizations_update', 'no rows updated');
      const index = this.data.organizations.findIndex((o) => o.id === org.id);
      const next: OrganizationRow = {
        ...org,
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.settings === undefined ? {} : { settings: input.settings }),
        updated_at: this.data.now(),
      };
      this.data.organizations[index] = next;
      return next;
    },
  };

  /* --- members ---------------------------------------------------------- */

  readonly members: MemberRepo = {
    list: async (query: PageQuery): Promise<PageResult<MemberRow>> =>
      paginate(this.orgScoped(this.data.members).map(toMemberRow), query, (m) => ({
        created_at: m.created_at,
        // `app.org_members` is keyed (org_id, user_id); user_id is the cursor's tiebreaker.
        id: m.user_id,
      })),

    get: async (userId: string): Promise<MemberRow | null> => {
      const found = this.orgScoped(this.data.members).find((m) => m.user_id === userId);
      return found === undefined ? null : toMemberRow(found);
    },

    roleInOrg: async (orgId: string, userId: string): Promise<OrgRole | null> => {
      // `members_select` shows your OWN row in every org you belong to, which is exactly
      // what an org switch needs to verify before re-minting a token.
      if (userId !== this.actor.userId) {
        const m = this.orgScoped(this.data.members).find((x) => x.user_id === userId);
        return m === undefined ? null : m.role;
      }
      const own = this.data.members.find((m) => m.org_id === orgId && m.user_id === userId);
      return own === undefined ? null : own.role;
    },

    update: async (userId: string, input: UpdateMemberInput): Promise<MemberRow> => {
      const index = this.data.members.findIndex(
        (m) => m.org_id === this.actor.activeOrgId && m.user_id === userId,
      );
      const current = index === -1 ? undefined : this.data.members[index];
      if (current === undefined || this.membership() === undefined) {
        throw new StoreConstraintError('members_update', 'no rows updated');
      }
      // `members_update` carries `role <> 'owner'` in BOTH USING and WITH CHECK: an admin can
      // neither demote an owner nor promote anyone (including themselves) to owner.
      if (current.role === 'owner' || input.role === 'owner') {
        throw new StoreConstraintError('members_update', 'no rows updated');
      }
      if (input.role === 'client' && (input.project_ids ?? current.project_ids).length === 0) {
        throw new StoreConstraintError(
          'members_client_must_be_scoped',
          'a client member must be scoped to at least one project',
        );
      }
      if (input.role !== undefined) current.role = input.role;
      if (input.project_ids !== undefined) current.project_ids = [...input.project_ids];
      current.updated_at = this.data.now();
      this.data.assertOrgHasOwner(current.org_id);
      return toMemberRow(current);
    },

    remove: async (userId: string): Promise<void> => {
      const index = this.data.members.findIndex(
        (m) => m.org_id === this.actor.activeOrgId && m.user_id === userId,
      );
      const current = index === -1 ? undefined : this.data.members[index];
      if (current === undefined || this.membership() === undefined) {
        throw new StoreConstraintError('members_delete', 'no rows deleted');
      }
      if (current.role === 'owner') {
        throw new StoreConstraintError('members_delete', 'no rows deleted');
      }
      this.data.members.splice(index, 1);
      this.data.assertOrgHasOwner(current.org_id);
    },

    insert: async (input: {
      readonly org_id: string;
      readonly user_id: string;
      readonly role: OrgRole;
      readonly project_ids: readonly string[];
      readonly invited_by: string | null;
    }): Promise<MemberRow> => {
      // `members_insert`: `WITH CHECK (… AND role <> 'owner')`. There is no path to ownership
      // that does not go through app.create_organization or an audited transfer.
      if (input.role === 'owner') {
        throw new StoreConstraintError(
          'members_insert',
          'an owner cannot be created by insert; use create_organization or an audited transfer',
        );
      }
      if (input.role === 'client' && input.project_ids.length === 0) {
        throw new StoreConstraintError(
          'members_client_must_be_scoped',
          'a client member must be scoped to at least one project',
        );
      }
      if (
        this.data.members.some((m) => m.org_id === input.org_id && m.user_id === input.user_id)
      ) {
        throw new StoreConstraintError('org_members_pkey', 'already a member of this organization');
      }
      const at = this.data.now();
      const record: MemberRecord = {
        org_id: input.org_id,
        user_id: input.user_id,
        role: input.role,
        project_ids: [...input.project_ids],
        invited_by: input.invited_by,
        created_at: at,
        updated_at: at,
        email: null,
      };
      this.data.members.push(record);
      return toMemberRow(record);
    },
  };

  /* --- invitations ------------------------------------------------------ */

  readonly invitations: InvitationRepo = {
    list: async (query: PageQuery): Promise<PageResult<InvitationRow>> =>
      paginate(this.orgScoped(this.data.invitations).map(toInvitationRow), query, idKey),

    create: async (input: CreateInvitationInput): Promise<InvitationRow> => {
      const org = this.actor.activeOrgId;
      if (org === null || this.membership() === undefined) {
        throw new StoreConstraintError('invitations_insert', 'no rows inserted');
      }
      // `invitations_role_not_owner`: "one cheap CHECK removes a whole class of
      // takeover-by-invite bugs" (B §1). The API rejects it earlier with a field-level
      // message; this is the second, independent guard.
      if (input.role === 'owner') {
        throw new StoreConstraintError(
          'invitations_role_not_owner',
          'invitations may not carry the owner role',
        );
      }
      if (input.role === 'client' && (input.project_ids ?? []).length === 0) {
        throw new StoreConstraintError(
          'invitations_client_must_be_scoped',
          'a client invitation must name at least one project',
        );
      }
      // `invitations_open_key`: at most one pending invitation per (org, email).
      if (
        this.data.invitations.some(
          (i) => i.org_id === org && i.email.toLowerCase() === input.email.toLowerCase() && i.status === 'pending',
        )
      ) {
        throw new StoreConstraintError(
          'invitations_open_key',
          `an open invitation for ${input.email} already exists`,
        );
      }
      const record: InvitationRecord = {
        id: this.data.id('inv'),
        org_id: org,
        email: input.email,
        role: input.role,
        project_ids: [...(input.project_ids ?? [])],
        token_hash: input.token_hash,
        status: 'pending',
        invited_by: this.actor.userId,
        expires_at: input.expires_at,
        accepted_at: null,
        accepted_by: null,
        created_at: this.data.now(),
      };
      this.data.invitations.push(record);
      return toInvitationRow(record);
    },

    // Deliberately NOT org-scoped: the caller is not a member yet. Keyed on the hash only.
    findByTokenHash: async (tokenHash: string): Promise<InvitationRow | null> => {
      const found = this.data.invitations.find((i) => i.token_hash === tokenHash);
      return found === undefined ? null : toInvitationRow(found);
    },

    markAccepted: async (id: string, userId: string): Promise<InvitationRow> => {
      const found = this.data.invitations.find((i) => i.id === id);
      if (found === undefined) {
        throw new StoreConstraintError('invitations_update', 'no rows updated');
      }
      found.status = 'accepted';
      found.accepted_at = this.data.now();
      found.accepted_by = userId;
      return toInvitationRow(found);
    },
  };

  /* --- projects --------------------------------------------------------- */

  readonly projects: ProjectRepo = {
    list: async (query: ListProjectsQuery): Promise<PageResult<ProjectRow>> => {
      const rows = this.orgScoped(this.data.projects)
        .filter((p) => this.canSeeProject(p.id))
        .filter((p) => (query.include_archived === true ? true : p.archived_at === null))
        .filter((p) =>
          query.q === undefined
            ? true
            : `${p.name} ${p.ref}`.toLowerCase().includes(query.q.toLowerCase()),
        );
      return paginate(rows, query, idKey);
    },

    get: async (id: string): Promise<ProjectRow | null> => {
      const found = this.orgScoped(this.data.projects).find((p) => p.id === id);
      if (found === undefined || !this.canSeeProject(found.id)) return null;
      return found;
    },

    create: async (input: CreateProjectInput): Promise<ProjectRow> => {
      const org = this.actor.activeOrgId;
      if (org === null || this.membership() === undefined) {
        throw new StoreConstraintError('projects_insert', 'no rows inserted');
      }
      if (
        this.data.projects.some(
          (p) => p.org_id === org && p.ref.toLowerCase() === input.ref.toLowerCase() && p.archived_at === null,
        )
      ) {
        throw new StoreConstraintError('projects_ref_key', `ref ${input.ref} is already in use`);
      }
      const at = this.data.now();
      const row: ProjectRow = {
        id: this.data.id('prj'),
        org_id: org,
        ref: input.ref,
        name: input.name,
        client_name: input.client_name ?? null,
        tags: [...(input.tags ?? [])],
        field_start: input.field_start ?? null,
        field_end: input.field_end ?? null,
        created_by: this.actor.userId,
        created_at: at,
        updated_at: at,
        archived_at: null,
      };
      this.data.projects.push(row);
      return row;
    },

    update: async (id: string, input: UpdateProjectInput): Promise<ProjectRow> => {
      const index = this.data.projects.findIndex((p) => p.id === id);
      const current = index === -1 ? undefined : this.data.projects[index];
      if (current === undefined || current.org_id !== this.actor.activeOrgId || !this.canSeeProject(id)) {
        throw new StoreConstraintError('projects_update', 'no rows updated');
      }
      const next: ProjectRow = {
        ...current,
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.client_name === undefined ? {} : { client_name: input.client_name }),
        ...(input.tags === undefined ? {} : { tags: [...input.tags] }),
        ...(input.field_start === undefined ? {} : { field_start: input.field_start }),
        ...(input.field_end === undefined ? {} : { field_end: input.field_end }),
        ...(input.archived_at === undefined ? {} : { archived_at: input.archived_at }),
        updated_at: this.data.now(),
      };
      this.data.projects[index] = next;
      return next;
    },

    remove: async (id: string): Promise<void> => {
      const index = this.data.projects.findIndex(
        (p) => p.id === id && p.org_id === this.actor.activeOrgId,
      );
      const current = index === -1 ? undefined : this.data.projects[index];
      // `projects_delete` requires `archived_at IS NOT NULL`: archive-then-delete means a hard
      // delete is always a second, deliberate act.
      if (current === undefined || current.archived_at === null) {
        throw new StoreConstraintError('projects_delete', 'no rows deleted');
      }
      this.data.projects.splice(index, 1);
    },
  };

  /* --- surveys and versions --------------------------------------------- */

  readonly surveys: SurveyRepo = {
    list: async (query: ListSurveysQuery): Promise<PageResult<SurveyRow>> => {
      const rows = this.orgScoped(this.data.surveys)
        .filter((s) => this.canSeeProject(s.project_id))
        .filter((s) => (query.project_id === undefined ? true : s.project_id === query.project_id))
        .filter((s) => (query.include_archived === true ? true : s.archived_at === null))
        .filter((s) =>
          query.q === undefined
            ? true
            : `${s.name} ${s.ref}`.toLowerCase().includes(query.q.toLowerCase()),
        );
      return paginate(rows, query, idKey);
    },

    get: async (id: string): Promise<SurveyRow | null> => {
      const found = this.orgScoped(this.data.surveys).find((s) => s.id === id);
      if (found === undefined || !this.canSeeProject(found.project_id)) return null;
      return found;
    },

    create: async (
      input: CreateSurveyInput,
    ): Promise<{ survey: SurveyRow; draft_version: SurveyVersionRow }> => {
      const org = this.actor.activeOrgId;
      if (org === null || this.membership() === undefined) {
        throw new StoreConstraintError('surveys_insert', 'no rows inserted');
      }
      const project = await this.projects.get(input.project_id);
      // The composite FK `(org_id, project_id) -> projects(org_id, id)` is what keeps the
      // denormalized org_id honest; a project the caller cannot see is not a project.
      if (project === null) {
        throw new StoreConstraintError('surveys_project_fkey', 'unknown project');
      }
      if (
        this.data.surveys.some(
          (s) => s.org_id === org && s.ref.toLowerCase() === input.ref.toLowerCase() && s.archived_at === null,
        )
      ) {
        throw new StoreConstraintError('surveys_ref_key', `ref ${input.ref} is already in use`);
      }
      const { survey, draft } = this.data.seedSurvey({
        orgId: org,
        projectId: input.project_id,
        ref: input.ref,
        name: input.name,
        createdBy: this.actor.userId,
      });
      const enriched: SurveyRow = {
        ...survey,
        description: input.description ?? null,
        survey_kind: input.survey_kind ?? 'standard',
        default_language: input.default_language ?? 'en',
        parent_survey_id: input.parent_survey_id ?? null,
      };
      this.data.surveys[this.data.surveys.findIndex((s) => s.id === survey.id)] = enriched;
      return { survey: enriched, draft_version: draft };
    },

    update: async (id: string, input: UpdateSurveyInput): Promise<SurveyRow> => {
      const index = this.data.surveys.findIndex((s) => s.id === id);
      const current = index === -1 ? undefined : this.data.surveys[index];
      if (
        current === undefined ||
        current.org_id !== this.actor.activeOrgId ||
        !this.canSeeProject(current.project_id)
      ) {
        throw new StoreConstraintError('surveys_update', 'no rows updated');
      }
      // API §2.3: renaming `ref` is metadata only and is refused if any non-draft version
      // exists — a ref that has reached a client's inbox in an export file name is no longer
      // free to change.
      if (input.ref !== undefined && input.ref !== current.ref) {
        const frozen = this.data.versions.some((v) => v.survey_id === id && v.status !== 'draft');
        if (frozen) {
          throw new StoreConstraintError(
            'surveys_ref_frozen',
            'ref cannot change once a non-draft version exists',
          );
        }
      }
      const next: SurveyRow = {
        ...current,
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.ref === undefined ? {} : { ref: input.ref }),
        ...(input.theme_id === undefined ? {} : { theme_id: input.theme_id }),
        ...(input.archived_at === undefined ? {} : { archived_at: input.archived_at }),
        updated_at: this.data.now(),
      };
      this.data.surveys[index] = next;
      return next;
    },

    remove: async (id: string): Promise<void> => {
      const index = this.data.surveys.findIndex(
        (s) => s.id === id && s.org_id === this.actor.activeOrgId,
      );
      const current = index === -1 ? undefined : this.data.surveys[index];
      if (current === undefined || current.archived_at === null) {
        throw new StoreConstraintError('surveys_delete', 'no rows deleted');
      }
      this.data.surveys.splice(index, 1);
    },

    listVersions: async (surveyId: string, query: PageQuery): Promise<PageResult<SurveyVersionRow>> => {
      const survey = await this.surveys.get(surveyId);
      if (survey === null) return { rows: [], hasMore: false };
      return paginate(
        this.orgScoped(this.data.versions).filter((v) => v.survey_id === surveyId),
        query,
        idKey,
      );
    },

    getVersion: async (id: string): Promise<SurveyVersionRow | null> => {
      const found = this.orgScoped(this.data.versions).find((v) => v.id === id);
      if (found === undefined) return null;
      // `app.can_see_survey()`: project scoping for a table that carries survey_id only.
      const survey = await this.surveys.get(found.survey_id);
      return survey === null ? null : found;
    },

    createVersion: async (input: CreateVersionInput): Promise<SurveyVersionRow> => {
      const org = this.actor.activeOrgId;
      const survey = await this.surveys.get(input.survey_id);
      if (org === null || survey === null) {
        throw new StoreConstraintError('sv_insert', 'no rows inserted');
      }
      const highest = this.data.versions
        .filter((v) => v.survey_id === input.survey_id)
        .reduce((max, v) => Math.max(max, v.version_no), 0);
      return this.data.insertVersion({
        orgId: org,
        surveyId: input.survey_id,
        versionNo: highest + 1,
        createdBy: this.actor.userId,
        ...(input.from_version_id === undefined ? {} : { clonedFrom: input.from_version_id }),
        ...(input.notes === undefined ? {} : { notes: input.notes }),
      });
    },

    updateVersion: async (
      id: string,
      expectedRevision: number,
      input: UpdateVersionInput,
    ): Promise<SurveyVersionRow | null> => {
      const current = await this.surveys.getVersion(id);
      if (current === null) throw new StoreConstraintError('sv_update', 'no rows updated');
      // Optimistic lock. `null` (not a throw) so the route can build a 412 body from the
      // current row: API §1.7's `changed_since` needs it.
      if (current.revision !== expectedRevision) return null;
      const index = this.data.versions.findIndex((v) => v.id === id);
      // `tg_version_guard`: `NEW.revision := OLD.revision + 1` on every UPDATE, so a caller
      // cannot forget to bump the lock.
      const next: SurveyVersionRow = {
        ...current,
        ...(input.notes === undefined ? {} : { notes: input.notes }),
        revision: current.revision + 1,
        updated_at: this.data.now(),
      };
      this.data.versions[index] = next;
      return next;
    },

    /**
     * `app.rollback_version`, reproduced closely enough that its refusals are testable.
     *
     * Every check below is one the function makes, in the order it makes them, and the ORDER of
     * the two status writes is the one part that is not merely fidelity: 0009 demotes before it
     * promotes because `sv_one_production` is a partial unique index checked at statement end, so
     * promoting first raises `23505` and "the rollback fails with a message about an index". A
     * store that promoted first would pass a test written against the outcome and hide the
     * constraint the real function is ordered around.
     */
    rollback: async (toVersionId: string, _requestId: string): Promise<RollbackResult> => {
      const target = await this.surveys.getVersion(toVersionId);
      // ONE message for "no such version", "not yours" and "not permitted": distinguishing them
      // is an existence oracle across tenants, which is why the function raises one exception for
      // all three. `project_manager`, not `programmer`: rollback changes what respondents see.
      if (target === null || !this.hasRole('project_manager')) {
        throw new StoreConstraintError('rollback_not_permitted', 'not a rollback target');
      }
      if (target.status !== 'archived') {
        throw new StoreConstraintError('rollback_target_not_archived', target.status);
      }
      if (target.compile_state !== 'compiled' || target.artifact_hash === null) {
        throw new StoreConstraintError('rollback_target_no_artifact', target.compile_state);
      }
      const incumbentIndex = this.data.versions.findIndex(
        (v) => v.survey_id === target.survey_id && v.status === 'production',
      );
      const incumbent = incumbentIndex === -1 ? undefined : this.data.versions[incumbentIndex];
      if (incumbent === undefined) {
        throw new StoreConstraintError('rollback_nothing_live', 'no production version');
      }

      // Demote, THEN promote.
      this.data.versions[incumbentIndex] = {
        ...incumbent,
        status: 'archived',
        revision: incumbent.revision + 1,
        updated_at: this.data.now(),
      };
      const targetIndex = this.data.versions.findIndex((v) => v.id === target.id);
      this.data.versions[targetIndex] = {
        ...target,
        status: 'production',
        revision: target.revision + 1,
        updated_at: this.data.now(),
      };

      // `runtime.upsert_survey_token`: REPOINT an existing live token rather than mint a new one,
      // because a token is a URL already in the field (K §5) and rotating it breaks every vendor
      // link. `artifact_hash` is not rewritten on any version — this row is the only thing that
      // moves, which is the whole of B §3.1's "rollback repoints artifact_hash" in this schema.
      const live = this.data.tokens.find(
        (t) => t.survey_id === target.survey_id && !t.is_test && t.revoked_at === null,
      );
      const token =
        live ??
        this.data.seedToken({
          token: 'r'.repeat(26),
          orgId: target.org_id,
          surveyId: target.survey_id,
          versionId: target.id,
          artifactHash: target.artifact_hash,
          status: 'production',
        });
      token.survey_version_id = target.id;
      token.artifact_hash = target.artifact_hash;
      token.status = 'production';

      return {
        token: token.token,
        survey_id: target.survey_id,
        from_version_id: incumbent.id,
        to_version_id: target.id,
        artifact_hash: target.artifact_hash,
      };
    },
  };

  /* --- jobs ------------------------------------------------------------- */

  readonly jobs: JobRepo = {
    get: async (id: string): Promise<JobRow | null> => {
      const found = this.data.jobs.find((j) => j.id === id);
      // `ops.jobs` has no RLS (schema `ops` is not granted to `authoring`), so the org check
      // is application code here by necessity — and therefore explicit rather than implied.
      if (found === undefined || found.org_id !== this.actor.activeOrgId) return null;
      return found;
    },

    enqueue: async (input: EnqueueJobInput): Promise<EnqueuedJob> => {
      const org = this.actor.activeOrgId;
      if (org === null) throw new StoreConstraintError('jobs_insert', 'no rows inserted');
      const key = input.idempotency_key;
      if (key !== undefined) {
        // `jobs_idem_key`, and `ON CONFLICT … DO NOTHING` rather than `DO UPDATE`: migration 0005
        // says why — "the existing job may already be running, and overwriting its payload
        // mid-flight would make the worker's own input change underneath it". So a replay returns
        // the EXISTING row unchanged, which is what makes `created: false` mean something.
        const existing = this.data.jobs.find(
          (j) => j.kind === input.kind && j.idempotency_key === key,
        );
        if (existing !== undefined) return { id: existing.id, created: false };
      }
      const row = this.data.seedJob({
        id: this.data.id('job'),
        org_id: org,
        kind: input.kind,
        status: 'queued',
        attempts: 0,
        started_at: null,
        heartbeat_at: null,
        // Derived from the SESSION, never from the input. See `EnqueueJobInput`.
        created_by: this.actor.userId,
        ...(key === undefined ? {} : { idempotency_key: key }),
        ...(input.project_id === undefined ? {} : { project_id: input.project_id }),
        ...(input.survey_version_id === undefined
          ? {}
          : { survey_version_id: input.survey_version_id }),
        ...(input.max_attempts === undefined ? {} : { max_attempts: input.max_attempts }),
      });
      this.data.enqueuedPayloads.push({ job_id: row.id, kind: input.kind, payload: input.payload });
      return { id: row.id, created: true };
    },
  };

  /* --- the variable registry -------------------------------------------- */

  readonly registry: RegistryRepo = {
    forVersion: async (versionId: string): Promise<VersionRegistryRows | null> => {
      // The org check goes through the VERSION, exactly as the real policy does: `content.*` rows
      // carry `org_id` and their policies join `app.survey_versions`, so a registry is visible
      // only when its version is. A version in another org is `null` (a 404 upstream), never an
      // empty registry — an empty registry would type-check the caller's source against nothing
      // and answer `ok: true`, which is a cross-tenant information leak dressed as a success.
      const version = this.data.versions.find((v) => v.id === versionId);
      if (version === undefined || version.org_id !== this.actor.activeOrgId) return null;
      return this.data.registries.find((r) => r.survey_version_id === versionId) ?? {
        survey_version_id: versionId,
        variables: [],
        nodes: [],
        items: [],
      };
    },
  };

  /* --- logic rules -------------------------------------------------------- */

  /**
   * `content.logic_rules`, with the policies reproduced by name: `rules_select` is
   * reviewer-floor + version-visible, the writes are programmer-floor + draft-only
   * (`content.tg_draft_only`), and `rules_one_target` is the biconditional CHECK. The
   * `depends_on_*` filters are JS `includes` here and `@>` over the GIN indexes in
   * `SupabaseRepo` — same rows either way, which is what the route tests assert.
   */
  readonly rules: RuleRepo = {
    list: async (versionId: string, query: ListRulesQuery): Promise<PageResult<RuleRow>> => {
      // Visibility goes through the VERSION, as `rules_select`'s `app.can_see_version()` does.
      const version = await this.surveys.getVersion(versionId);
      if (version === null || !this.hasRole('reviewer')) return { rows: [], hasMore: false };
      const rows = this.data.rules.filter(
        (r) =>
          r.survey_version_id === versionId &&
          r.deleted_at === null &&
          (query.kind === undefined || r.kind === query.kind) &&
          (query.target_node_id === undefined || r.target_node_id === query.target_node_id) &&
          (query.depends_on_node_id === undefined ||
            r.depends_on_node_ids.includes(query.depends_on_node_id)) &&
          (query.depends_on_variable_id === undefined ||
            r.depends_on_variable_ids.includes(query.depends_on_variable_id)),
      );
      return paginate(rows.map(toRuleRow), query, idKey);
    },

    get: async (ruleId: string): Promise<RuleRow | null> => {
      const found = this.orgScoped(this.data.rules).find(
        (r) => r.id === ruleId && r.deleted_at === null,
      );
      if (found === undefined || !this.hasRole('reviewer')) return null;
      const version = await this.surveys.getVersion(found.survey_version_id);
      return version === null ? null : toRuleRow(found);
    },

    create: async (input: CreateRuleInput): Promise<RuleRow> => {
      const version = await this.surveys.getVersion(input.survey_version_id);
      // One outcome for "no such version", "not yours" and "not programmer" — see redirects.
      if (version === null || !this.hasRole('programmer')) {
        throw new StoreConstraintError('rules_insert', 'no rows inserted');
      }
      if (version.status !== 'draft') {
        throw new StoreConstraintError('rules_draft_only', 'version is not a draft');
      }
      assertOneTarget(input.target_kind, input.target_node_id ?? null, input.target_item_id ?? null, input.target_variable_id ?? null);
      // `rules_trivia_dsl_only`: trivia is the DSL's fidelity record, meaningless on a
      // builder-authored rule and pinned empty by the CHECK.
      if ((input.authored_in ?? 'visual') === 'visual' && Object.keys(input.trivia ?? {}).length > 0) {
        throw new StoreConstraintError('rules_trivia_dsl_only', 'trivia on a visual rule');
      }
      const row = this.data.seedRule({ ...input, org_id: version.org_id });
      return toRuleRow(row);
    },

    update: async (ruleId: string, input: UpdateRuleInput): Promise<RuleRow> => {
      const index = this.data.rules.findIndex(
        (r) => r.id === ruleId && r.org_id === this.actor.activeOrgId && r.deleted_at === null,
      );
      const current = index === -1 ? undefined : this.data.rules[index];
      if (current === undefined || !this.hasRole('programmer')) {
        throw new StoreConstraintError('rules_update', 'no rows updated');
      }
      const version = await this.surveys.getVersion(current.survey_version_id);
      if (version === null) throw new StoreConstraintError('rules_update', 'no rows updated');
      if (version.status !== 'draft') {
        throw new StoreConstraintError('rules_draft_only', 'version is not a draft');
      }
      const next: MemoryRuleRow = {
        ...current,
        ...(input.kind === undefined ? {} : { kind: input.kind }),
        ...(input.target_kind === undefined ? {} : { target_kind: input.target_kind }),
        ...(input.target_node_id === undefined ? {} : { target_node_id: input.target_node_id }),
        ...(input.target_item_id === undefined ? {} : { target_item_id: input.target_item_id }),
        ...(input.target_variable_id === undefined ? {} : { target_variable_id: input.target_variable_id }),
        ...(input.condition === undefined ? {} : { condition: input.condition }),
        ...(input.effect === undefined ? {} : { effect: input.effect }),
        ...(input.evaluation === undefined ? {} : { evaluation: input.evaluation }),
        ...(input.authored_in === undefined ? {} : { authored_in: input.authored_in }),
        ...(input.trivia === undefined ? {} : { trivia: input.trivia }),
        ...(input.notes === undefined ? {} : { notes: input.notes }),
        ...(input.depends_on_variable_ids === undefined
          ? {}
          : { depends_on_variable_ids: [...input.depends_on_variable_ids] }),
        ...(input.depends_on_node_ids === undefined
          ? {}
          : { depends_on_node_ids: [...input.depends_on_node_ids] }),
        updated_at: this.data.now(),
      };
      assertOneTarget(next.target_kind, next.target_node_id, next.target_item_id, next.target_variable_id);
      this.data.rules[index] = next;
      return toRuleRow(next);
    },

    remove: async (ruleId: string): Promise<void> => {
      const index = this.data.rules.findIndex(
        (r) => r.id === ruleId && r.org_id === this.actor.activeOrgId && r.deleted_at === null,
      );
      const current = index === -1 ? undefined : this.data.rules[index];
      if (current === undefined || !this.hasRole('programmer')) {
        throw new StoreConstraintError('rules_delete', 'no rows deleted');
      }
      const version = await this.surveys.getVersion(current.survey_version_id);
      if (version === null) throw new StoreConstraintError('rules_delete', 'no rows deleted');
      if (version.status !== 'draft') {
        throw new StoreConstraintError('rules_draft_only', 'version is not a draft');
      }
      // Soft, like every content row: `deleted_at` is the editor's undo buffer (B §4.1).
      this.data.rules[index] = { ...current, deleted_at: this.data.now() };
    },

    usagesOfVariable: async (variableId: string) => {
      // The version is discovered THROUGH the variable, then re-checked through the version's
      // own visibility — the same two hops `content.variables`' policy joins make.
      const registry = this.data.registries.find((r) =>
        r.variables.some((v) => v.id === variableId),
      );
      if (registry === undefined || !this.hasRole('reviewer')) return null;
      const version = await this.surveys.getVersion(registry.survey_version_id);
      if (version === null) return null;
      const rules = this.data.rules
        .filter(
          (r) =>
            r.survey_version_id === registry.survey_version_id &&
            r.deleted_at === null &&
            r.depends_on_variable_ids.includes(variableId),
        )
        .map(toRuleRow);
      return { survey_version_id: registry.survey_version_id, rules };
    },
  };

  /* --- redirects ---------------------------------------------------------- */

  readonly redirects: RedirectRepo = {
    listRedirects: async (versionId: string): Promise<readonly RedirectRow[]> => {
      // Visibility goes through the VERSION, as `redirects_select`'s `app.can_see_version()`
      // does: a version in another org yields zero rows, never an error (an error is an oracle).
      const version = await this.surveys.getVersion(versionId);
      if (version === null) return [];
      return this.data.redirects
        .filter((r) => r.survey_version_id === versionId)
        // 0010's key order, the same ORDER BY the worker's publish read uses, so a test that
        // asserts round-trip ordering asserts the order the artifact is actually built from.
        .sort((a, b) =>
          `${a.scope} ${a.scope_key} ${a.disposition} ${a.custom_key}`.localeCompare(
            `${b.scope} ${b.scope_key} ${b.disposition} ${b.custom_key}`,
          ),
        )
        .map(({ scope, scope_key, disposition, custom_key, url_template }) => ({
          scope,
          scope_key,
          disposition,
          custom_key,
          url_template,
        }));
    },

    replaceRedirects: async (
      versionId: string,
      rows: readonly RedirectRow[],
    ): Promise<readonly RedirectRow[]> => {
      const version = await this.surveys.getVersion(versionId);
      // `redirects_insert`'s WITH CHECK: `current_org` + `has_role('programmer')` +
      // `can_see_version` + `version_is_draft`. One outcome for "no such version", "not yours"
      // and "not programmer" — zero rows written, surfaced as the same not_found the policy
      // produces — because distinguishing them is an existence oracle across tenants.
      if (version === null || !this.hasRole('programmer')) {
        throw new StoreConstraintError('redirects_insert', 'no rows inserted');
      }
      // `content.tg_draft_only`: a frozen version's redirects are part of what it published.
      // The route answers 409 frozen_version before reaching here; this is the trigger's copy.
      if (version.status !== 'draft') {
        throw new StoreConstraintError('redirects_draft_only', 'version is not a draft');
      }
      const org = version.org_id;
      const seen = new Set<string>();
      for (const row of rows) {
        // 0010's CHECKs, reproduced by name so a failing test names what a failing INSERT would.
        // The route's validator refuses all of these with a 422 before any write; these are the
        // trigger-and-constraint copies that catch anything reaching the store by another path.
        if ((row.scope === 'default') !== (row.scope_key === '')) {
          throw new StoreConstraintError('redirects_scope_key_shape', 'scope/scope_key mismatch');
        }
        if ((row.disposition === 'CUSTOM') !== (row.custom_key !== '')) {
          throw new StoreConstraintError('redirects_custom_key_shape', 'disposition/custom_key mismatch');
        }
        if (row.url_template.trim() === '') {
          throw new StoreConstraintError('redirects_template_nonempty', 'empty url_template');
        }
        const key = `${row.scope} ${row.scope_key} ${row.disposition} ${row.custom_key}`;
        if (seen.has(key)) throw new StoreConstraintError('redirects_pkey', 'duplicate redirect row');
        seen.add(key);
      }
      // Whole-set replace: delete then insert, which over PostgREST is two statements and here
      // is the atomic thing the RPC will one day make it there.
      for (let i = this.data.redirects.length - 1; i >= 0; i -= 1) {
        if (this.data.redirects[i]?.survey_version_id === versionId) this.data.redirects.splice(i, 1);
      }
      for (const row of rows) {
        this.data.redirects.push({ ...row, survey_version_id: versionId, org_id: org });
      }
      return this.redirects.listRedirects(versionId);
    },
  };

  /* --- languages and i18n strings ------------------------------------------ */

  readonly i18n: I18nRepo = {
    listLanguages: async (versionId: string): Promise<readonly LanguageRow[]> => {
      // `languages_select` is reviewer-floor + `can_see_version()`. Zero rows for a version in
      // another org OR a caller below the floor, never an error (an error is an oracle).
      const version = await this.surveys.getVersion(versionId);
      if (version === null || !this.hasRole('reviewer')) return [];
      return this.data.languages
        .filter((l) => l.survey_version_id === versionId)
        // Base first, then tag order — the order the manager renders and the worker reads.
        .sort((a, b) => (a.is_base === b.is_base ? a.lang.localeCompare(b.lang) : a.is_base ? -1 : 1))
        .map(({ lang, is_base, rtl, on_missing, block_publish_if_incomplete }) => ({
          lang,
          is_base,
          rtl,
          on_missing,
          block_publish_if_incomplete,
        }));
    },

    addLanguage: async (versionId: string, lang: string): Promise<LanguageRow> => {
      const version = await this.surveys.getVersion(versionId);
      // `languages_insert`'s WITH CHECK: org + programmer + can_see_version + draft. One
      // outcome for "no such version", "not yours" and "not programmer" — zero rows written.
      if (version === null || !this.hasRole('programmer')) {
        throw new StoreConstraintError('languages_insert', 'no rows inserted');
      }
      if (version.status !== 'draft') {
        throw new StoreConstraintError('languages_draft_only', 'version is not a draft');
      }
      // `languages_tag_shape` — 0007's CHECK, verbatim.
      if (!/^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2})?$/.test(lang)) {
        throw new StoreConstraintError('languages_tag_shape', `${lang} is not a BCP-47-ish tag`);
      }
      if (this.data.languages.some((l) => l.survey_version_id === versionId && l.lang === lang)) {
        throw new StoreConstraintError('languages_pkey', `${lang} already exists on this version`);
      }
      const row = this.data.seedLanguage({ versionId, orgId: version.org_id, lang });
      const { survey_version_id: _v, org_id: _o, ...wire } = row;
      return wire;
    },

    listStrings: async (versionId: string): Promise<readonly I18nStringRow[]> => {
      const version = await this.surveys.getVersion(versionId);
      if (version === null || !this.hasRole('reviewer')) return [];
      return this.data.strings
        .filter((s) => s.survey_version_id === versionId)
        .sort((a, b) => (a.lang === b.lang ? a.key.localeCompare(b.key) : a.lang.localeCompare(b.lang)))
        .map(({ lang, key, value, state }) => ({ lang, key, value, state }));
    },

    upsertStrings: async (
      versionId: string,
      lang: string,
      rows: readonly UpsertStringInput[],
    ): Promise<number> => {
      const version = await this.surveys.getVersion(versionId);
      // `i18n_insert`/`i18n_update`: REVIEWER floor — 0007 puts translation entry below the
      // programmer floor on purpose (translators are reviewers), unlike every other content
      // write. Deletes stay programmer-only and this method deliberately cannot express one.
      if (version === null || !this.hasRole('reviewer')) {
        throw new StoreConstraintError('i18n_insert', 'no rows written');
      }
      // `content.tg_draft_only`: a frozen version's strings are part of what it published.
      if (version.status !== 'draft') {
        throw new StoreConstraintError('i18n_draft_only', 'version is not a draft');
      }
      // The FK to content.languages: an upsert into a language the version does not carry is a
      // 23503, not an invented language.
      if (!this.data.languages.some((l) => l.survey_version_id === versionId && l.lang === lang)) {
        throw new StoreConstraintError('i18n_strings_lang_fkey', `no language ${lang} on this version`);
      }
      for (const row of rows) {
        if (row.state === 'missing' && row.value !== null && row.value !== '') {
          throw new StoreConstraintError('i18n_missing_has_no_value', 'a missing string has no value');
        }
        const existing = this.data.strings.find(
          (s) => s.survey_version_id === versionId && s.lang === lang && s.key === row.key,
        );
        if (existing !== undefined) {
          existing.value = row.state === 'missing' ? null : row.value;
          existing.state = row.state;
        } else {
          this.data.seedString({
            versionId,
            orgId: version.org_id,
            lang,
            key: row.key,
            value: row.value,
            state: row.state,
          });
        }
      }
      return rows.length;
    },
  };

  /* --- exports --------------------------------------------------------------- */

  readonly exports: ExportRepo = {
    create: async (input: CreateExportInput): Promise<ExportRow> => {
      const org = this.actor.activeOrgId;
      const version = await this.surveys.getVersion(input.survey_version_id);
      // `exports_insert`: org + analyst floor + requested_by pinned + born pending. One outcome
      // for "no such version", "not yours" and "below the floor" — zero rows.
      if (org === null || version === null || !this.hasRole('analyst')) {
        throw new StoreConstraintError('exports_insert', 'no rows inserted');
      }
      // `app.tg_exports_pii_guard` (0012): the pii_access CAPABILITY, never rank. Raised by
      // name so the API maps it to a 403 naming the missing grant, exactly as the trigger's
      // 42501 message does.
      if (input.pii_included && !this.data.hasCapability(org, this.actor.userId, 'pii_access')) {
        throw new StoreConstraintError(
          'exports_pii_guard',
          'exporting PII requires an explicit pii_access capability grant',
        );
      }
      const row: MemoryExportRow = {
        id: this.data.id('exp'),
        org_id: org,
        survey_version_id: input.survey_version_id,
        requested_by: this.actor.userId,
        status: 'pending',
        pii_included: input.pii_included,
        include_test: input.include_test,
        row_count: null,
        storage_key: null,
        error: null,
        created_at: this.data.now(),
        started_at: null,
        finished_at: null,
      };
      this.data.exports.push(row);
      const { org_id: _o, ...wire } = row;
      return wire;
    },

    listForVersion: async (versionId: string): Promise<readonly ExportRow[]> => {
      // `exports_select`: org + analyst floor, org-wide at that floor. Zero rows below it.
      const version = await this.surveys.getVersion(versionId);
      if (version === null || !this.hasRole('analyst')) return [];
      return this.data.exports
        .filter((e) => e.survey_version_id === versionId && e.org_id === this.actor.activeOrgId)
        // `exports_version_idx` order: newest first — the dialog's history.
        .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
        .slice(0, 50)
        .map(({ org_id: _o, ...wire }) => wire);
    },
  };

  /* --- field stats ------------------------------------------------------------ */

  readonly fieldStats: FieldStatsRepo = {
    forVersion: async (versionId: string, includeTest: boolean): Promise<readonly DispositionCount[]> => {
      // `app.field_stats` (0013) re-checks the same two things in the same order: the analyst
      // floor first (a caller with no standing learns nothing about whether the version
      // exists), then the org match through the version row.
      if (!this.hasRole('analyst')) {
        throw new StoreConstraintError('field_stats_floor', 'reading field stats requires analyst');
      }
      const version = await this.surveys.getVersion(versionId);
      if (version === null) {
        throw new StoreConstraintError('field_stats_not_found', 'survey version not found');
      }
      const counts = new Map<string, number>();
      for (const session of this.data.sessions) {
        if (session.survey_version_id !== versionId) continue;
        // E §14.1 / P1-11 acceptance: is_test rows are EXCLUDED from the default count.
        if (session.is_test && !includeTest) continue;
        const disposition = session.disposition ?? 'IN_PROGRESS';
        counts.set(disposition, (counts.get(disposition) ?? 0) + 1);
      }
      return [...counts.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([disposition, sessions]) => ({ disposition, sessions }));
    },
  };

  /* --- audit ------------------------------------------------------------ */

  readonly audit: AuditRepo = {
    write: async (event: AuditEventInput): Promise<void> => {
      // `event.org_id` wins only where the caller is legitimately acting outside their active
      // org: invitation acceptance and org switching. See AuditEventInput.org_id.
      const org = event.org_id ?? this.actor.activeOrgId;
      if (org === null) return;
      this.data.audit.push({
        ...event,
        id: this.data.id('aud'),
        org_id: org,
        actor_user_id: this.actor.userId,
        actor_kind: 'user',
        created_at: this.data.now(),
      });
    },

    since: async (surveyVersionId: string, afterIso: string): Promise<readonly AuditRow[]> =>
      this.data.audit.filter(
        (a) =>
          a.org_id === this.actor.activeOrgId &&
          a.survey_version_id === surveyVersionId &&
          a.created_at > afterIso,
      ),
  };

  /* --- idempotency ------------------------------------------------------ */

  readonly idempotency: IdempotencyStore = {
    get: async (orgId: string, endpoint: string, key: string): Promise<IdempotencyRecord | null> =>
      this.data.idempotency.find(
        (r) => r.org_id === orgId && r.endpoint === endpoint && r.key === key,
      ) ?? null,
    put: async (record: IdempotencyRecord): Promise<void> => {
      this.data.idempotency.push(record);
    },
  };
}

export function createInMemoryRepos(data: MemoryDataset, actor: Actor): Repos {
  return new InMemoryRepos(data, actor);
}
