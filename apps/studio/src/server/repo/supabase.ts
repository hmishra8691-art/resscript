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
