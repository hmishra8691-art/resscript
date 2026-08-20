/**
 * `nps` renderer and editor.
 *
 * Eleven radio inputs, an anchor label at each end, and one RTL subtlety that is the whole reason
 * F §8 spells it out: **the track reverses, the codes do not.** In Arabic the 0 sits on the right
 * and still stores 0. Getting that backwards produces a dataset where every promoter is recorded
 * as a detractor, and nothing in the pipeline can detect it after the fact.
 */

import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { defineRenderer, type EditorProps, type RendererProps } from '../../contract/view.js';
import { TOUCH_TARGET_CLASS } from '../../contract/a11y.js';
import { NPS_MAX_SCORE, NPS_MIN_SCORE, type NpsAnswer, type NpsConfig } from './core.js';

const SCORES: readonly number[] = Array.from(
  { length: NPS_MAX_SCORE - NPS_MIN_SCORE + 1 },
  (_unused, index) => NPS_MIN_SCORE + index,
);

export const NpsRenderer = defineRenderer<NpsConfig, NpsAnswer>(
  ({ question, value, onChange, issues, ctx }: RendererProps<NpsConfig, NpsAnswer>): ReactNode => {
    const score = value?.score ?? null;
    const invalid = issues.length > 0;
    const describedBy = [
      question.instruction === null ? undefined : ctx.ids.instructionId,
      invalid ? ctx.ids.errorId : undefined,
    ]
      .filter((id): id is string => id !== undefined)
      .join(' ');
    const tabStop = score === null ? NPS_MIN_SCORE : score;

    const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
      // Direction-aware: `ArrowRight` means "towards the high anchor", which is leftwards in RTL.
      // The score is unaffected by which side of the screen it sits on.
      const forward = ctx.dir === 'rtl' ? 'ArrowLeft' : 'ArrowRight';
      const back = ctx.dir === 'rtl' ? 'ArrowRight' : 'ArrowLeft';
      let next: number | null = null;
      if (event.key === forward) next = (score ?? NPS_MIN_SCORE - 1) + 1;
      else if (event.key === back) next = (score ?? NPS_MAX_SCORE + 1) - 1;
      else if (event.key === 'Home') next = NPS_MIN_SCORE;
      else if (event.key === 'End') next = NPS_MAX_SCORE;
      if (next === null) return;
      event.preventDefault();
      const clamped = Math.min(NPS_MAX_SCORE, Math.max(NPS_MIN_SCORE, next));
      onChange({ score: clamped });
      event.currentTarget
        .querySelectorAll<HTMLInputElement>('input[type="radio"]')
        .item(clamped - NPS_MIN_SCORE)
        ?.focus();
    };

    return (
      <div
        role="radiogroup"
        id={ctx.ids.groupId}
        aria-labelledby={ctx.ids.labelId}
        aria-describedby={describedBy === '' ? undefined : describedBy}
        aria-required={question.required ? true : undefined}
        aria-invalid={invalid ? true : undefined}
        className={`rs-nps rs-nps--${question.config.display}`}
        onKeyDown={onKeyDown}
      >
        {/* Anchors are inside the group so a screen reader reads them with it, and they are
            ordinary text: the visual reversal in RTL is the theme's job, through logical CSS. */}
        <span className="rs-nps__anchor rs-nps__anchor--low">{ctx.pipe(question.config.lowLabelKey)}</span>
        {SCORES.map((candidate) => (
          <label
            key={candidate}
            className={`rs-nps__point ${TOUCH_TARGET_CLASS}`}
            data-testid={`nps-${candidate}`}
          >
            <input
              type="radio"
              name={ctx.ids.groupId}
              value={String(candidate)}
              checked={score === candidate}
              tabIndex={candidate === tabStop ? 0 : -1}
              onChange={() => onChange({ score: candidate })}
            />
            <span>{String(candidate)}</span>
          </label>
        ))}
        <span className="rs-nps__anchor rs-nps__anchor--high">{ctx.pipe(question.config.highLabelKey)}</span>
      </div>
    );
  },
);

export function NpsEditor({ question, patch, ctx }: EditorProps<NpsConfig>): ReactNode {
  return (
    <div className="rs-editor rs-editor--nps">
      <label>
        {ctx.t('editor.nps_low_anchor')}
        <input
          type="text"
          value={question.config.lowLabelKey}
          onChange={(event) =>
            patch([{ op: 'replace', path: '/config/lowLabelKey', value: event.target.value }])
          }
        />
      </label>
      <label>
        {ctx.t('editor.nps_high_anchor')}
        <input
          type="text"
          value={question.config.highLabelKey}
          onChange={(event) =>
            patch([{ op: 'replace', path: '/config/highLabelKey', value: event.target.value }])
          }
        />
      </label>
      {/* The band table is deliberately not editable: "detractor" means 0–6 by definition, and a
          survey that redefines it has not measured NPS. See `core.ts`. */}
      <p className="rs-editor__note">{ctx.t('editor.nps_bands_fixed')}</p>
    </div>
  );
}
