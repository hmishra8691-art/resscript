/**
 * `multi_select` — the boolean fan-out plus a derived `set<enum>` view.
 *
 * This is the pattern the whole variable model is built around (F §10's catalogue:
 * "`Qr1..Qrn : boolean` + derived `Q : set<enum>`"). One question, n+1 variables, and the reason
 * there are n+1 rather than one is that both shapes are load-bearing:
 *
 *  - the **booleans** are what an analyst cross-tabs and what an export column is. `Q2r3` means
 *    "the option whose code is 3", for the life of the study, in every wave;
 *  - the **set view** is what logic reads. `Q2 ANY_OF [1,3]` and `Q2r1 == true` are then the same
 *    machinery rather than two code paths, which is why the logic engine has no multi-select
 *    branch.
 *
 * The set view is *structurally* derived: Deliverable D's AST has no operator that collects the
 * true members of a fan-out, so there is no expression to write and
 * `evaluateDerivation` computes it identically on client, server and in the export projection.
 * This is the case F §1.1's flat `expression?` cannot represent — see `contract/variables.ts`.
 */

import { itemCode } from '../../contract/items.js';
import {
  asPlainObject,
  CODEC_LIMITS,
  err,
  ok,
  readBoundedText,
  type ResponseCodec,
} from '../../contract/codec.js';
import { KIT_MESSAGE_KEYS, type ValidationIssue } from '../../contract/validate.js';
import type { PluginDiagnostic } from '../../contract/diagnostics.js';
import type { QuestionTypePluginCore } from '../../contract/plugin.js';
import type { A11yContract } from '../../contract/a11y.js';
import type { JsonSchema } from '../../json-schema.js';
import type { OptionCode } from '../../contract/items.js';
import type { SetViewMember, VariableDeclaration } from '../../contract/variables.js';
import { compareCodes } from '../../contract/variables.js';

export interface MultiSelectConfig {
  readonly display: 'vertical' | 'horizontal' | 'image_grid';
  readonly columns: 1 | 2 | 3 | 4;
  /** `0` = no floor. Distinct from the question-level `required`, which is "answer at all". */
  readonly minSelected: number;
  /** `0` = no ceiling. */
  readonly maxSelected: number;
  readonly other: { readonly enabled: boolean; readonly maxLen: number; readonly required: boolean };
}

export interface MultiSelectAnswer {
  readonly codes: readonly OptionCode[];
  /** Keyed by *option ref*, because that is what the renderer has; names come from codes. */
  readonly otherTexts: Readonly<Record<string, string>>;
}

export const MULTI_SELECT_CONFIG_SCHEMA: JsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['display', 'other'],
  properties: {
    display: { enum: ['vertical', 'horizontal', 'image_grid'] },
    columns: { type: 'integer', minimum: 1, maximum: 4, default: 1 },
    minSelected: { type: 'integer', minimum: 0, default: 0 },
    maxSelected: { type: 'integer', minimum: 0, default: 0 },
    other: {
      type: 'object',
      additionalProperties: false,
      required: ['enabled'],
      properties: {
        enabled: { type: 'boolean', default: false },
        maxLen: { type: 'integer', minimum: 1, maximum: 4000, default: 200 },
        required: { type: 'boolean', default: true },
      },
    },
  },
};

