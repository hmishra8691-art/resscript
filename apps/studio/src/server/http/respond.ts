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
  // `content.tg_draft_only`'s copies on the four content-tree tables (0007 §3–§7). The routes
  // answer 409 before writing; these catch a freeze that landed between the read and the write,
  // which for a tree editor is a real race rather than a theoretical one — a colleague publishes
  // while somebody has the outline open.
  nodes_draft_only: () => frozenVersionError(),
  qitems_draft_only: () => frozenVersionError(),
  qcells_draft_only: () => frozenVersionError(),
  variables_draft_only: () => frozenVersionError(),
  // C §3's survey-wide ref uniqueness, as one partial unique index. 409 rather than 422 because
  // the ref is well-formed and the conflict is with another row, which is what `already_exists`
  // means — and the actionable answer names the OTHER node, which only the client can see.
  nodes_ref_key: () =>
    new AppError('already_exists', 'that ref is already in use in this version', {
      details: [{ path: 'ref', code: 'already_exists', message: 'refs are unique per version' }],
    }),
  qitems_ref_key: () =>
    new AppError('already_exists', 'that item ref is already in use', {
      details: [
        { path: 'ref', code: 'already_exists', message: 'item refs are unique per question and kind' },
      ],
    }),
  // The export contract (C §5.1). The message says what the index means, because "duplicate
  // code" reads to an author like "renumber it for me" and this API deliberately will not:
  // `code` is the exported value and display order is a different column.
  qitems_code_key: () =>
    new AppError('already_exists', 'that code is already used by another item', {
      details: [
        {
          path: 'code',
          code: 'duplicate_code',
          message:
            'codes are unique per question and item kind; code is the exported value and is not ' +
            'the display position — reorder freely, renumber deliberately',
        },
      ],
    }),
  qitems_anchor_shape: () =>
    new AppError('validation_failed', '1 field failed validation', {
      details: [
        { path: 'anchor', code: 'invalid_value', message: "none, first, last or fixed:<n>" },
      ],
    }),
  // B §4.1's price for one node table: the CHECK that stops it becoming "a question with no
  // question_type". Reported against the field the kind requires, not as a 500.
  nodes_kind_shape: (message) =>
    new AppError('validation_failed', '1 field failed validation', {
      details: [{ path: null, code: 'kind_shape', message }],
    }),
  nodes_root_is_block: () =>
    new AppError('validation_failed', '1 field failed validation', {
      details: [
        {
          path: 'parent_id',
          code: 'root_is_block',
          message: 'only a block may be a root node (C §5)',
        },
      ],
    }),
  // `content.move_node`'s two refusals. Not constraint names in any migration — the function
  // raises them with `RAISE EXCEPTION` — so `SupabaseRepo.raiseMoveError` mints these two names
  // from the message and the in-memory store raises the same two. See that function.
  nodes_move_into_subtree: () =>
    new AppError('validation_failed', '1 field failed validation', {
      details: [
        {
          path: 'parent_id',
          code: 'move_into_own_subtree',
          message: 'a node cannot be moved into its own subtree',
        },
      ],
    }),
  nodes_nesting: (message) =>
    new AppError('validation_failed', '1 field failed validation', {
      details: [{ path: 'parent_id', code: 'illegal_nesting', message }],
    }),
  qcells_key: () =>
    new AppError('already_exists', 'that cell already has an override', {
      details: [
        {
          path: 'cells',
          code: 'duplicate_cell',
          message: 'one override per (row, column); two would make the data type depend on order',
        },
      ],
    }),
  qcells_use_columns_is_row_level: () =>
    new AppError('validation_failed', '1 field failed validation', {
      details: [
        {
          path: 'cells',
          code: 'use_columns_is_row_level',
          message: 'use_columns is only meaningful on a whole-row override (C §5.2)',
        },
      ],
    }),
  // A sibling or parent named in the body that does not exist in the version. 422 with the field
  // rather than 404: the RESOURCE the caller addressed exists and is theirs — it is the body that
  // names something absent, and the client needs to know which field.
  nodes_survey_version_id_parent_id_fkey: (message) =>
    new AppError('validation_failed', '1 field failed validation', {
      details: [{ path: 'parent_id', code: 'unknown_node', message }],
    }),
  question_items_survey_version_id_question_id_fkey: (message) =>
    new AppError('validation_failed', '1 field failed validation', {
      details: [{ path: 'after_id', code: 'unknown_item', message }],
    }),
  question_cells_survey_version_id_row_item_id_fkey: (message) =>
    new AppError('validation_failed', '1 field failed validation', {
      details: [{ path: 'cells', code: 'unknown_item', message }],
    }),
  // The export contract's two unique indexes (0007 §7). Both are reachable from a rename, which
  // is why the message points at the ref rather than at a variable the caller never named.
  variables_name_key: () =>
    new AppError('already_exists', 'that variable name is already in use in this version', {
      details: [
        { path: 'ref', code: 'already_exists', message: 'variable names are unique per version' },
      ],
    }),
  variables_export_col_key: () =>
    new AppError('already_exists', 'that export column is already claimed in this version', {
      details: [
        {
          path: 'ref',
          code: 'already_exists',
          message: 'two variables cannot claim one export column (ADR-007)',
        },
      ],
    }),
  // `content.tg_variable_name_not_reserved` (K §6): a question whose ref would derive a reserved
  // name — `DURATION_S`, `RESPONDENT_ID` — is refused, and renaming the QUESTION is the fix.
  variables_reserved_name: (message) =>
    new AppError('validation_failed', '1 field failed validation', {
      details: [{ path: 'ref', code: 'reserved_variable_name', message }],
    }),
  vars_enum_domain: (message) =>
    new AppError('validation_failed', '1 field failed validation', {
      details: [{ path: 'config', code: 'missing_enum_domain', message }],
    }),
  vars_response_has_source: (message) =>
    new AppError('validation_failed', '1 field failed validation', {
      details: [{ path: null, code: 'response_without_source', message }],
    }),
  vars_transient: (message) =>
    new AppError('validation_failed', '1 field failed validation', {
      details: [{ path: null, code: 'transient_response', message }],
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

/** One message for every `content.tg_draft_only` copy: ADR-002, with the actionable answer. */
function frozenVersionError(): AppError {
  return new AppError('frozen_version', 'this survey version is frozen; clone a new draft to edit');
}

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
  // The content tree's write policies decline the same way every other content table's do — zero
  // rows for "not yours", "not programmer" and "no such version/node" alike. The routes answer
  // the states a caller can see (403 role, 409 frozen) before the store is reached; what is left
  // is indistinguishable from a node that does not exist, and 404 is the answer that leaks least.
  'nodes_insert',
  'nodes_update',
  'nodes_select',
  'qitems_insert',
  'qitems_update',
  'qitems_select',
  'qcells_insert',
  'qcells_delete',
  'qcells_select',
  'variables_insert',
  'variables_update',
  'variables_select',
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
