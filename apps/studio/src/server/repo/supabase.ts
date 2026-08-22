/**
 * `SupabaseRepo` — the real implementation.
 *
 * Every statement here runs over PostgREST as the `authoring` role, carrying the caller's JWT,
 * so `app.current_org()`, `app.has_role()` and `app.can_see_project()` apply and a cross-tenant
 * read comes back as an empty result set rather than an error (P1-01 acceptance). Nothing in
 * this file adds an `org_id` filter for security — it adds them only where the composite index
 * wants one — because a filter written in TypeScript is a filter that can be forgotten, and the
 * policy is the guarantee.
 *
 * Deployment note (not a code concern, but the thing that breaks first): PostgREST must have
 * `app` in its exposed-schemas list for `.schema('app')` to resolve.
 *
 * Column names are verbatim from `db/migrations/0004_tenancy/up.sql`.
 */

import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js';
import type { JsonObject, OrgRole } from '@resscript/schema';
import { StoreConstraintError } from './memory.js';
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
  I18nRepo,
  I18nStringRow,
  LanguageRow,
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
  RedirectRepo,
  RedirectRow,
  RegistryItemRow,
  RegistryNodeRow,
  RegistryRepo,
  RegistryVariableRow,
  Repos,
  RollbackResult,
  CreateRuleInput,
  ListRulesQuery,
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

export interface SupabaseRepoContext {
  /** A client built by `createSupabaseServerClient()`: cookie-backed, carries the user JWT. */
  readonly client: SupabaseClient;
  readonly userId: string;
  /** From `app_metadata.active_org_id`. NEVER from a query parameter or a request body. */
  readonly activeOrgId: string | null;
  readonly requestId: string;
  /**
   * Service-role client, used for the ONE operation that legitimately bypasses RLS: reading
   * `ops.jobs`, which is not granted to `authoring` at all (see `jobs` below). Absent in a
   * deployment that has not configured the key, in which case job reads fail closed.
   */
  readonly admin?: SupabaseClient;
}

const APP = 'app';
const CONTENT = 'content';

/** The `content.logic_rules` projection every rules read returns — one list, or the shapes drift. */
const RULE_COLUMNS =
  'id, survey_version_id, kind, target_kind, target_node_id, target_item_id, target_variable_id, ' +
  'condition, effect, evaluation, authored_in, trivia, notes, depends_on_variable_ids, ' +
  'depends_on_node_ids, sort_key, created_at, updated_at';

/**
 * A `content.sort_key` (alphanumeric, ≤64) that sorts after everything minted earlier in this
 * process: ms timestamp in base36 plus a random suffix against same-ms collisions. Server-minted
 * because API §2.7 has no client-supplied ordering for rules — list order is authoring order.
 */
function nextSortKey(): string {
  return Date.now().toString(36).padStart(9, '0') + crypto.randomUUID().replaceAll('-', '').slice(0, 4);
}

/**
 * PostgREST errors → the same `StoreConstraintError` the in-memory store raises, so the HTTP
 * layer has ONE mapping from constraint to envelope code instead of two.
 */
function raise(error: PostgrestError, fallback: string): never {
  const named = /"?([a-z0-9_]+)"? *(?:constraint|index)?/i.exec(error.details ?? '')?.[1];
  const constraint = extractConstraint(error) ?? named ?? fallback;
  throw new StoreConstraintError(constraint, error.message);
}

function extractConstraint(error: PostgrestError): string | undefined {
  // PostgREST puts the constraint name in `message` for 23505/23514: e.g.
  // 'duplicate key value violates unique constraint "projects_ref_key"'.
  const match = /(?:constraint|index) "([^"]+)"/.exec(error.message);
  return match?.[1];
}

function toKeysetFilter(query: PageQuery): string | undefined {
  const after = query.after;
  if (after === undefined) return undefined;
  // Keyset over the sort tuple `(created_at DESC, id DESC)`. Expressed as PostgREST's `or`
  // because a row-value comparison is not available over the REST interface.
  return `created_at.lt.${after.created_at},and(created_at.eq.${after.created_at},id.lt.${after.id})`;
}

function page<T>(rows: readonly T[], query: PageQuery): PageResult<T> {
  return { rows: rows.slice(0, query.limit), hasMore: rows.length > query.limit };
}

class SupabaseRepos implements Repos {
  constructor(private readonly ctx: SupabaseRepoContext) {}

  private table(name: string) {
    return this.ctx.client.schema(APP).from(name);
  }

  readonly orgs: OrgRepo = {
    listMine: async (): Promise<readonly MembershipSummary[]> => {
      // `members_select` shows your own row in EVERY org you belong to; `organizations_select`
      // shows only the active org. The join is therefore deliberately left outer and the
      // switcher renders an id for orgs it cannot name.
      const { data, error } = await this.table('org_members')
        .select('org_id, role')
        .eq('user_id', this.ctx.userId);
      if (error !== null) raise(error, 'members_select');
      const active = await this.orgs.getActive();
      return (data ?? []).map((row) => {
        const r = row as { org_id: string; role: OrgRole };
        return {
          org_id: r.org_id,
          role: r.role,
          organization: active !== null && active.id === r.org_id ? active : null,
        };
      });
    },

    getActive: async (): Promise<OrganizationRow | null> => {
      // No `.eq('id', …)`: `organizations_select` already restricts the visible set to
      // `id = app.current_org()`. Adding the filter here would imply the policy were optional.
      const { data, error } = await this.table('organizations').select('*').limit(1);
      if (error !== null) raise(error, 'organizations_select');
      const row = (data ?? [])[0];
      return row === undefined ? null : (row as OrganizationRow);
    },

    create: async (input: CreateOrganizationInput): Promise<OrganizationRow> => {
      // `app.organizations` has NO INSERT policy. Orgs come into existence only through this
      // SECURITY DEFINER function, which also installs the caller as the first `owner` in the
      // same transaction — the only path by which an owner is ever created.
      const { data, error } = await this.ctx.client.schema(APP).rpc('create_organization', {
        p_slug: input.slug,
        p_name: input.name,
        ...(input.data_region === undefined ? {} : { p_region: input.data_region }),
      });
      if (error !== null) raise(error, 'create_organization');
      const orgId = data as string;
      const { data: row, error: readError } = await this.table('organizations')
        .select('*')
        .eq('id', orgId)
        .maybeSingle();
      if (readError !== null) raise(readError, 'organizations_select');
      if (row === null) {
        // Expected on the first request after creation: the caller's token is still scoped to
        // the PREVIOUS org, so `organizations_select` hides the new row until the token is
        // re-minted. Returning a synthesized row keeps the API contract without pretending to
        // have read something.
        return {
          id: orgId,
          slug: input.slug,
          name: input.name,
          data_region: input.data_region ?? 'eu-west-1',
          settings: {},
          sso_domain: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          suspended_at: null,
          deleted_at: null,
        };
      }
      return row as OrganizationRow;
    },

    updateActive: async (input: UpdateOrganizationInput): Promise<OrganizationRow> => {
      const patch: Record<string, unknown> = {};
      if (input.name !== undefined) patch['name'] = input.name;
      if (input.settings !== undefined) patch['settings'] = input.settings;
      const { data, error } = await this.table('organizations').update(patch).select('*');
      if (error !== null) raise(error, 'organizations_update');
      const row = (data ?? [])[0];
      if (row === undefined) {
        // Zero rows, not an error: the policy declined. Deliberately indistinguishable from
        // "the org does not exist", because distinguishing them is an information leak.
        throw new StoreConstraintError('organizations_update', 'no rows updated');
      }
      return row as OrganizationRow;
    },
  };

