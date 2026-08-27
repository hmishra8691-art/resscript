/**
 * `ranking` — put these in order: `Qr1..Qrn : number`, each the item's 1-based rank (F §10, P2-05).
 *
 * **What the variables mean, and why this is the inverse of the obvious design.** The naive layout
 * is "position 1 holds item X" — one variable per SLOT, whose value is an option code. This plugin
 * does the opposite: one variable per ITEM, whose value is that item's rank. Both encode the same
 * permutation, and only the second survives contact with real analysis:
 *
 *  - **The columns are stable when the item list changes.** Adding a brand adds a column; it does
 *     not renumber existing ones. Slot-keyed columns shift meaning the moment a brand is inserted,
 *     which silently breaks every wave-on-wave comparison in a tracker.
 *  - **The analyses people actually run are per item.** "Mean rank of Brand A", "% ranking Brand A
 *     first" are a column mean and a column filter. Under slot-keyed columns each is a scan across
 *     every column looking for a code.
 *  - **Partial rankings have somewhere to go.** `max_ranked: 3` over ten brands leaves seven items
 *     unranked, which is `null` in seven item columns — an honest missing value. Slot-keyed columns
 *     would need seven empty slots that mean something different from "not ranked".
 *
 * **Ties are impossible by construction, and that is enforced in the codec.** A ranking with two
 * items at rank 2 is not a ranking, and once it is in the data every mean-rank calculation is
 * quietly wrong. The codec rejects duplicate ranks and gaps (`1,2,4` over three ranked items)
 * rather than letting `validate` report them: unlike a sum constraint, which a respondent can
 * genuinely get wrong mid-entry, a rank collision cannot be produced by the rendered widget — it is
 * a forged or stale payload, and the honest response is a reject.
 *
 * **Accessibility is the reason this type is hard, not the drag.** Drag-and-drop is pointer-only, so
 * the contract declares `pointerDependent` and a `keyboardAlternative`, and the renderer ships a
 * real one: a rank `select` per item, operable by keyboard and screen reader, which is the
 * authoritative control rather than a fallback bolted on beside the visual list.
 */

import { asPlainObject, err, ok, type ResponseCodec } from '../../contract/codec.js';
import { KIT_MESSAGE_KEYS, type ValidationIssue } from '../../contract/validate.js';
import type { PluginDiagnostic } from '../../contract/diagnostics.js';
import type { QuestionTypePluginCore } from '../../contract/plugin.js';
import type { A11yContract } from '../../contract/a11y.js';
import type { JsonSchema } from '../../json-schema.js';
import type { VariableDeclaration } from '../../contract/variables.js';

export interface RankingConfig {
  /**
   * How many items the respondent must rank. Absent means all of them.
   *
   * A partial ranking ("your top 3 of these ten") is the common commercial case, and it is why the
   * unranked state has to be a first-class `null` rather than a sentinel rank.
   */
  readonly max_ranked?: number;
  /** Show the items in one column with rank selects, or as a drag list. Presentational only. */
  readonly display?: 'list' | 'drag';
}

export interface RankingAnswer {
  /**
   * `item ref -> 1-based rank`. An item the respondent has not ranked is ABSENT, never `0` and
   * never a large sentinel: a missing key is the only representation that cannot be mistaken for a
   * rank in an export or averaged into a mean.
   */
  readonly ranks: Readonly<Record<string, number>>;
}

export const RANKING_CONFIG_SCHEMA: JsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: [],
  properties: {
    max_ranked: { type: 'integer', minimum: 1 },
    display: { enum: ['list', 'drag'], default: 'list' },
  },
};

/**
 * Is this set of ranks a valid (possibly partial) ranking?
 *
 * `1..n` with no gaps and no duplicates, where `n` is however many items were ranked. Exported so
 * the renderer can refuse to build an invalid state and the tests can assert the rule directly
 * rather than through a codec error string.
 */
export function isDenseRanking(ranks: readonly number[]): boolean {
  if (ranks.length === 0) return true;
  const sorted = [...ranks].sort((a, b) => a - b);
  return sorted.every((rank, i) => rank === i + 1);
}

