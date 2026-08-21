/**
 * `consent` — the agreement gate (F §10's catalogue line: `Q_consent : boolean` +
 * `Q_consent_at : date`).
 *
 * ## THE GAP TO KNOW ABOUT: the codec never writes `Q_consent_at`. Read this before "fixing" it.
 *
 * `Q_consent_at` is *declared* here and *stamped by the runtime* at submission. It cannot be
 * stamped by the codec, because `CodecContext` carries no clock — deliberately, per ADR-006's
 * ban on wall clocks in deterministic paths — and a `toVariables` that read `Date.now()` would
 * produce different variables for the same Answer on client and server, which is precisely the
 * divergence ADR-004's metric exists to catch (and a replayed session could never reproduce).
 * So the split is: this plugin owns the *shape* of the consent record (both columns, their
 * types, their names); the runtime owns the one fact only it can know honestly, which is *when
 * its own trusted side accepted the submission*. A client-supplied timestamp would be worse
 * than none — a consent audit trail whose times the respondent's machine invented. Until the
 * runtime's stamping pass lands, the column exists and is null; that is a truthful "not
 * stamped", never a fabricated instant.
 *
 * Two more decisions:
 *
 *  1. **`pii: false`, hard, on both variables.** Not inherited from `ctx.flags.pii`: the
 *     consent record is the compliance artifact itself — the row an auditor asks for — and a
 *     PII flag would redact it from debug traces and gate its export, defeating the reason it
 *     is collected. (It contains nothing identifying: one boolean and one server-side instant.)
 *  2. **Declined is data.** `agreed: false` is an explicit answer, distinct from `null`
 *     (untouched), and in `declineBehavior: 'record'` mode it validates clean and exports as a
 *     legitimate `false` — a diary study that must *record* refusals is a real instrument. In
 *     `'block'` mode any non-`true` fails `err.required` when the question is required. One
 *     key for both empty-ish states on purpose: untouched and unchecked render as the same
 *     unchecked box, and two different messages for one visual state would send the respondent
 *     hunting for a difference that is not on the screen. (A plugin-local `must_agree` key was
 *     considered — the `textarea` precedent sanctions it — and rejected for that reason.)
 */

import { asPlainObject, err, ok, type ResponseCodec } from '../../contract/codec.js';
import { KIT_MESSAGE_KEYS, type ValidationIssue } from '../../contract/validate.js';
import type { PluginDiagnostic } from '../../contract/diagnostics.js';
import type { QuestionTypePluginCore } from '../../contract/plugin.js';
import type { A11yContract } from '../../contract/a11y.js';
import type { JsonSchema } from '../../json-schema.js';
import type { VariableDeclaration } from '../../contract/variables.js';

export interface ConsentConfig {
  /** The i18n key of the statement the checkbox asserts agreement with. The label IS the terms. */
  readonly statementKey: string;
  /**
   * `block`: a required consent must be granted to proceed (the screener/legal-gate case).
   * `record`: declining is a legitimate answer, stored as `false` (the opt-in-module case).
   */
  readonly declineBehavior: 'block' | 'record';
}

export interface ConsentAnswer {
  /** `null` = untouched, `false` = explicitly declined, `true` = agreed. Three states, and the
   * difference between the first two is the whole point of `declineBehavior: 'record'`. */
  readonly agreed: boolean | null;
}

export const CONSENT_CONFIG_SCHEMA: JsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['statementKey'],
  properties: {
    statementKey: { type: 'string', minLength: 1 },
    // `block` is the default: a consent question whose decline quietly records and moves on
    // must be an author's explicit choice, not an unnoticed dropdown.
    declineBehavior: { enum: ['block', 'record'], default: 'block' },
  },
};

const codec: ResponseCodec<ConsentConfig, ConsentAnswer> = {
  parse(raw) {
    if (raw === null || raw === undefined) return ok({ agreed: null });
    const record = asPlainObject(raw);
    if (record === undefined) return err({ code: 'shape', message: 'expected an object' });
    const agreed = record['agreed'];
    if (agreed === null || agreed === undefined) return ok({ agreed: null });
    if (typeof agreed !== 'boolean') {
      // Strictly boolean: `1`, `'yes'` and `'true'` are not consent. A coercion here would be a
      // consent record built out of a payload nobody actually asserted.
      return err({ code: 'shape', message: 'agreed must be a boolean', path: '/agreed' });
    }
    return ok({ agreed });
  },

  toVariables(answer, ctx) {
    // ONLY the boolean. `Q_consent_at` is declared but NOT written here — no clock in this
    // context, by design. See the file header before adding it.
    return { [ctx.name.suffixed('consent')]: answer.agreed };
  },

  fromVariables(vars, ctx) {
    const agreed = vars[ctx.name.suffixed('consent')];
    return { agreed: typeof agreed === 'boolean' ? agreed : null };
  },

  emptyAnswer: () => ({ agreed: null }),
};

