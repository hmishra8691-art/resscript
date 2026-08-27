/**
 * `currency` renderer and editor.
 *
 * **The symbol is logical, never physical.** Currency placement is a reading-order fact — "€ before
 * the number", "kr after it" — so the symbol span renders before or after the input in the DOM and
 * the page's direction decides which side of the screen that is. A `float: left` here would pin the
 * symbol to the wrong side of every Arabic survey, invisibly to an LTR reviewer, which is why the
 * harness scans for physical tokens rather than trusting review (F §8).
 *
 * **The currency select is a real control, not decoration.** When the author offers a choice, the
 * respondent's pick is half the answer — the amount is meaningless without it — so it is a labelled
 * `select` next to the box, and changing it re-emits the answer so the codec re-checks the amount
 * against the new currency's grid. Switching from EUR to JPY with 100.25 typed produces an amount
 * the new currency cannot express, and the plugin's own validation is what surfaces it.
 */

import type { ReactNode } from 'react';
import { defineRenderer, type EditorProps, type RendererProps } from '../../contract/view.js';
import { TOUCH_TARGET_CLASS } from '../../contract/a11y.js';
import {
  allowedCurrencies,
  minorUnitsOf,
  type CurrencyAnswer,
  type CurrencyConfig,
} from './core.js';

export const CurrencyRenderer = defineRenderer<CurrencyConfig, CurrencyAnswer>(
  ({ question, value, onChange, issues, ctx }: RendererProps<CurrencyConfig, CurrencyAnswer>): ReactNode => {
    const config = question.config;
    const amount = value?.amount ?? null;
    const codes = allowedCurrencies(config);
    // The effective currency: what the respondent picked, else the configured default. Never null
    // while a choice is offered, so the amount always has a unit to be checked against.
    const currency = value?.currency ?? codes[0] ?? config.currency.toUpperCase();
    const decimals = minorUnitsOf(currency) ?? 2;
    const step = decimals === 0 ? 1 : 10 ** -decimals;
    const invalid = issues.length > 0;
    const offersChoice = codes.length > 1;

    const describedBy = [
      question.instruction === null ? undefined : ctx.ids.instructionId,
      invalid ? ctx.ids.errorId : undefined,
    ]
      .filter((id): id is string => id !== undefined)
      .join(' ');

    return (
      <div className="rs-currency">
        {/* A fixed currency renders as text before the box in reading order; a choice renders as a
            select. Both occupy the same slot, so the layout does not change shape. */}
        {offersChoice ? (
          <select
            className={`rs-currency__code ${TOUCH_TARGET_CLASS}`}
            data-testid="currency-code"
            aria-label={ctx.pipe('common.currency')}
            value={currency}
            onChange={(event) => onChange({ amount, currency: event.target.value })}
          >
            {codes.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
        ) : (
          <span className="rs-currency__code" data-testid="currency-code">
            {currency}
          </span>
        )}

        <input
          type="number"
          id={ctx.ids.groupId}
          className={`rs-currency__amount ${TOUCH_TARGET_CLASS}`}
          aria-labelledby={ctx.ids.labelId}
          aria-describedby={describedBy === '' ? undefined : describedBy}
          aria-required={question.required ? true : undefined}
          aria-invalid={invalid ? true : undefined}
          value={amount ?? ''}
          min={config.min ?? 0}
          max={config.max}
          step={step}
          onChange={(event) => {
            const next = event.target.valueAsNumber;
            // A cleared box drops the currency too, so the empty answer has one representation and
            // `parse` never sees a unit with no amount.
            onChange(
              Number.isFinite(next)
                ? { amount: next, currency }
                : { amount: null, currency: null },
            );
          }}
        />
      </div>
    );
  },
);

/** Studio editor. Patches only, inside the allowlist — see `single-select/view.tsx`. */
export function CurrencyEditor({ question, patch, ctx }: EditorProps<CurrencyConfig>): ReactNode {
  const config = question.config;
  const boundPatch = (path: string, raw: number): void =>
    patch([Number.isFinite(raw) ? { op: 'add', path, value: raw } : { op: 'remove', path }]);

  return (
    <div className="rs-editor rs-editor--currency">
      <label>
        {ctx.t('editor.currency.code')}
        <input
          type="text"
          maxLength={3}
          value={config.currency}
          onChange={(event) =>
            patch([
              { op: 'replace', path: '/config/currency', value: event.target.value.toUpperCase() },
            ])
          }
        />
      </label>
      <label>
        {ctx.t('editor.min')}
        <input
          type="number"
          value={config.min ?? ''}
          onChange={(event) => boundPatch('/config/min', event.target.valueAsNumber)}
        />
      </label>
      <label>
        {ctx.t('editor.max')}
        <input
          type="number"
          value={config.max ?? ''}
          onChange={(event) => boundPatch('/config/max', event.target.valueAsNumber)}
        />
      </label>
    </div>
  );
}
