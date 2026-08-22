/**
 * Responses and the error envelope.
 *
 * The envelope is `AppError.toEnvelope()` from `@resscript/observability` — NOT a shape defined
 * here. API §1.5 specifies one error shape everywhere including the runtime API, and the class
 * that owns it lives in observability precisely because three layers construct it (this HTTP
 * boundary, `apps/worker`'s `ops.jobs.error`, and the logger's error serialisation). A second
 * definition at the API boundary would guarantee drift.
 */

import { AppError, type ErrorDetail } from '@resscript/observability';
import type { JsonValue } from '@resscript/schema';
import { StoreConstraintError } from '../repo/memory.js';
import type { RequestContext } from '../context.js';

export const REQUEST_ID_HEADER = 'X-Request-Id';

export interface JsonResponseInit {
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly requestId?: string;
}

export function json(body: unknown, init: JsonResponseInit = {}): Response {
  const headers = new Headers({ 'content-type': 'application/json; charset=utf-8' });
  for (const [key, value] of Object.entries(init.headers ?? {})) headers.set(key, value);
  if (init.requestId !== undefined) headers.set(REQUEST_ID_HEADER, init.requestId);
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers });
}

export function noContent(requestId: string): Response {
  return new Response(null, { status: 204, headers: { [REQUEST_ID_HEADER]: requestId } });
}

/**
 * Constraint names → envelope codes.
 *
 * One table for both stores: `SupabaseRepo` translates a PostgREST error into the same
 * `StoreConstraintError` the in-memory store raises, so this mapping is exercised by the unit
 * tests rather than only in production.
 *
 * Note what a "no rows updated/deleted" constraint maps to: `not_found`. A policy that declined
 * and a row that does not exist are deliberately indistinguishable — API §1.5: a cross-tenant
 * read is 404, not 403, because confirming existence leaks.
 */
