/**
 * `consent` renderer and editor.
 *
 * One checkbox whose *label is the statement* — the terms and the control are one element, so a
 * screen reader announcing the checkbox reads what is being agreed to, not "checkbox, Q7". The
 * wrapping `<label>` does the naming (adding `aria-labelledby` would override it and re-point
 * the checkbox at the question's short label, which is exactly the wrong text to consent to);
 * `aria-describedby` carries the instruction and the error through `ctx.ids`, and
 * `aria-invalid`/`aria-required` sit on the input itself.
 *
 * Unchecking stores `false`, never `null`: once the respondent has touched the box, "declined"
 * is what they said, and collapsing it back to "untouched" would erase the one distinction
 * `declineBehavior: 'record'` exists to keep. `validate` — not this file — decides whether a
 * `false` passes; the UI must let the respondent build every state the codec can store
 * (`multi-select/view.tsx`'s rule, inverted: no state the UI allows may be one `validate`
 * cannot explain).
 */

import type { ReactNode } from 'react';
import { defineRenderer, type EditorProps, type RendererProps } from '../../contract/view.js';
import { TOUCH_TARGET_CLASS } from '../../contract/a11y.js';
import type { ConsentAnswer, ConsentConfig } from './core.js';

export const ConsentRenderer = defineRenderer<ConsentConfig, ConsentAnswer>(
  ({ question, value, onChange, issues, ctx }: RendererProps<ConsentConfig, ConsentAnswer>): ReactNode => {
    const invalid = issues.length > 0;
    const describedBy = [
      question.instruction === null ? undefined : ctx.ids.instructionId,
      invalid ? ctx.ids.errorId : undefined,
    ]
      .filter((id): id is string => id !== undefined)
      .join(' ');

    return (
      <div id={ctx.ids.groupId} className="rs-consent">
        <label className={`rs-consent__item ${TOUCH_TARGET_CLASS}`} data-testid="consent-statement">
          <input
            type="checkbox"
            checked={value?.agreed === true}
            aria-describedby={describedBy === '' ? undefined : describedBy}
            aria-required={question.required ? true : undefined}
            aria-invalid={invalid ? true : undefined}
            onChange={(event) => onChange({ agreed: event.target.checked })}
          />
          <span className="rs-consent__statement">{ctx.pipe(question.config.statementKey)}</span>
        </label>
      </div>
    );
  },
);

/** Studio editor. Patches only, inside the allowlist — see `single-select/view.tsx`. */
export function ConsentEditor({ question, patch, ctx }: EditorProps<ConsentConfig>): ReactNode {
  return (
    <div className="rs-editor rs-editor--consent">
      <label>
        {ctx.t('editor.consent_statement_key')}
        <input
          type="text"
          value={question.config.statementKey}
          onChange={(event) =>
            patch([{ op: 'replace', path: '/config/statementKey', value: event.target.value }])
          }
        />
      </label>
      <label>
        {ctx.t('editor.consent_decline_behavior')}
        <select
          value={question.config.declineBehavior}
          onChange={(event) =>
            patch([{ op: 'replace', path: '/config/declineBehavior', value: event.target.value }])
          }
        >
          {(['block', 'record'] as const).map((behavior) => (
            <option key={behavior} value={behavior}>
              {ctx.t(`editor.consent_decline_behavior.${behavior}`)}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
