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
