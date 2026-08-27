/**
 * `slider` renderer and editor.
 *
 * **Direction is the platform's job.** A native `<input type="range">` is mirrored by the browser
 * under `dir="rtl"` — min ends up on the right, arrow keys follow reading order — so this file
 * positions nothing and names no side. Building the track by hand with `left: %` would look correct
 * to an LTR reviewer and put the low end of every Arabic survey's scale on the wrong side; the
 * harness scans for physical tokens because review does not catch it (F §8).
 *
 * **The untouched state is rendered, not defaulted.** The thumb has to sit somewhere, so it sits at
 * `restingValue(config)` — but while the answer is null the input carries `data-untouched` and NO
 * `aria-valuenow`/`aria-valuetext`, so a screen reader announces a slider with no current value
 * rather than reading out the resting position as the respondent's answer. `show_value` likewise
 * shows a dash, not the resting number. This is the visible half of `core.ts`' decision 2: if the
 * resting position were announced and displayed as a value, it would be a default answer in
 * everything but name.
 */

import type { ReactNode } from 'react';
import { defineRenderer, type EditorProps, type RendererProps } from '../../contract/view.js';
import { TOUCH_TARGET_CLASS } from '../../contract/a11y.js';
import { gridUnit, restingValue, type SliderAnswer, type SliderConfig } from './core.js';

export const SliderRenderer = defineRenderer<SliderConfig, SliderAnswer>(
  ({ question, value, onChange, issues, ctx }: RendererProps<SliderConfig, SliderAnswer>): ReactNode => {
    const config = question.config;
    const current = value?.value ?? null;
    const untouched = current === null;
    const invalid = issues.length > 0;
    const step = config.step ?? gridUnit(config.decimals);

    const describedBy = [
      question.instruction === null ? undefined : ctx.ids.instructionId,
      invalid ? ctx.ids.errorId : undefined,
    ]
      .filter((id): id is string => id !== undefined)
      .join(' ');

    return (
      <div className="rs-slider">
        {config.min_label_key === undefined ? null : (
          <span className="rs-slider__end-label rs-slider__end-label--min">
            {ctx.pipe(config.min_label_key)}
          </span>
        )}

        <input
          type="range"
          id={ctx.ids.groupId}
          className={`rs-slider__track ${TOUCH_TARGET_CLASS}`}
          aria-labelledby={ctx.ids.labelId}
          aria-describedby={describedBy === '' ? undefined : describedBy}
          aria-required={question.required ? true : undefined}
          aria-invalid={invalid ? true : undefined}
          min={config.min}
          max={config.max}
          step={step}
          // The thumb rests somewhere; the ANSWER is still null. `aria-valuenow` is omitted while
          // untouched so assistive tech does not read the resting position back as a choice, and
          // `data-untouched` gives the stylesheet a hook to draw the thumb as unset.
          value={current ?? restingValue(config)}
          {...(untouched
            ? { 'data-untouched': 'true', 'aria-valuenow': undefined }
            : { 'aria-valuenow': current })}
          onChange={(event) => {
            const next = event.target.valueAsNumber;
            // A range input cannot produce a blank, so any change is a real interaction — this is
            // exactly the moment `null` becomes a value, and the only such moment.
            onChange({ value: Number.isFinite(next) ? next : null });
          }}
        />

        {config.max_label_key === undefined ? null : (
          <span className="rs-slider__end-label rs-slider__end-label--max">
            {ctx.pipe(config.max_label_key)}
          </span>
        )}

        {config.show_value === true && (
          <output className="rs-slider__value" htmlFor={ctx.ids.groupId} data-testid="slider-value">
            {/* A dash, not the resting number: displaying it would anchor the respondent on a
                value they have not chosen. */}
            {untouched ? '—' : String(current)}
          </output>
        )}

        {(config.ticks ?? []).length > 0 && (
          <ul className="rs-slider__ticks" aria-hidden="true">
            {(config.ticks ?? []).map((tick) => (
              <li key={`${String(tick.value)}:${tick.labelKey}`} className="rs-slider__tick">
                {ctx.pipe(tick.labelKey)}
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  },
);

/** Studio editor. Patches only, inside the allowlist — see `single-select/view.tsx`. */
export function SliderEditor({ question, patch, ctx }: EditorProps<SliderConfig>): ReactNode {
  const config = question.config;
  // `min`/`max` are REQUIRED here, unlike numeric's, so an emptied field is a `replace` with a
  // usable number rather than a `remove`: removing one would make the config invalid against its
  // own schema and the question unrenderable.
  const requiredNumber = (path: string, raw: number, fallback: number): void =>
    patch([{ op: 'replace', path, value: Number.isFinite(raw) ? raw : fallback }]);

  return (
    <div className="rs-editor rs-editor--slider">
      <label>
        {ctx.t('editor.min')}
        <input
          type="number"
          value={config.min}
          onChange={(event) => requiredNumber('/config/min', event.target.valueAsNumber, 0)}
        />
      </label>
      <label>
        {ctx.t('editor.max')}
        <input
          type="number"
          value={config.max}
          onChange={(event) => requiredNumber('/config/max', event.target.valueAsNumber, 100)}
        />
      </label>
      <label>
        {ctx.t('editor.decimals')}
        <input
          type="number"
          min={0}
          max={6}
          value={config.decimals}
          onChange={(event) => requiredNumber('/config/decimals', event.target.valueAsNumber, 0)}
        />
      </label>
      <label>
        {ctx.t('editor.slider.resting_position')}
        <select
          value={config.resting_position ?? 'min'}
          onChange={(event) =>
            patch([{ op: 'replace', path: '/config/resting_position', value: event.target.value }])
          }
        >
          {(['min', 'midpoint', 'max'] as const).map((position) => (
            <option key={position} value={position}>
              {ctx.t(`editor.slider.resting_position.${position}`)}
            </option>
          ))}
        </select>
      </label>
      <label>
        {ctx.t('editor.slider.show_value')}
        <input
          type="checkbox"
          checked={config.show_value === true}
          onChange={(event) =>
            patch([{ op: 'replace', path: '/config/show_value', value: event.target.checked }])
          }
        />
      </label>
    </div>
  );
}
