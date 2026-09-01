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
  RULE_ACTIONS,
  RULE_EVALUATIONS,
  RULE_KINDS,
  type Disposition,
  type OrgRole,
  type RuleAction,
  type RuleEvaluation,
  type RuleKind,
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
      /**
       * Replay a RECORDED session (P1-11's acceptance, E §12.3). Unlike the other three actions
       * this one starts nothing: the runtime loads the session's seed and its stored events and
       * re-drives the pipeline, writing nothing. The id is shape-checked here because it becomes
       * a URL path segment upstream and an `app.ulid` at the database boundary.
       */
      action: z.literal('replay'),
      session_id: z.string().regex(/^ses_[0-7][0-9A-HJKMNP-TV-Z]{25}$/),
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
/* Vendors (API §2.16, migration 0024)                                        */
/* -------------------------------------------------------------------------- */

/**
 * One vendor on the wire.
 *
 * `security` is nullable rather than optional-with-a-partial-shape, because 0024's
 * `vendors_security_all_or_none` CHECK makes half-configured signing unstorable and a schema that
 * allowed `{ hash_param }` alone would accept a body the database refuses. Signed or unsigned,
 * never half — mirrored here so the 422 arrives before the write.
 *
 * `secret_ref` is bounded at 31 characters at the TOP end on purpose: 0024 refuses a value matching
 * `^[A-Za-z0-9+/=_-]{32,}$` because that is what a pasted HMAC key looks like, and a length cap is a
 * cheaper, clearer way to say the same thing on the wire. A legitimate reference is a path like
 * `vendor/panel_a/hmac`, well under it; a 32-character opaque blob is a secret. Both layers refuse
 * it, and the wire's message can say why in a 422 rather than a constraint name.
 */
const vendorInboundParamSchema = z
  .object({
    param: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/),
    variable_ref: z.string().min(1).max(64),
    required: z.boolean(),
  })
  .strict();

const vendorRowSchema = z
  .object({
    id: z.string().regex(/^vnd_[0-7][0-9A-HJKMNP-TV-Z]{25}$/),
    ref: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/),
    name: z.string().min(1).max(200),
    entry_url_template: z.string().max(2048).nullable(),
    max_completes: z.number().int().positive().nullable(),
    quota_plan_overrides: z.array(z.string().max(64)).max(64),
    inbound_params: z.array(vendorInboundParamSchema).max(64),
    security: z
      .object({
        hash_param: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/),
        algorithm: z.enum(['sha256', 'sha1', 'md5']),
        // See the header: a reference is short and path-shaped; 32+ opaque characters is a key.
        secret_ref: z.string().min(1).max(200),
        signed_params: z.array(z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/)).min(1).max(64),
        max_skew_s: z.number().int().positive().max(2_592_000).optional(),
        timestamp_param: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/).optional(),
        nonce_param: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/).optional(),
      })
      .strict()
      .nullable(),
  })
  .strict();

export const replaceVendorsSchema = z
  .object({ vendors: z.array(vendorRowSchema).max(64) })
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

/* -------------------------------------------------------------------------- */
/* Translations (roadmap P1-12, migration 0007 §8)                            */
/* -------------------------------------------------------------------------- */

/**
 * One added language. The regex is `languages_tag_shape` (0007), verbatim — `en`, `fr-CA`,
 * `zh-Hans-CN` — so a bad tag is a 422 with a field path rather than the CHECK's 500. No
 * `is_base`: the base language is born with the version, and a body that could claim it would
 * be a request `languages_one_base` exists to refuse.
 */
export const addLanguageSchema = z
  .object({ lang: z.string().regex(/^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2})?$/, 'a BCP-47-ish tag: en, fr-CA, zh-Hans-CN') })
  .strict();

/**
 * The import body: a FLAT key-value map, exactly the file the export handed out. `z.record`
 * and not `.strict()` because here the unknown keys ARE the data — key validation (against the
 * BASE language's key set, so a translator's typo is a 422 naming it rather than a silently
 * invented row) is the route's job, since the valid set lives in the store, not the schema.
 * `''` is legal and meaningful: it clears the string back to `missing` (0007's own encoding:
 * state `missing`, value NULL), which is what makes an exported-then-unedited file a no-op.
 */