  readonly members: MemberRepo = {
    list: async (query: PageQuery): Promise<PageResult<MemberRow>> => {
      let q = this.table('org_members')
        .select('org_id, user_id, role, project_ids, invited_by, created_at, updated_at')
        .order('created_at', { ascending: false })
        .order('user_id', { ascending: false })
        .limit(query.limit + 1);
      const keyset = toKeysetFilter(query);
      if (keyset !== undefined) q = q.or(keyset.replaceAll('id.lt', 'user_id.lt'));
      const { data, error } = await q;
      if (error !== null) raise(error, 'members_select');
      // `email` lives in `auth.users`, which `authoring` is not granted. Null rather than a
      // second query with a privileged client: the member list is not worth a service-role read.
      return page(
        (data ?? []).map((row) => ({ ...(row as Omit<MemberRow, 'email'>), email: null })),
        query,
      );
    },

    get: async (userId: string): Promise<MemberRow | null> => {
      const { data, error } = await this.table('org_members')
        .select('org_id, user_id, role, project_ids, invited_by, created_at, updated_at')
        .eq('user_id', userId)
        .maybeSingle();
      if (error !== null) raise(error, 'members_select');
      return data === null ? null : { ...(data as Omit<MemberRow, 'email'>), email: null };
    },

    roleInOrg: async (orgId: string, userId: string): Promise<OrgRole | null> => {
      const { data, error } = await this.table('org_members')
        .select('role')
        .eq('org_id', orgId)
        .eq('user_id', userId)
        .maybeSingle();
      if (error !== null) raise(error, 'members_select');
      return data === null ? null : (data as { role: OrgRole }).role;
    },

    update: async (userId: string, input: UpdateMemberInput): Promise<MemberRow> => {
      const patch: Record<string, unknown> = {};
      if (input.role !== undefined) patch['role'] = input.role;
      if (input.project_ids !== undefined) patch['project_ids'] = input.project_ids;
      const { data, error } = await this.table('org_members')
        .update(patch)
        .eq('user_id', userId)
        .select('org_id, user_id, role, project_ids, invited_by, created_at, updated_at');
      if (error !== null) raise(error, 'members_update');
      const row = (data ?? [])[0];
      if (row === undefined) throw new StoreConstraintError('members_update', 'no rows updated');
      return { ...(row as Omit<MemberRow, 'email'>), email: null };
    },

    remove: async (userId: string): Promise<void> => {
      const { data, error } = await this.table('org_members')
        .delete()
        .eq('user_id', userId)
        .select('user_id');
      if (error !== null) raise(error, 'members_delete');
      if ((data ?? []).length === 0) {
        throw new StoreConstraintError('members_delete', 'no rows deleted');
      }
    },

    insert: async (input: {
      readonly org_id: string;
      readonly user_id: string;
      readonly role: OrgRole;
      readonly project_ids: readonly string[];
      readonly invited_by: string | null;
    }): Promise<MemberRow> => {
      const { data, error } = await this.table('org_members')
        .insert({
          org_id: input.org_id,
          user_id: input.user_id,
          role: input.role,
          project_ids: input.project_ids,
          invited_by: input.invited_by,
        })
        .select('org_id, user_id, role, project_ids, invited_by, created_at, updated_at')
        .single();
      if (error !== null) raise(error, 'members_insert');
      return { ...(data as Omit<MemberRow, 'email'>), email: null };
    },
  };

