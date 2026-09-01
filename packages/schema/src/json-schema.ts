/**
 * JSON Schema (draft 2020-12) and the runtime shape validator, from one source of truth.
 *
 * ## The approach, and why
 *
 * There are three plausible ways to get a JSON Schema for this model:
 *
 *  1. Generate it from the TypeScript types with a reflection tool. Rejected: it drags a
 *     build-time dependency into a package that must stay dependency-free, and the generated
 *     output is unreadable, so nobody reviews it.
 *  2. Hand-write the JSON Schema next to the types. Rejected: two hand-written descriptions of
 *     one model drift within weeks, and the drift is silent — a field added to the TS type is
 *     simply not validated, which is the worst possible failure mode for an import boundary.
 *  3. Hand-write a compact *descriptor* and derive both the JSON Schema and the runtime
 *     validator from it, with the TS types checking the descriptor for completeness.
 *
 * This file is (3). The descriptor is ordinary data, so both outputs come from one walk, and
 * the mapped type `FieldsOf<T>` makes the compiler enforce the correspondence:
 *
 *  - a field present in the TS type but missing from the descriptor is a **compile error**
 *    (the mapped type requires every key);
 *  - a field in the descriptor that the TS type does not have is a **compile error** (excess
 *    property checking on the object literal);
 *  - a field that is optional in TS but declared required in the descriptor, or vice versa, is
 *    a **compile error** (`optional` is required to match `{} extends Pick<T, K>`).
 *
 * So the schema cannot silently fall behind the model. What it deliberately does not police is
 * *semantics* — dangling ids, reserved names, mask fallbacks. Those are `validateStructural`'s
 * job, because they need the whole document, not one field.
 */

import { ANCHOR_PATTERN } from './types/common.js';
import { REF_PATTERN, ULID_BODY_PATTERN, type IdPrefix } from './ids.js';
import { DISPOSITIONS } from './registries.js';
import { pointer, type Diagnostic } from './diagnostics.js';
import { MIN_TIME_ACTIONS, PAGE_LAYOUTS } from './types/content.js';
import { RANDOMIZATION_MODES } from './types/common.js';
import { VALIDATION_SCOPES, VALIDATION_TYPES } from './types/validation.js';
import { MASK_FALLBACKS, MASK_MODES, MASK_TARGETS } from './types/masks.js';
import { RULE_ACTIONS, RULE_AUTHORED_IN, RULE_EVALUATIONS, RULE_KINDS } from './types/logic.js';
import {
  QUOTA_CELL_MODES,
  QUOTA_COUNTER_SCOPES,
  QUOTA_COUNT_AT,
  QUOTA_PLAN_TYPES,
  QUOTA_STORE_FAILURE_MODES,
  QUOTA_TARGET_MODES,
} from './types/quotas.js';
import { DESIGN_METHODS } from './types/designs.js';
import { SCRIPT_HOOKS, SCRIPT_SCOPES, SCRIPT_TARGETS } from './types/assets.js';
import { MISSING_STRING_POLICIES } from './types/i18n.js';
import { PROGRESS_BAR_MODES, RESUME_POSITIONS } from './types/settings.js';
import { VARIABLE_KINDS, VARIABLE_TYPES } from './types/variables.js';

import type { JsonValue } from './types/common.js';
import type {
  BlockNode,
  BlockSettings,
  LoopItem,
  LoopSpec,
  OptionBehaviour,
  OptionMedia,
  PageNode,
  PageSettings,
  QuestionCell,
  QuestionCellControl,
  QuestionFlags,
  QuestionItem,
  QuestionNode,
  QuestionScripts,
  TextNode,
} from './types/content.js';
import type { RandomizationSpec, RandomizationSubBlock } from './types/common.js';
import type { Mask, MaskFallbackSpec } from './types/masks.js';
import type { ValidationRule } from './types/validation.js';
import type { Flow, FlowBranch } from './types/flow.js';
import type { LogicRule, RuleEffect } from './types/logic.js';
import type {
  QuotaBucket,
  QuotaCell,
  QuotaConfig,
  QuotaDimension,
  QuotaPlan,
  QuotaPolicy,
  VendorQuotaLimit,
} from './types/quotas.js';
import type { Vendor, VendorInboundParam, VendorSecurity, Redirects } from './types/vendors.js';
import type {
  Design,
  DesignBalance,
  DesignGenerated,
  DesignItem,
  DesignSpec,
} from './types/designs.js';
import type {
  Assets,
  CssAsset,
  HtmlTemplateAsset,
  MediaAsset,
  ScriptAsset,
} from './types/assets.js';
import type { LanguageDef, LanguagePolicy, Languages } from './types/i18n.js';
import type {
  NavigationSettings,
  ProgressBarSettings,
  QualitySettings,
  ResumeSettings,
  ScreenoutSettings,
  SurveySettings,
} from './types/settings.js';
import type { Survey, SurveyMeta } from './types/survey.js';
import type {
  EnumDomainEntry,
  Variable,
  VariableExport,
  VariableSource,
  VariableStorage,
} from './types/variables.js';

/* ========================================================================== */
/* The descriptor language                                                     */
/* ========================================================================== */