export const importTranslationsSchema = z.record(z.string().max(20_000));

/* -------------------------------------------------------------------------- */
/* Exports (roadmap P1-12, migration 0012)                                    */
/* -------------------------------------------------------------------------- */

/**
 * Both flags default FALSE — the same defaults the table's columns carry, and the honest ones:
 * PII off (security §7.2) and test rows out (E §14.1). The dialog's job is these defaults; the
 * ENFORCEMENT of `pii_included` is 0012's `app.tg_exports_pii_guard`, which this schema
 * deliberately does not restate.
 */
export const createExportSchema = z
  .object({
    pii_included: z.boolean().optional(),
    include_test: z.boolean().optional(),
  })
  .strict();

/* -------------------------------------------------------------------------- */
/* Content nodes, items and cells (API §2.5, migration 0007)                  */
/* -------------------------------------------------------------------------- */

/** `content.node_kind` / `content.item_kind` — physical discriminators, not K §7 registries. */
const nodeKindSchema = z.enum(['block', 'page', 'question', 'text']);
const itemKindSchema = z.enum(['option', 'row', 'column']);

/**
 * Where a new sibling goes: `after_id`, or `before_id`, or neither (which means first).
 *
 * NO `sort_key` and no `position`, which is API §3 item 6 made unrepresentable rather than merely
 * refused: "a client never sees a fractional key and cannot corrupt the ordering by inventing
 * one". `after_id: null` is explicitly legal and means the head of the list, so the field is
 * nullable rather than only optional — "put it first" must be sayable.
 */
const siblingPositionFields = {
  after_id: ulidIdSchema.nullable().optional(),
  before_id: ulidIdSchema.optional(),
};

function onePosition(body: {
  readonly after_id?: string | null | undefined;
  readonly before_id?: string | undefined;
}): boolean {
  return body.after_id === undefined || body.before_id === undefined;
}

const ONE_POSITION = { message: 'provide either after_id or before_id, not both' };

/**
 * A label as an I18N KEY, not as prose.
 *
 * Every human-readable string in a survey lives in `content.i18n_strings` keyed by
 * `label_key` / `instruction_key` / `title_key` (B §6, C §16), because a survey runs in one to
 * forty languages and the base language is just the first of them. So these three fields carry
 * the KEY, and the text arrives through `PUT /versions/{id}/translations/{lang}`. API §2.5 spells
 * the field `label`, which is what the column is called minus the `_key` suffix; the suffix is
 * dropped on the wire and restored by the route, so nothing here invents a second name for it.
 */
const i18nKeySchema = z.string().min(1).max(256);

/**
 * `config` is `z.record(z.unknown())` and NOT validated field-by-field here, deliberately.
 *
 * The authority is the PLUGIN's `configSchema` (F §5), compiled by the registry and run in
 * `src/server/questions.ts` on the same object this schema passes through; restating fifteen
 * plugins' config shapes in Zod would be a second definition that eventually rejects what the
 * plugin accepts — and the plugin's is the one that decides what the question emits.
 */
const configSchema = z.record(z.unknown());

/**
 * A label as PROSE, which the server turns into a key plus a base-language string.
 *
 * The sibling of `i18nKeySchema` and the field a UI should send. `label` means "I am managing the
 * keys myself, here is one"; `label_text` means "here is what the author typed — mint or reuse a
 * key and store this in the base language". Both exist because both callers exist: an API consumer
 * importing a survey with its own key scheme, and a person typing into a textarea.
 *
 * It is a separate field rather than a redefinition of `label` because 03 §16 makes keys the
 * interface and an API consumer's keys must keep working. The studio was sending prose in `label`,
 * so every label it wrote was a dangling reference — twenty-one `SCH-1008` errors on a
 * four-question survey, each naming a key that was visibly a sentence.
 *
 * Longer than a key on purpose: this is a question stem, which can legitimately be a paragraph.
 */
const i18nTextSchema = z.string().min(1).max(8192);

/**
 * `label` and `label_text` are mutually exclusive, per field.
 *
 * Accepting both would mean choosing one silently, and either choice is wrong half the time: the
 * caller has told us two different things about the same column. Refused with the field named, so
 * the answer is actionable rather than "invalid body".
 */