  readonly invitations: InvitationRepo = {
    list: async (query: PageQuery): Promise<PageResult<InvitationRow>> => {
      let q = this.table('invitations')
        .select(
          'id, org_id, email, role, project_ids, status, invited_by, expires_at, accepted_at, accepted_by, created_at',
        )
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(query.limit + 1);
      const keyset = toKeysetFilter(query);
      if (keyset !== undefined) q = q.or(keyset);
      const { data, error } = await q;
      if (error !== null) raise(error, 'invitations_select');
      return page((data ?? []) as InvitationRow[], query);
    },

    create: async (input: CreateInvitationInput): Promise<InvitationRow> => {
      const org = this.ctx.activeOrgId;
      if (org === null) throw new StoreConstraintError('invitations_insert', 'no active org');
      const { data, error } = await this.table('invitations')
        .insert({
          org_id: org,
          email: input.email,
          role: input.role,
          project_ids: input.project_ids ?? [],
          // The plaintext token is never persisted: `app.hash_invitation_token()` is the one
          // place a raw token becomes what the database stores.
          token_hash: input.token_hash,
          invited_by: this.ctx.userId,
          expires_at: input.expires_at,
        })
        .select(
          'id, org_id, email, role, project_ids, status, invited_by, expires_at, accepted_at, accepted_by, created_at',
        )
        .single();
      if (error !== null) raise(error, 'invitations_insert');
      return data as InvitationRow;
    },

    findByTokenHash: async (tokenHash: string): Promise<InvitationRow | null> => {
      // There is deliberately NO policy letting an invitee read their own invitation row, so
      // this lookup runs through a SECURITY DEFINER function keyed on the hash. The function
      // does not exist in 0004 — see the note in the accept route.
      const { data, error } = await this.ctx.client
        .schema(APP)
        .rpc('resolve_invitation', { p_token_hash: tokenHash });
      if (error !== null) raise(error, 'resolve_invitation');
      const rows = (data ?? []) as InvitationRow[];
      return rows[0] ?? null;
    },

    markAccepted: async (id: string, userId: string): Promise<InvitationRow> => {
      const { data, error } = await this.table('invitations')
        .update({ status: 'accepted', accepted_at: new Date().toISOString(), accepted_by: userId })
        .eq('id', id)
        .select(
          'id, org_id, email, role, project_ids, status, invited_by, expires_at, accepted_at, accepted_by, created_at',
        )
        .single();
      if (error !== null) raise(error, 'invitations_update');
      return data as InvitationRow;
    },
  };

  readonly projects: ProjectRepo = {
    list: async (query: ListProjectsQuery): Promise<PageResult<ProjectRow>> => {
      let q = this.table('projects')
        .select('*')
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(query.limit + 1);
      if (query.include_archived !== true) q = q.is('archived_at', null);
      if (query.q !== undefined) q = q.ilike('name', `%${query.q}%`);
      const keyset = toKeysetFilter(query);
      if (keyset !== undefined) q = q.or(keyset);
      const { data, error } = await q;
      if (error !== null) raise(error, 'projects_select');
      return page((data ?? []) as ProjectRow[], query);
    },

    get: async (id: string): Promise<ProjectRow | null> => {
      const { data, error } = await this.table('projects').select('*').eq('id', id).maybeSingle();
      if (error !== null) raise(error, 'projects_select');
      return data === null ? null : (data as ProjectRow);
    },

    create: async (input: CreateProjectInput): Promise<ProjectRow> => {
      const org = this.ctx.activeOrgId;
      if (org === null) throw new StoreConstraintError('projects_insert', 'no active org');
      const { data, error } = await this.table('projects')
        .insert({
          // `org_id` is written from the CLAIM, and `projects_insert`'s WITH CHECK re-tests it
          // against `app.current_org()`, so a wrong value here is rejected by the database.
          org_id: org,
          ref: input.ref,
          name: input.name,
          client_name: input.client_name ?? null,
          tags: input.tags ?? [],
          field_start: input.field_start ?? null,
          field_end: input.field_end ?? null,
          created_by: this.ctx.userId,
        })
        .select('*')
        .single();
      if (error !== null) raise(error, 'projects_insert');
      return data as ProjectRow;
    },

    update: async (id: string, input: UpdateProjectInput): Promise<ProjectRow> => {
      const patch: Record<string, unknown> = {};
      if (input.name !== undefined) patch['name'] = input.name;
      if (input.client_name !== undefined) patch['client_name'] = input.client_name;
      if (input.tags !== undefined) patch['tags'] = input.tags;
      if (input.field_start !== undefined) patch['field_start'] = input.field_start;
      if (input.field_end !== undefined) patch['field_end'] = input.field_end;
      if (input.archived_at !== undefined) patch['archived_at'] = input.archived_at;
      const { data, error } = await this.table('projects').update(patch).eq('id', id).select('*');
      if (error !== null) raise(error, 'projects_update');
      const row = (data ?? [])[0];
      if (row === undefined) throw new StoreConstraintError('projects_update', 'no rows updated');
      return row as ProjectRow;
    },

    remove: async (id: string): Promise<void> => {
      const { data, error } = await this.table('projects').delete().eq('id', id).select('id');
      if (error !== null) raise(error, 'projects_delete');
      if ((data ?? []).length === 0) {
        // `projects_delete` requires an already-archived project, so zero rows here means
        // either "not archived" or "not yours" — the API answers the same way for both.
        throw new StoreConstraintError('projects_delete', 'no rows deleted');
      }
    },
  };