export type SchemaDesc =
  | { readonly kind: 'string'; readonly pattern?: string; readonly values?: readonly string[] }
  | { readonly kind: 'number'; readonly integer?: boolean }
  | { readonly kind: 'boolean' }
  /** Any JSON value. Available for open payloads a plugin defines the shape of. */
  | { readonly kind: 'json' }
  /** A JSON object with arbitrary keys. */
  | { readonly kind: 'json_object' }
  /** A Deliverable D AST node. Only the envelope (`op: string`) is checked here — see below. */
  | { readonly kind: 'expr' }
  | { readonly kind: 'array'; readonly items: SchemaDesc }
  | { readonly kind: 'record'; readonly values: SchemaDesc }
  | {
      readonly kind: 'object';
      readonly fields: { readonly [key: string]: FieldDesc };
      /** Open objects are the exception; everything in the survey model is closed. */
      readonly additional?: boolean;
    }
  | {
      readonly kind: 'union';
      readonly variants: readonly SchemaDesc[];
      /** When set, the variant is chosen by this field, giving precise error paths. */
      readonly discriminator?: string;
    }
  | { readonly kind: 'ref'; readonly name: string };

export interface FieldDesc {
  readonly desc: SchemaDesc;
  readonly optional?: boolean;
  /** `null` is an accepted value in addition to `desc`. */
  readonly nullable?: boolean;
}

type RequiredField = FieldDesc & { readonly optional?: false };
type OptionalField = FieldDesc & { readonly optional: true };

/**
 * The exhaustiveness trick. `{} extends Pick<T, K>` is true exactly when `K` is optional in
 * `T`, so the descriptor's optionality has to agree with the type's.
 */
export type FieldsOf<T> = {
  [K in keyof Required<T>]-?: {} extends Pick<T, K> ? OptionalField : RequiredField;
};

function object<T>(fields: FieldsOf<T>): SchemaDesc {
  // `fields` is checked against T by the mapped type above; the widening to the descriptor's
  // index-signature shape is the only place that knowledge is erased.
  return { kind: 'object', fields: fields as { readonly [key: string]: FieldDesc } };
}

/* short constructors, so the descriptor reads like a schema rather than like code */
const str = (values?: readonly string[]): SchemaDesc =>
  values === undefined ? { kind: 'string' } : { kind: 'string', values };
const pattern = (p: string): SchemaDesc => ({ kind: 'string', pattern: p });
const num = (integer = false): SchemaDesc => ({ kind: 'number', integer });
const bool: SchemaDesc = { kind: 'boolean' };
const jsonObject: SchemaDesc = { kind: 'json_object' };
const expr: SchemaDesc = { kind: 'expr' };
const arr = (items: SchemaDesc): SchemaDesc => ({ kind: 'array', items });
const rec = (values: SchemaDesc): SchemaDesc => ({ kind: 'record', values });
const ref = (name: string): SchemaDesc => ({ kind: 'ref', name });
const union = (variants: readonly SchemaDesc[], discriminator?: string): SchemaDesc =>
  discriminator === undefined ? { kind: 'union', variants } : { kind: 'union', variants, discriminator };

const req = (desc: SchemaDesc): RequiredField => ({ desc });
const opt = (desc: SchemaDesc): OptionalField => ({ desc, optional: true });
const optNull = (desc: SchemaDesc): OptionalField => ({ desc, optional: true, nullable: true });

/** A prefixed ULID of a specific kind — the same pattern Deliverable B's `app.ulid` enforces. */
const id = (prefix: IdPrefix): SchemaDesc => pattern(`^${prefix}_${ULID_BODY_PATTERN}$`);
const anyId = (prefixes: readonly IdPrefix[]): SchemaDesc =>
  pattern(`^(${prefixes.join('|')})_${ULID_BODY_PATTERN}$`);
const refName: SchemaDesc = pattern(`^${REF_PATTERN}$`);
const i18nRef: SchemaDesc = { kind: 'object', fields: { key: req(str()) } };

const contentNodeIdDesc = anyId(['blk', 'pg', 'qst', 'txt']);

/* ========================================================================== */
/* The descriptor                                                              */
/* ========================================================================== */

const conditionalBool: SchemaDesc = union([
  { kind: 'object', fields: { literal: req(bool) } },
  { kind: 'object', fields: { condition: req(expr) } },
]);