const NO_KEY_AND_TEXT =
  'label/instruction/title and their _text form are mutually exclusive: send the KEY when you ' +
  'manage keys yourself, or the TEXT to have one minted and the base-language string written.';

function keyXorText(value: {
  readonly label?: unknown; readonly label_text?: unknown;
  readonly instruction?: unknown; readonly instruction_text?: unknown;
  readonly title?: unknown; readonly title_text?: unknown;
}): boolean {
  return (
    !(value.label !== undefined && value.label_text !== undefined) &&
    !(value.instruction !== undefined && value.instruction_text !== undefined) &&
    !(value.title !== undefined && value.title_text !== undefined)
  );
}

export const createNodeSchema = z
  .object({
    node_kind: nodeKindSchema,
    /** `null` = a root node, which `nodes_root_is_block` allows only for a block. */
    parent_id: ulidIdSchema.nullable(),
    ...siblingPositionFields,
    ref: refSchema.optional(),
    question_type: z.string().min(1).max(64).optional(),
    label: i18nKeySchema.optional(),
    instruction: i18nKeySchema.optional(),
    title: i18nKeySchema.optional(),
    /** Prose. Mutually exclusive with the key form above — see the refinement below. */
    label_text: i18nTextSchema.optional(),
    instruction_text: i18nTextSchema.optional(),
    title_text: i18nTextSchema.optional(),
    required: z.boolean().optional(),
    config: configSchema.optional(),
  })
  .strict()
  .refine(onePosition, ONE_POSITION)
  .refine(keyXorText, NO_KEY_AND_TEXT);

/**
 * A partial node edit.
 *
 * `question_type` IS accepted by the schema and then refused by the route with an explanation.
 * Leaving it out would answer `400 unknown_field: question_type is not a field of this resource`,
 * which is false — it is a field, and an important one; what it is not is patchable, because the
 * emitted variables differ (API §2.5). A truthful 422 naming the remedy ("delete and recreate")
 * is worth the extra line.
 */
export const updateNodeSchema = z
  .object({
    ref: refSchema.optional(),
    question_type: z.string().min(1).max(64).optional(),
    label: i18nKeySchema.nullable().optional(),
    instruction: i18nKeySchema.nullable().optional(),
    title: i18nKeySchema.nullable().optional(),
    label_text: i18nTextSchema.optional(),
    instruction_text: i18nTextSchema.optional(),
    title_text: i18nTextSchema.optional(),
    required: z.boolean().optional(),
    config: configSchema.optional(),
    settings: z.record(z.unknown()).optional(),
    flags: z.record(z.unknown()).optional(),
  })
  .strict()
  .refine(keyXorText, NO_KEY_AND_TEXT);

export const moveNodeSchema = z
  .object({ parent_id: ulidIdSchema.nullable(), ...siblingPositionFields })
  .strict()
  .refine(onePosition, ONE_POSITION);

/**
 * `POST /nodes/{id}/duplicate`. `ref` is the COPY's ref for the subtree ROOT; every descendant's
 * ref is derived by the suffix rule in `src/server/nodes.ts`, because a client cannot know how
 * many nodes the subtree holds without walking it — and if it walked it, it would be computing
 * refs the server has to re-check for uniqueness anyway.
 */
export const duplicateNodeSchema = z
  .object({
    ref: refSchema,
    into_parent_id: ulidIdSchema.nullable().optional(),
    after_id: ulidIdSchema.nullable().optional(),
  })
  .strict();

/**
 * One option / row / column `behaviour` entry: `{literal}` or `{condition: AST}` (C §5.1).
 *
 * `condition` is `z.unknown()` for `createRuleSchema`'s reason — the AST's shape is
 * `packages/logic`'s and the validator with authority is `checkExpr`, which the route runs and
 * answers 422 with the `LGC-*` codes. Exactly one of the two arms, because "a literal AND a
 * condition" is two answers to one question.
 */
const behaviourEntrySchema = z
  .object({ literal: z.unknown().optional(), condition: z.unknown().optional() })
  .strict()
  .refine(
    (entry) => (entry.literal === undefined) !== (entry.condition === undefined),
    'provide either literal or condition, not both',
  );

