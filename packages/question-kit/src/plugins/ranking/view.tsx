/**
 * `ranking` renderer and editor.
 *
 * **The rank selects are the control; the drag list is a skin over them.** Both displays render the
 * same `select` per item, and `display: 'drag'` only adds a grab handle and reorders the visual
 * list. That is not a fallback grudgingly added for accessibility — it is the design, and it is why
 * the a11y contract can name `ranking-rank-select` as the keyboard alternative and mean it. A
 * drag-only widget with a hidden "accessible mode" is two implementations of one question, and the
 * one nobody demos is the one that breaks.
 *
 * **Assigning a rank displaces rather than duplicates.** Picking rank 2 for an item that another
 * item already holds swaps them, so the state the widget can produce is always a dense 1..n
 * ranking — the same invariant the codec enforces. Letting two items share a rank and reporting it
 * afterwards would put the respondent in a state they cannot see the way out of.
 *
 * **Nothing here names a side.** The drag affordance is a handle glyph and ordering is DOM order,
 * so RTL is the page's direction and not this file's problem (F §8).
 */

import type { ReactNode } from 'react';
import { defineRenderer, type EditorProps, type RendererProps } from '../../contract/view.js';
import { TOUCH_TARGET_CLASS } from '../../contract/a11y.js';
import type { RankingAnswer, RankingConfig } from './core.js';

export const RankingRenderer = defineRenderer<RankingConfig, RankingAnswer>(
  ({ question, value, onChange, issues, ctx }: RendererProps<RankingConfig, RankingAnswer>): ReactNode => {
    const config = question.config;
    const items = question.options.filter((option) => option.visible);
    const ranks = value?.ranks ?? {};
    const invalid = issues.length > 0;
    const slots = Math.min(config.max_ranked ?? items.length, items.length);

    const describedBy = [
      question.instruction === null ? undefined : ctx.ids.instructionId,
      invalid ? ctx.ids.errorId : undefined,
    ]
      .filter((id): id is string => id !== undefined)
      .join(' ');

    /**
     * Assign `rank` to `ref`, displacing whoever holds it.
     *
     * Swap rather than shift: shifting renumbers every item below the insertion point, so a
     * respondent correcting one choice watches the rest of their answers move. A swap changes
     * exactly the two items they were looking at.
     */
    const assign = (ref: string, rank: number | null): void => {
      const next: Record<string, number> = { ...ranks };
      const previous = next[ref];
      if (rank === null) {
        delete next[ref];
        // Close the gap the removal left, so the state stays a dense 1..n ranking.
        if (previous !== undefined) {
          for (const [other, otherRank] of Object.entries(next)) {
            if (otherRank > previous) next[other] = otherRank - 1;
          }
        }
        onChange({ ranks: next });
        return;
      }
      const holder = Object.entries(next).find(([other, r]) => r === rank && other !== ref);
      if (holder && previous !== undefined) {
        next[holder[0]] = previous; // a true swap: both items had a rank
      } else if (holder) {
        delete next[holder[0]]; // the newcomer takes the slot; the holder becomes unranked
      }
      next[ref] = rank;
      onChange({ ranks: next });
    };

    // Visual order: ranked items first in rank order, then the unranked in authored order. This is
    // what makes `display: 'drag'` legible without any positioning, and it is harmless for 'list'.
    const ordered =
      config.display === 'drag'
        ? [...items].sort((a, b) => (ranks[a.ref] ?? Infinity) - (ranks[b.ref] ?? Infinity))
        : items;

    return (
      <div
        role="group"
        id={ctx.ids.groupId}
        aria-labelledby={ctx.ids.labelId}
        aria-describedby={describedBy === '' ? undefined : describedBy}
        aria-required={question.required ? true : undefined}
        aria-invalid={invalid ? true : undefined}
        className={`rs-ranking rs-ranking--${config.display ?? 'list'}`}
      >
        {ordered.map((itemOption) => {
          const rank = ranks[itemOption.ref] ?? null;
          return (
            <div
              key={itemOption.ref}
              // No `role="option"`: the row is not activatable, the select inside it is. Claiming
              // an option role would promise a click target that does not exist — see the a11y
              // note in `core.ts`.
              className="rs-ranking__item"
              data-ranked={rank === null ? undefined : 'true'}
              data-testid={`rank-item-${itemOption.ref}`}
            >
              {config.display === 'drag' && (
                <span className="rs-ranking__handle" aria-hidden="true">
                  ⠿
                </span>
              )}
              <span className="rs-ranking__label">{ctx.pipe(itemOption.labelKey)}</span>
              <select
                className={`rs-ranking__rank ${TOUCH_TARGET_CLASS}`}
                data-testid="ranking-rank-select"
                aria-label={`${ctx.pipe(itemOption.labelKey)} — ${ctx.pipe('common.rank')}`}
                disabled={!itemOption.enabled}
                value={rank === null ? '' : String(rank)}
                onChange={(event) => {
                  const raw = event.target.value;
                  assign(itemOption.ref, raw === '' ? null : Number(raw));
                }}
              >
                <option value="">{ctx.pipe('common.unranked')}</option>
                {Array.from({ length: slots }, (_, i) => i + 1).map((slot) => (
                  <option key={slot} value={String(slot)}>
                    {String(slot)}
                  </option>
                ))}
              </select>
            </div>
          );
        })}
      </div>
    );
  },
);

/** Studio editor. Patches only, inside the allowlist — see `single-select/view.tsx`. */
export function RankingEditor({ question, patch, ctx }: EditorProps<RankingConfig>): ReactNode {
  const config = question.config;
  return (
    <div className="rs-editor rs-editor--ranking">
      <label>
        {ctx.t('editor.display')}
        <select
          value={config.display ?? 'list'}
          onChange={(event) =>
            patch([{ op: 'replace', path: '/config/display', value: event.target.value }])
          }
        >
          {(['list', 'drag'] as const).map((display) => (
            <option key={display} value={display}>
              {ctx.t(`editor.ranking.display.${display}`)}
            </option>
          ))}
        </select>
      </label>
      <label>
        {ctx.t('editor.ranking.max_ranked')}
        <input
          type="number"
          min={1}
          value={config.max_ranked ?? ''}
          onChange={(event) => {
            const raw = event.target.valueAsNumber;
            // Optional in config, so an emptied field is `remove`: "rank all of them" and "rank
            // exactly N" are different questions, and `Number('')` is 0.
            patch([
              Number.isFinite(raw) && raw >= 1
                ? { op: 'add', path: '/config/max_ranked', value: raw }
                : { op: 'remove', path: '/config/max_ranked' },
            ]);
          }}
        />
      </label>
    </div>
  );
}
