/**
 * `formatted_text` renderer and editor.
 *
 * Deliberately almost identical to `text`'s renderer, and the two things it does NOT add are the
 * point:
 *
 *  - **No `type="email"`.** That enrols the browser's own validity UI, which the server-side
 *    `validate` does not run — the client/server disagreement ADR-004's divergence metric exists to
 *    catch. `inputMode` gives the phone keyboard and nothing else.
 *  - **No `pattern` attribute.** The browser would then block submission on its own regex
 *    interpretation, which is not guaranteed to match the plugin's (flags, Unicode handling), so a
 *    respondent could be stopped by a rule the server would have passed — with no message the
 *    plugin controls. The format is checked in one place, in code that runs on both sides.
 *
 * `maxLength` mirrors the config so a respondent hits the limit while typing rather than at submit;
 * the codec truncates and `validate` reports, exactly as in `text`.
 */

import type { ReactNode } from 'react';
import { defineRenderer, type EditorProps, type RendererProps } from '../../contract/view.js';
import { TOUCH_TARGET_CLASS } from '../../contract/a11y.js';
import { TEXT_FORMATS, type FormattedTextAnswer, type FormattedTextConfig } from './core.js';

export const FormattedTextRenderer = defineRenderer<FormattedTextConfig, FormattedTextAnswer>(
  ({ question, value, onChange, issues, ctx }: RendererProps<FormattedTextConfig, FormattedTextAnswer>): ReactNode => {
    const config = question.config;
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
        inputMode={config.inputMode ?? 'text'}
        id={ctx.ids.groupId}
        className={`rs-formatted-text rs-formatted-text--${config.format} ${TOUCH_TARGET_CLASS}`}
        aria-labelledby={ctx.ids.labelId}
        aria-describedby={describedBy === '' ? undefined : describedBy}
        aria-required={question.required ? true : undefined}
        aria-invalid={invalid ? true : undefined}
        maxLength={config.maxLen}
        placeholder={
          config.placeholderKey === undefined || config.placeholderKey === null
            ? undefined
            : ctx.pipe(config.placeholderKey)
        }
        value={value?.text ?? ''}
        onChange={(event) => onChange({ text: event.target.value })}
      />
    );
  },
);

/** The studio editor. Patches only — see `single-select/view.tsx` for why that is the contract. */
export function FormattedTextEditor({ question, patch, ctx }: EditorProps<FormattedTextConfig>): ReactNode {
  const config = question.config;
  return (
    <div className="rs-editor rs-editor--formatted-text">
      <label>
        {ctx.t('editor.formatted_text.format')}
        <select
          value={config.format}
          onChange={(event) =>
            patch([{ op: 'replace', path: '/config/format', value: event.target.value }])
          }
        >
          {TEXT_FORMATS.map((format) => (
            <option key={format} value={format}>
              {ctx.t(`editor.formatted_text.format.${format}`)}
            </option>
          ))}
        </select>
      </label>
      {/* Shown only for `custom`: for a named format the authored pattern is ignored, and offering
          the field anyway is how an author comes to believe they have changed the rule. */}
      {config.format === 'custom' && (
        <label>
          {ctx.t('editor.formatted_text.pattern')}
          <input
            type="text"
            value={config.pattern ?? ''}
            onChange={(event) => {
              const next = event.target.value;
              patch([
                next === ''
                  ? { op: 'remove', path: '/config/pattern' }
                  : { op: 'add', path: '/config/pattern', value: next },
              ]);
            }}
          />
        </label>
      )}
      <label>
        {ctx.t('editor.max_len')}
        <input
          type="number"
          min={1}
          max={4000}
          value={config.maxLen}
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
        {ctx.t('editor.formatted_text.normalize')}
        <select
          value={config.normalize ?? 'trim'}
          onChange={(event) =>
            patch([{ op: 'replace', path: '/config/normalize', value: event.target.value }])
          }
        >
          {(['none', 'trim', 'lower'] as const).map((mode) => (
            <option key={mode} value={mode}>
              {ctx.t(`editor.formatted_text.normalize.${mode}`)}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