/**
 * The programmable properties of one item.
 *
 * `.strict()`, so a property the schema does not name is a 422 rather than a field that is
 * accepted, stored, and read by nothing. That is also why adding one here is a deliberate edit:
 * every key below has a cell in the engine and a consumer at render time.
 *
 * `pin` is a plain boolean among the conditional values — see `OptionBehaviour.pin` for why it
 * lives in this bag rather than beside `exclusive` on the item.
 */
const behaviourSchema = z
  .object({
    visible: behaviourEntrySchema.optional(),
    enabled: behaviourEntrySchema.optional(),
    preselected: behaviourEntrySchema.optional(),
    auto_select: behaviourEntrySchema.optional(),
    required_if: behaviourEntrySchema.optional(),
    pin: z.boolean().optional(),
    prioritized: behaviourEntrySchema.optional(),
    deprioritized: behaviourEntrySchema.optional(),
  })
  .strict();

/**
 * `code` is `z.number().int()` and is REQUIRED, with no default and no "next free code" helper.
 *
 * C §5.1 calls conflating code with display order "a classic data disaster", and a server that
 * assigned codes by position would be the API doing exactly that on the author's behalf. The
 * author says what the exported value is; `qitems_code_key` says whether it is free.
 */
const itemCodeSchema = z.number().int().min(-2_147_483_648).max(2_147_483_647);

/** `qitems_anchor_shape`, verbatim, so a typo'd anchor is a 422 and not a silent non-anchor. */
const anchorSchema = z
  .string()
  .regex(/^(none|first|last|fixed:[0-9]{1,4})$/, 'none, first, last or fixed:<n>');

export const createItemSchema = z
  .object({
    item_kind: itemKindSchema,
    ref: refSchema,
    code: itemCodeSchema,
    label: i18nKeySchema.optional(),
    ...siblingPositionFields,
    anchor: anchorSchema.optional(),
    exclusive: z.boolean().optional(),
    behaviour: behaviourSchema.optional(),
    value_override: z.string().max(256).optional(),
    custom_class: z.string().max(128).optional(),
    meta: z.record(z.unknown()).optional(),
  })
  .strict()
  .refine(onePosition, ONE_POSITION);

export const updateItemSchema = z
  .object({
    ref: refSchema.optional(),
    code: itemCodeSchema.optional(),
    label: i18nKeySchema.nullable().optional(),
    anchor: anchorSchema.optional(),
    exclusive: z.boolean().optional(),
    behaviour: behaviourSchema.optional(),
    value_override: z.string().max(256).nullable().optional(),
    custom_class: z.string().max(128).nullable().optional(),
    meta: z.record(z.unknown()).optional(),
  })
  .strict();

export const moveItemSchema = z
  .object(siblingPositionFields)
  .strict()
  .refine(onePosition, ONE_POSITION);

/**
 * The paste-60-brands body. 2,000 rows is far past API §1.3's sibling cap of 1,000 and is here as
 * a body-size guard rather than a product limit: the atomic write is one statement either way.
 */
export const bulkItemsSchema = z
  .object({
    item_kind: itemKindSchema,
    mode: z.enum(['replace', 'append']),
    items: z
      .array(
        z
          .object({
            ref: refSchema,
            code: itemCodeSchema,
            label: i18nKeySchema.optional(),
            anchor: anchorSchema.optional(),
            exclusive: z.boolean().optional(),
            behaviour: behaviourSchema.optional(),
            value_override: z.string().max(256).optional(),
            custom_class: z.string().max(128).optional(),
            meta: z.record(z.unknown()).optional(),
          })
          .strict(),
      )
      .max(2000),
  })
  .strict();

/**
 * `PUT /nodes/{id}/cells` — mixed matrices (C §5.2), addressed by item REF.
 *
 * Refs and not ids, exactly as API §2.5 spells it, and the route resolves them against the
 * question's own items: a cell is authored as "row BRAND_C is a numeric", and the id of the row
 * is not something an author holds. `use_columns` means "this control ranges over the matrix's
 * columns", which `qcells_use_columns_is_row_level` allows only on a whole-row override.
 */
export const replaceCellsSchema = z
  .object({
    cells: z
      .array(
        z
          .object({
            row_ref: refSchema,
            column_ref: refSchema.optional(),
            control: z
              .object({
                question_type: z.string().min(1).max(64),
                config: configSchema.optional(),
                use_columns: z.boolean().optional(),
              })
              .strict(),
          })
          .strict(),
      )
      .max(2000),
  })
  .strict();