  readonly surveys: SurveyRepo = {
    list: async (query: ListSurveysQuery): Promise<PageResult<SurveyRow>> => {
      let q = this.table('surveys')
        .select('*')
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(query.limit + 1);
      if (query.project_id !== undefined) q = q.eq('project_id', query.project_id);
      if (query.include_archived !== true) q = q.is('archived_at', null);
      if (query.q !== undefined) q = q.ilike('name', `%${query.q}%`);
      const keyset = toKeysetFilter(query);
      if (keyset !== undefined) q = q.or(keyset);
      const { data, error } = await q;
      if (error !== null) raise(error, 'surveys_select');
      return page((data ?? []) as SurveyRow[], query);
    },

    get: async (id: string): Promise<SurveyRow | null> => {
      const { data, error } = await this.table('surveys').select('*').eq('id', id).maybeSingle();
      if (error !== null) raise(error, 'surveys_select');
      return data === null ? null : (data as SurveyRow);
    },

    create: async (
      input: CreateSurveyInput,
    ): Promise<{ survey: SurveyRow; draft_version: SurveyVersionRow }> => {
      const org = this.ctx.activeOrgId;
      if (org === null) throw new StoreConstraintError('surveys_insert', 'no active org');
      const { data, error } = await this.table('surveys')
        .insert({
          org_id: org,
          project_id: input.project_id,
          ref: input.ref,
          name: input.name,
          description: input.description ?? null,
          survey_kind: input.survey_kind ?? 'standard',
          default_language: input.default_language ?? 'en',
          parent_survey_id: input.parent_survey_id ?? null,
          created_by: this.ctx.userId,
        })
        .select('*')
        .single();
      if (error !== null) raise(error, 'surveys_insert');
      const survey = data as SurveyRow;
      // API §2.3: "creating a survey always creates its draft version — a survey with no
      // version is not addressable." Two statements rather than one transaction is a real
      // weakness of doing this over PostgREST; the RPC that makes it atomic is P1-03's
      // `app.create_survey_with_draft`, noted rather than faked.
      const draft = await this.surveys.createVersion({ survey_id: survey.id, schema_version: 1 });
      return { survey, draft_version: draft };
    },

    update: async (id: string, input: UpdateSurveyInput): Promise<SurveyRow> => {
      const patch: Record<string, unknown> = {};
      if (input.name !== undefined) patch['name'] = input.name;
      if (input.description !== undefined) patch['description'] = input.description;
      if (input.ref !== undefined) patch['ref'] = input.ref;
      if (input.theme_id !== undefined) patch['theme_id'] = input.theme_id;
      if (input.archived_at !== undefined) patch['archived_at'] = input.archived_at;
      const { data, error } = await this.table('surveys').update(patch).eq('id', id).select('*');
      if (error !== null) raise(error, 'surveys_update');
      const row = (data ?? [])[0];
      if (row === undefined) throw new StoreConstraintError('surveys_update', 'no rows updated');
      return row as SurveyRow;
    },

    remove: async (id: string): Promise<void> => {
      const { data, error } = await this.table('surveys').delete().eq('id', id).select('id');
      if (error !== null) raise(error, 'surveys_delete');
      if ((data ?? []).length === 0) {
        throw new StoreConstraintError('surveys_delete', 'no rows deleted');
      }
    },

    listVersions: async (surveyId: string, query: PageQuery): Promise<PageResult<SurveyVersionRow>> => {
      let q = this.table('survey_versions')
        .select('*')
        .eq('survey_id', surveyId)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(query.limit + 1);
      const keyset = toKeysetFilter(query);
      if (keyset !== undefined) q = q.or(keyset);
      const { data, error } = await q;
      if (error !== null) raise(error, 'sv_select');
      return page((data ?? []) as SurveyVersionRow[], query);
    },

    getVersion: async (id: string): Promise<SurveyVersionRow | null> => {
      const { data, error } = await this.table('survey_versions')
        .select('*')
        .eq('id', id)
        .maybeSingle();
      if (error !== null) raise(error, 'sv_select');
      return data === null ? null : (data as SurveyVersionRow);
    },

    createVersion: async (input: CreateVersionInput): Promise<SurveyVersionRow> => {
      const org = this.ctx.activeOrgId;
      if (org === null) throw new StoreConstraintError('sv_insert', 'no active org');
      const { data: existing, error: readError } = await this.table('survey_versions')
        .select('version_no')
        .eq('survey_id', input.survey_id)
        .order('version_no', { ascending: false })
        .limit(1);
      if (readError !== null) raise(readError, 'sv_select');
      const highest = ((existing ?? [])[0] as { version_no: number } | undefined)?.version_no ?? 0;
      const { data, error } = await this.table('survey_versions')
        .insert({
          org_id: org,
          survey_id: input.survey_id,
          version_no: highest + 1,
          // `sv_insert`'s WITH CHECK pins `status = 'draft'` and `frozen_at IS NULL`: a version
          // is always born a draft, so publishing is an UPDATE that tg_version_guard validates.
          status: 'draft',
          compile_state: 'none',
          schema_version: input.schema_version,
          notes: input.notes ?? null,
          created_by: this.ctx.userId,
          cloned_from_version_id: input.from_version_id ?? null,
        })
        .select('*')
        .single();
      if (error !== null) raise(error, 'sv_insert');
      return data as SurveyVersionRow;
    },

    updateVersion: async (
      id: string,
      expectedRevision: number,
      input: UpdateVersionInput,
    ): Promise<SurveyVersionRow | null> => {
      const patch: Record<string, unknown> = {};
      if (input.notes !== undefined) patch['notes'] = input.notes;
      // The optimistic lock is a WHERE clause, not a read-then-write: `.eq('revision', …)`
      // makes the compare-and-swap atomic in the database. `tg_version_guard` then increments
      // `revision` itself, so the caller cannot forget to.
      const { data, error } = await this.table('survey_versions')
        .update(patch)
        .eq('id', id)
        .eq('revision', expectedRevision)
        .select('*');
      if (error !== null) raise(error, 'sv_update');
      const row = (data ?? [])[0];
      if (row !== undefined) return row as SurveyVersionRow;
      // Zero rows: either the revision moved (a conflict the caller can recover from) or the
      // row is invisible (a 404). Distinguish by re-reading through the same policy.
      const current = await this.surveys.getVersion(id);
      if (current === null) throw new StoreConstraintError('sv_update', 'no rows updated');
      return null;
    },

    rollback: async (toVersionId: string, requestId: string): Promise<RollbackResult> => {
      // One RPC, no client-side transaction. 0009 owns the ordering (demote before promote, or
      // `sv_one_production` refuses with a message about an index), the token write in schema
      // `runtime` — which `authoring` cannot reach at all — and the audit row. A route that did
      // this as two `PATCH`es would be a route that can be killed between them.
      const { data, error } = await this.ctx.client.schema(APP).rpc('rollback_version', {
        p_to_version_id: toVersionId,
        p_request_id: requestId,
      });
      if (error !== null) raise(error, 'rollback_version');
      const row = data as Record<string, unknown> | null;
      if (row === null) throw new StoreConstraintError('rollback_version', 'no result');
      return {
        token: String(row['token'] ?? ''),
        survey_id: String(row['survey_id'] ?? ''),
        from_version_id: String(row['from_version_id'] ?? ''),
        to_version_id: String(row['to_version_id'] ?? ''),
        artifact_hash: String(row['artifact_hash'] ?? ''),
      };
    },
  };

