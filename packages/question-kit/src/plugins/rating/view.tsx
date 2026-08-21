/**
 * `rating` renderer and editor.
 *
 * The same RTL rule nps's header spells out governs everything here: **the track reverses, the
 * codes do not.** In Arabic the low end of the scale sits on the right and still stores its own
 * code; `ArrowRight` means "towards whichever anchor is next in reading order", never "towards
 * the higher code". Getting that backwards flips every satisfied respondent into a dissatisfied
 * one, invisibly, in exactly the markets nobody on the team reads.
 *
 * Stars are radios wearing a costume. The glyph is `aria-hidden` decoration over an ordinary
 * radio whose accessible name is the point's authored label, so the keyboard path (arrows move
 * the rating) and the screen-reader path (labels, one tab stop) are the radiogroup pattern the
 * a11y contract declares — a hover-to-fill star widget would be pointer-dependent, which the
 * contract forbids.
 */

import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { defineRenderer, type EditorProps, type RendererProps } from '../../contract/view.js';
import { TOUCH_TARGET_CLASS } from '../../contract/a11y.js';
import { itemCode } from '../../contract/items.js';
import type { RatingAnswer, RatingConfig } from './core.js';

/** Which way `ArrowLeft`/`ArrowRight` move, given the reading direction. */
function horizontalStep(key: string, dir: 'ltr' | 'rtl'): number {
  const forward = dir === 'rtl' ? 'ArrowLeft' : 'ArrowRight';
  const back = dir === 'rtl' ? 'ArrowRight' : 'ArrowLeft';
  if (key === forward) return 1;
  if (key === back) return -1;
  return 0;
}

function verticalStep(key: string): number {
  if (key === 'ArrowDown') return 1;
  if (key === 'ArrowUp') return -1;
  return 0;
}

export const RatingRenderer = defineRenderer<RatingConfig, RatingAnswer>(
  ({ question, value, onChange, issues, ctx }: RendererProps<RatingConfig, RatingAnswer>): ReactNode => {
    const config = question.config;
    // Through `ctx.order` like every choice control (ADR-006): a scale is rarely randomized, but
    // scale-reversal designs exist, and the seeded PRNG is the only ordering a renderer may use.
    const items = ctx.order('options', question.options).filter((item) => item.visible);
    const selected = value?.code ?? null;
    const invalid = issues.length > 0;
    const describedBy = [
      question.instruction === null ? undefined : ctx.ids.instructionId,
      invalid ? ctx.ids.errorId : undefined,
    ]
      .filter((id): id is string => id !== undefined)
      .join(' ');

    const selectedIndex = items.findIndex((item) => itemCode(item) === selected);
    // Roving tabindex: the selected point is the tab stop, or the first enabled one — one stop
    // for the group, per the ARIA radiogroup pattern.
    const tabStop = selectedIndex >= 0 ? selectedIndex : items.findIndex((item) => item.enabled);

    const select = (event: ReactKeyboardEvent<HTMLDivElement>, index: number): void => {
      const target = items[index];
      if (target === undefined || !target.enabled) return;
      event.preventDefault();
      onChange({ code: itemCode(target) });
      focusPoint(event.currentTarget, index);
    };

    const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
      if (event.key === 'Home') return select(event, 0);
      if (event.key === 'End') return select(event, items.length - 1);
      const step = horizontalStep(event.key, ctx.dir) || verticalStep(event.key);
      if (step === 0 || items.length === 0) return;
      const from = selectedIndex >= 0 ? selectedIndex : 0;
      // Skip disabled points rather than landing on them: a masked point is disabled in the
      // accessibility tree (F §8), so stopping there would be a dead keystroke.
      let next = from;
      for (let i = 0; i < items.length; i += 1) {
        next = (next + step + items.length) % items.length;
        if (items[next]?.enabled === true) break;
      }
      select(event, next);
    };

    return (
      <div
        role="radiogroup"
        id={ctx.ids.groupId}
        aria-labelledby={ctx.ids.labelId}
        aria-describedby={describedBy === '' ? undefined : describedBy}
        aria-required={question.required ? true : undefined}
        aria-invalid={invalid ? true : undefined}
        className={`rs-rating rs-rating--${config.display}`}
        onKeyDown={onKeyDown}
      >
        {/* Anchors sit inside the group so a screen reader reads them with it. Ordinary text: the
            visual reversal in RTL is the theme's job, through logical CSS. */}
        {config.lowLabelKey !== null && (
          <span className="rs-rating__anchor rs-rating__anchor--low">{ctx.pipe(config.lowLabelKey)}</span>
        )}
        {items.map((item, index) => (
          <label key={item.ref} className={`rs-rating__point ${TOUCH_TARGET_CLASS}`} data-testid={`opt-${item.ref}`}>
            <input
              type="radio"
              name={ctx.ids.groupId}
              value={String(itemCode(item))}
              checked={itemCode(item) === selected}
              disabled={!item.enabled}
              tabIndex={index === tabStop ? 0 : -1}
              onChange={() => onChange({ code: itemCode(item) })}
            />
            {config.display === 'stars' && (
              /* Decoration only. The label span below is the accessible name; a star that WAS the
                 name would announce "star star star" for every point of every scale. */
              <span className="rs-rating__star" aria-hidden="true">
                ★
              </span>
            )}
            {/* Always rendered, whatever the display: the authored label is the radio's accessible
                name, and the theme decides whether it is also visible ('radio') or visually hidden
                behind the star/number ('stars'/'buttons'). */}
            <span className="rs-rating__label">{ctx.pipe(item.labelKey)}</span>
            {config.showNumbers && (
              /* `aria-hidden`: the label already names the point, and "4, somewhat satisfied,
                 4 of 5" reads the same number twice. `item.code`, not the array index — the
                 number shown must be the code stored. */
              <span className="rs-rating__number" aria-hidden="true">
                {String(item.code)}
              </span>
            )}
          </label>
        ))}
        {config.highLabelKey !== null && (
          <span className="rs-rating__anchor rs-rating__anchor--high">{ctx.pipe(config.highLabelKey)}</span>
        )}
      </div>
    );
  },
);