/* -------------------------------------------------------------------------- */
/* Logic rules (API §2.7, roadmap P1-12)                                      */
/* -------------------------------------------------------------------------- */

/** `content.rule_kind` / the effect registry / the evaluation CHECK — canonical arrays, never restated. */
const ruleKindSchema = z.enum(RULE_KINDS as unknown as readonly [RuleKind, ...RuleKind[]]);
const ruleActionSchema = z.enum(RULE_ACTIONS as unknown as readonly [RuleAction, ...RuleAction[]]);
const ruleEvaluationSchema = z.enum(
  RULE_EVALUATIONS as unknown as readonly [RuleEvaluation, ...RuleEvaluation[]],
);

/**
 * `target` mirrors API §2.7's `{node_id|item_id|variable_id}` — exactly one, which is
 * `rules_one_target` restated at the boundary so the author gets a 422 naming the field rather
 * than a constraint error dressed as a 500.
 */
const ruleTargetSchema = z
  .object({
    node_id: ulidIdSchema.optional(),
    item_id: ulidIdSchema.optional(),
    variable_id: ulidIdSchema.optional(),
  })
  .strict()
  .refine(
    (t) => [t.node_id, t.item_id, t.variable_id].filter((v) => v !== undefined).length === 1,
    'exactly one of node_id, item_id, variable_id',
  );

/**
 * `condition` and `effect.value` are `z.unknown()` for `dslPrintSchema`'s reason: the AST's
 * shape is `packages/logic`'s to define, and the validator with authority is `checkExpr` — the
 * route runs it and answers 422 with `LGC-*` codes, which no Zod restatement of 58 node kinds
 * could match without eventually disagreeing.
 */
const ruleEffectSchema = z
  .object({
    action: ruleActionSchema,
    value: z.unknown().optional(),
    target_id: ulidIdSchema.optional(),
    disposition: z.string().min(1).max(64).optional(),
    message_key: z.string().min(1).max(256).optional(),
    params: z
      .object({
        axis: z.enum(['option', 'row', 'column']).optional(),
        codes: z.array(z.number().int()).max(500).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/**
 * API §2.7: "accepts either `condition` (AST) **or** `source` (ResScript)". With `source`, the
 * server parses it and stores both the AST and the trivia — so `kind`/`condition`/`effect` come
 * from the statement and are forbidden alongside it (a body that supplied both would be two
 * definitions of one rule). `target` stays legal with `source` because some effects name no
 * content target in the text (`TERMINATE`), and `rules_one_target` still wants one.
 */
export const createRuleSchema = z
  .object({
    kind: ruleKindSchema.optional(),
    target: ruleTargetSchema.optional(),
    condition: z.unknown().optional(),
    effect: ruleEffectSchema.optional(),
    evaluation: ruleEvaluationSchema.optional(),
    notes: z.string().max(2000).optional(),
    source: z.string().max(200_000).optional(),
  })
  .strict()
  .refine((body) => (body.source === undefined) !== (body.condition === undefined), {
    message: 'provide either source or condition, not both',
  })
  .refine(
    (body) => body.source !== undefined || (body.kind !== undefined && body.effect !== undefined && body.target !== undefined),
    { message: 'the AST path requires kind, target and effect' },
  )
  .refine((body) => body.source === undefined || (body.kind === undefined && body.effect === undefined), {
    message: 'kind and effect come from the source statement; do not also send them',
  });

/** Partial edit. The same either/or applies when the condition itself is being replaced. */
export const updateRuleSchema = z
  .object({
    kind: ruleKindSchema.optional(),
    target: ruleTargetSchema.optional(),
    condition: z.unknown().optional(),
    effect: ruleEffectSchema.optional(),
    evaluation: ruleEvaluationSchema.optional(),
    notes: z.string().max(2000).nullable().optional(),
    source: z.string().max(200_000).optional(),
  })
  .strict()
  .refine((body) => body.source === undefined || body.condition === undefined, {
    message: 'provide either source or condition, not both',
  })
  .refine((body) => body.source === undefined || (body.kind === undefined && body.effect === undefined), {
    message: 'kind and effect come from the source statement; do not also send them',
  });