export const SCHEMA_DEFS: { readonly [name: string]: SchemaDesc } = {
  Survey: object<Survey>({
    meta: req(ref('SurveyMeta')),
    schema_version: req(num(true)),
    settings: req(ref('SurveySettings')),
    languages: req(ref('Languages')),
    theme_ref: optNull(str()),
    variables: req(arr(ref('Variable'))),
    content: req(arr(ref('ContentNode'))),
    flow: req(ref('Flow')),
    logic_rules: req(arr(ref('LogicRule'))),
    quotas: optNull(ref('QuotaConfig')),
    vendors: opt(arr(ref('Vendor'))),
    redirects: optNull(ref('Redirects')),
    designs: opt(arr(ref('Design'))),
    assets: opt(ref('Assets')),
    entitlement_reqs: opt(arr(str())),
  }),

  SurveyMeta: object<SurveyMeta>({
    id: req(id('svy')),
    ref: req(refName),
    name: req(str()),
    description: optNull(str()),
    tags: opt(arr(str())),
  }),

  /* -- settings ----------------------------------------------------------- */

  SurveySettings: object<SurveySettings>({
    navigation: req(ref('NavigationSettings')),
    resume: req(ref('ResumeSettings')),
    progress_bar: req(ref('ProgressBarSettings')),
    screenout: req(ref('ScreenoutSettings')),
    quality: opt(ref('QualitySettings')),
    allow_test_sessions: opt(bool),
    max_duration_s: optNull(num(true)),
  }),
  NavigationSettings: object<NavigationSettings>({
    back_allowed: req(bool),
    show_page_numbers: opt(bool),
    allow_backward_edit: opt(bool),
  }),
  ResumeSettings: object<ResumeSettings>({
    enabled: req(bool),
    window_s: req(num(true)),
    position: req(str(RESUME_POSITIONS)),
  }),
  ProgressBarSettings: object<ProgressBarSettings>({
    mode: req(str(PROGRESS_BAR_MODES)),
    show_percentage: opt(bool),
  }),
  ScreenoutSettings: object<ScreenoutSettings>({
    show_message: req(bool),
    message_key: optNull(str()),
    redirect_delay_s: opt(num(true)),
  }),
  QualitySettings: object<QualitySettings>({
    speeder_threshold_ratio: optNull(num()),
    straightliner_min_rows: optNull(num(true)),
    terminate_below_score: optNull(num()),
  }),

  /* -- languages ---------------------------------------------------------- */

  Languages: object<Languages>({
    base: req(str()),
    available: req(arr(ref('LanguageDef'))),
    bundles: req(rec(rec(str()))),
    policy: req(ref('LanguagePolicy')),
  }),
  LanguageDef: object<LanguageDef>({
    code: req(str()),
    label: optNull(str()),
    rtl: opt(bool),
  }),
  LanguagePolicy: object<LanguagePolicy>({
    on_missing: req(str(MISSING_STRING_POLICIES)),
    block_publish_if_incomplete: req(bool),
  }),

  /* -- variables ---------------------------------------------------------- */

  Variable: object<Variable>({
    id: req(id('var')),
    name: req(refName),
    kind: req(str(VARIABLE_KINDS)),
    type: req(str(VARIABLE_TYPES)),
    source: opt(ref('VariableSource')),
    enum_domain: optNull(arr(ref('EnumDomainEntry'))),
    expression: optNull(expr),
    storage: opt(ref('VariableStorage')),
    export: req(ref('VariableExport')),
    pii: req(bool),
    persist: req(bool),
    meta: opt(jsonObject),
    title: optNull(i18nRef),
  }),
  VariableSource: object<VariableSource>({
    question_id: opt(id('qst')),
    part: req(ref('VariablePart')),
    iteration: opt(num(true)),
  }),
  /**
   * Written by hand rather than through `object<VariablePart>()` because it is a union of
   * nine shapes; each variant is still closed, so a typo in a part kind is a shape error.
   */
  VariablePart: union(
    [
      { kind: 'object', fields: { kind: req(str(['scalar'])) } },
      { kind: 'object', fields: { kind: req(str(['set_view'])) } },
      {
        kind: 'object',
        fields: { kind: req(str(['option'])), option_id: req(id('opt')), code: req(num(true)) },
      },
      {
        kind: 'object',
        fields: { kind: req(str(['row'])), row_id: req(id('opt')), code: req(num(true)) },
      },
      {
        kind: 'object',
        fields: { kind: req(str(['column'])), column_id: req(id('opt')), code: req(num(true)) },
      },
      {
        kind: 'object',
        fields: {
          kind: req(str(['cell'])),
          row_id: req(id('opt')),
          row_code: req(num(true)),
          column_id: req(id('opt')),
          column_code: req(num(true)),
        },
      },
      {
        kind: 'object',
        fields: {
          kind: req(str(['other_specify'])),
          option_id: opt(id('opt')),
          code: opt(num(true)),
        },
      },
      { kind: 'object', fields: { kind: req(str(['suffix'])), suffix: req(str()) } },
      {
        kind: 'object',
        fields: { kind: req(str(['design_task'])), task: req(num(true)), role: req(str()) },
      },
    ],
    'kind',
  ),
  EnumDomainEntry: object<EnumDomainEntry>({
    code: req(num(true)),
    label_key: req(str()),
  }),
  VariableStorage: object<VariableStorage>({
    code: optNull(num(true)),
    label_key: optNull(str()),
  }),
  VariableExport: object<VariableExport>({
    include: req(bool),
    column: req(str()),
    label: optNull(str()),
    label_key: optNull(str()),
  }),

  /* -- content ------------------------------------------------------------ */

  ContentNode: union(
    [ref('BlockNode'), ref('PageNode'), ref('QuestionNode'), ref('TextNode')],
    'type',
  ),

  BlockNode: object<BlockNode>({
    id: req(id('blk')),
    type: req(str(['block'])),
    ref: req(refName),
    title: optNull(i18nRef),
    settings: opt(ref('BlockSettings')),
    children: req(arr(ref('ContentNode'))),
  }),
  BlockSettings: object<BlockSettings>({
    randomize_children: opt(ref('RandomizationSpec')),
    loop: optNull(ref('LoopSpec')),
    on_enter_scripts: opt(arr(id('ast'))),
    on_exit_scripts: opt(arr(id('ast'))),
  }),
  PageNode: object<PageNode>({
    id: req(id('pg')),
    type: req(str(['page'])),
    ref: req(refName),
    title: optNull(i18nRef),
    settings: opt(ref('PageSettings')),
    children: req(arr(union([ref('QuestionNode'), ref('TextNode')], 'type'))),
  }),
  PageSettings: object<PageSettings>({
    layout: opt(str(PAGE_LAYOUTS)),
    html_template_ref: optNull(id('ast')),
    css_ref: optNull(id('ast')),
    back_allowed: opt(bool),
    auto_advance: opt(bool),
    min_time_s: optNull(num()),
    min_time_action: opt(str(MIN_TIME_ACTIONS)),
    randomize_children: opt(ref('RandomizationSpec')),
  }),
  QuestionNode: object<QuestionNode>({
    id: req(id('qst')),
    type: req(str(['question'])),
    ref: req(refName),
    question_type: req(str()),
    label: optNull(i18nRef),
    instruction: optNull(i18nRef),
    required: req(bool),
    config: opt(jsonObject),
    options: opt(arr(ref('QuestionItem'))),
    rows: opt(arr(ref('QuestionItem'))),
    columns: opt(arr(ref('QuestionItem'))),
    cells: opt(arr(ref('QuestionCell'))),
    validation: opt(arr(ref('ValidationRule'))),
    masks: opt(arr(ref('Mask'))),
    emits: opt(arr(id('var'))),
    scripts: opt(ref('QuestionScripts')),
    flags: opt(ref('QuestionFlags')),
    randomize_options: opt(ref('RandomizationSpec')),
    randomize_rows: opt(ref('RandomizationSpec')),
    randomize_columns: opt(ref('RandomizationSpec')),
  }),
  TextNode: object<TextNode>({
    id: req(id('txt')),
    type: req(str(['text'])),
    label: req(i18nRef),
    html_template_ref: optNull(id('ast')),
  }),
  QuestionItem: object<QuestionItem>({
    id: req(id('opt')),
    ref: req(refName),
    code: req(num(true)),
    label: optNull(i18nRef),
    media: optNull(ref('OptionMedia')),
    position: req(num(true)),
    anchor: opt(pattern(ANCHOR_PATTERN)),
    exclusive: opt(bool),
    behaviour: opt(ref('OptionBehaviour')),
    value_override: optNull(str()),
    custom_class: optNull(str()),
    meta: opt(jsonObject),
    other_specify: opt(bool),
  }),
  OptionMedia: object<OptionMedia>({
    image_asset_id: optNull(id('ast')),
    alt_key: optNull(str()),
  }),
  OptionBehaviour: object<OptionBehaviour>({
    visible: opt(conditionalBool),
    enabled: opt(conditionalBool),
    preselected: opt(conditionalBool),
    auto_select: optNull(conditionalBool),
    required_if: optNull(expr),
    pin: opt(bool),
    prioritized: opt(conditionalBool),
    deprioritized: opt(conditionalBool),
  }),
  QuestionCell: object<QuestionCell>({
    row_ref: req(str()),
    column_ref: optNull(str()),
    control: req(ref('QuestionCellControl')),
  }),
  QuestionCellControl: object<QuestionCellControl>({
    question_type: req(str()),
    config: opt(jsonObject),
    use_columns: opt(bool),
  }),
  QuestionScripts: object<QuestionScripts>({
    on_load: opt(arr(id('ast'))),
    on_answer: opt(arr(id('ast'))),
    on_validate: opt(arr(id('ast'))),
  }),
  QuestionFlags: object<QuestionFlags>({
    has_custom_js: opt(bool),
    pii: opt(bool),
    exclude_from_export: opt(bool),
  }),
  RandomizationSpec: object<RandomizationSpec>({
    mode: req(str(RANDOMIZATION_MODES)),
    n: optNull(num(true)),
    group_ref: optNull(str()),
    respect_anchors: opt(bool),
    sub_blocks: opt(arr(ref('RandomizationSubBlock'))),
    seed_salt: optNull(str()),
    even_distribution: opt(bool),
    fixed_orders: opt(arr(arr(str()))),
  }),
  RandomizationSubBlock: object<RandomizationSubBlock>({
    refs: req(arr(str())),
  }),
  LoopSpec: object<LoopSpec>({
    source: req(
      union(
        [
          {
            kind: 'object',
            fields: { kind: req(str(['selected_options'])), variable_id: req(id('var')) },
          },
          {
            kind: 'object',
            fields: { kind: req(str(['explicit_list'])), items: req(arr(ref('LoopItem'))) },
          },
          {
            kind: 'object',
            fields: {
              kind: req(str(['numeric_range'])),
              from: req(num(true)),
              to: req(num(true)),
            },
          },
        ],
        'kind',
      ),
    ),
    max_iterations: req(num(true)),
    order: optNull(ref('RandomizationSpec')),
    iteration_variable_ref: req(refName),
    variable_naming: req(str()),
  }),
  LoopItem: object<LoopItem>({
    ref: req(refName),
    code: req(num(true)),
    label_key: optNull(str()),
    meta: opt(jsonObject),
  }),
  ValidationRule: object<ValidationRule>({
    id: req(id('val')),
    type: req(str(VALIDATION_TYPES)),
    params: opt(jsonObject),
    condition: optNull(expr),
    message_key: optNull(str()),
    scope: opt(str(VALIDATION_SCOPES)),
  }),
  Mask: object<Mask>({
    id: req(id('msk')),
    applies_to: req(str(MASK_TARGETS)),
    mode: req(str(MASK_MODES)),
    source: req(
      union(
        [
          {
            kind: 'object',
            fields: { kind: req(str(['selected_in'])), variable_id: req(id('var')) },
          },
          {
            kind: 'object',
            fields: { kind: req(str(['not_selected_in'])), variable_id: req(id('var')) },
          },
          {
            kind: 'object',
            fields: { kind: req(str(['explicit'])), item_ids: req(arr(id('opt'))) },
          },
          {
            kind: 'object',
            fields: { kind: req(str(['expression_per_item'])), condition: req(expr) },
          },
        ],
        'kind',
      ),
    ),
    fallback: req(ref('MaskFallbackSpec')),
  }),
  MaskFallbackSpec: object<MaskFallbackSpec>({
    when_empty: req(str(MASK_FALLBACKS)),
  }),

  /* -- flow --------------------------------------------------------------- */

  Flow: object<Flow>({
    nodes: req(arr(ref('FlowNode'))),
  }),
  FlowNode: union(
    [
      { kind: 'object', fields: { id: req(id('fn')), type: req(str(['start'])), next: { desc: id('fn'), nullable: true } } },
      {
        kind: 'object',
        fields: {
          id: req(id('fn')),
          type: req(str(['sequence'])),
          target_id: req(contentNodeIdDesc),
          next: { desc: id('fn'), nullable: true },
        },
      },
      {
        kind: 'object',
        fields: {
          id: req(id('fn')),
          type: req(str(['branch'])),
          branches: req(arr(ref('FlowBranch'))),
        },
      },
      {
        kind: 'object',
        fields: {
          id: req(id('fn')),
          type: req(str(['quota_gate'])),
          quota_ref: req(refName),
          on_pass: { desc: id('fn'), nullable: true },
          on_full: { desc: id('fn'), nullable: true },
        },
      },
      {
        kind: 'object',
        fields: {
          id: req(id('fn')),
          type: req(str(['randomizer'])),
          targets: req(arr(contentNodeIdDesc)),
          mode: req(str(RANDOMIZATION_MODES)),
          n: optNull(num(true)),
          even_distribution: opt(bool),
          seed_salt: optNull(str()),
          next: { desc: id('fn'), nullable: true },
        },
      },
      {
        kind: 'object',
        fields: {
          id: req(id('fn')),
          type: req(str(['loop'])),
          target_id: req(contentNodeIdDesc),
          over_variable_id: optNull(id('var')),
          next: { desc: id('fn'), nullable: true },
        },
      },
      {
        kind: 'object',
        fields: {
          id: req(id('fn')),
          type: req(str(['termination'])),
          disposition: req(str(DISPOSITIONS)),
          custom_key: optNull(str()),
        },
      },
      {
        kind: 'object',
        fields: {
          id: req(id('fn')),
          type: req(str(['api_call'])),
          asset_id: optNull(id('ast')),
          url_template: optNull(str()),
          method: opt(str(['GET', 'POST'])),
          send_variable_ids: opt(arr(id('var'))),
          assign_to_variable_ids: opt(arr(id('var'))),
          config: opt(jsonObject),
          on_success: { desc: id('fn'), nullable: true },
          on_error: { desc: id('fn'), nullable: true },
        },
      },
      {
        kind: 'object',
        fields: {
          id: req(id('fn')),
          type: req(str(['end'])),
          disposition: req(str(DISPOSITIONS)),
        },
      },
    ],
    'type',
  ),
  FlowBranch: object<FlowBranch>({
    condition: { desc: expr, nullable: true },
    next: { desc: id('fn'), nullable: true },
  }),

  /* -- logic -------------------------------------------------------------- */

  LogicRule: object<LogicRule>({
    id: req(id('rul')),
    kind: req(str(RULE_KINDS)),
    target: req(
      union(
        [
          { kind: 'object', fields: { type: req(str(['question'])), id: req(id('qst')) } },
          { kind: 'object', fields: { type: req(str(['page'])), id: req(id('pg')) } },
          { kind: 'object', fields: { type: req(str(['block'])), id: req(id('blk')) } },
          { kind: 'object', fields: { type: req(str(['option'])), id: req(id('opt')) } },
          { kind: 'object', fields: { type: req(str(['variable'])), id: req(id('var')) } },
          { kind: 'object', fields: { type: req(str(['survey'])) } },
        ],
        'type',
      ),
    ),
    condition: req(expr),
    effect: req(ref('RuleEffect')),
    evaluation: opt(str(RULE_EVALUATIONS)),
    authored_in: opt(str(RULE_AUTHORED_IN)),
    notes: optNull(str()),
  }),
  RuleEffect: object<RuleEffect>({
    action: req(str(RULE_ACTIONS)),
    value: optNull(expr),
    target_id: optNull(anyId(['blk', 'pg', 'qst', 'txt', 'var'])),
    disposition: optNull(str(DISPOSITIONS)),
    message_key: optNull(str()),
    params: opt(jsonObject),
  }),

  /* -- quotas ------------------------------------------------------------- */

  QuotaConfig: object<QuotaConfig>({
    policy: req(ref('QuotaPolicy')),
    dimensions: req(arr(ref('QuotaDimension'))),
    plans: req(arr(ref('QuotaPlan'))),
    vendor_limits: opt(arr(ref('VendorQuotaLimit'))),
  }),
  QuotaPolicy: object<QuotaPolicy>({
    count_at: req(str(QUOTA_COUNT_AT)),
    reservation_ttl_s: req(num(true)),
    on_store_unavailable: req(str(QUOTA_STORE_FAILURE_MODES)),
    counter_scope: req(str(QUOTA_COUNTER_SCOPES)),
  }),
  QuotaDimension: object<QuotaDimension>({
    id: req(id('qd')),
    ref: req(refName),
    variable_id: req(id('var')),
    buckets: req(arr(ref('QuotaBucket'))),
  }),
  QuotaBucket: object<QuotaBucket>({
    ref: req(str()),
    match: req(expr),
  }),
  QuotaPlan: object<QuotaPlan>({
    id: req(id('qp')),
    ref: req(refName),
    type: req(str(QUOTA_PLAN_TYPES)),
    dimension_ids: req(arr(id('qd'))),
    target_mode: opt(str(QUOTA_TARGET_MODES)),
    cells: req(arr(ref('QuotaCell'))),
    overflow: optNull(str(DISPOSITIONS)),
  }),
  QuotaCell: object<QuotaCell>({
    key: req(arr(str())),
    target: optNull(num(true)),
    target_pct: optNull(num()),
    mode: req(str(QUOTA_CELL_MODES)),
  }),
  VendorQuotaLimit: object<VendorQuotaLimit>({
    vendor_ref: req(refName),
    max_completes: req(num(true)),
  }),

  /* -- vendors ------------------------------------------------------------ */

  Vendor: object<Vendor>({
    id: req(id('vnd')),
    ref: req(refName),
    name: req(str()),
    inbound_params: req(arr(ref('VendorInboundParam'))),
    entry_url_template: optNull(str()),
    max_completes: optNull(num(true)),
    quota_plan_overrides: opt(arr(refName)),
    security: optNull(ref('VendorSecurity')),
  }),
  VendorInboundParam: object<VendorInboundParam>({
    param: req(str()),
    variable_ref: req(refName),
    required: req(bool),
  }),
  VendorSecurity: object<VendorSecurity>({
    hash_param: req(str()),
    algorithm: req(str(['sha256', 'sha1', 'md5'])),
    secret_ref: req(str()),
    signed_params: opt(arr(str())),
    max_skew_s: opt(num(true)),
    timestamp_param: opt(str()),
    nonce_param: opt(str()),
  }),
  Redirects: object<Redirects>({
    default: req(ref('RedirectMap')),
    by_vendor: opt(rec(ref('RedirectMap'))),
    by_language: opt(rec(ref('RedirectMap'))),
  }),
  /**
   * Hand-written because `RedirectMap` is a mapped type over the disposition union, which
   * `FieldsOf` cannot walk. The key set is derived from `DISPOSITIONS` at module load so it
   * still cannot drift from Deliverable K §2 — including the deliberate absence of
   * `ABANDONED`, `TIMED_OUT` and `IN_PROGRESS`, which nobody is left to redirect.
   */
  RedirectMap: {
    kind: 'object',
    fields: Object.fromEntries([
      ...DISPOSITIONS.filter(
        (d) => d !== 'IN_PROGRESS' && d !== 'ABANDONED' && d !== 'TIMED_OUT' && d !== 'CUSTOM',
      ).map((d) => [d, opt(str())] as const),
      ['CUSTOM', opt(rec(str()))] as const,
    ]),
  },

  /* -- designs ------------------------------------------------------------ */

  Design: object<Design>({
    id: req(id('dsn')),
    ref: req(refName),
    method: req(str(DESIGN_METHODS)),
    spec: req(ref('DesignSpec')),
    generated: optNull(ref('DesignGenerated')),
    emits: opt(arr(id('var'))),
  }),
  DesignSpec: object<DesignSpec>({
    items: req(arr(ref('DesignItem'))),
    tasks_per_respondent: req(num(true)),
    items_per_task: req(num(true)),
    blocks: req(num(true)),
    seed: req(num(true)),
    balance: req(ref('DesignBalance')),
  }),
  DesignItem: object<DesignItem>({
    ref: req(refName),
    label_key: req(str()),
    meta: opt(jsonObject),
  }),
  DesignBalance: object<DesignBalance>({
    frequency: req(bool),
    orthogonality: req(str(['none', 'near', 'exact'])),
    positional: req(bool),
  }),
  DesignGenerated: object<DesignGenerated>({
    generated_at: req(str()),
    algorithm: req(str()),
    // Diagnostics carry an open metric set: a new algorithm reports new numbers, and losing
    // them would defeat the point of storing them at all.
    diagnostics: req(rec(num())),
    matrix_asset_id: req(id('ast')),
  }),

  /* -- assets ------------------------------------------------------------- */

  Assets: object<Assets>({
    scripts: opt(arr(ref('ScriptAsset'))),
    html_templates: opt(arr(ref('HtmlTemplateAsset'))),
    css: opt(arr(ref('CssAsset'))),
    media: opt(arr(ref('MediaAsset'))),
  }),
  ScriptAsset: object<ScriptAsset>({
    id: req(id('ast')),
    ref: req(refName),
    scope: req(str(SCRIPT_SCOPES)),
    hooks: req(arr(str(SCRIPT_HOOKS))),
    source: req(str()),
    sha256: optNull(pattern('^[0-9a-f]{64}$')),
    runs_on: req(str(SCRIPT_TARGETS)),
  }),
  HtmlTemplateAsset: object<HtmlTemplateAsset>({
    id: req(id('ast')),
    ref: req(refName),
    source: req(str()),
    sha256: optNull(pattern('^[0-9a-f]{64}$')),
  }),
  CssAsset: object<CssAsset>({
    id: req(id('ast')),
    ref: req(refName),
    source: req(str()),
    scope: req(str(SCRIPT_SCOPES)),
  }),
  MediaAsset: object<MediaAsset>({
    id: req(id('ast')),
    ref: optNull(refName),
    storage_key: req(str()),
    mime: req(str()),
    bytes: optNull(num(true)),
    sha256: optNull(pattern('^[0-9a-f]{64}$')),
  }),
};