  readonly jobs: JobRepo = {
    get: async (id: string): Promise<JobRow | null> => {
      // Migration 0005 added a reader so this no longer needs the service-role client and no
      // longer applies the tenancy check in application code.
      //
      // It lives in `app`, not `ops`, and that is not cosmetic: `authoring` has no USAGE on
      // schema `ops` (asserted by 0001's and 0003's suites), so a GRANT EXECUTE on
      // `ops.get_job` would still have failed with "permission denied for schema ops". The
      // alternative — granting USAGE ON SCHEMA ops — would trade a documented plane boundary
      // for one function.
      //
      // `app.get_job` filters on `app.current_org()` inside the function body, so the org
      // check cannot be forgotten at a call site, and it omits `jobs.payload` entirely: a
      // compile payload can carry survey content and this view needs only status and
      // progress. A job in another org returns zero rows rather than raising, so probing job
      // ids reveals nothing.
      const { data, error } = await this.ctx.client.schema(APP).rpc('get_job', { p_id: id });
      if (error !== null) raise(error, 'jobs_select');
      const row = (data as JobRow[] | null)?.[0];
      return row ?? null;
    },

    /**
     * `app.enqueue_job`, added by migration 0010 — the object this call was written against
     * before it existed, and the reason the comment here used to say so in capitals.
     *
     * `ops.enqueue_job` is unreachable from `authoring` for the same reason `ops.get_job` was
     * ("permission denied for schema ops": EXECUTE without schema USAGE is inert), and 0005 fixed
     * the read side with a wrapper in schema `app` and left the write side alone — so the studio
     * could not queue its own publish job at all. 0010 §1 is that wrapper, and it delegates to
     * `ops.enqueue_job` so 0003's `jobs_idem_key` contract has one implementation.
     *
     * A service-role INSERT was never an acceptable stand-in: it leaves `created_by` NULL and
     * 0009's publish transaction then refuses the job with `insufficient_privilege` — correctly,
     * since "the system published this" is not an answer anyone accepts six months later.
     *
     * Argument names mirror `ops.enqueue_job`'s except for ONE omission: there is no `p_org_id`,
     * and there must not be. The wrapper derives it from `app.current_org()` and `created_by`
     * from `app.current_user_id()`, which is this file's standing rule (see `types.ts`'s header: a
     * method that cannot express "this org" makes a `?org_id=`-style injection unrepresentable)
     * and is also what makes the enqueued job's `org_id` the same value the publish capability
     * check will read. `p_delay_ms` is left to its default of 0; nothing in the studio defers a
     * job yet, and the wrapper's signature carries the parameter so that when something does
     * (P3-06's reminder emails) it is not a re-signing.
     */
    enqueue: async (input: EnqueueJobInput): Promise<EnqueuedJob> => {
      const { data, error } = await this.ctx.client.schema(APP).rpc('enqueue_job', {
        p_kind: input.kind,
        p_payload: input.payload,
        p_idempotency_key: input.idempotency_key ?? null,
        p_project_id: input.project_id ?? null,
        p_survey_version_id: input.survey_version_id ?? null,
        p_max_attempts: input.max_attempts ?? 3,
      });
      if (error !== null) raise(error, 'enqueue_job');
      const row = (data as { id: string; created: boolean }[] | null)?.[0];
      if (row === undefined) throw new StoreConstraintError('enqueue_job', 'no row returned');
      return { id: row.id, created: row.created };
    },
  };

  /**
   * The variable registry for one version — the type environment the `/v1/dsl/*` endpoints need
   * (API §5.1: "`scope.survey_version_id` is required … because `ref → id` resolution and type
   * inference need the variable registry").
   *
   * Three reads, in parallel, all under `content.*`'s policies: a version in another org yields
   * three empty sets, which is why the version row is checked first and a miss is `null` rather
   * than an empty registry. Deleted rows are excluded here rather than by the policy —
   * `deleted_at` is the editor's undo buffer (B §4.1) and a soft-deleted question must not
   * resolve a `ref`, or a rule would type-check against a question the author has deleted.
   *
   * Deployment note, same class as the `app` one above: PostgREST must expose `content`.
   */
  readonly registry: RegistryRepo = {
    forVersion: async (versionId: string): Promise<VersionRegistryRows | null> => {
      const version = await this.surveys.getVersion(versionId);
      if (version === null) return null;
      const content = (name: string) => this.ctx.client.schema(CONTENT).from(name);
      const [variables, nodes, items] = await Promise.all([
        content('variables')
          .select('id, name, kind, vtype, enum_domain, source_question_id, source_item_id, source_part, pii, persist, sort_key')
          .eq('survey_version_id', versionId)
          .is('deleted_at', null)
          .order('sort_key', { ascending: true }),
        content('nodes')
          .select('id, node_kind, parent_id, ref, required, emits, sort_key')
          .eq('survey_version_id', versionId)
          .is('deleted_at', null)
          .order('sort_key', { ascending: true }),
        content('question_items')
          .select('id, question_id, item_kind, ref, code, label_key, sort_key')
          .eq('survey_version_id', versionId)
          .is('deleted_at', null)
          .order('sort_key', { ascending: true }),
      ]);
      if (variables.error !== null) raise(variables.error, 'variables_select');
      if (nodes.error !== null) raise(nodes.error, 'nodes_select');
      if (items.error !== null) raise(items.error, 'question_items_select');
      return {
        survey_version_id: versionId,
        variables: (variables.data ?? []) as RegistryVariableRow[],
        nodes: (nodes.data ?? []) as RegistryNodeRow[],
        items: (items.data ?? []) as RegistryItemRow[],
      };
    },
  };

