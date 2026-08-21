/**
 * `text_list` renderer and editor — the multi-select layout with inputs where checkboxes were.
 *
 * The a11y shape follows from what the widget *is*: n independent text boxes inside one labelled
 * group. There is no roving tabindex (that pattern belongs to composite widgets like radiogroups;
 * a keyboard user expects Tab to walk form fields) and no arrow-key handling (the browser owns
 * the caret inside each box). Per-box errors land on the box: an issue whose `focus.optionRef`
 * names an item marks that input `aria-invalid`, so a screen-reader user finds the 201-character
 * box rather than being told "one of these is wrong".
 */

import type { ReactNode } from 'react';
import { defineRenderer, type EditorProps, type RendererProps } from '../../contract/view.js';
import { TOUCH_TARGET_CLASS } from '../../contract/a11y.js';
import type { TextListAnswer, TextListConfig } from './core.js';

export const TextListRenderer = defineRenderer<TextListConfig, TextListAnswer>(
  ({ question, value, onChange, issues, ctx }: RendererProps<TextListConfig, TextListAnswer>): ReactNode => {
    // Order comes from the seeded PRNG (ADR-006), same as every fan-out: a replayed session must
    // reproduce the box order the respondent actually saw.
    const items = ctx.order('options', question.options).filter((item) => item.visible);
    const texts = value?.texts ?? {};
    const invalid = issues.length > 0;
    const flaggedRefs = new Set(
      issues.map((issue) => issue.focus?.optionRef).filter((ref): ref is string => ref !== undefined),
    );
    const describedBy = [
      question.instruction === null ? undefined : ctx.ids.instructionId,
      invalid ? ctx.ids.errorId : undefined,
    ]
      .filter((id): id is string => id !== undefined)
      .join(' ');

    return (
      <div
        role="group"
        id={ctx.ids.groupId}
        aria-labelledby={ctx.ids.labelId}
        aria-describedby={describedBy === '' ? undefined : describedBy}
        aria-required={question.required ? true : undefined}
        aria-invalid={invalid ? true : undefined}
        className="rs-text-list"
      >
        {items.map((item) => (
          <label
            key={item.ref}
            className={`rs-text-list__item ${TOUCH_TARGET_CLASS}`}
            data-testid={`box-${item.ref}`}
          >
            <span>{ctx.pipe(item.labelKey)}</span>
            <input
              type="text"
              className="rs-text-list__input"
              maxLength={question.config.maxLen}
              disabled={!item.enabled}
              aria-invalid={flaggedRefs.has(item.ref) ? true : undefined}
              aria-describedby={flaggedRefs.has(item.ref) ? ctx.ids.errorId : undefined}
              value={texts[item.ref] ?? ''}
              onChange={(event) =>
                onChange({ texts: { ...texts, [item.ref]: event.target.value } })
              }
            />
          </label>
        ))}
      </div>
    );
  },
);

export function TextListEditor({ question, patch, ctx }: EditorProps<TextListConfig>): ReactNode {
  return (
    <div className="rs-editor rs-editor--text-list">
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
                value: Number.isFinite(event.target.valueAsNumber)
                  ? event.target.valueAsNumber
                  : 200,
              },
            ])
          }
        />
      </label>
      <label>
        {ctx.t('editor.min_answered')}
        <input
          type="number"
          min={0}
          value={question.config.minAnswered}
          onChange={(event) =>
            patch([
              {
                op: 'replace',
                path: '/config/minAnswered',
                value: Number.isFinite(event.target.valueAsNumber) ? event.target.valueAsNumber : 0,
              },
            ])
          }
        />
      </label>
    </div>
  );
}