const codec: ResponseCodec<MultiSelectConfig, MultiSelectAnswer> = {
  parse(raw, ctx) {
    if (raw === null || raw === undefined) return ok({ codes: [], otherTexts: {} });
    const record = asPlainObject(raw);
    if (record === undefined) return err({ code: 'shape', message: 'expected an object' });

    const rawCodes = record['codes'];
    if (rawCodes !== undefined && !Array.isArray(rawCodes)) {
      return err({ code: 'shape', message: 'codes must be an array', path: '/codes' });
    }
    const list = rawCodes ?? [];
    // Checked *before* the map, so a 10,000-entry payload costs a length comparison rather than
    // 10,000 allocations (F §9's hostile input list).
    if (list.length > CODEC_LIMITS.maxItems) {
      return err({ code: 'too_large', message: 'too many selections', path: '/codes' });
    }
    const codes: OptionCode[] = [];
    const domain = new Map<OptionCode, string>(
      ctx.question.options.map((option) => [itemCode(option), option.ref]),
    );
    for (const entry of list) {
      if (typeof entry !== 'number' && typeof entry !== 'string') {
        return err({ code: 'shape', message: 'a code must be a scalar', path: '/codes' });
      }
      if (!domain.has(entry)) {
        // A code outside the domain is a forged payload, not a respondent mistake: the UI cannot
        // produce one. Rejecting keeps `toVariables` unable to write a column that was never
        // declared (ADR-005 threat 3).
        return err({ code: 'domain', message: `unknown option code ${String(entry)}`, path: '/codes' });
      }
      if (!codes.includes(entry)) codes.push(entry);
    }

    const otherTexts: Record<string, string> = {};
    const rawOther = record['otherTexts'];
    if (rawOther !== undefined && rawOther !== null) {
      const map = asPlainObject(rawOther);
      if (map === undefined) {
        return err({ code: 'shape', message: 'otherTexts must be an object', path: '/otherTexts' });
      }
      for (const [ref, text] of Object.entries(map)) {
        if (!ctx.question.options.some((option) => option.ref === ref)) {
          return err({ code: 'unknown_key', message: `no option ${ref}`, path: '/otherTexts' });
        }
        const read = readBoundedText(text, ctx.config.other.maxLen);
        if (!read.ok) {
          return err({
            code: read.code,
            message:
              read.code === 'shape'
                ? 'otherTexts values must be strings'
                : 'an otherTexts value is too large',
            path: '/otherTexts',
          });
        }
        if (read.value !== null) otherTexts[ref] = read.value;
      }
    }
    return ok({ codes: [...codes].sort(compareCodes), otherTexts });
  },

  toVariables(answer, ctx) {
    const out: Record<string, boolean | string | null> = {};
    const selected = new Set(answer.codes);
    for (const option of ctx.question.options) {
      const code = itemCode(option);
      // Every option gets a value, including `false`. "Not selected" and "never shown" are
      // different facts, and an absent key is how the second one is represented.
      out[ctx.name.option(option.code)] = selected.has(code);
      if (ctx.config.other.enabled && option.otherSpecify === true) {
        out[ctx.name.other(option.code)] = answer.otherTexts[option.ref] ?? null;
      }
    }
    return out;
  },

  fromVariables(vars, ctx) {
    const codes: OptionCode[] = [];
    const otherTexts: Record<string, string> = {};
    for (const option of ctx.question.options) {
      if (vars[ctx.name.option(option.code)] === true) codes.push(itemCode(option));
      if (ctx.config.other.enabled && option.otherSpecify === true) {
        const text = vars[ctx.name.other(option.code)];
        if (typeof text === 'string' && text !== '') otherTexts[option.ref] = text;
      }
    }
    return { codes: codes.sort(compareCodes), otherTexts };
  },

  emptyAnswer: () => ({ codes: [], otherTexts: {} }),
};