const CONSTRAINT_ERRORS: Readonly<Record<string, (message: string) => AppError>> = {
  org_slug_key: () =>
    new AppError('already_exists', 'that organization slug is taken', {
      details: [{ path: 'slug', code: 'already_exists', message: 'choose another slug' }],
    }),
  org_slug_fmt: () =>
    new AppError('validation_failed', '1 field failed validation', {
      details: [
        {
          path: 'slug',
          code: 'invalid_format',
          message: 'lowercase letters, digits and hyphens; 3–40 characters',
        },
      ],
    }),
  projects_ref_key: () =>
    new AppError('already_exists', 'that project ref is already in use', {
      details: [{ path: 'ref', code: 'already_exists', message: 'refs are unique per org' }],
    }),
  surveys_ref_key: () =>
    new AppError('already_exists', 'that survey ref is already in use', {
      details: [
        {
          path: 'ref',
          code: 'already_exists',
          // Org-wide and not project-wide, because survey refs end up in export file names.
          message: 'survey refs are unique across the organization',
        },
      ],
    }),
  surveys_ref_frozen: () =>
    new AppError('illegal_transition', 'ref cannot change once a non-draft version exists', {
      details: [{ path: 'ref', code: 'frozen_ref', message: 'archive or clone instead' }],
    }),
  invitations_role_not_owner: () =>
    new AppError('validation_failed', '1 field failed validation', {
      details: [
        {
          path: 'role',
          code: 'role_not_invitable',
          message: 'owner cannot be granted by invitation',
        },
      ],
    }),
  invitations_open_key: () =>
    new AppError('already_exists', 'an open invitation for that address already exists', {
      details: [{ path: 'email', code: 'already_exists', message: 'revoke it before re-inviting' }],
    }),
  invitations_client_must_be_scoped: () => clientMustBeScoped(),
  members_client_must_be_scoped: () => clientMustBeScoped(),
  members_insert: (message) => new AppError('forbidden', message),
  org_members_pkey: () => new AppError('already_exists', 'that user is already a member'),
  org_has_owner: () =>
    new AppError('illegal_transition', 'an organization must retain at least one owner', {
      details: [
        { path: null, code: 'last_owner', message: 'transfer ownership before removing this member' },
      ],
    }),
  // `content.tg_draft_only`, should a redirect write reach the table on a non-draft the route's
  // own frozen check did not see (a freeze that landed between the read and the write).
  redirects_draft_only: () =>
    new AppError('frozen_version', 'this survey version is frozen; clone a new draft to edit'),
  // The same trigger's copy on `content.logic_rules` (rules routes answer 409 before writing).
  rules_draft_only: () =>
    new AppError('frozen_version', 'this survey version is frozen; clone a new draft to edit'),
  // `rules_one_target`: the route's schema already refuses a malformed TARGET; what reaches the
  // store wrong is a kind/id disagreement, which is a caller bug worth naming.
  rules_one_target: (message) =>
    new AppError('validation_failed', '1 field failed validation', {
      details: [{ path: 'target', code: 'one_target', message }],
    }),
  rules_trivia_dsl_only: () =>
    new AppError('validation_failed', '1 field failed validation', {
      details: [
        {
          path: 'trivia',
          code: 'trivia_dsl_only',
          message: 'trivia is the DSL fidelity record; a visual rule stores none',
        },
      ],
    }),
  // The same trigger's copies on the translation tables — the routes answer 409 before
  // writing; these catch a freeze that landed between the read and the write.
  languages_draft_only: () =>
    new AppError('frozen_version', 'this survey version is frozen; clone a new draft to edit'),
  i18n_draft_only: () =>
    new AppError('frozen_version', 'this survey version is frozen; clone a new draft to edit'),
  languages_tag_shape: (message) =>
    new AppError('validation_failed', '1 field failed validation', {
      details: [{ path: 'lang', code: 'invalid_language_tag', message }],
    }),
  languages_pkey: () =>
    new AppError('already_exists', 'that language already exists on this version', {
      details: [{ path: 'lang', code: 'already_exists', message: 'edit the existing language' }],
    }),
  // 0012's `app.tg_exports_pii_guard`: the CAPABILITY refusal (K §1 — never rank). 403 and not
  // 404, deliberately: the caller already proved they can see the version and hold the analyst
  // floor, so naming the missing grant leaks nothing and tells them exactly who to ask.
  exports_pii_guard: () =>
    new AppError('forbidden', 'exporting PII requires an explicit pii_access capability grant', {
      details: [{ path: 'pii_included', code: 'capability_required', message: 'pii_access' }],
    }),
  // `app.field_stats`' own floor (0013), should a call reach the function past the route's
  // guard. Same wording as `requireRole`'s refusal so the two paths read as one rule.
  field_stats_floor: () =>
    new AppError('forbidden', 'this action requires the analyst role or higher', {
      details: [{ path: null, code: 'role_required', message: 'analyst' }],
    }),
  sv_one_draft: () =>
    new AppError('already_exists', 'this survey already has a draft version', {
      details: [{ path: null, code: 'one_draft', message: 'edit the existing draft' }],
    }),
  // `app.rollback_version`'s four refusals. The first is deliberately indistinguishable from a
  // missing row — it is raised for "no such version", "not your org" and "not permitted" alike,
  // because telling them apart is an existence oracle across tenants — so it maps to `not_found`
  // via NOT_FOUND_CONSTRAINTS below rather than to `forbidden`. The other three are states the
  // caller can see and act on, so they say what is wrong.
  rollback_target_not_archived: (message) =>
    new AppError('illegal_transition', 'rollback is archived to production', {
      details: [
        { path: 'to_version_id', code: 'not_archived', message },
        // Promoting a draft is a publish, not a rollback — the same distinction
        // app.rollback_version's HINT makes.
        { path: null, code: 'use_instead', message: 'POST /api/v1/versions/{id}/publish' },
      ],
    }),
  rollback_target_no_artifact: (message) =>
    new AppError('illegal_transition', 'the rollback target has no usable artifact', {
      details: [{ path: 'to_version_id', code: 'compile_state', message }],
    }),
  rollback_nothing_live: () =>
    new AppError('illegal_transition', 'this survey has no production version to roll back from', {
      details: [
        { path: null, code: 'nothing_live', message: 'POST /api/v1/versions/{id}/publish' },
      ],
    }),
};

function clientMustBeScoped(): AppError {
  return new AppError('validation_failed', '1 field failed validation', {
    details: [
      {
        path: 'project_ids',
        code: 'client_must_be_scoped',
        // K §1: a client is scoped to explicitly shared projects, so an empty array would mean
        // the exact opposite of what the role is for.
        message: 'a client must be scoped to at least one project',
      },
    ],
  });
}

