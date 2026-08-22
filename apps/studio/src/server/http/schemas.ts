/**
 * Request schemas.
 *
 * All `.strict()`, because API §1.1 rejects unknown request fields rather than ignoring them:
 * an ignored typo is a survey that quietly lacks a quota. Enum members come from
 * `@resscript/schema`'s canonical registries — `ORG_ROLES` here is the same array the SQL enum
 * and the RLS policies are generated from, so a role added in one place cannot be missing in
 * the other.
 */

import { z } from 'zod';
import {
  ORG_ROLES,
  REDIRECT_REQUIRED_DISPOSITIONS,
  type Disposition,
  type OrgRole,
} from '@resscript/schema';

/**
 * `app.org_role`, from the canonical registry. Never a hand-written string union.
 *
 * The cast is to a non-empty tuple — `z.enum` needs that shape and `ORG_ROLES` is typed as an
 * array — and it is the only thing the cast asserts: the VALUES still come from the registry, so
 * a role added there is accepted here with no edit, and the parsed output is `OrgRole` rather
 * than `string`, which is what keeps the routes free of casts.
 */
export const orgRoleSchema = z.enum(ORG_ROLES as unknown as readonly [OrgRole, ...OrgRole[]]);

/** `app.ref` — the format shared by project and survey refs. */
const refSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z][A-Za-z0-9_]*$/, 'must start with a letter and contain only letters, digits and _');

const ulidIdSchema = z.string().regex(/^[a-z]{2,4}_[0-9A-HJKMNP-TV-Z]{26}$/, 'not a prefixed ULID');

export const createOrganizationSchema = z
  .object({
    slug: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/, 'lowercase letters, digits and hyphens; 3-40 chars'),
    name: z.string().min(1).max(200),
    data_region: z.string().min(2).max(32).optional(),
  })
  .strict();

export const updateOrganizationSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    settings: z.record(z.unknown()).optional(),
  })
  .strict();

export const updateMemberSchema = z
  .object({
    role: orgRoleSchema.optional(),
    project_ids: z.array(ulidIdSchema).max(500).optional(),
  })
  .strict();

export const createInvitationSchema = z
  .object({
    email: z.string().email().max(320),
    role: orgRoleSchema,
    project_ids: z.array(ulidIdSchema).max(500).optional(),
  })
  .strict();

export const acceptInvitationSchema = z.object({ token: z.string().min(16).max(512) }).strict();

export const createProjectSchema = z
  .object({
    ref: refSchema,
    name: z.string().min(1).max(200),
    client_name: z.string().max(200).optional(),
    tags: z.array(z.string().min(1).max(40)).max(50).optional(),
    field_start: z.string().date().optional(),
    field_end: z.string().date().optional(),
  })
  .strict();

export const updateProjectSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    client_name: z.string().max(200).optional(),
    tags: z.array(z.string().min(1).max(40)).max(50).optional(),
    field_start: z.string().date().optional(),
    field_end: z.string().date().optional(),
    /** Soft archive. `false` un-archives, which frees nothing and breaks nothing. */
    archived: z.boolean().optional(),
  })
  .strict();

export const createSurveySchema = z
  .object({
    project_id: ulidIdSchema,
    ref: refSchema,
    name: z.string().min(1).max(200),
    description: z.string().max(2000).optional(),
    survey_kind: z.enum(['standard', 'tracker_wave', 'template']).optional(),
    default_language: z.string().min(2).max(12).optional(),
    parent_survey_id: ulidIdSchema.optional(),
  })
  .strict();

export const updateSurveySchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).optional(),
    ref: refSchema.optional(),
    archived: z.boolean().optional(),
  })
  .strict();

export const createVersionSchema = z
  .object({
    from_version_id: ulidIdSchema.optional(),
    notes: z.string().max(2000).optional(),
  })
  .strict();

/** `status` is NOT writable here: publishing is `POST /versions/{id}/publish` (API §2.4). */
export const updateVersionSchema = z.object({ notes: z.string().max(2000).optional() }).strict();