export const SURVEY_DESC: SchemaDesc = ref('Survey');

/* ========================================================================== */
/* JSON Schema generation                                                      */
/* ========================================================================== */

export interface JsonSchemaObject {
  readonly [key: string]: JsonValue;
}

/** Emit draft 2020-12 JSON Schema for the whole survey model. */
export function toJsonSchema(): JsonSchemaObject {
  const defs: Record<string, JsonValue> = {};
  for (const [name, desc] of Object.entries(SCHEMA_DEFS)) {
    defs[name] = descToSchema(desc);
  }
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://resscript.dev/schema/survey.json',
    title: 'ResScript Survey',
    $ref: '#/$defs/Survey',
    $defs: defs,
  };
}

function descToSchema(desc: SchemaDesc): JsonValue {
  switch (desc.kind) {
    case 'string': {
      if (desc.values !== undefined) return { type: 'string', enum: [...desc.values] };
      if (desc.pattern !== undefined) return { type: 'string', pattern: desc.pattern };
      return { type: 'string' };
    }
    case 'number':
      return desc.integer === true ? { type: 'integer' } : { type: 'number' };
    case 'boolean':
      return { type: 'boolean' };
    case 'json':
      return {};
    case 'json_object':
      return { type: 'object' };
    case 'expr':
      // Only the envelope: `packages/logic` owns the node union and its type checker.
      return { type: 'object', required: ['op'], properties: { op: { type: 'string' } } };
    case 'array':
      return { type: 'array', items: descToSchema(desc.items) };
    case 'record':
      return { type: 'object', additionalProperties: descToSchema(desc.values) };
    case 'object': {
      const properties: Record<string, JsonValue> = {};
      const required: string[] = [];
      for (const [key, field] of Object.entries(desc.fields)) {
        const inner = descToSchema(field.desc);
        properties[key] = field.nullable === true ? { anyOf: [inner, { type: 'null' }] } : inner;
        if (field.optional !== true) required.push(key);
      }
      return {
        type: 'object',
        properties,
        ...(required.length > 0 ? { required } : {}),
        additionalProperties: desc.additional === true,
      };
    }
    case 'union': {
      const variants = desc.variants.map(descToSchema);
      return desc.discriminator === undefined
        ? { anyOf: variants }
        : { oneOf: variants, $comment: `discriminated on "${desc.discriminator}"` };
    }
    case 'ref':
      return { $ref: `#/$defs/${desc.name}` };
    default: {
      const never: never = desc;
      throw new Error(`Unhandled descriptor: ${JSON.stringify(never)}`);
    }
  }
}

