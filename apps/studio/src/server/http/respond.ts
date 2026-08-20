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
  sv_one_draft: () =>
    new AppError('already_exists', 'this survey already has a draft version', {
      details: [{ path: null, code: 'one_draft', message: 'edit the existing draft' }],
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
