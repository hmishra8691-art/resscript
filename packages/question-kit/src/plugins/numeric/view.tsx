/**
 * `numeric` renderer and editor.
 *
 * The RTL trap this file exists to not fall into: **a unit is logical, never physical.** "€
 * before the number" is a *reading-order* fact, so the prefix span renders before the input in
 * the DOM and the suffix after it, and the page's direction decides which side of the screen
 * that is. Writing `float: left` (or a `--left` class) for the prefix would pin the euro sign to
 * the wrong side of every Arabic survey — invisibly to an LTR reviewer, which is why the harness
 * scans for physical tokens instead of trusting review (F §8).
 *
 * The stepper's buttons nudge along the *grid*, not along raw floats: `0.1 + 0.2` drift would
 * otherwise put the answer off the declared decimal grid and the codec would (correctly) reject
 * a value the plugin's own UI produced.
 */

import type { ReactNode } from 'react';
import { defineRenderer, type EditorProps, type RendererProps } from '../../contract/view.js';
import { TOUCH_TARGET_CLASS } from '../../contract/a11y.js';
import type { NumericAnswer, NumericConfig } from './core.js';

export const NumericRenderer = defineRenderer<NumericConfig, NumericAnswer>(
  ({ question, value, onChange, issues, ctx }: RendererProps<NumericConfig, NumericAnswer>): ReactNode => {
    const config = question.config;
    const current = value?.value ?? null;
    const invalid = issues.length > 0;
    const describedBy = [
      question.instruction === null ? undefined : ctx.ids.instructionId,
      invalid ? ctx.ids.errorId : undefined,
    ]
      .filter((id): id is string => id !== undefined)
      .join(' ');

    // The UI increment. Falls back to one grid unit so the arrows never step off the grid the
    // codec enforces.
    const step = config.step ?? (config.decimals === 0 ? 1 : 10 ** -config.decimals);
    const factor = 10 ** config.decimals;

    const nudge = (direction: 1 | -1): void => {
      const from = current ?? config.min ?? 0;
      // Round on the grid *after* adding: repeated float addition drifts, and a stepper that
      // produces 0.30000000000000004 has built a value its own codec rejects.
      let next = Math.round((from + direction * step) * factor) / factor;
      if (config.min !== undefined && next < config.min) next = config.min;
      if (config.max !== undefined && next > config.max) next = config.max;
      onChange({ value: next });
    };

    const unit =
      config.unit === undefined ? null : (
        <span className={`rs-numeric__unit rs-numeric__unit--${config.unit.position}`}>
          {ctx.pipe(config.unit.labelKey)}
        </span>
      );

    return (
      <div className={`rs-numeric rs-numeric--${config.display}`}>
        {config.unit?.position === 'prefix' ? unit : null}
        {config.display === 'stepper' && (
          <button
            type="button"
            className={`rs-numeric__step ${TOUCH_TARGET_CLASS}`}
            aria-label={ctx.pipe('common.decrement')}
            data-testid="numeric-decrement"
            onClick={() => nudge(-1)}
          >
            −
          </button>
        )}
        <input
          type="number"
          id={ctx.ids.groupId}
          className={`rs-numeric__input ${TOUCH_TARGET_CLASS}`}
          aria-labelledby={ctx.ids.labelId}
          aria-describedby={describedBy === '' ? undefined : describedBy}
          aria-required={question.required ? true : undefined}
          aria-invalid={invalid ? true : undefined}
          value={current ?? ''}
          min={config.min}
          max={config.max}
          step={step}
          onChange={(event) => {
            const next = event.target.valueAsNumber;
            // A cleared box is `NaN` from `valueAsNumber`; store the honest blank rather than 0.
            onChange({ value: Number.isFinite(next) ? next : null });
          }}
        />
        {config.display === 'stepper' && (
          <button
            type="button"
            className={`rs-numeric__step ${TOUCH_TARGET_CLASS}`}
            aria-label={ctx.pipe('common.increment')}
            data-testid="numeric-increment"
            onClick={() => nudge(1)}
          >
            +
          </button>
        )}
        {config.unit?.position === 'suffix' ? unit : null}
      </div>
    );
  },
);

/** Studio editor. Patches only, inside the allowlist — see `single-select/view.tsx`. */
export function NumericEditor({ question, patch, ctx }: EditorProps<NumericConfig>): ReactNode {
  // `min`/`max` are *optional* in config, so an emptied field is `remove`, not `replace`-with-0:
  // "no floor" and "floor of zero" are different questions, and `Number('')` is 0.
  const boundPatch = (path: string, raw: number): void =>
    patch([Number.isFinite(raw) ? { op: 'add', path, value: raw } : { op: 'remove', path }]);

  return (
    <div className="rs-editor rs-editor--numeric">
      <label>
        {ctx.t('editor.display')}
        <select
          value={question.config.display}
          onChange={(event) =>
            patch([{ op: 'replace', path: '/config/display', value: event.target.value }])
          }
        >
          {(['input', 'stepper'] as const).map((display) => (
            <option key={display} value={display}>
              {ctx.t(`editor.display.${display}`)}
            </option>
          ))}
        </select>
      </label>
      <label>
        {ctx.t('editor.decimals')}
        <input
          type="number"
          min={0}
          max={6}
          value={question.config.decimals}
          onChange={(event) =>
            patch([
              {
                op: 'replace',
                path: '/config/decimals',
                value: Number.isFinite(event.target.valueAsNumber) ? event.target.valueAsNumber : 0,
              },
            ])
          }
        />
      </label>
      <label>
        {ctx.t('editor.min')}
        <input
          type="number"
          value={question.config.min ?? ''}
          onChange={(event) => boundPatch('/config/min', event.target.valueAsNumber)}
        />
      </label>
      <label>
        {ctx.t('editor.max')}
        <input
          type="number"
          value={question.config.max ?? ''}
          onChange={(event) => boundPatch('/config/max', event.target.valueAsNumber)}
        />
      </label>
    </div>
  );
}