/** Focus follows selection in a radiogroup. DOM access in a handler, never during render (F §8). */
function focusPoint(group: HTMLElement, index: number): void {
  const inputs = group.querySelectorAll<HTMLInputElement>('input[type="radio"]');
  inputs.item(index)?.focus();
}

/**
 * The studio editor. Patches only, inside the allowlist — see `single-select/view.tsx`. The scale
 * points themselves are edited through studio's shared item list; this panel owns only the
 * plugin's config.
 */
export function RatingEditor({ question, patch, ctx }: EditorProps<RatingConfig>): ReactNode {
  // An emptied anchor field is `null`, never `''`: the config models "no anchor" as null, and an
  // empty-string label key would resolve to a missing-translation marker at runtime.
  const anchorPatch = (path: string, raw: string): void =>
    patch([{ op: 'replace', path, value: raw === '' ? null : raw }]);

  return (
    <div className="rs-editor rs-editor--rating">
      <label>
        {ctx.t('editor.display')}
        <select
          value={question.config.display}
          onChange={(event) =>
            patch([{ op: 'replace', path: '/config/display', value: event.target.value }])
          }
        >
          {(['radio', 'stars', 'buttons'] as const).map((display) => (
            <option key={display} value={display}>
              {ctx.t(`editor.display.${display}`)}
            </option>
          ))}
        </select>
      </label>
      <label>
        {ctx.t('editor.rating_low_anchor')}
        <input
          type="text"
          value={question.config.lowLabelKey ?? ''}
          onChange={(event) => anchorPatch('/config/lowLabelKey', event.target.value)}
        />
      </label>
      <label>
        {ctx.t('editor.rating_high_anchor')}
        <input
          type="text"
          value={question.config.highLabelKey ?? ''}
          onChange={(event) => anchorPatch('/config/highLabelKey', event.target.value)}
        />
      </label>
      <label>
        {ctx.t('editor.show_numbers')}
        <input
          type="checkbox"
          checked={question.config.showNumbers}
          onChange={(event) =>
            patch([{ op: 'replace', path: '/config/showNumbers', value: event.target.checked }])
          }
        />
      </label>
    </div>
  );
}
