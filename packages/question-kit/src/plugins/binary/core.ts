/**
 * `binary` — yes/no · true/false: `Q : enum` over exactly two authored options (F §10).
 *
 * The catalogue calls it "a thin config over single_select", and that is a statement about the
 * *data*, not the code: the plugin declares the same single self-named enum, and it is its own
 * core rather than a wrapper because the two configs share nothing — no "other" machinery, no
 * columns, no deselect — and a delegate that first has to fabricate a `SingleSelectConfig` would
 * couple this plugin's export contract to a config shape its author never wrote.
 *
 * The one rule that is this plugin's own: **exactly two options, and they are authored.** A
 * hardcoded yes=1/no=2 would be simpler and wrong twice over — the labels are the client's
 * ("Agree/Disagree", "Have/Have not"), and the codes are the tracker's (a legacy layout may need
 * `Y`/`N` via `valueOverride`). Both facts live on the authored option, exactly as in
 * single-select, so F §1.1 rule 2 (codes never come from iteration order) holds for free.
 */

import { itemCode } from '../../contract/items.js';
import { asOptionCode, asPlainObject, err, ok, type ResponseCodec } from '../../contract/codec.js';
import { KIT_MESSAGE_KEYS, type ValidationIssue } from '../../contract/validate.js';
import type { PluginDiagnostic } from '../../contract/diagnostics.js';
import type { QuestionTypePluginCore } from '../../contract/plugin.js';
import type { A11yContract } from '../../contract/a11y.js';
import type { JsonSchema } from '../../json-schema.js';
import type { OptionCode } from '../../contract/items.js';
import type { VariableDeclaration } from '../../contract/variables.js';

export interface BinaryConfig {
  readonly display: 'buttons' | 'toggle' | 'radio';
}

export interface BinaryAnswer {
  /** `null` when unanswered. One empty state — `exactOptionalPropertyTypes` would otherwise
   * make "absent" a second one, and a codec with two empty answers fails its own round-trip. */
  readonly code: OptionCode | null;
}

export const BINARY_CONFIG_SCHEMA: JsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  properties: {
    display: { enum: ['buttons', 'toggle', 'radio'], default: 'buttons' },
  },
};

const codec: ResponseCodec<BinaryConfig, BinaryAnswer> = {
  parse(raw) {
    if (raw === null || raw === undefined) return ok({ code: null });
    const record = asPlainObject(raw);
    if (record === undefined) return err({ code: 'shape', message: 'expected an object' });
    const code = asOptionCode(record['code']);
    if (code === undefined) {
      return err({ code: 'shape', message: 'code must be a scalar or null', path: '/code' });
    }
    // The domain check ("is this one of the two options?") belongs to `validate`, same as
    // single-select: the codec rejects the wrong *kind* of thing, validation rejects the wrong
    // *value*, and ADR-004 runs both on both sides.
    return ok({ code });
  },

  toVariables(answer, ctx) {
    return { [ctx.name.self()]: answer.code };
  },

  fromVariables(vars, ctx) {
    const code = vars[ctx.name.self()];
    return { code: typeof code === 'number' || typeof code === 'string' ? code : null };
  },

  emptyAnswer: () => ({ code: null }),
};

export const binaryCore: QuestionTypePluginCore<BinaryConfig, BinaryAnswer> = {
  meta: {
    id: 'binary',
    version: '1.0.0',
    displayName: 'qt.binary.name',
    description: 'qt.binary.desc',
    category: 'choice',
    icon: 'toggle',
    entitlementKey: null,
    // Advisory only: `registry.register` overwrites this with the tier of the source (F §6).
    trust: 'first_party',
    // One self-named enum, no companions — the scoped namer covers it completely, so a yes/no
    // cell in a mixed matrix ("Do you own this brand?" per row) needs nothing the compose rules
    // cannot name. This is the same argument as `numeric`'s.
    composable: true,
    emitsData: true,
  },

  configSchema: BINARY_CONFIG_SCHEMA,

  // 'buttons' regardless of cell context: two side-by-side buttons fit a matrix cell fine, which
  // is not true of single-select's n-across group (its dropdown default exists for that reason).
  defaultConfig: () => ({ display: 'buttons' }),

  declareVariables(ctx) {
    const declaration: VariableDeclaration = {
      name: ctx.name.self(),
      kind: 'response',
      type: 'enum',
      // Codes come from the authored option, NOT from an iteration index — swapping "Yes" and
      // "No" in the editor must not renumber the domain (F §1.1 rule 2).
      enumDomain: ctx.options.map((option) => ({
        code: itemCode(option),
        labelKey: option.labelKey,
        ...(option.meta === undefined ? {} : { meta: option.meta }),
      })),
      source: { part: { kind: 'self' } },
      export: {
        include: !ctx.flags.excludeFromExport,
        column: ctx.name.self(),
        labelKey: `${ctx.ref}.label`,
        order: 0,
      },
      pii: ctx.flags.pii,
      persist: true,
      // `nominal`, not `boolean`-anything: the export stores the authored codes, and a yes/no
      // whose codes are 1/2 (or Y/N) is a two-level category, not a truth value.
      analysis: { measure: 'nominal' },
    };
    return [declaration];
  },

  validate(ctx) {
    const issues: ValidationIssue[] = [];
    const selected = ctx.value?.code ?? null;
    const selfName = ctx.question.variables.self ?? null;

    if (ctx.required && selected === null) {
      return [{ variableName: selfName, messageKey: KIT_MESSAGE_KEYS.required, severity: 'error' }];
    }
    if (selected === null) return issues;

    const domain = new Set<OptionCode>(ctx.question.options.map(itemCode));
    if (!domain.has(selected)) {
      // Only reachable via a tampered payload; the codec accepts any scalar on purpose.
      issues.push({
        variableName: selfName,
        messageKey: KIT_MESSAGE_KEYS.invalidOption,
        severity: 'error',
      });
    }
    return issues;
  },

  codec,

  exportContribution: {
    columnLabel: (_declaration, ctx) => ctx.t(ctx.question.label),
    valueLabels: (declaration, ctx) =>
      declaration.type === 'enum'
        ? (declaration.enumDomain ?? []).map((entry) => ({
            code: entry.code,
            label: ctx.t(entry.labelKey),
          }))
        : [],
  },

  a11y: {
    // Two mutually exclusive choices are a radiogroup whatever they look like — including the
    // 'toggle' display. Declaring `switch` for the toggle would erase the second label: a switch
    // announces one thing as on/off, and "No" is an answer, not the absence of "Yes".
    interactionModel: 'radiogroup',
    requiredRoles: ['radiogroup', 'radio'],
    keys: ['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Space'],
    minTouchTargetPx: 44,
    pointerDependent: false,
    rtlSafe: true,
  } satisfies A11yContract,

  staticChecks(ctx) {
    const out: PluginDiagnostic[] = [];
    if (ctx.options.length !== 2) {
      // An error, not a warning: one option is a statement, three is a single-select, and both
      // would still compile into a perfectly valid enum — which is exactly why the check exists.
      // The wrong shape here is only ever caught by a human reading the export, months later.
      out.push({
        code: 'two_options_required',
        severity: 'error',
        message: `binary requires exactly two options; got ${ctx.options.length}`,
        path: '/options',
      });
    }
    if (ctx.options.some((option) => option.exclusive === true)) {
      out.push({
        code: 'exclusive_on_binary',
        severity: 'warning',
        message: 'option.exclusive has no effect when only one option can be selected',
        path: '/options',
      });
    }
    return out;
  },
};