/* -------------------------------------------------------------------------- */
/* Publish and rollback (API §2.4, roadmap P1-08)                             */
/* -------------------------------------------------------------------------- */

/**
 * One acknowledged compile warning.
 *
 * `key` and NOT `{code, node_id}`, which is what H §2.4's example shows, and the deviation is
 * deliberate: the compiler computes the acknowledgement identity itself
 * (`acknowledgementKey()` = code + JSON pointer + sorted detail) precisely so that an
 * acknowledgement dies when the thing it was given for moves. A code plus a node id is a
 * DIFFERENT identity — coarser, and stable across edits that change what the warning is about —
 * so accepting that shape would mean the API computing a second definition of "the same warning"
 * and disagreeing with the gate that blocks the publish. The client echoes back the key the
 * compile result gave it.
 *
 * `reason` is 03 §17's recorded note: "publishing over a warning is allowed but the
 * acknowledgement is recorded and audited, so 'who signed off on shipping this' is answerable
 * months later". Optional here rather than required because the studio's dialog can legitimately
 * offer "acknowledge all" for a batch of the same code, and a required field would be satisfied
 * with a space.
 */
const acknowledgedWarningSchema = z
  .object({ key: z.string().min(1).max(512), reason: z.string().max(2000).optional() })
  .strict();

/**
 * `target` accepts staging and production ONLY.
 *
 * H §2.4 lists `'review'` as a third option and `app.publish_version` refuses it — "draft and
 * review are authoring states; archived is reached by app.rollback_version" — so accepting it here
 * would queue a job whose only possible outcome is an `insufficient_privilege` the user cannot act
 * on. Rejected at the boundary with that explanation instead. Moving a version to `review` is a
 * status transition with no compile behind it and belongs to its own endpoint.
 */
export const publishVersionSchema = z
  .object({
    target: z.enum(['staging', 'production']),
    acknowledge_warnings: z.array(acknowledgedWarningSchema).max(1000).optional(),
  })
  .strict();

/** `app.rollback_version` takes only the target; the survey and the incumbent come from it. */
export const rollbackSurveySchema = z.object({ to_version_id: ulidIdSchema }).strict();

/* -------------------------------------------------------------------------- */
/* The preview debug session (P1-11)                                          */
/* -------------------------------------------------------------------------- */

/** E §14.1: 32 lowercase hex chars — the exact shape the runtime accepts and echoes back. */
const previewSeedSchema = z.string().regex(/^[0-9a-f]{32}$/, '32 lowercase hex characters');

/**
 * One step of a debug session, proxied to the runtime's preview endpoints by
 * `POST /versions/:id/debug-session`. A discriminated union rather than three routes because
 * the three actions share everything that matters — the version resolution, the compiled-check,
 * the server-side token mint — and the thing the route must hold in ONE place is the `pt`
 * token, which must never reach the browser (it is minted from `PREVIEW_SIGNING_SECRET`).
 *
 * `values` and `vars` are `z.record(z.unknown())`: their field-level validation is the
 * runtime's (`filterSubmit` against the variable manifest, `handlePreviewSetVars` against the
 * same), and restating it here would be a second filter that eventually disagrees with the one
 * that actually writes.
 */
export const debugSessionSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('start'),
      seed: previewSeedSchema.optional(),
      lang: z.string().min(2).max(16).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('submit'),
      session_id: z.string().min(1).max(128),
      page_id: z.string().min(1).max(128),
      values: z.record(z.unknown()),
    })
    .strict(),
  z
    .object({
      action: z.literal('setvars'),
      session_id: z.string().min(1).max(128),
      vars: z.record(z.unknown()),
    })
    .strict(),
]);

/* -------------------------------------------------------------------------- */
/* Redirects (API §2.9, migration 0010)                                       */
/* -------------------------------------------------------------------------- */

