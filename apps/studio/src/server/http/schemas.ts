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
import { ORG_ROLES, type OrgRole } from '@resscript/schema';

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