const codec: ResponseCodec<RankingConfig, RankingAnswer> = {
  parse(raw, ctx) {
    if (raw === null || raw === undefined) return ok({ ranks: {} });
    const record = asPlainObject(raw);
    if (record === undefined) return err({ code: 'shape', message: 'expected an object' });

    const rawRanks = record['ranks'];
    if (rawRanks === undefined || rawRanks === null) return ok({ ranks: {} });
    // `asPlainObject` also rejects a >1000-key payload and an own `__proto__` before anything
    // below allocates per entry (F §9's hostile list).
    const map = asPlainObject(rawRanks);
    if (map === undefined) {
      return err({ code: 'shape', message: 'ranks must be an object', path: '/ranks' });
    }

    const known = new Set(ctx.question.options.map((option) => option.ref));
    const ranks: Record<string, number> = {};
    for (const [ref, entry] of Object.entries(map)) {
      if (!known.has(ref)) {
        // A fabricated ref is a forged payload: the UI renders only authored options. Rejecting
        // keeps `toVariables` unable to write a column that was never declared (ADR-005 threat 3).
        return err({ code: 'unknown_key', message: `no option ${ref}`, path: '/ranks' });
      }
      if (entry === null || entry === undefined) continue; // unranked, expressed as absence
      if (typeof entry !== 'number' || !Number.isInteger(entry) || entry < 1) {
        return err({
          code: 'shape',
          message: 'a rank must be a positive integer',
          path: `/ranks/${ref}`,
        });
      }
      ranks[ref] = entry;
    }

    const assigned = Object.values(ranks);
    if (new Set(assigned).size !== assigned.length) {
      // Two items at one rank is not a ranking, and every mean-rank calculation downstream would
      // be quietly wrong. The widget cannot produce it, so this is a forged or stale payload.
      return err({ code: 'range', message: 'two items share a rank', path: '/ranks' });
    }
    if (!isDenseRanking(assigned)) {
      return err({
        code: 'range',
        message: 'ranks must run 1..n with no gaps',
        path: '/ranks',
      });
    }
    const cap = ctx.config.max_ranked;
    if (cap !== undefined && assigned.length > cap) {
      return err({ code: 'range', message: `at most ${cap} items may be ranked`, path: '/ranks' });
    }
    return ok({ ranks });
  },

  toVariables(answer, ctx) {
    const out: Record<string, number | null> = {};
    for (const option of ctx.question.options) {
      // Every item gets a column, `null` when unranked: "offered and not ranked" and "never
      // offered" are different facts, and an absent key is how the second is represented.
      out[ctx.name.option(option.code)] = answer.ranks[option.ref] ?? null;
    }
    return out;
  },

  fromVariables(vars, ctx) {
    const ranks: Record<string, number> = {};
    for (const option of ctx.question.options) {
      const value = vars[ctx.name.option(option.code)];
      if (typeof value === 'number' && Number.isInteger(value) && value >= 1) {
        ranks[option.ref] = value;
      }
    }
    return { ranks };
  },

  emptyAnswer: () => ({ ranks: {} }),
};