/* ========================================================================== */
/* The runtime validator                                                       */
/* ========================================================================== */

/**
 * Validate an unknown value against the descriptor, producing the same `Diagnostic` shape as
 * `validateStructural` so a caller has one list to render.
 *
 * Hand-written rather than Ajv-driven: this package must have zero runtime dependencies, and
 * the subset of JSON Schema the descriptor can express is small enough that the validator is
 * 120 lines. Ajv would also give worse messages, because it does not know which union variant
 * the author *meant*; the discriminator here does.
 */
export function validateShape(value: unknown, desc: SchemaDesc = SURVEY_DESC): readonly Diagnostic[] {
  const out: Diagnostic[] = [];
  check(value, desc, [], out);
  return out;
}

type Path = readonly (string | number)[];

function fail(
  out: Diagnostic[],
  code: 'SCH-0100' | 'SCH-0101' | 'SCH-0102' | 'SCH-0103' | 'SCH-0104',
  path: Path,
  message: string,
): void {
  out.push({ code, severity: 'error', message, path: pointer(...path) });
}

function check(value: unknown, desc: SchemaDesc, path: Path, out: Diagnostic[]): void {
  switch (desc.kind) {
    case 'string': {
      if (typeof value !== 'string') {
        fail(out, 'SCH-0101', path, `Expected a string, got ${describe(value)}.`);
        return;
      }
      if (desc.values !== undefined && !desc.values.includes(value)) {
        fail(
          out,
          'SCH-0103',
          path,
          `Expected one of ${desc.values.map((v) => JSON.stringify(v)).join(', ')}, got ${JSON.stringify(value)}.`,
        );
      }
      if (desc.pattern !== undefined && !new RegExp(desc.pattern).test(value)) {
        fail(out, 'SCH-0104', path, `${JSON.stringify(value)} does not match ${desc.pattern}.`);
      }
      return;
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        fail(out, 'SCH-0101', path, `Expected a finite number, got ${describe(value)}.`);
        return;
      }
      if (desc.integer === true && !Number.isInteger(value)) {
        fail(out, 'SCH-0101', path, `Expected an integer, got ${value}.`);
      }
      return;
    }
    case 'boolean':
      if (typeof value !== 'boolean') {
        fail(out, 'SCH-0101', path, `Expected a boolean, got ${describe(value)}.`);
      }
      return;
    case 'json':
      if (!isJsonValue(value)) {
        fail(out, 'SCH-0101', path, `Expected a JSON value, got ${describe(value)}.`);
      }
      return;
    case 'json_object':
      if (!isPlainObject(value)) {
        fail(out, 'SCH-0101', path, `Expected an object, got ${describe(value)}.`);
      } else if (!isJsonValue(value)) {
        fail(out, 'SCH-0101', path, 'Expected a JSON-serializable object.');
      }
      return;
    case 'expr':
      if (!isPlainObject(value)) {
        fail(out, 'SCH-0101', path, `Expected a logic expression object, got ${describe(value)}.`);
        return;
      }
      if (typeof value['op'] !== 'string') {
        fail(out, 'SCH-0100', [...path, 'op'], 'A logic expression must carry a string "op".');
      }
      return;
    case 'array': {
      if (!Array.isArray(value)) {
        fail(out, 'SCH-0101', path, `Expected an array, got ${describe(value)}.`);
        return;
      }
      value.forEach((entry, i) => check(entry, desc.items, [...path, i], out));
      return;
    }
    case 'record': {
      if (!isPlainObject(value)) {
        fail(out, 'SCH-0101', path, `Expected an object, got ${describe(value)}.`);
        return;
      }
      for (const [key, entry] of Object.entries(value)) {
        check(entry, desc.values, [...path, key], out);
      }
      return;
    }
    case 'object': {
      if (!isPlainObject(value)) {
        fail(out, 'SCH-0101', path, `Expected an object, got ${describe(value)}.`);
        return;
      }
      for (const [key, field] of Object.entries(desc.fields)) {
        const present = Object.hasOwn(value, key);
        const entry = value[key];
        if (!present || entry === undefined) {
          if (field.optional !== true) {
            fail(out, 'SCH-0100', [...path, key], `Required field "${key}" is missing.`);
          }
          continue;
        }
        if (entry === null) {
          if (field.nullable !== true) {
            fail(out, 'SCH-0101', [...path, key], `Field "${key}" may not be null.`);
          }
          continue;
        }
        check(entry, field.desc, [...path, key], out);
      }
      if (desc.additional !== true) {
        for (const key of Object.keys(value)) {
          if (!Object.hasOwn(desc.fields, key)) {
            // Unknown fields are an error, not a warning: silently dropping a field an author
            // wrote is how "I set that and it did nothing" bugs are born.
            fail(out, 'SCH-0102', [...path, key], `Unknown field "${key}".`);
          }
        }
      }
      return;
    }
    case 'union': {
      if (desc.discriminator !== undefined && isPlainObject(value)) {
        const tag = value[desc.discriminator];
        for (const variant of desc.variants) {
          const resolved = resolve(variant);
          if (resolved.kind !== 'object') continue;
          const field = resolved.fields[desc.discriminator];
          const values = field?.desc.kind === 'string' ? field.desc.values : undefined;
          if (values !== undefined && typeof tag === 'string' && values.includes(tag)) {
            check(value, variant, path, out);
            return;
          }
        }
        fail(
          out,
          'SCH-0103',
          [...path, desc.discriminator],
          `${JSON.stringify(tag)} does not select any known variant.`,
        );
        return;
      }
      // Undiscriminated: accept if any variant validates cleanly, otherwise report the
      // variant that got closest, which is almost always the one the author intended.
      let best: readonly Diagnostic[] | undefined;
      for (const variant of desc.variants) {
        const attempt: Diagnostic[] = [];
        check(value, variant, path, attempt);
        if (attempt.length === 0) return;
        if (best === undefined || attempt.length < best.length) best = attempt;
      }
      out.push(...(best ?? []));
      return;
    }
    case 'ref': {
      const target = SCHEMA_DEFS[desc.name];
      if (target === undefined) throw new Error(`Unknown schema def: ${desc.name}`);
      check(value, target, path, out);
      return;
    }
    default: {
      const never: never = desc;
      throw new Error(`Unhandled descriptor: ${JSON.stringify(never)}`);
    }
  }
}

function resolve(desc: SchemaDesc): SchemaDesc {
  if (desc.kind !== 'ref') return desc;
  const target = SCHEMA_DEFS[desc.name];
  if (target === undefined) throw new Error(`Unknown schema def: ${desc.name}`);
  return resolve(target);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): boolean {
  if (value === null) return true;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return true;
    case 'number':
      return Number.isFinite(value);
    case 'object':
      if (Array.isArray(value)) return value.every(isJsonValue);
      return Object.values(value as Record<string, unknown>).every(
        (v) => v === undefined || isJsonValue(v),
      );
    default:
      return false;
  }
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value;
}

/** Every field name the descriptor knows for a def — used by the drift test. */
export function fieldNamesOf(defName: string): readonly string[] {
  const desc = SCHEMA_DEFS[defName];
  if (desc === undefined) throw new Error(`Unknown schema def: ${defName}`);
  const resolved = resolve(desc);
  return resolved.kind === 'object' ? Object.keys(resolved.fields).sort() : [];
}
