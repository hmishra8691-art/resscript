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
import { isReservedVariableName, roleRank } from '@resscript/schema';
import type { JsonObject, JsonValue, OrgRole, VersionStatus } from '@resscript/schema';
import {
  fracKeyAtPosition,
  fracKeyBetween,
  FracKeyExhausted,
  rebalanceWidth,
  REBALANCE_KEY_LENGTH,
} from './frac-key.js';
import type {
  AuditEventInput,
  AuditRepo,
  AuditRow,
  BulkItemInput,
  CellInput,
  CellRow,
  CreateItemInput,
  CreateNodeInput,
  DuplicateInput,
  DuplicatedSubtree,
  ItemKind,
  ItemRow,
  MoveNodeInput,
  NodeKind,
  NodeRepo,
  NodeRow,
  SiblingPosition,
  TreeRowRecord,
  UpdateItemInput,
  UpdateNodeInput,
  VariableRow,
  VariableWriteResult,
  WriteVariableInput,
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
  VendorRepo,
  VendorRow,
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
/** The wire row plus the two columns the wire omits, same shape as MemoryRedirectRow. */
export interface MemoryVendorRow extends VendorRow {
  readonly survey_version_id: string;
  readonly org_id: string;
}

export interface MemoryRedirectRow extends RedirectRow {
  readonly survey_version_id: string;
  readonly org_id: string;
}

/** One row of `content.logic_rules`: the wire shape plus `org_id` and the soft-delete column. */
export interface MemoryRuleRow extends RuleRow {
  readonly org_id: string;
  readonly deleted_at: string | null;
}

/**
 * `content.nodes`, `content.question_items`, `content.question_cells` and `content.variables`:
 * the wire shapes plus the one column the wire omits (`org_id`).
 *
 * Held as FULL rows, unlike the projected `registries` below, for the reason the rules table is:
 * the content routes are this milestone's, so the store models the columns the constraints
 * actually police — `nodes_ref_key`, `qitems_code_key`, `variables_export_col_key` and the
 * fractional `sort_key` are the behaviour P1-03 is about, and none of them is testable against a
 * store that keeps a projection.
 */
export interface MemoryNodeRow extends NodeRow {
  readonly org_id: string;
}

export interface MemoryItemRow extends ItemRow {
  readonly org_id: string;
}

export interface MemoryCellRow extends CellRow {
  readonly org_id: string;
}

export interface MemoryVariableRow extends VariableRow {
  readonly org_id: string;
}

/** One recorded write, for the assertions P1-03's acceptance criteria are stated as. */
export interface MemoryWrite {
  /** Schema-qualified, as a `psql` session would name it: `content.nodes`. */
  readonly table: string;
  readonly op: 'insert' | 'update' | 'delete';
  readonly id: string;
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
   * A PROJECTED registry, attached to a version by `seedRegistry`.
   *
   * This is what the P1-07 milestone needed and all it needed: the `/v1/dsl/*` endpoints want a
   * type environment, not a tree, and a half-modelled `content.nodes` at that point would have
   * been a second definition of the tree P1-03 then had to reconcile. P1-03 added the real
   * tables below, and `registry.forVersion` now returns the UNION of the two — the seeded
   * projection stays because five suites' fixtures are written against it, and a node created
   * through `NodeRepo` shows up in the same registry so a rule can target it.
   */
  readonly registries: VersionRegistryRows[] = [];
  /** `content.nodes` (0007 §3) — the tree. */
  readonly nodes: MemoryNodeRow[] = [];
  /** `content.question_items` (0007 §4) — options, matrix rows, matrix columns. */
  readonly items: MemoryItemRow[] = [];
  /** `content.question_cells` (0007 §5) — mixed-matrix control overrides. */
  readonly cells: MemoryCellRow[] = [];
  /** `content.variables` (0007 §7) — the export contract. */
  readonly variables: MemoryVariableRow[] = [];
  /**
   * Every row write, in order, so a test can assert HOW MANY of them a request made.
   *
   * Kept for `enqueuedPayloads`' reason — a fact about the store that no repo method returns and
   * that a suite would otherwise have to take on trust — and P1-03 needs it more sharply than
   * exports did: the milestone's headline acceptance criterion is "reorders a 60-option list by
   * dragging, and the database shows ONE UPDATE per drag". Without a counter, a store that
   * renumbered all 60 rows would pass every assertion about the resulting ORDER, which is
   * exactly the implementation B §4.6 exists to rule out.
   */
  readonly writes: MemoryWrite[] = [];
  /**
   * `content.redirects` (0010), held as the flattened wire rows plus the two columns the wire
   * omits (`survey_version_id`, `org_id`). Flattened here as in the table, because the API's
   * whole reason for the shape — "is every disposition covered is a join, not a JSONB walk" —
   * is only testable against a store that holds rows rather than a reassembled map.
   */
  readonly redirects: MemoryRedirectRow[] = [];
  readonly vendors: MemoryVendorRow[] = [];
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

  recordWrite(table: string, op: MemoryWrite['op'], id: string): void {
    this.writes.push({ table, op, id });
  }

  /** How many writes of one shape landed. `op` omitted counts every write to the table. */
  countWrites(table: string, op?: MemoryWrite['op']): number {
    return this.writes.filter((w) => w.table === table && (op === undefined || w.op === op)).length;
  }

  /**
   * One `content.nodes` row, as `POST /versions/:id/nodes` would have written it.
   *
   * `sort_key` defaults to a dense fixed-width key by insertion order among the parent's
   * existing children, which is what `content.frac_key_at(row_number(), 4)` produces for a
   * freshly rebalanced set — so a fixture's tree is ordered the way a real one is, and a test
   * that asserts document order is asserting the store's own comparison rather than a
   * hand-picked string.
   */
  seedNode(
    input: Partial<MemoryNodeRow> & {
      readonly org_id: string;
      readonly survey_version_id: string;
      readonly node_kind: NodeKind;
    },
  ): MemoryNodeRow {
    const at = this.now();
    const parentId = input.parent_id ?? null;
    const siblings = this.nodes.filter(
      (n) => n.survey_version_id === input.survey_version_id && (n.parent_id ?? null) === parentId,
    ).length;
    const row: MemoryNodeRow = {
      id: input.id ?? this.id(NODE_ID_PREFIX[input.node_kind]),
      survey_version_id: input.survey_version_id,
      org_id: input.org_id,
      node_kind: input.node_kind,
      parent_id: parentId,
      sort_key: input.sort_key ?? fracKeyAtPosition(siblings + 1, 4),
      ref: input.ref ?? null,
      label_key: input.label_key ?? null,
      instruction_key: input.instruction_key ?? null,
      title_key: input.title_key ?? null,
      question_type: input.question_type ?? null,
      required: input.required ?? null,
      config: input.config ?? {},
      settings: input.settings ?? {},
      validation: input.validation ?? [],
      masks: input.masks ?? [],
      scripts: input.scripts ?? {},
      flags: input.flags ?? {},
      emits: input.emits ?? [],
      created_at: input.created_at ?? at,
      updated_at: input.updated_at ?? at,
      deleted_at: input.deleted_at ?? null,
    };
    // `nodes_sibling_order_key`: order within a sibling set is TOTAL, and the index is NOT partial
    // on `deleted_at` — a soft-deleted node keeps its slot so undo restores it where it was. Two
    // siblings sharing a key would make `ORDER BY sort_key` nondeterministic, which is the one
    // thing the whole fractional scheme cannot tolerate, so it is checked here rather than trusted
    // to whichever code path computed the key.
    if (
      this.nodes.some(
        (n) =>
          n.survey_version_id === row.survey_version_id &&
          (n.parent_id ?? null) === parentId &&
          n.sort_key === row.sort_key,
      )
    ) {
      throw new StoreConstraintError(
        'nodes_sibling_order_key',
        `sort_key ${row.sort_key} is already taken among these siblings`,
      );
    }
    this.nodes.push(row);
    this.recordWrite('content.nodes', 'insert', row.id);
    return row;
  }

  /** One `content.question_items` row. Ids are `opt_` for all three kinds (0010's constraint). */
  seedItem(
    input: Partial<MemoryItemRow> & {
      readonly org_id: string;
      readonly survey_version_id: string;
      readonly question_id: string;
      readonly item_kind: ItemKind;
      readonly ref: string;
      readonly code: number;
    },
  ): MemoryItemRow {
    const at = this.now();
    const siblings = this.items.filter(
      (i) =>
        i.survey_version_id === input.survey_version_id &&
        i.question_id === input.question_id &&
        i.item_kind === input.item_kind,
    ).length;
    const row: MemoryItemRow = {
      id: input.id ?? this.id('opt'),
      survey_version_id: input.survey_version_id,
      org_id: input.org_id,
      question_id: input.question_id,
      item_kind: input.item_kind,
      ref: input.ref,
      code: input.code,
      label_key: input.label_key ?? null,
      sort_key: input.sort_key ?? fracKeyAtPosition(siblings + 1, 4),
      anchor: input.anchor ?? 'none',
      exclusive: input.exclusive ?? false,
      behaviour: input.behaviour ?? {},
      value_override: input.value_override ?? null,
      custom_class: input.custom_class ?? null,
      meta: input.meta ?? {},
      created_at: input.created_at ?? at,
      updated_at: input.updated_at ?? at,
      deleted_at: input.deleted_at ?? null,
    };
    // `qitems_order_key`, the item table's copy of the same totality claim — and the reason the
    // bulk paste prefixes the set's maximum key rather than restarting the dense series.
    if (
      this.items.some(
        (i) =>
          i.survey_version_id === row.survey_version_id &&
          i.question_id === row.question_id &&
          i.item_kind === row.item_kind &&
          i.sort_key === row.sort_key,
      )
    ) {
      throw new StoreConstraintError(
        'qitems_order_key',
        `sort_key ${row.sort_key} is already taken among these items`,
      );
    }
    this.items.push(row);
    this.recordWrite('content.question_items', 'insert', row.id);
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

/**
 * The id prefix per node kind — `packages/schema`'s `ID_PREFIXES`, projected onto
 * `content.node_kind`. 0007's `content.nodes.id` comment is the authority: the prefix is
 * kind-dependent there (unlike `content.question_items`, which 0010 normalized to `opt_` for all
 * three kinds), because a `pg_` id in a mask is obviously wrong on sight.
 */
const NODE_ID_PREFIX: Readonly<Record<NodeKind, string>> = {
  block: 'blk',
  page: 'pg',
  question: 'qst',
  text: 'txt',
};

/** C §5's nesting rules, exactly as `content.move_node` states them. */
function nestingAllowed(parentKind: NodeKind, childKind: NodeKind): boolean {
  if (parentKind === 'block') return childKind === 'block' || childKind === 'page';
  if (parentKind === 'page') return childKind === 'question' || childKind === 'text';
  return false;
}

/** Strip `org_id`; copy the arrays so a route cannot mutate the store through a row it read. */
function toNodeRow(record: MemoryNodeRow): NodeRow {
  const { org_id: _org, ...rest } = record;
  return {
    ...rest,
    validation: [...record.validation],
    masks: [...record.masks],
    emits: [...record.emits],
  };
}

function toItemRow(record: MemoryItemRow): ItemRow {
  const { org_id: _org, ...rest } = record;
  return rest;
}

function toCellRow(record: MemoryCellRow): CellRow {
  const { org_id: _org, ...rest } = record;
  return rest;
}

function toVariableRow(record: MemoryVariableRow): VariableRow {
  const { org_id: _org, ...rest } = record;
  return {
    ...rest,
    enum_domain: record.enum_domain === null ? null : [...record.enum_domain],
  };
}

/** Ascending `(sort_key, id)` — `content.sort_key`'s COLLATE "C", which is UTF-16 order here. */
function bySortKey<T extends { readonly sort_key: string; readonly id: string }>(a: T, b: T): number {
  if (a.sort_key !== b.sort_key) return a.sort_key < b.sort_key ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
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

    touchVersion: async (id: string, expectedRevision: number): Promise<SurveyVersionRow | null> => {
      const current = await this.surveys.getVersion(id);
      if (current === null || !this.hasRole('programmer')) {
        throw new StoreConstraintError('sv_update', 'no rows updated');
      }
      // The compare-and-swap. `null` rather than a throw, for `updateVersion`'s reason: the
      // route answers 412 with the CURRENT row, which is what the client needs to recover.
      if (current.revision !== expectedRevision) return null;
      const index = this.data.versions.findIndex((v) => v.id === id);
      const next: SurveyVersionRow = {
        ...current,
        // `tg_version_guard` again: no column of the version changes, and `revision` still moves,
        // because every content mutation shares this one lock (API §1.7).
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
      // The UNION of the seeded projection and the real content tables — see `registries`. Both
      // halves are the SAME read in Postgres (one `content.*` select per table); the split
      // exists only because the fixture predates the tables. Live rows come second so a seeded
      // fixture's registry order is unchanged for the suites written against it.
      const seeded = this.data.registries.find((r) => r.survey_version_id === versionId);
      const live = this.projectedRegistry(versionId);
      if (seeded === undefined) return live;
      return {
        survey_version_id: versionId,
        variables: [...seeded.variables, ...live.variables],
        nodes: [...seeded.nodes, ...live.nodes],
        items: [...seeded.items, ...live.items],
      };
    },
  };

  /** `content.*` → the registry projection, deleted rows excluded (B §4.1's undo buffer). */
  private projectedRegistry(versionId: string): VersionRegistryRows {
    return {
      survey_version_id: versionId,
      variables: this.data.variables
        .filter((v) => v.survey_version_id === versionId && v.deleted_at === null)
        .sort(bySortKey)
        .map((v) => ({
          id: v.id,
          name: v.name,
          kind: v.kind,
          vtype: v.vtype,
          enum_domain: v.enum_domain === null ? null : [...v.enum_domain],
          source_question_id: v.source_question_id,
          source_item_id: v.source_item_id,
          source_part: v.source_part,
          pii: v.pii,
          persist: v.persist,
          sort_key: v.sort_key,
        })),
      nodes: this.data.nodes
        .filter((n) => n.survey_version_id === versionId && n.deleted_at === null)
        .sort(bySortKey)
        .map((n) => ({
          id: n.id,
          node_kind: n.node_kind,
          parent_id: n.parent_id,
          ref: n.ref,
          required: n.required,
          emits: [...n.emits],
          sort_key: n.sort_key,
        })),
      items: this.data.items
        .filter((i) => i.survey_version_id === versionId && i.deleted_at === null)
        .sort(bySortKey)
        .map((i) => ({
          id: i.id,
          question_id: i.question_id,
          item_kind: i.item_kind,
          ref: i.ref,
          code: i.code,
          label_key: i.label_key,
          sort_key: i.sort_key,
        })),
    };
  }

  /**
   * The seeded registry's nodes as `content.nodes` rows, for the tree read.
   *
   * A projection back into the fuller shape, which is only possible because the projection is a
   * subset: what it cannot supply (`label_key`, `flags`, `config`) comes back empty, so a
   * fixture-seeded tree renders with no label preview and no badges. That is the honest limit of
   * the fixture rather than a limit of the route — a suite that needs previews seeds real nodes.
   */
  private seededNodes(versionId: string): readonly MemoryNodeRow[] {
    const seeded = this.data.registries.find((r) => r.survey_version_id === versionId);
    if (seeded === undefined) return [];
    const at = '2026-08-20T12:00:00.000Z';
    return seeded.nodes
      .filter((node) => !this.data.nodes.some((row) => row.id === node.id))
      .map((node) => ({
        id: node.id,
        survey_version_id: versionId,
        org_id: this.actor.activeOrgId ?? '',
        node_kind: node.node_kind,
        parent_id: node.parent_id,
        sort_key: node.sort_key,
        ref: node.ref,
        label_key: null,
        instruction_key: null,
        title_key: null,
        question_type: node.node_kind === 'question' ? 'single_select' : null,
        required: node.required,
        config: {},
        settings: {},
        validation: [],
        masks: [],
        scripts: {},
        flags: {},
        emits: [...node.emits],
        created_at: at,
        updated_at: at,
        deleted_at: null,
      }));
  }

  /* --- the content tree --------------------------------------------------- */

  /**
   * The version a content write is about to touch, or the constraint that declined.
   *
   * `insertConstraint` is the POLICY's name and `draftConstraint` the TRIGGER's, because the two
   * refusals are different answers: a policy declining is zero rows written (indistinguishable
   * from "no such version", which is 0004's existence-oracle rule), and `content.tg_draft_only`
   * is a raised exception naming a state the caller can see and act on (409, clone a draft).
   */
  private async writableVersion(
    versionId: string,
    insertConstraint: string,
    draftConstraint: string,
  ): Promise<SurveyVersionRow> {
    const version = await this.surveys.getVersion(versionId);
    if (version === null || !this.hasRole('programmer')) {
      throw new StoreConstraintError(insertConstraint, 'no rows written');
    }
    if (version.status !== 'draft') {
      throw new StoreConstraintError(draftConstraint, 'version is not a draft');
    }
    return version;
  }

  private nodeAt(nodeId: string): { index: number; row: MemoryNodeRow } | null {
    const index = this.data.nodes.findIndex(
      (n) => n.id === nodeId && n.org_id === this.actor.activeOrgId,
    );
    const row = index === -1 ? undefined : this.data.nodes[index];
    return row === undefined ? null : { index, row };
  }

  private itemAt(itemId: string): { index: number; row: MemoryItemRow } | null {
    const index = this.data.items.findIndex(
      (i) => i.id === itemId && i.org_id === this.actor.activeOrgId,
    );
    const row = index === -1 ? undefined : this.data.items[index];
    return row === undefined ? null : { index, row };
  }

  /**
   * `content.next_sort_key(version, parent, after_id, exclude_id)`, including its recovery.
   *
   * Sibling sets include SOFT-DELETED rows, because `nodes_sibling_order_key` is not partial on
   * `deleted_at`: a deleted node keeps its slot so undo restores it where it was.
   */
  private nextNodeSortKey(
    versionId: string,
    parentId: string | null,
    afterId: string | null,
    excludeId: string | null,
  ): string {
    const compute = (): string => {
      let before: string | null = null;
      if (afterId !== null) {
        const anchor = this.data.nodes.find(
          (n) => n.survey_version_id === versionId && n.id === afterId,
        );
        if (anchor === undefined) {
          throw new StoreConstraintError(
            'nodes_survey_version_id_parent_id_fkey',
            `node ${afterId} does not exist in version ${versionId}`,
          );
        }
        before = anchor.sort_key;
      }
      const upper = this.data.nodes
        .filter(
          (n) =>
            n.survey_version_id === versionId &&
            (n.parent_id ?? null) === parentId &&
            (excludeId === null || n.id !== excludeId) &&
            (before === null || n.sort_key > before),
        )
        .map((n) => n.sort_key)
        .sort()[0] ?? null;
      return fracKeyBetween(before, upper);
    };
    try {
      return compute();
    } catch (error: unknown) {
      // frac_key_at's documented escape hatch, and the reason `content.rebalance_siblings`
      // exists: rebalance once, then retry once. A second failure is a real bug, not a full set.
      if (!(error instanceof FracKeyExhausted)) throw error;
      this.rebalanceSiblings(versionId, parentId);
      return compute();
    }
  }

  /** `content.rebalance_siblings` — O(siblings) writes, amortized over thousands of edits. */
  private rebalanceSiblings(versionId: string, parentId: string | null): number {
    const set = this.data.nodes
      .filter((n) => n.survey_version_id === versionId && (n.parent_id ?? null) === parentId)
      .sort(bySortKey);
    if (set.length === 0) return 0;
    const width = rebalanceWidth(set.length);
    set.forEach((row, position) => {
      const at = this.nodeAt(row.id);
      if (at === null) return;
      this.data.nodes[at.index] = { ...at.row, sort_key: fracKeyAtPosition(position + 1, width) };
      this.data.recordWrite('content.nodes', 'update', row.id);
    });
    return set.length;
  }

  /** `content.next_item_sort_key` / `content.rebalance_items`, the same two functions per item set. */
  private nextItemSortKey(
    versionId: string,
    questionId: string,
    kind: ItemKind,
    afterId: string | null,
    excludeId: string | null,
  ): string {
    const compute = (): string => {
      let before: string | null = null;
      if (afterId !== null) {
        const anchor = this.data.items.find(
          (i) => i.survey_version_id === versionId && i.id === afterId,
        );
        if (anchor === undefined) {
          throw new StoreConstraintError(
            'question_items_survey_version_id_question_id_fkey',
            `item ${afterId} does not exist in version ${versionId}`,
          );
        }
        before = anchor.sort_key;
      }
      const upper = this.data.items
        .filter(
          (i) =>
            i.survey_version_id === versionId &&
            i.question_id === questionId &&
            i.item_kind === kind &&
            (excludeId === null || i.id !== excludeId) &&
            (before === null || i.sort_key > before),
        )
        .map((i) => i.sort_key)
        .sort()[0] ?? null;
      return fracKeyBetween(before, upper);
    };
    try {
      return compute();
    } catch (error: unknown) {
      if (!(error instanceof FracKeyExhausted)) throw error;
      this.rebalanceItems(versionId, questionId, kind);
      return compute();
    }
  }

  private rebalanceItems(versionId: string, questionId: string, kind: ItemKind): number {
    const set = this.data.items
      .filter(
        (i) =>
          i.survey_version_id === versionId && i.question_id === questionId && i.item_kind === kind,
      )
      .sort(bySortKey);
    if (set.length === 0) return 0;
    const width = rebalanceWidth(set.length);
    set.forEach((row, position) => {
      const at = this.itemAt(row.id);
      if (at === null) return;
      this.data.items[at.index] = { ...at.row, sort_key: fracKeyAtPosition(position + 1, width) };
      this.data.recordWrite('content.question_items', 'update', row.id);
    });
    return set.length;
  }

  /**
   * A `SiblingPosition` → the `after_id` `content.next_sort_key` understands.
   *
   * `before_id` becomes the predecessor of that sibling; an absent position becomes the LAST
   * sibling (append), which is `SiblingPosition`'s documented default and not the same thing as
   * an explicit `after_id: null` (first).
   */
  private resolveNodeAfter(
    versionId: string,
    parentId: string | null,
    position: SiblingPosition,
    excludeId: string | null,
  ): string | null {
    if (position.before_id === undefined && position.after_id === undefined) {
      const siblings = this.data.nodes
        .filter(
          (n) =>
            n.survey_version_id === versionId &&
            (n.parent_id ?? null) === parentId &&
            (excludeId === null || n.id !== excludeId),
        )
        .sort(bySortKey);
      return siblings[siblings.length - 1]?.id ?? null;
    }
    if (position.before_id === undefined) return position.after_id ?? null;
    const target = this.data.nodes.find(
      (n) => n.survey_version_id === versionId && n.id === position.before_id,
    );
    if (target === undefined) {
      throw new StoreConstraintError(
        'nodes_survey_version_id_parent_id_fkey',
        `node ${position.before_id} does not exist in version ${versionId}`,
      );
    }
    const predecessors = this.data.nodes
      .filter(
        (n) =>
          n.survey_version_id === versionId &&
          (n.parent_id ?? null) === parentId &&
          n.sort_key < target.sort_key &&
          (excludeId === null || n.id !== excludeId),
      )
      .sort(bySortKey);
    return predecessors[predecessors.length - 1]?.id ?? null;
  }

  private resolveItemAfter(
    versionId: string,
    questionId: string,
    kind: ItemKind,
    position: SiblingPosition,
    excludeId: string | null,
  ): string | null {
    if (position.before_id === undefined && position.after_id === undefined) {
      const siblings = this.data.items
        .filter(
          (i) =>
            i.survey_version_id === versionId &&
            i.question_id === questionId &&
            i.item_kind === kind &&
            (excludeId === null || i.id !== excludeId),
        )
        .sort(bySortKey);
      return siblings[siblings.length - 1]?.id ?? null;
    }
    if (position.before_id === undefined) return position.after_id ?? null;
    const target = this.data.items.find(
      (i) => i.survey_version_id === versionId && i.id === position.before_id,
    );
    if (target === undefined) {
      throw new StoreConstraintError(
        'question_items_survey_version_id_question_id_fkey',
        `item ${position.before_id} does not exist in version ${versionId}`,
      );
    }
    const predecessors = this.data.items
      .filter(
        (i) =>
          i.survey_version_id === versionId &&
          i.question_id === questionId &&
          i.item_kind === kind &&
          i.sort_key < target.sort_key &&
          (excludeId === null || i.id !== excludeId),
      )
      .sort(bySortKey);
    return predecessors[predecessors.length - 1]?.id ?? null;
  }

  /** `nodes_kind_shape` and `nodes_root_is_block` — 0007's two CHECKs, by name. */
  private assertNodeShape(row: MemoryNodeRow): void {
    const shaped =
      row.node_kind === 'question'
        ? row.question_type !== null && row.ref !== null && row.required !== null
        : row.node_kind === 'text'
          ? row.question_type === null && row.label_key !== null
          : row.question_type === null && row.ref !== null;
    if (!shaped) {
      throw new StoreConstraintError(
        'nodes_kind_shape',
        `a ${row.node_kind} node is missing a column its kind requires`,
      );
    }
    if (row.parent_id === null && row.node_kind !== 'block') {
      throw new StoreConstraintError('nodes_root_is_block', 'only a block may be a root node');
    }
  }

  /** `nodes_ref_key`: unique on `lower(ref)` per version, live rows only, NULL exempt. */
  private assertNodeRefFree(versionId: string, ref: string | null, selfId: string | null): void {
    if (ref === null) return;
    // The seeded projection counts as taken, for `seededNodes`' reason: the tree read and the
    // registry read both show those nodes, so a ref that collides with one would be a duplicate
    // the fixture can see and the index would refuse.
    const taken = [...this.data.nodes, ...this.seededNodes(versionId)].some(
      (n) =>
        n.survey_version_id === versionId &&
        n.deleted_at === null &&
        n.id !== selfId &&
        n.ref !== null &&
        n.ref.toLowerCase() === ref.toLowerCase(),
    );
    if (taken) throw new StoreConstraintError('nodes_ref_key', `ref ${ref} is already in use`);
  }

  /** `qitems_ref_key`, `qitems_code_key` and `qitems_anchor_shape`. */
  private assertItemShape(row: MemoryItemRow): void {
    if (!/^(none|first|last|fixed:\d{1,4})$/.test(row.anchor)) {
      throw new StoreConstraintError('qitems_anchor_shape', `${row.anchor} is not an anchor`);
    }
    const peers = this.data.items.filter(
      (i) =>
        i.survey_version_id === row.survey_version_id &&
        i.question_id === row.question_id &&
        i.item_kind === row.item_kind &&
        i.deleted_at === null &&
        i.id !== row.id,
    );
    if (peers.some((i) => i.ref.toLowerCase() === row.ref.toLowerCase())) {
      throw new StoreConstraintError('qitems_ref_key', `item ref ${row.ref} is already in use`);
    }
    // The export contract: two options of one question cannot claim the same code. This is the
    // constraint that makes "code and display order are separate fields" enforceable rather than
    // conventional — a bulk paste with a duplicated code is refused here, not renumbered.
    if (peers.some((i) => i.code === row.code)) {
      throw new StoreConstraintError('qitems_code_key', `code ${row.code} is already in use`);
    }
  }

  /** The variables table's CHECKs, its two unique indexes, and its reserved-name trigger. */
  private assertVariableShape(row: MemoryVariableRow): void {
    if (isReservedVariableName(row.name)) {
      throw new StoreConstraintError(
        'variables_reserved_name',
        `${row.name} is in the reserved system namespace`,
      );
    }
    if ((row.vtype === 'enum' || row.vtype === 'set') && row.enum_domain === null) {
      throw new StoreConstraintError('vars_enum_domain', `${row.name} is ${row.vtype} with no domain`);
    }
    if (row.kind === 'response' && row.source_question_id === null) {
      throw new StoreConstraintError('vars_response_has_source', `${row.name} has no source`);
    }
    if (!row.persist && row.kind !== 'derived' && row.kind !== 'system') {
      throw new StoreConstraintError('vars_transient', `${row.name} is ${row.kind} and not persisted`);
    }
    const peers = this.data.variables.filter(
      (v) =>
        v.survey_version_id === row.survey_version_id && v.deleted_at === null && v.id !== row.id,
    );
    if (peers.some((v) => v.name.toLowerCase() === row.name.toLowerCase())) {
      throw new StoreConstraintError('variables_name_key', `variable ${row.name} already exists`);
    }
    if (
      row.export_include &&
      peers.some(
        (v) => v.export_include && v.export_column.toLowerCase() === row.export_column.toLowerCase(),
      )
    ) {
      throw new StoreConstraintError(
        'variables_export_col_key',
        `export column ${row.export_column} is already claimed`,
      );
    }
  }

  /** A manifest key that sorts after every variable minted earlier in this version. */
  private mintVariableSortKey(versionId: string): string {
    const highest = this.data.variables
      .filter((v) => v.survey_version_id === versionId)
      .map((v) => v.sort_key)
      .sort()
      .pop() ?? null;
    return fracKeyBetween(highest, null);
  }

  /**
   * `content.nodes` + `content.question_items` + `content.question_cells` + `content.variables`,
   * with 0007's policies, triggers and constraints reproduced BY NAME so a failing test names
   * the same thing a failing statement would.
   *
   * The ordering functions are the emulation that matters: `sort_key` is never accepted from a
   * caller and is computed here by the transliteration of `content.frac_key_at` in
   * `frac-key.ts`, so a move is one row write in this store exactly as it is in Postgres — and
   * `MemoryDataset.writes` is what lets a test say so.
   */
  readonly nodes: NodeRepo = {
    tree: async (versionId: string): Promise<readonly TreeRowRecord[] | null> => {
      // `content.tree_rows` is SECURITY INVOKER, so the rows are the caller's; the reviewer floor
      // is `nodes_select`'s. A version in another org is `null` — a 404 upstream, never an empty
      // outline, because an empty outline is a plausible answer for a real version.
      const version = await this.surveys.getVersion(versionId);
      if (version === null || !this.hasRole('reviewer')) return null;
      const live = [
        ...this.data.nodes.filter(
          (n) => n.survey_version_id === versionId && n.deleted_at === null,
        ),
        // The seeded projection, same union as `registry.forVersion` and for the same reason: the
        // fixture in `src/test/registry-fixture.ts` predates `content.nodes` being modelled here,
        // five suites are written against it, and the tree read must see the same tree the
        // registry read does or a rule could target a node the outline does not show.
        ...this.seededNodes(versionId),
      ];
      // The recursive CTE's document order: the path of sort keys from the root, chr(1)-joined.
      // Same separator, same reason — it sorts below every character `content.sort_key` permits,
      // so no sibling's key can be a prefix of another's path segment.
      const pathOf = (row: MemoryNodeRow): string => {
        const parts: string[] = [];
        let current: MemoryNodeRow | undefined = row;
        const seen = new Set<string>();
        while (current !== undefined && !seen.has(current.id)) {
          seen.add(current.id);
          parts.unshift(current.sort_key);
          const parentId: string | null = current.parent_id;
          current =
            parentId === null
              ? undefined
              : live.find((n) => n.id === parentId);
        }
        return parts.join('');
      };
      const walked = live
        // A node whose parent is soft-deleted is not reachable from a root, so the CTE never
        // emits it: a deleted subtree disappears from the tree while its ids stay alive for undo.
        .filter((n) => n.parent_id === null || live.some((p) => p.id === n.parent_id))
        .map((n) => ({ row: n, path: pathOf(n), depth: pathOf(n).split('').length }))
        .sort((a, b) => (a.path === b.path ? (a.row.id < b.row.id ? -1 : 1) : a.path < b.path ? -1 : 1));
      return walked.map((entry, index) => ({
        id: entry.row.id,
        node_kind: entry.row.node_kind,
        parent_id: entry.row.parent_id,
        sort_key: entry.row.sort_key,
        depth: entry.depth,
        ordinal: index + 1,
        ref: entry.row.ref,
        label_key: entry.row.label_key,
        instruction_key: entry.row.instruction_key,
        title_key: entry.row.title_key,
        question_type: entry.row.question_type,
        required: entry.row.required,
        settings: entry.row.settings,
        flags: entry.row.flags,
        emits: [...entry.row.emits],
        item_count: this.data.items.filter(
          (i) => i.question_id === entry.row.id && i.survey_version_id === versionId && i.deleted_at === null,
        ).length,
        child_count: live.filter((n) => n.parent_id === entry.row.id).length,
        emit_count: entry.row.emits.length,
        pii: entry.row.flags['pii'] === true,
        has_custom_js: entry.row.flags['has_custom_js'] === true,
        updated_at: entry.row.updated_at,
      }));
    },

    get: async (nodeId: string): Promise<NodeRow | null> => {
      const at = this.nodeAt(nodeId);
      if (at === null || at.row.deleted_at !== null || !this.hasRole('reviewer')) return null;
      const version = await this.surveys.getVersion(at.row.survey_version_id);
      return version === null ? null : toNodeRow(at.row);
    },

    getDeleted: async (nodeId: string): Promise<NodeRow | null> => {
      const at = this.nodeAt(nodeId);
      if (at === null || !this.hasRole('reviewer')) return null;
      const version = await this.surveys.getVersion(at.row.survey_version_id);
      return version === null ? null : toNodeRow(at.row);
    },

    subtree: async (nodeId: string, includeDeleted = false): Promise<readonly NodeRow[]> => {
      const at = this.nodeAt(nodeId);
      if (at === null || !this.hasRole('reviewer')) return [];
      const version = await this.surveys.getVersion(at.row.survey_version_id);
      if (version === null) return [];
      const scope = this.data.nodes.filter(
        (n) =>
          n.survey_version_id === at.row.survey_version_id &&
          (includeDeleted || n.deleted_at === null),
      );
      const out: MemoryNodeRow[] = [];
      const walk = (row: MemoryNodeRow): void => {
        out.push(row);
        for (const child of scope.filter((n) => n.parent_id === row.id).sort(bySortKey)) {
          walk(child);
        }
      };
      if (includeDeleted || at.row.deleted_at === null) walk(at.row);
      return out.map(toNodeRow);
    },

    create: async (input: CreateNodeInput): Promise<NodeRow> => {
      const version = await this.writableVersion(
        input.survey_version_id,
        'nodes_insert',
        'nodes_draft_only',
      );
      if (input.parent_id !== null) {
        const parent = this.data.nodes.find(
          (n) => n.survey_version_id === version.id && n.id === input.parent_id,
        );
        if (parent === undefined) {
          throw new StoreConstraintError(
            'nodes_survey_version_id_parent_id_fkey',
            `parent ${input.parent_id} does not exist in version ${version.id}`,
          );
        }
      }
      this.assertNodeRefFree(version.id, input.ref ?? null, null);
      const afterId = this.resolveNodeAfter(version.id, input.parent_id, input, null);
      // Server-computed, always: API §3 item 6 — a client never sees a fractional key and
      // cannot corrupt the ordering by inventing one.
      const sortKey = this.nextNodeSortKey(version.id, input.parent_id, afterId, null);
      const row = this.data.seedNode({
        org_id: version.org_id,
        survey_version_id: version.id,
        node_kind: input.node_kind,
        parent_id: input.parent_id,
        sort_key: sortKey,
        ...(input.ref === undefined ? {} : { ref: input.ref }),
        ...(input.question_type === undefined ? {} : { question_type: input.question_type }),
        ...(input.label_key === undefined ? {} : { label_key: input.label_key }),
        ...(input.instruction_key === undefined ? {} : { instruction_key: input.instruction_key }),
        ...(input.title_key === undefined ? {} : { title_key: input.title_key }),
        ...(input.required === undefined ? {} : { required: input.required }),
        ...(input.config === undefined ? {} : { config: input.config }),
        ...(input.settings === undefined ? {} : { settings: input.settings }),
        ...(input.flags === undefined ? {} : { flags: input.flags }),
      });
      try {
        this.assertNodeShape(row);
      } catch (error: unknown) {
        // The CHECK fires BEFORE the row exists in Postgres; here it fires after, so the row is
        // withdrawn rather than left behind for the next assertion to trip over.
        this.data.nodes.splice(this.data.nodes.indexOf(row), 1);
        throw error;
      }
      return toNodeRow(row);
    },

    update: async (nodeId: string, patch: UpdateNodeInput): Promise<NodeRow> => {
      const at = this.nodeAt(nodeId);
      if (at === null || at.row.deleted_at !== null || !this.hasRole('programmer')) {
        throw new StoreConstraintError('nodes_update', 'no rows updated');
      }
      await this.writableVersion(at.row.survey_version_id, 'nodes_update', 'nodes_draft_only');
      if (patch.ref !== undefined) {
        this.assertNodeRefFree(at.row.survey_version_id, patch.ref, nodeId);
      }
      const next: MemoryNodeRow = {
        ...at.row,
        ...(patch.ref === undefined ? {} : { ref: patch.ref }),
        ...(patch.label_key === undefined ? {} : { label_key: patch.label_key }),
        ...(patch.instruction_key === undefined ? {} : { instruction_key: patch.instruction_key }),
        ...(patch.title_key === undefined ? {} : { title_key: patch.title_key }),
        ...(patch.required === undefined ? {} : { required: patch.required }),
        ...(patch.config === undefined ? {} : { config: patch.config }),
        ...(patch.settings === undefined ? {} : { settings: patch.settings }),
        ...(patch.flags === undefined ? {} : { flags: patch.flags }),
        ...(patch.validation === undefined ? {} : { validation: [...patch.validation] }),
        ...(patch.masks === undefined ? {} : { masks: [...patch.masks] }),
        ...(patch.scripts === undefined ? {} : { scripts: patch.scripts }),
        updated_at: this.data.now(),
      };
      this.assertNodeShape(next);
      this.data.nodes[at.index] = next;
      this.data.recordWrite('content.nodes', 'update', nodeId);
      return toNodeRow(next);
    },

    move: async (nodeId: string, input: MoveNodeInput): Promise<NodeRow> => {
      const at = this.nodeAt(nodeId);
      if (at === null || at.row.deleted_at !== null || !this.hasRole('programmer')) {
        throw new StoreConstraintError('nodes_update', 'no rows updated');
      }
      const versionId = at.row.survey_version_id;
      await this.writableVersion(versionId, 'nodes_update', 'nodes_draft_only');
      const scope = this.data.nodes.filter((n) => n.survey_version_id === versionId);

      if (input.parent_id !== null) {
        const parent = scope.find((n) => n.id === input.parent_id);
        if (parent === undefined) {
          throw new StoreConstraintError(
            'nodes_survey_version_id_parent_id_fkey',
            `parent ${input.parent_id} does not exist in version ${versionId}`,
          );
        }
        // `content.move_node`'s first refusal: a subtree cannot be moved into itself. The FK
        // cannot express it and the recursive read would simply never terminate.
        const ancestors = new Set<string>();
        let cursor: MemoryNodeRow | undefined = parent;
        while (cursor !== undefined && !ancestors.has(cursor.id)) {
          ancestors.add(cursor.id);
          const parentId: string | null = cursor.parent_id;
          cursor = parentId === null ? undefined : scope.find((n) => n.id === parentId);
        }
        if (ancestors.has(nodeId)) {
          throw new StoreConstraintError(
            'nodes_move_into_subtree',
            `cannot move node ${nodeId} into its own subtree`,
          );
        }
        // Its second: C §5's nesting rules.
        if (!nestingAllowed(parent.node_kind, at.row.node_kind)) {
          throw new StoreConstraintError(
            'nodes_nesting',
            `a ${parent.node_kind} may not contain a ${at.row.node_kind}`,
          );
        }
      } else if (at.row.node_kind !== 'block') {
        throw new StoreConstraintError('nodes_root_is_block', 'only a block may be a root node');
      }

      const afterId = this.resolveNodeAfter(versionId, input.parent_id, input, nodeId);
      const sortKey = this.nextNodeSortKey(versionId, input.parent_id, afterId, nodeId);
      // ONE row. This is the whole argument of B §4.6, and `MemoryDataset.writes` is where a
      // test reads it back: with integer positions this would be N updates of N siblings.
      const next: MemoryNodeRow = {
        ...at.row,
        parent_id: input.parent_id,
        sort_key: sortKey,
        updated_at: this.data.now(),
      };
      this.data.nodes[at.index] = next;
      this.data.recordWrite('content.nodes', 'update', nodeId);
      // Amortized maintenance, AFTER the move is durable — and only past the length budget, so
      // the common drag stays a single-row write.
      const longest = Math.max(
        ...this.data.nodes
          .filter((n) => n.survey_version_id === versionId && (n.parent_id ?? null) === input.parent_id)
          .map((n) => n.sort_key.length),
        0,
      );
      if (longest > REBALANCE_KEY_LENGTH) this.rebalanceSiblings(versionId, input.parent_id);
      const moved = this.nodeAt(nodeId);
      return toNodeRow(moved === null ? next : moved.row);
    },

    softDelete: async (nodeIds: readonly string[]): Promise<readonly NodeRow[]> => {
      const out: NodeRow[] = [];
      // ONE timestamp for the whole subtree, because in Postgres this is ONE `UPDATE … IN (…)`
      // and `now()` is fixed for the statement. That is not cosmetic: `POST /undelete` restores
      // exactly the rows whose `deleted_at` matches the root's, which is how undo restores what
      // the cascade removed and not a question somebody deleted last week.
      const deletedAt = this.data.now();
      for (const nodeId of nodeIds) {
        const at = this.nodeAt(nodeId);
        if (at === null || at.row.deleted_at !== null || !this.hasRole('programmer')) {
          throw new StoreConstraintError('nodes_update', 'no rows updated');
        }
        await this.writableVersion(at.row.survey_version_id, 'nodes_update', 'nodes_draft_only');
        // Soft, and through the UPDATE policy rather than DELETE: the row stays for undo, which
        // is the only reason undo can restore logic that referenced the node (UI §5).
        const next: MemoryNodeRow = { ...at.row, deleted_at: deletedAt };
        this.data.nodes[at.index] = next;
        this.data.recordWrite('content.nodes', 'update', nodeId);
        out.push(toNodeRow(next));
      }
      return out;
    },

    undelete: async (nodeIds: readonly string[]): Promise<readonly NodeRow[]> => {
      const out: NodeRow[] = [];
      for (const nodeId of nodeIds) {
        const at = this.nodeAt(nodeId);
        if (at === null || !this.hasRole('programmer')) {
          throw new StoreConstraintError('nodes_update', 'no rows updated');
        }
        await this.writableVersion(at.row.survey_version_id, 'nodes_update', 'nodes_draft_only');
        // The ref was released the moment the node was deleted (`nodes_ref_key` is partial on
        // `deleted_at`), so undelete can legitimately collide with a node created since.
        this.assertNodeRefFree(at.row.survey_version_id, at.row.ref, nodeId);
        const next: MemoryNodeRow = { ...at.row, deleted_at: null };
        this.data.nodes[at.index] = next;
        this.data.recordWrite('content.nodes', 'update', nodeId);
        out.push(toNodeRow(next));
      }
      return out;
    },

    duplicate: async (input: DuplicateInput): Promise<DuplicatedSubtree> => {
      const origin = this.nodeAt(input.node_id);
      if (origin === null || origin.row.deleted_at !== null || !this.hasRole('programmer')) {
        throw new StoreConstraintError('nodes_insert', 'no rows inserted');
      }
      const versionId = origin.row.survey_version_id;
      const version = await this.writableVersion(versionId, 'nodes_insert', 'nodes_draft_only');
      const refFor = new Map(input.refs.map((spec) => [spec.id, spec.ref]));
      const source = await this.nodes.subtree(input.node_id);
      const idMap = new Map<string, string>();

      const parentId =
        input.into_parent_id === undefined ? origin.row.parent_id : input.into_parent_id;
      const afterId = this.resolveNodeAfter(versionId, parentId, input, null);
      const rootKey = this.nextNodeSortKey(versionId, parentId, afterId, null);

      const nodes: NodeRow[] = [];
      for (const node of source) {
        const copyRef = refFor.get(node.id) ?? null;
        this.assertNodeRefFree(versionId, copyRef, null);
        const isRoot = node.id === input.node_id;
        const copy = this.data.seedNode({
          org_id: version.org_id,
          survey_version_id: versionId,
          node_kind: node.node_kind,
          parent_id: isRoot ? parentId : idMap.get(node.parent_id ?? '') ?? null,
          // A descendant keeps its key: its parent is a NEW row, so the sibling set it joins is
          // empty of everything but its own copies and no key can collide.
          sort_key: isRoot ? rootKey : node.sort_key,
          ...(copyRef === null ? {} : { ref: copyRef }),
          ...(node.question_type === null ? {} : { question_type: node.question_type }),
          ...(node.label_key === null ? {} : { label_key: node.label_key }),
          ...(node.instruction_key === null ? {} : { instruction_key: node.instruction_key }),
          ...(node.title_key === null ? {} : { title_key: node.title_key }),
          ...(node.required === null ? {} : { required: node.required }),
          config: node.config,
          settings: node.settings,
          validation: [...node.validation],
          masks: [...node.masks],
          scripts: node.scripts,
          flags: node.flags,
          // `emits` is deliberately EMPTY on the copy: the variables are recomputed from the
          // plugin against the copy's own ref, and carrying the original's ids would make two
          // questions claim one export column.
          emits: [],
        });
        this.assertNodeShape(copy);
        idMap.set(node.id, copy.id);
        nodes.push(toNodeRow(copy));
      }

      const items: ItemRow[] = [];
      for (const node of source) {
        const newQuestionId = idMap.get(node.id);
        if (newQuestionId === undefined) continue;
        for (const item of this.data.items
          .filter(
            (i) => i.survey_version_id === versionId && i.question_id === node.id && i.deleted_at === null,
          )
          .sort(bySortKey)) {
          const copy = this.data.seedItem({
            org_id: version.org_id,
            survey_version_id: versionId,
            question_id: newQuestionId,
            item_kind: item.item_kind,
            // ref and code are unique per (question, kind) and the question is new, so both
            // survive the copy — and `code` MUST, because it is the exported value.
            ref: item.ref,
            code: item.code,
            sort_key: item.sort_key,
            ...(item.label_key === null ? {} : { label_key: item.label_key }),
            anchor: item.anchor,
            exclusive: item.exclusive,
            behaviour: item.behaviour,
            ...(item.value_override === null ? {} : { value_override: item.value_override }),
            ...(item.custom_class === null ? {} : { custom_class: item.custom_class }),
            meta: item.meta,
          });
          idMap.set(item.id, copy.id);
          items.push(toItemRow(copy));
        }
      }

      const cells: CellRow[] = [];
      for (const node of source) {
        const newQuestionId = idMap.get(node.id);
        if (newQuestionId === undefined) continue;
        for (const cell of this.data.cells.filter(
          (c) => c.survey_version_id === versionId && c.question_id === node.id,
        )) {
          const rowItemId = idMap.get(cell.row_item_id);
          if (rowItemId === undefined) continue;
          const copy: MemoryCellRow = {
            id: this.data.id('cel'),
            survey_version_id: versionId,
            org_id: version.org_id,
            question_id: newQuestionId,
            row_item_id: rowItemId,
            column_item_id:
              cell.column_item_id === null ? null : idMap.get(cell.column_item_id) ?? null,
            question_type: cell.question_type,
            config: cell.config,
            use_columns: cell.use_columns,
          };
          this.data.cells.push(copy);
          this.data.recordWrite('content.question_cells', 'insert', copy.id);
          cells.push(toCellRow(copy));
        }
      }

      return { nodes, items, cells, id_map: idMap };
    },

    listItems: async (nodeId: string, kind?: ItemKind): Promise<readonly ItemRow[]> => {
      const node = await this.nodes.get(nodeId);
      if (node === null) return [];
      return this.data.items
        .filter(
          (i) =>
            i.survey_version_id === node.survey_version_id &&
            i.question_id === nodeId &&
            i.deleted_at === null &&
            (kind === undefined || i.item_kind === kind),
        )
        .sort(bySortKey)
        .map(toItemRow);
    },

    getItem: async (itemId: string): Promise<ItemRow | null> => {
      const at = this.itemAt(itemId);
      if (at === null || at.row.deleted_at !== null || !this.hasRole('reviewer')) return null;
      const version = await this.surveys.getVersion(at.row.survey_version_id);
      return version === null ? null : toItemRow(at.row);
    },

    createItem: async (nodeId: string, input: CreateItemInput): Promise<ItemRow> => {
      const node = await this.nodes.get(nodeId);
      if (node === null || !this.hasRole('programmer')) {
        throw new StoreConstraintError('qitems_insert', 'no rows inserted');
      }
      const version = await this.writableVersion(
        node.survey_version_id,
        'qitems_insert',
        'qitems_draft_only',
      );
      const afterId = this.resolveItemAfter(version.id, nodeId, input.item_kind, input, null);
      const sortKey = this.nextItemSortKey(version.id, nodeId, input.item_kind, afterId, null);
      const row = this.data.seedItem({
        org_id: version.org_id,
        survey_version_id: version.id,
        question_id: nodeId,
        item_kind: input.item_kind,
        ref: input.ref,
        code: input.code,
        sort_key: sortKey,
        ...(input.label_key === undefined ? {} : { label_key: input.label_key }),
        ...(input.anchor === undefined ? {} : { anchor: input.anchor }),
        ...(input.exclusive === undefined ? {} : { exclusive: input.exclusive }),
        ...(input.behaviour === undefined ? {} : { behaviour: input.behaviour }),
        ...(input.value_override === undefined ? {} : { value_override: input.value_override }),
        ...(input.custom_class === undefined ? {} : { custom_class: input.custom_class }),
        ...(input.meta === undefined ? {} : { meta: input.meta }),
      });
      try {
        this.assertItemShape(row);
      } catch (error: unknown) {
        this.data.items.splice(this.data.items.indexOf(row), 1);
        throw error;
      }
      return toItemRow(row);
    },

    updateItem: async (itemId: string, patch: UpdateItemInput): Promise<ItemRow> => {
      const at = this.itemAt(itemId);
      if (at === null || at.row.deleted_at !== null || !this.hasRole('programmer')) {
        throw new StoreConstraintError('qitems_update', 'no rows updated');
      }
      await this.writableVersion(at.row.survey_version_id, 'qitems_update', 'qitems_draft_only');
      const next: MemoryItemRow = {
        ...at.row,
        ...(patch.ref === undefined ? {} : { ref: patch.ref }),
        ...(patch.code === undefined ? {} : { code: patch.code }),
        ...(patch.label_key === undefined ? {} : { label_key: patch.label_key }),
        ...(patch.anchor === undefined ? {} : { anchor: patch.anchor }),
        ...(patch.exclusive === undefined ? {} : { exclusive: patch.exclusive }),
        ...(patch.behaviour === undefined ? {} : { behaviour: patch.behaviour }),
        ...(patch.value_override === undefined ? {} : { value_override: patch.value_override }),
        ...(patch.custom_class === undefined ? {} : { custom_class: patch.custom_class }),
        ...(patch.meta === undefined ? {} : { meta: patch.meta }),
        updated_at: this.data.now(),
      };
      this.assertItemShape(next);
      this.data.items[at.index] = next;
      this.data.recordWrite('content.question_items', 'update', itemId);
      return toItemRow(next);
    },

    moveItem: async (itemId: string, position: SiblingPosition): Promise<ItemRow> => {
      const at = this.itemAt(itemId);
      if (at === null || at.row.deleted_at !== null || !this.hasRole('programmer')) {
        throw new StoreConstraintError('qitems_update', 'no rows updated');
      }
      const versionId = at.row.survey_version_id;
      await this.writableVersion(versionId, 'qitems_update', 'qitems_draft_only');
      const afterId = this.resolveItemAfter(
        versionId,
        at.row.question_id,
        at.row.item_kind,
        position,
        itemId,
      );
      const sortKey = this.nextItemSortKey(
        versionId,
        at.row.question_id,
        at.row.item_kind,
        afterId,
        itemId,
      );
      // ONE row, and `code` is untouched — C §5.1's whole point, and the acceptance criterion:
      // "reorders a 60-option list by dragging, and the database shows one UPDATE per drag".
      const next: MemoryItemRow = { ...at.row, sort_key: sortKey, updated_at: this.data.now() };
      this.data.items[at.index] = next;
      this.data.recordWrite('content.question_items', 'update', itemId);
      const longest = Math.max(
        ...this.data.items
          .filter(
            (i) =>
              i.survey_version_id === versionId &&
              i.question_id === at.row.question_id &&
              i.item_kind === at.row.item_kind,
          )
          .map((i) => i.sort_key.length),
        0,
      );
      if (longest > REBALANCE_KEY_LENGTH) {
        this.rebalanceItems(versionId, at.row.question_id, at.row.item_kind);
      }
      const moved = this.itemAt(itemId);
      return toItemRow(moved === null ? next : moved.row);
    },

    removeItem: async (itemId: string): Promise<void> => {
      const at = this.itemAt(itemId);
      if (at === null || at.row.deleted_at !== null || !this.hasRole('programmer')) {
        throw new StoreConstraintError('qitems_update', 'no rows updated');
      }
      await this.writableVersion(at.row.survey_version_id, 'qitems_update', 'qitems_draft_only');
      this.data.items[at.index] = { ...at.row, deleted_at: this.data.now() };
      this.data.recordWrite('content.question_items', 'update', itemId);
    },

    bulkItems: async (
      nodeId: string,
      kind: ItemKind,
      mode: 'replace' | 'append',
      items: readonly BulkItemInput[],
    ): Promise<readonly ItemRow[]> => {
      const node = await this.nodes.get(nodeId);
      if (node === null || !this.hasRole('programmer')) {
        throw new StoreConstraintError('qitems_insert', 'no rows inserted');
      }
      const version = await this.writableVersion(
        node.survey_version_id,
        'qitems_insert',
        'qitems_draft_only',
      );
      const existing = this.data.items
        .filter(
          (i) =>
            i.survey_version_id === version.id &&
            i.question_id === nodeId &&
            i.item_kind === kind &&
            i.deleted_at === null,
        )
        .sort(bySortKey);

      // ATOMIC (API §1.6's default). Every row is checked against the FINAL set before anything
      // is written, because a half-pasted brand list is a question that fails publish for a
      // reason the author did not cause — and because `mode: 'replace'` would otherwise leave the
      // question with no options at all when row 42 duplicates a code.
      const codes = new Set<number>();
      const refs = new Set<string>();
      if (mode === 'append') {
        for (const row of existing) {
          codes.add(row.code);
          refs.add(row.ref.toLowerCase());
        }
      }
      for (const row of items) {
        if (codes.has(row.code)) {
          throw new StoreConstraintError('qitems_code_key', `code ${row.code} is already in use`);
        }
        if (refs.has(row.ref.toLowerCase())) {
          throw new StoreConstraintError('qitems_ref_key', `item ref ${row.ref} is already in use`);
        }
        if (row.anchor !== undefined && !/^(none|first|last|fixed:\d{1,4})$/.test(row.anchor)) {
          throw new StoreConstraintError('qitems_anchor_shape', `${row.anchor} is not an anchor`);
        }
        codes.add(row.code);
        refs.add(row.ref.toLowerCase());
      }

      if (mode === 'replace') {
        for (const row of existing) {
          const at = this.itemAt(row.id);
          if (at === null) continue;
          this.data.items[at.index] = { ...at.row, deleted_at: this.data.now() };
          this.data.recordWrite('content.question_items', 'update', row.id);
        }
      }

      // Dense fixed-width keys for the whole pasted block — what a rebalanced set looks like, so
      // 60 options pasted at once do not start life with 60 characters of key.
      //
      // PREFIXED with the set's current maximum key, and that is not decoration:
      // `qitems_order_key` is NOT partial on `deleted_at` (a soft-deleted item keeps its slot so
      // undo restores it where it was), so a `replace` cannot reuse the slots it just vacated.
      // Every `max + dense(n)` is strictly greater than `max` — it extends it — and therefore
      // collides with nothing, in either mode, while staying totally ordered among itself.
      const prefix = this.data.items
        .filter(
          (i) =>
            i.survey_version_id === version.id &&
            i.question_id === nodeId &&
            i.item_kind === kind,
        )
        .map((i) => i.sort_key)
        .sort()
        .pop() ?? '';
      const width = rebalanceWidth(items.length);
      let position = 0;
      const written: ItemRow[] = [];
      for (const row of items) {
        position += 1;
        written.push(
          toItemRow(
            this.data.seedItem({
              org_id: version.org_id,
              survey_version_id: version.id,
              question_id: nodeId,
              item_kind: kind,
              ref: row.ref,
              code: row.code,
              sort_key: prefix + fracKeyAtPosition(position, width),
              ...(row.label_key === undefined ? {} : { label_key: row.label_key }),
              ...(row.anchor === undefined ? {} : { anchor: row.anchor }),
              ...(row.exclusive === undefined ? {} : { exclusive: row.exclusive }),
              ...(row.behaviour === undefined ? {} : { behaviour: row.behaviour }),
              ...(row.value_override === undefined ? {} : { value_override: row.value_override }),
              ...(row.custom_class === undefined ? {} : { custom_class: row.custom_class }),
              ...(row.meta === undefined ? {} : { meta: row.meta }),
            }),
          ),
        );
      }
      return written;
    },

    listCells: async (nodeId: string): Promise<readonly CellRow[]> => {
      const node = await this.nodes.get(nodeId);
      if (node === null) return [];
      return this.data.cells
        .filter((c) => c.survey_version_id === node.survey_version_id && c.question_id === nodeId)
        .map(toCellRow);
    },

    replaceCells: async (nodeId: string, cells: readonly CellInput[]): Promise<readonly CellRow[]> => {
      const node = await this.nodes.get(nodeId);
      if (node === null || !this.hasRole('programmer')) {
        throw new StoreConstraintError('qcells_insert', 'no rows inserted');
      }
      const version = await this.writableVersion(
        node.survey_version_id,
        'qcells_insert',
        'qcells_draft_only',
      );
      const seen = new Set<string>();
      for (const cell of cells) {
        if (cell.use_columns === true && (cell.column_item_id ?? null) !== null) {
          throw new StoreConstraintError(
            'qcells_use_columns_is_row_level',
            'use_columns is only meaningful on a whole-row override',
          );
        }
        // `qcells_key`, with the row-level override occupying the empty-string slot: two
        // overrides for one cell is not "last one wins", it is a survey whose data type depends
        // on row order.
        const key = `${cell.row_item_id} ${cell.column_item_id ?? ''}`;
        if (seen.has(key)) throw new StoreConstraintError('qcells_key', 'two overrides for one cell');
        seen.add(key);
        for (const itemId of [cell.row_item_id, cell.column_item_id]) {
          if (itemId === null || itemId === undefined) continue;
          const item = this.data.items.find(
            (i) => i.survey_version_id === version.id && i.id === itemId && i.deleted_at === null,
          );
          if (item === undefined || item.question_id !== nodeId) {
            throw new StoreConstraintError(
              'question_cells_survey_version_id_row_item_id_fkey',
              `item ${String(itemId)} is not an item of ${nodeId}`,
            );
          }
        }
      }
      for (let i = this.data.cells.length - 1; i >= 0; i -= 1) {
        const row = this.data.cells[i];
        if (row !== undefined && row.survey_version_id === version.id && row.question_id === nodeId) {
          this.data.cells.splice(i, 1);
          this.data.recordWrite('content.question_cells', 'delete', row.id);
        }
      }
      for (const cell of cells) {
        const row: MemoryCellRow = {
          id: this.data.id('cel'),
          survey_version_id: version.id,
          org_id: version.org_id,
          question_id: nodeId,
          row_item_id: cell.row_item_id,
          column_item_id: cell.column_item_id ?? null,
          question_type: cell.question_type,
          config: cell.config ?? {},
          use_columns: cell.use_columns ?? false,
        };
        this.data.cells.push(row);
        this.data.recordWrite('content.question_cells', 'insert', row.id);
      }
      return this.nodes.listCells(nodeId);
    },

    listVariables: async (nodeId: string): Promise<readonly VariableRow[]> => {
      const node = await this.nodes.get(nodeId);
      if (node === null) return [];
      return this.data.variables
        .filter(
          (v) =>
            v.survey_version_id === node.survey_version_id &&
            v.source_question_id === nodeId &&
            v.deleted_at === null,
        )
        .sort(bySortKey)
        .map(toVariableRow);
    },

    replaceQuestionVariables: async (
      nodeId: string,
      rows: readonly WriteVariableInput[],
    ): Promise<VariableWriteResult> => {
      const at = this.nodeAt(nodeId);
      if (at === null || at.row.deleted_at !== null || !this.hasRole('programmer')) {
        throw new StoreConstraintError('variables_insert', 'no rows written');
      }
      const version = await this.writableVersion(
        at.row.survey_version_id,
        'variables_insert',
        'variables_draft_only',
      );
      const existing = this.data.variables.filter(
        (v) =>
          v.survey_version_id === version.id &&
          v.source_question_id === nodeId &&
          v.deleted_at === null,
      );
      const wanted = new Set(rows.map((r) => r.id));
      const created: VariableRow[] = [];
      const updated: VariableRow[] = [];
      const removed: VariableRow[] = [];

      // Removals FIRST: an option deleted and re-added under another code would otherwise make
      // the new row collide on `variables_name_key` with the row that is about to disappear.
      for (const row of existing) {
        if (wanted.has(row.id)) continue;
        const index = this.data.variables.indexOf(row);
        const next: MemoryVariableRow = { ...row, deleted_at: this.data.now() };
        this.data.variables[index] = next;
        this.data.recordWrite('content.variables', 'update', row.id);
        removed.push(toVariableRow(next));
      }

      for (const row of rows) {
        const index = this.data.variables.findIndex(
          (v) => v.id === row.id && v.survey_version_id === version.id,
        );
        const previous = index === -1 ? undefined : this.data.variables[index];
        const next: MemoryVariableRow = {
          id: row.id,
          survey_version_id: version.id,
          org_id: version.org_id,
          name: row.name,
          kind: row.kind,
          vtype: row.vtype,
          source_question_id: nodeId,
          source_item_id: row.source_item_id,
          source_part: row.source_part,
          enum_domain: row.enum_domain,
          export_include: row.export_include,
          export_column: row.export_column,
          export_label_key: row.export_label_key,
          pii: row.pii,
          persist: row.persist,
          // The id is carried across a rename, and so is the manifest position: a rename must
          // move nothing in the export layout except the column NAME (ADR-007).
          sort_key: previous?.sort_key ?? this.mintVariableSortKey(version.id),
          created_at: previous?.created_at ?? this.data.now(),
          updated_at: this.data.now(),
          deleted_at: null,
        };
        this.assertVariableShape(next);
        if (previous === undefined) {
          this.data.variables.push(next);
          this.data.recordWrite('content.variables', 'insert', next.id);
          created.push(toVariableRow(next));
        } else {
          this.data.variables[index] = next;
          this.data.recordWrite('content.variables', 'update', next.id);
          updated.push(toVariableRow(next));
        }
      }

      // `nodes.emits`, rewritten wholesale — B §4.4 makes the same argument for rule dependency
      // closures, and 0007's column comment for the same reason: "which columns does Q7 produce"
      // must be answerable by a diff and a text search rather than by running the compiler.
      const node = this.nodeAt(nodeId);
      if (node !== null) {
        this.data.nodes[node.index] = {
          ...node.row,
          emits: rows.map((r) => r.id),
          updated_at: this.data.now(),
        };
        this.data.recordWrite('content.nodes', 'update', nodeId);
      }
      return { created, updated, removed };
    },

    rulesTouching: async (
      versionId: string,
      nodeIds: readonly string[],
      itemIds: readonly string[],
    ): Promise<readonly RuleRow[]> => {
      const version = await this.surveys.getVersion(versionId);
      if (version === null || !this.hasRole('reviewer')) return [];
      const nodes = new Set(nodeIds);
      const items = new Set(itemIds);
      return this.data.rules
        .filter(
          (r) =>
            r.survey_version_id === versionId &&
            r.deleted_at === null &&
            ((r.target_node_id !== null && nodes.has(r.target_node_id)) ||
              (r.target_item_id !== null && items.has(r.target_item_id)) ||
              r.depends_on_node_ids.some((id) => nodes.has(id))),
        )
        .map(toRuleRow);
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

  /* --- vendors (0024) ------------------------------------------------------ */

  readonly vendors: VendorRepo = {
    listVendors: async (versionId: string): Promise<readonly VendorRow[]> => {
      // Visibility through the VERSION, as `vendors_select`'s `app.can_see_version()` does. Note
      // the read floor is PROGRAMMER here and reviewer for every other content table — 0024's
      // reason: a list of secret_refs is a map of the secret store, and a review link is shared
      // outside the programming team.
      const version = await this.surveys.getVersion(versionId);
      if (version === null || !this.hasRole('programmer')) return [];
      return this.data.vendors
        .filter((v) => v.survey_version_id === versionId)
        .sort((a, b) => a.ref.localeCompare(b.ref))
        .map(({ survey_version_id: _v, org_id: _o, ...row }) => row);
    },

    replaceVendors: async (
      versionId: string,
      rows: readonly VendorRow[],
    ): Promise<readonly VendorRow[]> => {
      const version = await this.surveys.getVersion(versionId);
      // One outcome for "no such version", "not yours" and "not programmer", as everywhere else —
      // distinguishing them is an existence oracle across tenants.
      if (version === null || !this.hasRole('programmer')) {
        throw new StoreConstraintError('vendors_insert', 'no rows inserted');
      }
      if (version.status !== 'draft') {
        throw new StoreConstraintError('vendors_draft_only', 'version is not a draft');
      }
      const org = version.org_id;
      const refs = new Set<string>();
      const declared = new Set(
        this.data.variables.filter((v) => v.survey_version_id === versionId).map((v) => v.name),
      );

      for (const row of rows) {
        // 0024's CHECKs, reproduced BY NAME so a failing test names what a failing INSERT would.
        if (row.name.trim() === '') {
          throw new StoreConstraintError('vendors_name_nonempty', 'empty vendor name');
        }
        if (refs.has(row.ref)) {
          throw new StoreConstraintError('vendors_ref_key', `duplicate vendor ref ${row.ref}`);
        }
        refs.add(row.ref);
        if (row.security !== null) {
          // `vendors_signed_params_present`: a signature over nothing verifies everything.
          if (row.security.signed_params.length === 0) {
            throw new StoreConstraintError(
              'vendors_signed_params_present',
              'a signed vendor must name its signed params',
            );
          }
          // `vendors_secret_ref_is_a_reference`: the same heuristic the compiler's assertNoSecrets
          // uses, moved to the write path because every other layer that forbids a secret VALUE
          // sits downstream of a paste into this console.
          if (/^[A-Za-z0-9+/=_-]{32,}$/.test(row.security.secret_ref)) {
            throw new StoreConstraintError(
              'vendors_secret_ref_is_a_reference',
              'secret_ref looks like a secret value, not a reference',
            );
          }
          if (row.security.secret_ref.trim() === '') {
            throw new StoreConstraintError('vendors_secret_ref_nonempty', 'empty secret_ref');
          }
        }
        if (row.max_completes !== null && row.max_completes <= 0) {
          throw new StoreConstraintError('vendors_max_completes_positive', 'max_completes must be > 0');
        }
        const params = new Set<string>();
        for (const p of row.inbound_params) {
          if (!/^[A-Za-z0-9_.-]{1,64}$/.test(p.param)) {
            throw new StoreConstraintError('vendor_params_param_shape', `bad param name ${p.param}`);
          }
          if (params.has(p.param)) {
            throw new StoreConstraintError('vendor_params_pkey', `duplicate param ${p.param}`);
          }
          params.add(p.param);
          // 0024's composite FK to content.variables. Reproduced here because the FK is the whole
          // reason the params are a table rather than a jsonb column.
          if (!declared.has(p.variable_ref)) {
            throw new StoreConstraintError(
              'vendor_params_variable_fk',
              `inbound parameter ${p.param} targets undeclared variable ${p.variable_ref}`,
            );
          }
        }
      }

      for (let i = this.data.vendors.length - 1; i >= 0; i -= 1) {
        if (this.data.vendors[i]?.survey_version_id === versionId) this.data.vendors.splice(i, 1);
      }
      for (const row of rows) {
        this.data.vendors.push({ ...row, survey_version_id: versionId, org_id: org });
      }
      return this.vendors.listVendors(versionId);
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