  /**
   * `content.logic_rules` (0007 §4.4) — the central rule registry.
   *
   * The two `depends_on_*` filters are PostgREST `.contains()`, which renders as `@>` — the
   * array-containment operator `rules_depends_var_gin` and `rules_depends_node_gin` exist for,
   * so "what does Q3 affect" is an index lookup here exactly as DB §4.4 promises. Everything
   * else follows the redirects pattern above: policies are the guarantee, zero rows written is
   * one indistinguishable refusal, and the delete is soft (`deleted_at`) per API §2.7.
   */
  readonly rules: RuleRepo = {
    list: async (versionId: string, query: ListRulesQuery): Promise<PageResult<RuleRow>> => {
      let request = this.ctx.client
        .schema(CONTENT)
        .from('logic_rules')
        .select(RULE_COLUMNS)
        .eq('survey_version_id', versionId)
        .is('deleted_at', null);
      if (query.kind !== undefined) request = request.eq('kind', query.kind);
      if (query.target_node_id !== undefined) request = request.eq('target_node_id', query.target_node_id);
      if (query.depends_on_node_id !== undefined) {
        request = request.contains('depends_on_node_ids', [query.depends_on_node_id]);
      }
      if (query.depends_on_variable_id !== undefined) {
        request = request.contains('depends_on_variable_ids', [query.depends_on_variable_id]);
      }
      const keyset = toKeysetFilter(query);
      if (keyset !== undefined) request = request.or(keyset);
      const { data, error } = await request
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(query.limit + 1);
      if (error !== null) raise(error, 'rules_select');
      return page((data ?? []) as unknown as RuleRow[], query);
    },

    get: async (ruleId: string): Promise<RuleRow | null> => {
      const { data, error } = await this.ctx.client
        .schema(CONTENT)
        .from('logic_rules')
        .select(RULE_COLUMNS)
        .eq('id', ruleId)
        .is('deleted_at', null)
        .maybeSingle();
      if (error !== null) raise(error, 'rules_select');
      return data === null ? null : (data as unknown as RuleRow);
    },

    create: async (input: CreateRuleInput): Promise<RuleRow> => {
      const org = this.ctx.activeOrgId;
      if (org === null) throw new StoreConstraintError('rules_insert', 'no active org');
      const { data, error } = await this.ctx.client
        .schema(CONTENT)
        .from('logic_rules')
        .insert({
          survey_version_id: input.survey_version_id,
          // From the CLAIM; `rules_insert`'s WITH CHECK re-tests it against `app.current_org()`.
          org_id: org,
          kind: input.kind,
          target_kind: input.target_kind,
          target_node_id: input.target_node_id ?? null,
          target_item_id: input.target_item_id ?? null,
          target_variable_id: input.target_variable_id ?? null,
          condition: input.condition,
          effect: input.effect,
          evaluation: input.evaluation ?? 'on_change',
          authored_in: input.authored_in ?? 'visual',
          trivia: input.trivia ?? {},
          notes: input.notes ?? null,
          depends_on_variable_ids: input.depends_on_variable_ids,
          depends_on_node_ids: input.depends_on_node_ids,
          sort_key: nextSortKey(),
        })
        .select(RULE_COLUMNS)
        .maybeSingle();
      if (error !== null) raise(error, 'rules_insert');
      if (data === null) throw new StoreConstraintError('rules_insert', 'no rows inserted');
      return data as unknown as RuleRow;
    },

    update: async (ruleId: string, input: UpdateRuleInput): Promise<RuleRow> => {
      const { data, error } = await this.ctx.client
        .schema(CONTENT)
        .from('logic_rules')
        .update({
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
            : { depends_on_variable_ids: input.depends_on_variable_ids }),
          ...(input.depends_on_node_ids === undefined
            ? {}
            : { depends_on_node_ids: input.depends_on_node_ids }),
        })
        .eq('id', ruleId)
        .is('deleted_at', null)
        .select(RULE_COLUMNS)
        .maybeSingle();
      if (error !== null) raise(error, 'rules_update');
      if (data === null) throw new StoreConstraintError('rules_update', 'no rows updated');
      return data as unknown as RuleRow;
    },

    remove: async (ruleId: string): Promise<void> => {
      // Soft delete. `rules_update` (not `rules_delete`) is the policy this write runs under,
      // which is the point: the row stays for undo, and a frozen version still refuses it.
      const { data, error } = await this.ctx.client
        .schema(CONTENT)
        .from('logic_rules')
        .update({ deleted_at: new Date().toISOString() })
        .eq('id', ruleId)
        .is('deleted_at', null)
        .select('id');
      if (error !== null) raise(error, 'rules_delete');
      if ((data ?? []).length === 0) {
        throw new StoreConstraintError('rules_delete', 'no rows deleted');
      }
    },