export const rankingCore: QuestionTypePluginCore<RankingConfig, RankingAnswer> = {
  meta: {
    id: 'ranking',
    version: '1.0.0',
    displayName: 'qt.ranking.name',
    description: 'qt.ranking.desc',
    category: 'ranking',
    icon: 'list-ordered',
    entitlementKey: null,
    trust: 'first_party',
    // NOT composable. A matrix cell is one control in a row; a ranking is a control over a WHOLE
    // item list, and its variables are named per item rather than per cell — the scoped namer has
    // no way to express "rank of item 3 within cell (row 2, column 1)". Declaring `true` would let
    // the studio offer a configuration whose variable names collide.
    composable: false,
    emitsData: true,
  },

  configSchema: RANKING_CONFIG_SCHEMA,

  defaultConfig: () => ({ display: 'list' }),

  declareVariables(ctx) {
    const out: VariableDeclaration[] = [];
    for (const option of ctx.options) {
      out.push({
        name: ctx.name.option(option.code),
        kind: 'response',
        type: 'number',
        // The domain is the rank space, not the option codes: this column holds 1..n.
        numericDomain: { min: 1, max: Math.max(ctx.options.length, 1), decimals: 0 },
        source: { part: { kind: 'option', optionRef: option.ref } },
        export: {
          include: !ctx.flags.excludeFromExport,
          column: ctx.name.option(option.code),
          labelKey: option.labelKey,
          // Order from the *code*, never the loop index: dragging an item up the authored list
          // must not shift export columns (F §1.1 rule 2).
          order: option.code,
        },
        pii: ctx.flags.pii,
        persist: true,
        // `ordinal`, not `scale`: a rank is an order without a metric — the gap between 1st and
        // 2nd is not comparable to the gap between 8th and 9th. Analysts do take mean ranks
        // anyway, which is exactly why the measure level should say what the number really is.
        analysis: { measure: 'ordinal', batteryRef: ctx.ref },
      });
    }
    return out;
  },

  validate(ctx) {
    const issues: ValidationIssue[] = [];
    const ranks = ctx.value?.ranks ?? {};
    const options = ctx.question.options.filter((option) => option.visible);
    const assigned = options
      .map((option) => ranks[option.ref])
      .filter((rank): rank is number => typeof rank === 'number');
    const required = Math.min(ctx.question.config.max_ranked ?? options.length, options.length);

    if (assigned.length === 0) {
      // One message, not one per item — n "required" errors on a question the respondent has not
      // started reads as the form shouting.
      return ctx.required
        ? [{ variableName: null, messageKey: KIT_MESSAGE_KEYS.required, severity: 'error' }]
        : issues;
    }

    // A partially-completed ranking. Reported as "too few" rather than "required", because the
    // respondent HAS engaged and the actionable message is how many more to place.
    if (assigned.length < required) {
      issues.push({
        variableName: null,
        messageKey: KIT_MESSAGE_KEYS.tooFewSelected,
        params: { min: required },
        severity: 'error',
      });
    }
    if (assigned.length > required) {
      issues.push({
        variableName: null,
        messageKey: KIT_MESSAGE_KEYS.tooManySelected,
        params: { max: required },
        severity: 'error',
      });
    }
    // Defensive: the codec rejects both of these first, and ADR-004 makes the server re-run it.
    // Reachable only from a stale Answer held by a client across a republish.
    if (new Set(assigned).size !== assigned.length || !isDenseRanking(assigned)) {
      issues.push({
        variableName: null,
        messageKey: KIT_MESSAGE_KEYS.invalidOption,
        severity: 'error',
      });
    }
    return issues;
  },

  codec,

  exportContribution: {
    columnLabel: (declaration, ctx) =>
      `${ctx.t(ctx.question.label)} — ${ctx.t(declaration.export.labelKey)}`,
    // No value labels. The numbers ARE the meaning (1 = first), and labelling 1..n with the item
    // names would be exactly backwards: the item is the column, not the value.
    valueLabels: () => [],
  },

  a11y: {
    interactionModel: 'reorder',
    /**
     * `group` + `combobox`, and NOT `listbox`/`option`.
     *
     * The first draft wrapped the items in `role="listbox"` with `role="option"` children, which is
     * the shape a drag-reorder widget suggests — and it was wrong twice over. A listbox's options
     * must be selectable by activating them, and these are not: the rank `select` inside each row
     * is the control, and the row itself does nothing when clicked. The harness caught it as a
     * touch-target failure (an interactive `role="option"` with no target class), which is the
     * right complaint for the wrong reason — the fix was not to add the class to a fake option but
     * to stop claiming a role the markup does not implement.
     *
     * What the output actually is: a labelled GROUP of per-item rank controls, each a native
     * `select` (a `combobox` in ARIA 1.2). Declaring that is what makes the keyboard alternative
     * below a description of the real control rather than of a second one.
     */
    requiredRoles: ['group', 'combobox'],
    keys: ['Tab', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Space', 'Enter'],
    minTouchTargetPx: 44,
    // Honest: the drag display genuinely depends on pointer position. Declaring `false` because a
    // keyboard path also exists would hide the fact that one of the two displays is pointer-only.
    pointerDependent: true,
    keyboardAlternative: {
      description:
        'Every item carries a rank select, operable by keyboard and screen reader. It is the ' +
        'authoritative control: the drag list writes the same ranks, and a respondent who never ' +
        'uses a pointer can complete the question entirely through the selects.',
      testId: 'ranking-rank-select',
    },
    rtlSafe: true,
  } satisfies A11yContract,

  staticChecks(ctx) {
    const out: PluginDiagnostic[] = [];
    const cap = ctx.config.max_ranked;

    if (ctx.options.length < 2) {
      out.push({
        code: 'too_few_items',
        severity: 'error',
        message: 'a ranking needs at least two items to order',
        path: '/options',
      });
    }
    if (cap !== undefined && cap > ctx.options.length) {
      out.push({
        code: 'max_ranked_exceeds_items',
        severity: 'error',
        message: `max_ranked (${cap}) exceeds the ${ctx.options.length} items offered, so the ` +
          'question can never be completed',
        path: '/config/max_ranked',
      });
    }
    if (ctx.rows.length > 0) {
      out.push({
        code: 'rows_ignored',
        severity: 'warning',
        message: 'ranking orders its options; authored rows are ignored',
        path: '/rows',
      });
    }
    return out;
  },
};
