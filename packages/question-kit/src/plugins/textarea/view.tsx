/**
 * `textarea` renderer and editor.
 *
 * One control, so most of F §8 is trivially satisfied; the piece that is not obvious is the
 * counter. It is `aria-hidden` **deliberately**: a live count next to a textarea is exactly the
 * kind of thing that gets wired to `aria-live` "to be helpful", and two live regions on a page
 * means one is silently ignored (F §8 — the page shell owns the only one). A screen-reader user
 * gets the limit from the error message when they cross it, which is the same information without
 * a per-keystroke announcement fighting the page's own region.
 */

import type { ReactNode } from 'react';
import { defineRenderer, type EditorProps, type RendererProps } from '../../contract/view.js';
import { TOUCH_TARGET_CLASS } from '../../contract/a11y.js';
import type { TextareaAnswer, TextareaConfig } from './core.js';

export const TextareaRenderer = defineRenderer<TextareaConfig, TextareaAnswer>(
  ({ question, value, onChange, issues, ctx }: RendererProps<TextareaConfig, TextareaAnswer>): ReactNode => {
    const invalid = issues.length > 0;
    const describedBy = [
      question.instruction === null ? undefined : ctx.ids.instructionId,
      invalid ? ctx.ids.errorId : undefined,
    ]
      .filter((id): id is string => id !== undefined)
      .join(' ');
    const current = value?.text ?? '';

    return (
      <div className="rs-textarea">
        <textarea
          id={ctx.ids.groupId}
          className={`rs-textarea__input ${TOUCH_TARGET_CLASS}`}
          rows={question.config.rows}
          aria-labelledby={ctx.ids.labelId}
          aria-describedby={describedBy === '' ? undefined : describedBy}
          aria-required={question.required ? true : undefined}
          aria-invalid={invalid ? true : undefined}
          maxLength={question.config.maxLen}
          value={current}
          onChange={(event) => onChange({ text: event.target.value })}
        />
        {question.config.showCounter && (
          <span className="rs-textarea__counter" aria-hidden="true">
            {/* Code points, matching what `validate` counts — a counter that disagrees with the
                error message teaches respondents the form is broken. */}
            {`${[...current].length} / ${question.config.maxLen}`}
          </span>
        )}
      </div>
    );
  },
);

export function TextareaEditor({ question, patch, ctx }: EditorProps<TextareaConfig>): ReactNode {
  const numberField = (
    labelKey: string,
    path: string,
    current: number,
    min: number,
    fallback: number,
  ): ReactNode => (
    <label>
      {ctx.t(labelKey)}
      <input
        type="number"
        min={min}
        value={current}
        onChange={(event) =>
          patch([
            {
              op: 'replace',
              path,
              value: Number.isFinite(event.target.valueAsNumber)
                ? event.target.valueAsNumber
                : fallback,
            },
          ])
        }
      />
    </label>
  );

  return (
    <div className="rs-editor rs-editor--textarea">
      {numberField('editor.max_len', '/config/maxLen', question.config.maxLen, 1, 2000)}
      {numberField('editor.rows', '/config/rows', question.config.rows, 2, 4)}
      {numberField('editor.min_words', '/config/minWords', question.config.minWords, 0, 0)}
      {numberField('editor.max_words', '/config/maxWords', question.config.maxWords, 0, 0)}
      <label>
        {ctx.t('editor.show_counter')}
        <input
          type="checkbox"
          checked={question.config.showCounter}
          onChange={(event) =>
            patch([{ op: 'replace', path: '/config/showCounter', value: event.target.checked }])
          }
        />
      </label>
    </div>
  );
}