/**
 * One flattened `content.redirects` row, as PUT receives it.
 *
 * `disposition` is the REGISTRY SUBSET K §2 marks "redirect required" — the same array 0010's
 * `redirects_disposition_registry` CHECK is generated from — never a hand-written union: a row
 * for `ABANDONED` or `TIMED_OUT` would be a URL nobody is there to be sent to, and the schema
 * refuses it with the enum's own message rather than letting the CHECK refuse it as a 500.
 *
 * `scope_key` and `custom_key` are OPTIONAL and land as `''`, which is the table's own encoding
 * of "not applicable" (0010's biconditional CHECKs pin it), so an author writing a default-scope
 * COMPLETE row sends two fields, not four. Optional here and normalized in the route rather than
 * Zod's `.default('')`, because `parseJsonBody`'s `ZodType<T>` boundary erases the
 * output-vs-input distinction a default lives in — the route would receive `string | undefined`
 * either way and the `??` there is the honest spelling. The biconditionals — a `vendor` row needs
 * a ref, a `CUSTOM` row needs a key — are cross-field facts Zod cannot name per row cheaply;
 * they are checked with the templates in `src/server/redirects.ts`, which is also what keeps
 * every failure of one PUT in ONE 422 naming every offending row instead of the first.
 */
const redirectRowSchema = z
  .object({
    scope: z.enum(['default', 'vendor', 'language']),
    scope_key: z.string().max(128).optional(),
    disposition: z.enum(
      REDIRECT_REQUIRED_DISPOSITIONS as unknown as readonly [Disposition, ...Disposition[]],
    ),
    custom_key: z.string().max(128).optional(),
    // 4 KB: generous for a callback URL with a signature, small enough that a runaway paste
    // cannot make the validator the slowest thing in the request.
    url_template: z.string().min(1).max(4096),
  })
  .strict();

/** Whole-set replace — PUT semantics. 500 rows is 8 scopes × the whole disposition registry, twice over. */
export const replaceRedirectsSchema = z
  .object({ redirects: z.array(redirectRowSchema).max(500) })
  .strict();

/* -------------------------------------------------------------------------- */
/* The ResScript DSL endpoints (API §5)                                       */
/* -------------------------------------------------------------------------- */

/**
 * `scope.survey_version_id` is required, and that is API §5.1's decision, not a convenience:
 * "there is no context-free compile of a survey rule, and pretending otherwise would let a CI job
 * produce ASTs with dangling references". The version supplies the variable registry, which *is*
 * the type environment (D §3.2).
 */
const dslScopeSchema = z.object({ survey_version_id: ulidIdSchema }).strict();

export const dslCompileSchema = z
  .object({
    // 200 KB. Generous for a rule pane and small enough that a runaway paste cannot make the
    // parser the slowest thing in the request.
    source: z.string().max(200_000),
    scope: dslScopeSchema,
    mode: z.enum(['rules', 'survey', 'expression']).optional(),
    options: z.object({ keep_trivia: z.boolean().optional() }).strict().optional(),
  })
  .strict();

/**
 * `statements` is `unknown[]` at the schema boundary, deliberately.
 *
 * Every other request body here is `.strict()`-validated field by field, because an ignored typo
 * is a survey that quietly lacks a quota (API §1.1). An AST is the exception: its shape is defined
 * by `packages/logic` (58 node kinds, five statement kinds, trivia), and restating it as a Zod
 * schema would be precisely the second definition ADR-010 exists to prevent — one that would
 * accept or reject a *different* language than the printer implements. So the validation is the
 * printer itself: an unknown node kind is a thrown `LogicInvariant` (printer.ts's exhaustive
 * `switch`), which the route turns into a `validation_failed` naming the offending index.
 */
export const dslPrintSchema = z
  .object({
    statements: z.array(z.unknown()).max(5000),
    scope: dslScopeSchema,
    options: z
      .object({
        width: z.number().int().min(20).max(400).optional(),
        indent: z.string().max(8).optional(),
        /**
         * API §5.2's example passes this. Only `true` is implementable: D §6.4 T2 forbids the
         * printer changing "the author's choice of symbolic (`Q1.Yes`) vs numeric (`1`) option
         * references", so the choice comes from the AST's trivia and not from a request field.
         * `false` is refused with that explanation rather than accepted and ignored.
         */
        symbolic_option_refs: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