export const consentCore: QuestionTypePluginCore<ConsentConfig, ConsentAnswer> = {
  meta: {
    id: 'consent',
    version: '1.0.0',
    displayName: 'qt.consent.name',
    description: 'qt.consent.desc',
    // `choice`: the respondent makes one. There is no legal/compliance category, and inventing
    // one is not this plugin's call — `PLUGIN_CATEGORIES` is a closed list.
    category: 'choice',
    icon: 'shield_check',
    entitlementKey: null,
    trust: 'first_party',
    /**
     * **Not composable, and this is a contract limitation rather than a product decision.**
     *
     * A cell control names itself through the scoped namer, and there is no variable part in
     * schema §4 that names `Q5r3_consent`: the `suffix` part produces `{ref}_{suffix}`, so the
     * consent pair of a cell would have to be called `Q5_r3_consent`, which is not the cell's
     * namespace. A plugin that declares companion variables therefore cannot be a cell control
     * until the part model gains a composite (row + suffix) form. Recorded on the plugin
     * because the alternative is discovering it as a `compose_unnameable_part` at publish time.
     */
    composable: false,
    emitsData: true,
  },

  configSchema: CONSENT_CONFIG_SCHEMA,

  defaultConfig: (ctx) => ({
    // Per-question, like content_text's body: two consent gates in one survey (recontact
    // permission and data-processing terms, say) must not share one statement.
    statementKey: `${ctx.ref}.statement`,
    declineBehavior: 'block',
  }),

  declareVariables(ctx) {
    const shared = {
      kind: 'response' as const,
      // Hard false, never ctx.flags.pii — the consent record must survive redaction to be
      // worth anything. See the file header.
      pii: false,
      persist: true,
    };
    const consent: VariableDeclaration = {
      name: ctx.name.suffixed('consent'),
      ...shared,
      type: 'boolean',
      source: { part: { kind: 'meta', label: 'consent_granted', suffix: 'consent' } },
      export: {
        include: !ctx.flags.excludeFromExport,
        column: ctx.name.suffixed('consent'),
        labelKey: `${ctx.ref}.consent.label`,
        order: 0,
      },
      analysis: { measure: 'nominal', batteryRef: ctx.ref },
    };
    const consentAt: VariableDeclaration = {
      name: ctx.name.suffixed('consent_at'),
      ...shared,
      type: 'date',
      // Runtime-stamped, codec-never-written: see the file header. Declared here all the same,
      // because the manifest is the export contract and a column added later by the runtime
      // would be exactly the undeclared-key forgery ADR-005 threat 3 rejects.
      source: { part: { kind: 'meta', label: 'consent_timestamp', suffix: 'consent_at' } },
      export: {
        include: !ctx.flags.excludeFromExport,
        column: ctx.name.suffixed('consent_at'),
        labelKey: `${ctx.ref}.consent_at.label`,
        order: 1,
      },
      analysis: { measure: 'scale', batteryRef: ctx.ref },
    };
    return [consent, consentAt];
  },

  validate(ctx) {
    const issues: ValidationIssue[] = [];
    const agreed = ctx.value?.agreed ?? null;
    // The boolean is a meta part, so the name comes from the index — never string-built (F §1.2).
    const consentName = ctx.question.variables.byRow['meta:consent'] ?? null;

    if (!ctx.required) return issues;
    if (agreed === null) {
      return [{ variableName: consentName, messageKey: KIT_MESSAGE_KEYS.required, severity: 'error' }];
    }
    if (ctx.question.config.declineBehavior === 'block' && !agreed) {
      // Same key as untouched — one visual state, one message. See the file header.
      return [{ variableName: consentName, messageKey: KIT_MESSAGE_KEYS.required, severity: 'error' }];
    }
    return issues;
  },

  codec,

  exportContribution: {
    columnLabel: (declaration, ctx) => {
      const part = declaration.source.part;
      const label = ctx.t(ctx.question.label);
      return part.kind === 'meta' && part.suffix === 'consent_at' ? `${label} — consented at` : label;
    },
    valueLabels: () => [],
  },

  a11y: {
    // A single checkbox is a checkbox group of one — the degenerate case, not a different
    // pattern. Declaring `custom_documented` for it would exempt from the harness exactly the
    // wiring (Space toggles, one tab stop, `checkbox` role) a checkbox must have.
    interactionModel: 'checkboxgroup',
    requiredRoles: ['checkbox'],
    keys: ['Tab', 'Space'],
    minTouchTargetPx: 44,
    pointerDependent: false,
    rtlSafe: true,
  } satisfies A11yContract,

  staticChecks(ctx) {
    const out: PluginDiagnostic[] = [];
    if (ctx.options.length > 0) {
      out.push({
        code: 'options_ignored',
        severity: 'warning',
        message: 'consent is one fixed checkbox; authored options are ignored',
        path: '/options',
      });
    }
    if (ctx.config.declineBehavior === 'block' && !ctx.required) {
      // Coherent but almost certainly not what the author meant: `block` only ever blocks a
      // *required* consent, so this combination is `record` semantics wearing `block`'s name.
      out.push({
        code: 'block_without_required',
        severity: 'warning',
        message: 'declineBehavior "block" has no effect while the question is not required — declining only blocks a required consent',
        path: '/config/declineBehavior',
      });
    }
    return out;
  },
};
