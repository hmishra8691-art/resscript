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
import type { JsonObject, OrgRole } from '@resscript/schema';
import type {
  AuditEventInput,
  AuditRepo,
  AuditRow,
  CreateInvitationInput,
  CreateOrganizationInput,
  CreateProjectInput,
  CreateSurveyInput,
  CreateVersionInput,
  IdempotencyRecord,
  IdempotencyStore,
  InvitationRepo,
  InvitationRow,
  JobRepo,
  JobRow,
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
  Repos,
  SurveyRepo,
  SurveyRow,
  SurveyVersionRow,
  UpdateMemberInput,
  UpdateOrganizationInput,
  UpdateProjectInput,
  UpdateSurveyInput,
  UpdateVersionInput,
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
  readonly audit: AuditRow[] = [];
  readonly idempotency: IdempotencyRecord[] = [];

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