export const multiSelectCore: QuestionTypePluginCore<MultiSelectConfig, MultiSelectAnswer> = {
  meta: {
    id: 'multi_select',
    version: '1.0.0',
    displayName: 'qt.multi_select.name',
    description: 'qt.multi_select.desc',
    category: 'choice',
    icon: 'checkbox',
    entitlementKey: null,
    trust: 'first_party',
    /**
     * Not composable, and the reason is the fan-out rather than a policy: a cell control names
     * itself through the scoped namer, whose `option()` throws `compose_unnameable_part` — there
     * is no schema §4 part that names `Q5r3r2`. A multi-select inside a grid cell is a
     * multi-select matrix, which is `matrix` with a per-row control, not this.
     */
    composable: false,
    emitsData: true,
  },

  configSchema: MULTI_SELECT_CONFIG_SCHEMA,

  defaultConfig: () => ({
    display: 'vertical',
    columns: 1,
    minSelected: 0,
    maxSelected: 0,
    other: { enabled: false, maxLen: 200, required: true },
  }),

  declareVariables(ctx) {
    const out: VariableDeclaration[] = [];
    const members: SetViewMember[] = [];

    for (const option of ctx.options) {
      const name = ctx.name.option(option.code);
      const code = itemCode(option);
      members.push({ variableName: name, code });
      out.push({
        name,
        kind: 'response',
        type: 'boolean',
        source: { part: { kind: 'option', optionRef: option.ref } },
        export: {
          include: !ctx.flags.excludeFromExport,
          column: name,
          labelKey: option.labelKey,
          // Order from the *code*, never from the loop index: the export column order must not
          // move when the author drags an option up the list (F §1.1 rule 2).
          order: option.code,
        },
        pii: ctx.flags.pii,
        persist: true,
        analysis: { measure: 'nominal', batteryRef: ctx.ref },
      });
    }

    /**
     * The set view. `persist: false` and `include: false`, deliberately:
     *
     *  - it is recomputed per page from the booleans (schema §4), so storing it would create a
     *    second copy of the same fact that could disagree with the first;
     *  - a `set` in a flat cell is not an analysis unit (F §4's policy). The booleans are the
     *    columns; this exists so logic, quotas and masks have one thing to point at.
     */
    out.push({
      name: ctx.name.self(),
      kind: 'derived',
      type: 'set',
      enumDomain: ctx.options.map((option) => ({
        code: itemCode(option),
        labelKey: option.labelKey,
      })),
      source: { part: { kind: 'set_view' } },
      export: {
        include: false,
        column: ctx.name.self(),
        labelKey: `${ctx.ref}.label`,
        order: 0,
      },
      pii: ctx.flags.pii,
      persist: false,
      derivation: { kind: 'structural', structural: { computation: 'set_view', members } },
      analysis: { measure: 'nominal' },
    });

    if (ctx.config.other.enabled) {
      for (const option of ctx.options) {
        if (option.otherSpecify !== true) continue;
        const name = ctx.name.other(option.code);
        out.push({
          name,
          kind: 'response',
          type: 'text',
          source: { part: { kind: 'other_specify', ofRef: option.ref } },
          export: {
            include: !ctx.flags.excludeFromExport,
            column: name,
            labelKey: `${ctx.ref}.other.label`,
            // Offset past the booleans so the verbatim columns land after the fan-out, whatever
            // the codes are. 1000 is a constant, so it is stable; `out.length` would not be.
            order: 1000 + option.code,
          },
          pii: true,
          persist: true,
          analysis: { measure: 'nominal' },
        });
      }
    }

    return out;
  },

  validate(ctx) {
    const issues: ValidationIssue[] = [];
    const selected = ctx.value?.codes ?? [];
    const config = ctx.question.config;

    if (ctx.required && selected.length === 0) {
      return [{ variableName: null, messageKey: KIT_MESSAGE_KEYS.required, severity: 'error' }];
    }
    if (selected.length === 0) return issues;

    const byCode = new Map(ctx.question.options.map((option) => [itemCode(option), option]));
    for (const code of selected) {
      if (!byCode.has(code)) {
        issues.push({
          variableName: null,
          messageKey: KIT_MESSAGE_KEYS.invalidOption,
          severity: 'error',
        });
        return issues;
      }
    }

    // An exclusive option ("None of these") selected alongside anything else. The renderer clears
    // the others on click, so this only fires for a tampered payload or a resumed session whose
    // options changed — both of which have to be caught server-side (ADR-004).
    const exclusive = selected.filter((code) => byCode.get(code)?.exclusive === true);
    if (exclusive.length > 0 && selected.length > 1) {
      issues.push({
        variableName: null,
        messageKey: KIT_MESSAGE_KEYS.exclusiveViolated,
        severity: 'error',
      });
    }
    if (config.minSelected > 0 && selected.length < config.minSelected) {
      issues.push({
        variableName: null,
        messageKey: KIT_MESSAGE_KEYS.tooFewSelected,
        params: { min: config.minSelected },
        severity: 'error',
      });
    }
    if (config.maxSelected > 0 && selected.length > config.maxSelected) {
      issues.push({
        variableName: null,
        messageKey: KIT_MESSAGE_KEYS.tooManySelected,
        params: { max: config.maxSelected },
        severity: 'error',
      });
    }

    if (config.other.enabled) {
      for (const option of ctx.question.options) {
        if (option.otherSpecify !== true) continue;
        if (!selected.includes(itemCode(option))) continue;
        const text = ctx.value?.otherTexts[option.ref] ?? '';
        const variableName = ctx.question.variables.otherByItem[option.ref] ?? null;
        if (config.other.required && text.trim() === '') {
          issues.push({
            variableName,
            messageKey: KIT_MESSAGE_KEYS.otherRequired,
            severity: 'error',
            focus: { optionRef: option.ref },
          });
        }
        if ([...text].length > config.other.maxLen) {
          issues.push({
            variableName,
            messageKey: KIT_MESSAGE_KEYS.tooLong,
            params: { max: config.other.maxLen },
            severity: 'error',
            focus: { optionRef: option.ref },
          });
        }
      }
    }
    return issues;
  },

  codec,

  exportContribution: {
    columnLabel: (declaration, ctx) => {
      const part = declaration.source.part;
      const label = ctx.t(ctx.question.label);
      switch (part.kind) {
        case 'option':
          return `${label} — ${ctx.t(declaration.export.labelKey)}`;
        case 'other_specify':
          return `${label} — other (specify)`;
        default:
          // The set view and anything a future major adds: the question's own label is right, and
          // guessing a better one from a part this plugin does not emit would be a fabrication.
          return label;
      }
    },
    valueLabels: (declaration, ctx) =>
      declaration.type === 'boolean'
        ? [
            { code: true, label: ctx.t('common.selected') },
            { code: false, label: ctx.t('common.not_selected') },
          ]
        : (declaration.enumDomain ?? []).map((entry) => ({
            code: entry.code,
            label: ctx.t(entry.labelKey),
          })),
  },

  a11y: {
    interactionModel: 'checkboxgroup',
    requiredRoles: ['group', 'checkbox'],
    keys: ['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Space'],
    minTouchTargetPx: 44,
    pointerDependent: false,
    rtlSafe: true,
  } satisfies A11yContract,

  staticChecks(ctx) {
    const out: PluginDiagnostic[] = [];
    if (ctx.options.length === 0) {
      out.push({
        code: 'no_options',
        severity: 'error',
        message: 'multi_select requires at least one option',
        path: '/options',
      });
    }
    const { minSelected, maxSelected } = ctx.config;
    if (maxSelected > 0 && minSelected > maxSelected) {
      out.push({
        code: 'impossible_selection_bounds',
        severity: 'error',
        message: `minSelected (${minSelected}) exceeds maxSelected (${maxSelected}), so no answer can validate`,
        path: '/config/minSelected',
      });
    }
    if (minSelected > ctx.options.length) {
      out.push({
        code: 'impossible_selection_bounds',
        severity: 'error',
        message: `minSelected (${minSelected}) exceeds the option count (${ctx.options.length})`,
        path: '/config/minSelected',
      });
    }
    if (ctx.config.other.enabled && !ctx.options.some((option) => option.otherSpecify === true)) {
      out.push({
        code: 'other_option_unset',
        severity: 'error',
        message: 'other.enabled is true but no option is marked other_specify',
        path: '/config/other/enabled',
      });
    }
    if (ctx.options.filter((option) => option.exclusive === true).length > 1) {
      out.push({
        code: 'multiple_exclusive_options',
        severity: 'warning',
        message:
          'more than one exclusive option: selecting either clears the other, which respondents ' +
          'read as the form fighting them',
        path: '/options',
      });
    }
    return out;
  },
};