const NOT_FOUND_CONSTRAINTS: readonly string[] = [
  'organizations_update',
  'members_update',
  'members_delete',
  'projects_update',
  'projects_delete',
  'surveys_update',
  'surveys_delete',
  'sv_update',
  'sv_insert',
  'projects_insert',
  'surveys_insert',
  'invitations_insert',
  'invitations_update',
  'surveys_project_fkey',
  'jobs_insert',
  // See the comment on `rollback_target_not_archived`: one message for "no such version", "not
  // yours" and "not permitted", and `not_found` is the only one of the three that leaks nothing.
  'rollback_not_permitted',
  // `content.redirects`' write policies decline for "not yours", "not programmer" and "not a
  // draft" alike, as zero rows. The route answers the two states the caller can see (403 role,
  // 409 frozen) before writing; what remains is indistinguishable from a missing version.
  'redirects_insert',
  'redirects_delete',
  // `content.logic_rules`' write policies decline the same way — zero rows for "not yours",
  // "not programmer" and "no such version/rule" alike (`rules_select` covers the read miss).
  'rules_insert',
  'rules_update',
  'rules_delete',
  'rules_select',
  // The translation and export write policies decline the same way — zero rows for "not
  // yours", "below the floor" and "no such version" alike; the routes answer the states the
  // caller can see (403 role, 409 frozen, 404 unknown language) before the store is reached.
  'languages_insert',
  'i18n_insert',
  'i18n_strings_lang_fkey',
  'exports_insert',
  'exports_select',
  // `app.field_stats` raises P0002 for "no such version" AND "another org's version" — 0004's
  // existence-oracle rule, one answer for both.
  'field_stats_not_found',
  'field_stats',
];

export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof StoreConstraintError) {
    const build = CONSTRAINT_ERRORS[err.constraint];
    if (build !== undefined) return build(err.message);
    if (NOT_FOUND_CONSTRAINTS.includes(err.constraint)) {
      return new AppError('not_found', 'resource not found', {
        context: { constraint: err.constraint },
      });
    }
    return new AppError('internal_error', err.message, {
      cause: err,
      context: { constraint: err.constraint },
    });
  }
  return AppError.from(err);
}

/**
 * Render an error. `request_id` in the body is the same value as the `X-Request-Id` header and
 * the same value written to `app.audit_log.request_id`, so a customer quoting it is a
 * two-minute investigation.
 */
export function errorResponse(err: unknown, ctx: { requestId: string; logger?: RequestContext['logger'] }): Response {
  const appError = toAppError(err);
  const headers: Record<string, string> = { [REQUEST_ID_HEADER]: ctx.requestId };
  if (appError.retryAfterS !== undefined) headers['Retry-After'] = String(appError.retryAfterS);
  ctx.logger?.log(appError.status >= 500 ? 'error' : 'warn', 'request failed', {
    error: appError.toJSON(),
    status: appError.status,
  });
  return json(appError.toEnvelope(ctx.requestId), { status: appError.status, headers });
}

/**
 * The `412` body from API §1.7, which carries what the client needs to recover.
 *
 * `current_revision` and `changed_since` are ADDITIVE fields on the same envelope, not a
 * second error shape: API §1.1 permits adding a response field within v1, and the studio's
 * auto-retry (UI §5.3) is unimplementable without them.
 */
export function revisionConflictResponse(input: {
  readonly requestId: string;
  readonly currentRevision: number;
  readonly changedSince: readonly JsonValue[];
  readonly expected: string;
}): Response {
  const err = new AppError('revision_conflict', 'the resource was modified by someone else', {
    details: [
      { path: null, code: 'expected_revision', message: input.expected },
      { path: null, code: 'current_revision', message: String(input.currentRevision) },
    ] satisfies readonly ErrorDetail[],
  });
  const envelope = err.toEnvelope(input.requestId);
  return json(
    {
      error: {
        ...envelope.error,
        current_revision: input.currentRevision,
        changed_since: input.changedSince,
      },
    },
    { status: err.status, requestId: input.requestId },
  );
}
