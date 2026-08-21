/**
 * `date` renderer and editor.
 *
 * Plain text boxes with a stated format, not `<input type="date">` — the a11y contract in
 * `core.ts` documents why (no ARIA role to assert, an unlocalizable native picker). What that
 * costs is mid-entry leniency, and the renderer pays it honestly: the raw keystrokes go into the
 * Answer as typed, and `validate` — not the input — says whether "2026-0" is a date yet. Swallowing
 * keystrokes until they parse would make the box feel broken; correcting them would be the rollover
 * bug (`2026-02-30` → March 2nd) reintroduced in the UI after the codec was written to kill it.
 *
 * RTL: a `YYYY-MM-DD` value is a bidi-neutral digit run, so the inputs carry no direction of
 * their own and the from/to pair stacks in reading order — nothing here names a side.
 */

import type { ReactNode } from 'react';
import { defineRenderer, type EditorProps, type RendererProps } from '../../contract/view.js';
import { TOUCH_TARGET_CLASS } from '../../contract/a11y.js';
import type { DateAnswer, DateConfig } from './core.js';

const blankToNull = (text: string): string | null => (text === '' ? null : text);

export const DateRenderer = defineRenderer<DateConfig, DateAnswer>(
  ({ question, value, onChange, issues, ctx }: RendererProps<DateConfig, DateAnswer>): ReactNode => {
    const config = question.config;
    const invalid = issues.length > 0;
    const describedBy = [
      question.instruction === null ? undefined : ctx.ids.instructionId,
      invalid ? ctx.ids.errorId : undefined,
    ]
      .filter((id): id is string => id !== undefined)
      .join(' ');

    if (config.mode === 'date') {
      return (
        <input
          type="text"
          id={ctx.ids.groupId}
          className={`rs-date__input ${TOUCH_TARGET_CLASS}`}
          inputMode="numeric"
          autoComplete="off"
          maxLength={10}
          placeholder={ctx.pipe('qt.date.format_hint')}
          aria-labelledby={ctx.ids.labelId}
          aria-describedby={describedBy === '' ? undefined : describedBy}
          aria-required={question.required ? true : undefined}
          aria-invalid={invalid ? true : undefined}
          value={value?.date ?? ''}
          onChange={(event) =>
            onChange({ date: blankToNull(event.target.value), from: null, to: null })
          }
        />
      );
    }

    const from = value?.from ?? null;
    const to = value?.to ?? null;
    return (
      <div
        role="group"
        id={ctx.ids.groupId}
        aria-labelledby={ctx.ids.labelId}
        aria-describedby={describedBy === '' ? undefined : describedBy}
        aria-required={question.required ? true : undefined}
        aria-invalid={invalid ? true : undefined}
        className="rs-date rs-date--range"
      >
        <label className={`rs-date__end ${TOUCH_TARGET_CLASS}`} data-testid="date-from">
          <span>{ctx.pipe('qt.date.from')}</span>
          <input
            type="text"
            className="rs-date__input"
            inputMode="numeric"
            autoComplete="off"
            maxLength={10}
            placeholder={ctx.pipe('qt.date.format_hint')}
            value={from ?? ''}
            onChange={(event) =>
              onChange({ date: null, from: blankToNull(event.target.value), to })
            }
          />
        </label>
        <label className={`rs-date__end ${TOUCH_TARGET_CLASS}`} data-testid="date-to">
          <span>{ctx.pipe('qt.date.to')}</span>
          <input
            type="text"
            className="rs-date__input"
            inputMode="numeric"
            autoComplete="off"
            maxLength={10}
            placeholder={ctx.pipe('qt.date.format_hint')}
            value={to ?? ''}
            onChange={(event) =>
              onChange({ date: null, from, to: blankToNull(event.target.value) })
            }
          />
        </label>
      </div>
    );
  },
);

/** Studio editor. Patches only, inside the allowlist — see `single-select/view.tsx`. */
export function DateEditor({ question, patch, ctx }: EditorProps<DateConfig>): ReactNode {
  // `remove` for a cleared bound: "no minimum" and "minimum of the empty string" are different
  // things and the second one fails the config schema's pattern.
  const boundPatch = (path: string, raw: string): void =>
    patch([raw === '' ? { op: 'remove', path } : { op: 'add', path, value: raw }]);

  return (
    <div className="rs-editor rs-editor--date">
      <label>
        {ctx.t('editor.date_mode')}
        <select
          value={question.config.mode}
          onChange={(event) =>
            patch([{ op: 'replace', path: '/config/mode', value: event.target.value }])
          }
        >
          {(['date', 'range'] as const).map((mode) => (
            <option key={mode} value={mode}>
              {ctx.t(`editor.date_mode.${mode}`)}
            </option>
          ))}
        </select>
      </label>
      <label>
        {ctx.t('editor.min')}
        <input
          type="text"
          placeholder="YYYY-MM-DD"
          value={question.config.min ?? ''}
          onChange={(event) => boundPatch('/config/min', event.target.value)}
        />
      </label>
      <label>
        {ctx.t('editor.max')}
        <input
          type="text"
          placeholder="YYYY-MM-DD"
          value={question.config.max ?? ''}
          onChange={(event) => boundPatch('/config/max', event.target.value)}
        />
      </label>
    </div>
  );
}
