/**
 * `text` renderer and editor — F §8 applied to the smallest possible surface.
 *
 * There is almost nothing here, which is the point: a single-line input needs no roving tabindex
 * (it is one control), no arrow-key handling (the browser owns the caret) and no layout classes
 * with a direction in them. The two things that are easy to get wrong anyway:
 *
 *  - **`inputMode`, never `type`.** `type="email"` enrols the browser's own validity UI, which the
 *    server-side `validate` does not run (see `core.ts`). The keyboard hint is the whole feature.
 *  - **`maxLength` mirrors the config but is not the enforcement.** The codec truncates and
 *    `validate` reports; the attribute exists so a respondent hits the limit while typing rather
 *    than at submit.
 */

import type { ReactNode } from 'react';
import { defineRenderer, type EditorProps, type RendererProps } from '../../contract/view.js';
import { TOUCH_TARGET_CLASS } from '../../contract/a11y.js';
import type { TextAnswer, TextConfig, TextInputMode } from './core.js';

export const TextRenderer = defineRenderer<TextConfig, TextAnswer>(
  ({ question, value, onChange, issues, ctx }: RendererProps<TextConfig, TextAnswer>): ReactNode => {
    const invalid = issues.length > 0;
    const describedBy = [
      question.instruction === null ? undefined : ctx.ids.instructionId,
      invalid ? ctx.ids.errorId : undefined,
    ]
      .filter((id): id is string => id !== undefined)
      .join(' ');

    return (
      <input
        type="text"
        inputMode={question.config.inputMode}
        id={ctx.ids.groupId}
        className={`rs-text ${TOUCH_TARGET_CLASS}`}
        aria-labelledby={ctx.ids.labelId}
        aria-describedby={describedBy === '' ? undefined : describedBy}
        aria-required={question.required ? true : undefined}
        aria-invalid={invalid ? true : undefined}
        maxLength={question.config.maxLen}
        placeholder={
          question.config.placeholderKey === null
            ? undefined
            : ctx.pipe(question.config.placeholderKey)
        }
        value={value?.text ?? ''}
        onChange={(event) => onChange({ text: event.target.value })}
      />
    );
  },
);

const INPUT_MODES: readonly TextInputMode[] = ['text', 'email', 'tel', 'url'];

/** The studio editor. Patches only — see `single-select/view.tsx` for why that is the contract. */
export function TextEditor({ question, patch, ctx }: EditorProps<TextConfig>): ReactNode {
  return (
    <div className="rs-editor rs-editor--text">
      <label>
        {ctx.t('editor.max_len')}
        <input
          type="number"
          min={1}
          max={4000}
          value={question.config.maxLen}
          onChange={(event) =>
            patch([
              {
                op: 'replace',
                path: '/config/maxLen',
                // `Number.isFinite` rather than a bare cast: an empty input yields `''`, and
                // `Number('')` is 0 — which the schema would then reject as below its minimum.
                value: Number.isFinite(event.target.valueAsNumber)
                  ? event.target.valueAsNumber
                  : 200,
              },
            ])
          }
        />
      </label>
      <label>
        {ctx.t('editor.input_mode')}
        <select
          value={question.config.inputMode}
          onChange={(event) =>
            patch([{ op: 'replace', path: '/config/inputMode', value: event.target.value }])
          }
        >
          {INPUT_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {ctx.t(`editor.input_mode.${mode}`)}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