    usagesOfVariable: async (variableId: string) => {
      const { data, error } = await this.ctx.client
        .schema(CONTENT)
        .from('variables')
        .select('id, survey_version_id')
        .eq('id', variableId)
        .is('deleted_at', null)
        .maybeSingle();
      if (error !== null) raise(error, 'variables_select');
      if (data === null) return null;
      const versionId = (data as { survey_version_id: string }).survey_version_id;
      const { data: ruleRows, error: rulesError } = await this.ctx.client
        .schema(CONTENT)
        .from('logic_rules')
        .select(RULE_COLUMNS)
        .eq('survey_version_id', versionId)
        // `@>` — the exact read `rules_depends_var_gin` indexes.
        .contains('depends_on_variable_ids', [variableId])
        .is('deleted_at', null)
        .order('sort_key', { ascending: true });
      if (rulesError !== null) raise(rulesError, 'rules_select');
      return { survey_version_id: versionId, rules: (ruleRows ?? []) as unknown as RuleRow[] };
    },
  };

  /**
   * `content.redirects` (0010) — API §2.9's flattened rows, verbatim.
   *
   * Reads and writes both run under the table's own policies: `redirects_select` is
   * reviewer-floor + `app.can_see_version()`, the write policies are programmer-floor +
   * `app.version_is_draft()`, and `content.tg_draft_only` catches anything that reaches the
   * table by another route. Nothing here re-tests any of that in TypeScript — a filter written
   * here is a filter that can be forgotten, and the policy is the guarantee.
   *
   * `replaceRedirects` is delete-then-insert: two statements rather than one transaction, the
   * same honest weakness `surveys.create` records for PostgREST, and the same remedy — an RPC
   * (`content.replace_redirects`) when a migration owns it, noted rather than faked. The
   * failure mode is bounded: a crash between the two leaves the version with no redirect rows,
   * which CMP-0300 refuses to publish, never with a half-merged set.
   */
  readonly redirects: RedirectRepo = {
    listRedirects: async (versionId: string): Promise<readonly RedirectRow[]> => {
      const { data, error } = await this.ctx.client
        .schema(CONTENT)
        .from('redirects')
        .select('scope, scope_key, disposition, custom_key, url_template')
        .eq('survey_version_id', versionId)
        // 0010's key order — the same ORDER BY the worker's publish read uses, so what the
        // author sees listed is ordered as what the artifact is assembled from.
        .order('scope', { ascending: true })
        .order('scope_key', { ascending: true })
        .order('disposition', { ascending: true })
        .order('custom_key', { ascending: true });
      if (error !== null) raise(error, 'redirects_select');
      return (data ?? []) as RedirectRow[];
    },

    replaceRedirects: async (
      versionId: string,
      rows: readonly RedirectRow[],
    ): Promise<readonly RedirectRow[]> => {
      const org = this.ctx.activeOrgId;
      if (org === null) throw new StoreConstraintError('redirects_insert', 'no active org');
      const { error: deleteError } = await this.ctx.client
        .schema(CONTENT)
        .from('redirects')
        .delete()
        .eq('survey_version_id', versionId);
      if (deleteError !== null) raise(deleteError, 'redirects_delete');
      if (rows.length === 0) return [];
      const { data, error } = await this.ctx.client
        .schema(CONTENT)
        .from('redirects')
        .insert(
          rows.map((row) => ({
            survey_version_id: versionId,
            // Written from the CLAIM, and `redirects_insert`'s WITH CHECK re-tests it against
            // `app.current_org()`, so a wrong value here is rejected by the database.
            org_id: org,
            scope: row.scope,
            scope_key: row.scope_key,
            disposition: row.disposition,
            custom_key: row.custom_key,
            url_template: row.url_template,
          })),
        )
        .select('scope, scope_key, disposition, custom_key, url_template');
      if (error !== null) raise(error, 'redirects_insert');
      const written = (data ?? []) as RedirectRow[];
      if (written.length === 0) {
        // Zero rows: the policy declined (not yours, not programmer, or not a draft).
        // Deliberately indistinguishable from a missing version, as everywhere else.
        throw new StoreConstraintError('redirects_insert', 'no rows inserted');
      }
      return this.redirects.listRedirects(versionId);
    },
  };

  /**
   * `content.languages` + `content.i18n_strings` (0007 §8) — the translation surface.
   *
   * All four methods run under the tables' own policies: reads are reviewer-floor +
   * `app.can_see_version()`; string upserts are REVIEWER-floor (0007 puts translation entry
   * below the programmer floor on purpose — translators are reviewers) and language inserts
   * are programmer-floor, both draft-only with `content.tg_draft_only` catching anything that
   * arrives by another path. Nothing here re-tests any of that in TypeScript.
   */
  readonly i18n: I18nRepo = {
    listLanguages: async (versionId: string): Promise<readonly LanguageRow[]> => {
      const { data, error } = await this.ctx.client
        .schema(CONTENT)
        .from('languages')
        .select('lang, is_base, rtl, on_missing, block_publish_if_incomplete')
        .eq('survey_version_id', versionId)
        // Base first, then tag order — the order the manager renders and the worker reads.
        .order('is_base', { ascending: false })
        .order('lang', { ascending: true });
      if (error !== null) raise(error, 'languages_select');
      return (data ?? []) as LanguageRow[];
    },

    addLanguage: async (versionId: string, lang: string): Promise<LanguageRow> => {
      const org = this.ctx.activeOrgId;
      if (org === null) throw new StoreConstraintError('languages_insert', 'no active org');
      const { data, error } = await this.ctx.client
        .schema(CONTENT)
        .from('languages')
        // Never `is_base: true`: the base is born with the version, and `languages_one_base`
        // refuses a second one — this method deliberately cannot even ask for it.
        .insert({ survey_version_id: versionId, org_id: org, lang, is_base: false })
        .select('lang, is_base, rtl, on_missing, block_publish_if_incomplete')
        .single();
      if (error !== null) raise(error, 'languages_insert');
      return data as LanguageRow;
    },

    listStrings: async (versionId: string): Promise<readonly I18nStringRow[]> => {
      // One read for the whole version, all languages: the summary, the flat export and the
      // import validation all need the same rows. The explicit high limit overrides
      // PostgREST's default page (commonly 1,000 rows) up to its configured max-rows; Phase-1
      // surveys (a few thousand keys × a handful of languages) fit, and a survey that outgrows
      // it needs a keyset read here, not a silent truncation — hence the limit is stated.
      const { data, error } = await this.ctx.client
        .schema(CONTENT)
        .from('i18n_strings')
        .select('lang, key, value, state')
        .eq('survey_version_id', versionId)
        .order('lang', { ascending: true })
        .order('key', { ascending: true })
        .limit(100_000);
      if (error !== null) raise(error, 'i18n_select');
      return (data ?? []) as I18nStringRow[];
    },

    upsertStrings: async (
      versionId: string,
      lang: string,
      rows: readonly UpsertStringInput[],
    ): Promise<number> => {
      if (rows.length === 0) return 0;
      const org = this.ctx.activeOrgId;
      if (org === null) throw new StoreConstraintError('i18n_insert', 'no active org');
      const { data, error } = await this.ctx.client
        .schema(CONTENT)
        .from('i18n_strings')
        .upsert(
          rows.map((row) => ({
            survey_version_id: versionId,
            org_id: org,
            lang,
            key: row.key,
            // `i18n_missing_has_no_value`: a missing string stores NULL, the table's own
            // encoding — materialized here once so the CHECK and the reader agree.
            value: row.state === 'missing' ? null : row.value,
            state: row.state,
            updated_by: this.ctx.userId,
          })),
          // The table's PRIMARY KEY — an import overwrites the row it names, never duplicates.
          { onConflict: 'survey_version_id,lang,key' },
        )
        .select('key');
      if (error !== null) raise(error, 'i18n_insert');
      const written = (data ?? []).length;
      if (written === 0) {
        // Zero rows: the policy declined (not yours, below reviewer, or not a draft).
        throw new StoreConstraintError('i18n_insert', 'no rows written');
      }
      return written;
    },
  };

  /**
   * `app.exports` (0012). The PII gate is `app.tg_exports_pii_guard`, running as the INVOKING
   * role on this very INSERT — the trigger's 42501 surfaces here as a StoreConstraintError the
   * HTTP layer maps to a 403 naming the missing grant. Nothing is re-tested in TypeScript.
   */
  readonly exports: ExportRepo = {
    create: async (input: CreateExportInput): Promise<ExportRow> => {
      const org = this.ctx.activeOrgId;
      if (org === null) throw new StoreConstraintError('exports_insert', 'no active org');
      const { data, error } = await this.table('exports')
        .insert({
          org_id: org,
          survey_version_id: input.survey_version_id,
          // Pinned by `exports_insert`'s WITH CHECK; written from the verified context so the
          // policy's re-test passes rather than filtering the insert to zero rows.
          requested_by: this.ctx.userId,
          pii_included: input.pii_included,
          include_test: input.include_test,
        })
        .select(
          'id, survey_version_id, requested_by, status, pii_included, include_test, row_count, storage_key, error, created_at, started_at, finished_at',
        )
        .single();
      if (error !== null) {
        // The trigger raises 42501 with a message naming the grant; PostgREST forwards the
        // message but no constraint name, so the mapping is keyed on its distinctive phrase.
        if (error.message.includes('pii_access')) {
          throw new StoreConstraintError('exports_pii_guard', error.message);
        }
        raise(error, 'exports_insert');
      }
      return data as ExportRow;
    },

    listForVersion: async (versionId: string): Promise<readonly ExportRow[]> => {
      const { data, error } = await this.table('exports')
        .select(
          'id, survey_version_id, requested_by, status, pii_included, include_test, row_count, storage_key, error, created_at, started_at, finished_at',
        )
        .eq('survey_version_id', versionId)
        // `exports_version_idx` order: newest first — the dialog's history. 50 is a history,
        // not an archive; API §2.15's paginated GET /v1/exports is the collection read.
        .order('created_at', { ascending: false })
        .limit(50);
      if (error !== null) raise(error, 'exports_select');
      return (data ?? []) as ExportRow[];
    },
  };

  /**
   * `app.field_stats` (0013) — SECURITY DEFINER, because ADR-001 gives `authoring` no path
   * into schema `runtime` and the dashboard's counts live in `runtime.sessions`. The function
   * re-checks the analyst floor and the org match on every call; a version in another org
   * raises the same "not found" a version that never existed does.
   */
  readonly fieldStats: FieldStatsRepo = {
    forVersion: async (versionId: string, includeTest: boolean): Promise<readonly DispositionCount[]> => {
      const { data, error } = await this.ctx.client.schema(APP).rpc('field_stats', {
        p_survey_version_id: versionId,
        p_include_test: includeTest,
      });
      if (error !== null) raise(error, 'field_stats');
      return ((data ?? []) as { disposition: string; sessions: number | string }[]).map((row) => ({
        disposition: row.disposition,
        // bigint arrives as a string over PostgREST; the counts are small, the cast is honest.
        sessions: Number(row.sessions),
      }));
    },
  };

  readonly audit: AuditRepo = {
    write: async (event: AuditEventInput): Promise<void> => {
      const org = event.org_id ?? this.ctx.activeOrgId;
      if (org === null) return;
      // `app.audit_log` has a SELECT policy and NO INSERT policy: this function is the only
      // way a row gets in, which is what makes the trail unforgeable by its own subject.
      const { error } = await this.ctx.client.schema(APP).rpc('write_audit_event', {
        p_org_id: org,
        p_action: event.action,
        p_actor_kind: 'user',
        p_actor_user_id: this.ctx.userId,
        p_target_kind: event.target_kind ?? null,
        p_target_id: event.target_id ?? null,
        p_project_id: event.project_id ?? null,
        p_survey_id: event.survey_id ?? null,
        p_survey_version_id: event.survey_version_id ?? null,
        p_summary: event.summary ?? null,
        p_diff: event.diff ?? null,
        p_request_id: event.request_id ?? this.ctx.requestId,
      });
      if (error !== null) raise(error, 'write_audit_event');
    },

    since: async (surveyVersionId: string, afterIso: string): Promise<readonly AuditRow[]> => {
      const { data, error } = await this.table('audit_log')
        .select('id, org_id, actor_user_id, actor_kind, action, target_kind, target_id, survey_version_id, summary, diff, created_at')
        .eq('survey_version_id', surveyVersionId)
        .gt('created_at', afterIso)
        .order('created_at', { ascending: false })
        .limit(50);
      // `audit_select` is admin-only, so a programmer's 412 body legitimately comes back
      // empty. An empty `changed_since` is a weaker conflict dialog, not a failure.
      if (error !== null) return [];
      return (data ?? []) as AuditRow[];
    },
  };

  /**
   * Process-local idempotency, deliberately.
   *
   * API §1.4 does not build a general replay store in Phase 1, and API §14 lists
   * `app.idempotency_keys` as the open item. A single-instance map is honest: it makes
   * double-click-Publish correct on one node and is documented as insufficient for a fleet.
   * Swapping it for the table is one class, not a route change.
   */
  readonly idempotency: IdempotencyStore = processIdempotencyStore();
}

const PROCESS_IDEMPOTENCY = new Map<string, IdempotencyRecord>();
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

function processIdempotencyStore(): IdempotencyStore {
  return {
    get: async (orgId: string, endpoint: string, key: string): Promise<IdempotencyRecord | null> => {
      const record = PROCESS_IDEMPOTENCY.get(`${orgId}|${endpoint}|${key}`);
      if (record === undefined) return null;
      // Keys expire after 24 h (API §1.4).
      if (Date.now() - Date.parse(record.created_at) > IDEMPOTENCY_TTL_MS) return null;
      return record;
    },
    put: async (record: IdempotencyRecord): Promise<void> => {
      PROCESS_IDEMPOTENCY.set(`${record.org_id}|${record.endpoint}|${record.key}`, record);
    },
  };
}

export function createSupabaseRepos(ctx: SupabaseRepoContext): Repos {
  return new SupabaseRepos(ctx);
}

/** Exported for the settings screens that need to show org settings as a typed object. */
export type OrgSettings = JsonObject;
