/**
 * `multi_select` renderer and editor — Deliverable F §8's rules applied to a checkbox group.
 *
 * The one behaviour worth naming: **the exclusive option clears the others, and the others clear
 * it** (schema §5.1's `exclusive`). Doing it in the renderer rather than only in `validate` means
 * the respondent never sees an error for a state the UI let them build — and `validate` still
 * checks it, because the server is the authority (ADR-004) and a resumed session can arrive in a
 * state no UI produced.
 */

import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { defineRenderer, type EditorProps, type RendererProps } from '../../contract/view.js';
import { TOUCH_TARGET_CLASS } from '../../contract/a11y.js';
import { itemCode, type ResolvedItem } from '../../contract/items.js';
import type { OptionCode } from '../../contract/items.js';
import { compareCodes } from '../../contract/variables.js';
import type { MultiSelectAnswer, MultiSelectConfig } from './core.js';

function nextSelection(
  item: ResolvedItem,
  items: readonly ResolvedItem[],
  current: readonly OptionCode[],
): readonly OptionCode[] {
  const code = itemCode(item);
  const selected = new Set(current);
  if (selected.has(code)) {
    selected.delete(code);
  } else if (item.exclusive === true) {
    // "None of these" is the answer, not one of the answers.
    return [code];
  } else {
    for (const other of items) {
      if (other.exclusive === true) selected.delete(itemCode(other));
    }
    selected.add(code);
  }
  return [...selected].sort(compareCodes);
}

export const MultiSelectRenderer = defineRenderer<MultiSelectConfig, MultiSelectAnswer>(
  ({ question, value, onChange, issues, ctx }: RendererProps<MultiSelectConfig, MultiSelectAnswer>): ReactNode => {
    const items = ctx.order('options', question.options).filter((item) => item.visible);
    const selected = value?.codes ?? [];
    const otherTexts = value?.otherTexts ?? {};
    const invalid = issues.length > 0;
    const describedBy = [
      question.instruction === null ? undefined : ctx.ids.instructionId,
      invalid ? ctx.ids.errorId : undefined,
    ]
      .filter((id): id is string => id !== undefined)
      .join(' ');

    // One tab stop for the group (F §8). The first selected box is the stop so that returning to a
    // partially answered question puts the caret where the respondent left it.
    const firstSelected = items.findIndex((item) => selected.includes(itemCode(item)));
    const tabStop = firstSelected >= 0 ? firstSelected : items.findIndex((item) => item.enabled);

    const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
      // Arrows *move focus* in a checkbox group; they do not toggle. Toggling on arrow would make
      // a keyboard user select everything they scroll past.
      const forward = ctx.dir === 'rtl' ? 'ArrowLeft' : 'ArrowRight';
      const back = ctx.dir === 'rtl' ? 'ArrowRight' : 'ArrowLeft';
      const step =
        event.key === forward || event.key === 'ArrowDown'
          ? 1
          : event.key === back || event.key === 'ArrowUp'
            ? -1
            : 0;
      const boxes = event.currentTarget.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
      if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        boxes.item(event.key === 'Home' ? 0 : boxes.length - 1)?.focus();
        return;
      }
      if (step === 0 || boxes.length === 0) return;
      event.preventDefault();
      const active = [...boxes].findIndex((box) => box === document.activeElement);
      const from = active >= 0 ? active : Math.max(tabStop, 0);
      boxes.item((from + step + boxes.length) % boxes.length)?.focus();
    };

    return (
      <div
        role="group"
        id={ctx.ids.groupId}
        aria-labelledby={ctx.ids.labelId}
        aria-describedby={describedBy === '' ? undefined : describedBy}
        aria-required={question.required ? true : undefined}
        aria-invalid={invalid ? true : undefined}
        className={`rs-choice rs-choice--${question.config.display} rs-cols-${question.config.columns}`}
        onKeyDown={onKeyDown}
      >
        {items.map((item, index) => {
          const checked = selected.includes(itemCode(item));
          return (
            <div key={item.ref} className="rs-choice__row">
              <label className={`rs-choice__item ${TOUCH_TARGET_CLASS}`} data-testid={`opt-${item.ref}`}>
                <input
                  type="checkbox"
                  value={String(itemCode(item))}
                  checked={checked}
                  disabled={!item.enabled}
                  tabIndex={index === tabStop ? 0 : -1}
                  onChange={() =>
                    onChange({ codes: nextSelection(item, items, selected), otherTexts })
                  }
                />
                <span>{ctx.pipe(item.labelKey)}</span>
              </label>
              {question.config.other.enabled && item.otherSpecify === true && checked && (
                <input
                  type="text"
                  className={TOUCH_TARGET_CLASS}
                  aria-label={ctx.pipe('common.other_specify')}
                  maxLength={question.config.other.maxLen}
                  value={otherTexts[item.ref] ?? ''}
                  onChange={(event) =>
                    onChange({
                      codes: selected,
                      otherTexts: { ...otherTexts, [item.ref]: event.target.value },
                    })
                  }
                />
              )}
            </div>
          );
        })}
      </div>
    );
  },
);

export function MultiSelectEditor({ question, patch, ctx }: EditorProps<MultiSelectConfig>): ReactNode {
  return (
    <div className="rs-editor rs-editor--multi-select">
      <label>
        {ctx.t('editor.min_selected')}
        <input
          type="number"
          min={0}
          value={question.config.minSelected}
          onChange={(event) =>
            patch([
              {
                op: 'replace',
                path: '/config/minSelected',
                // `Number.isFinite` rather than a bare cast: an empty input yields `''`, and
                // `Number('')` is 0 — which would silently rewrite the author's floor.
                value: Number.isFinite(event.target.valueAsNumber) ? event.target.valueAsNumber : 0,
              },
            ])
          }
        />
      </label>
      <label>
        {ctx.t('editor.max_selected')}
        <input
          type="number"
          min={0}
          value={question.config.maxSelected}
          onChange={(event) =>
            patch([
              {
                op: 'replace',
                path: '/config/maxSelected',
                value: Number.isFinite(event.target.valueAsNumber) ? event.target.valueAsNumber : 0,
              },
            ])
          }
        />
      </label>
      <label>
        {ctx.t('editor.other_enabled')}
        <input
          type="checkbox"
          checked={question.config.other.enabled}
          onChange={(event) =>
            patch([{ op: 'replace', path: '/config/other/enabled', value: event.target.checked }])
          }
        />
      </label>
    </div>
  );
}
