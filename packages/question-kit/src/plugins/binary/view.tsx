/**
 * `binary` renderer and editor.
 *
 * All three displays render the *same two radios* and differ only in class, because the display
 * is a styling fact and the semantics are not: a 'toggle' that switched to `role="switch"` would
 * change the announced pattern ("on/off" of one thing) for a question that has two labelled
 * answers — and screen-reader users would hear a different question than sighted ones read.
 *
 * Keyboard: any arrow moves to the other option, but the horizontal pair still goes through
 * `ctx.dir` — with two options "the other one" hides the bug, right up until one option is
 * disabled by a mask and the walk has to know which way it is stepping (F §8).
 */

import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { defineRenderer, type EditorProps, type RendererProps } from '../../contract/view.js';
import { TOUCH_TARGET_CLASS } from '../../contract/a11y.js';
import { itemCode } from '../../contract/items.js';
import type { BinaryAnswer, BinaryConfig } from './core.js';

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

export const BinaryRenderer = defineRenderer<BinaryConfig, BinaryAnswer>(
  ({ question, value, onChange, issues, ctx }: RendererProps<BinaryConfig, BinaryAnswer>): ReactNode => {
    // Through `ctx.order` even though a binary is rarely randomized: the seeded PRNG is the only
    // ordering a renderer may consult (ADR-006), and "rarely" is not "never" — yea-saying bias
    // studies rotate yes/no deliberately.
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
    // Roving tabindex: the selected option is the tab stop, or the first enabled one — one stop
    // for the group, per the ARIA radiogroup pattern.
    const tabStop = selectedIndex >= 0 ? selectedIndex : items.findIndex((item) => item.enabled);

    const select = (event: ReactKeyboardEvent<HTMLDivElement>, index: number): void => {
      const target = items[index];
      if (target === undefined || !target.enabled) return;
      event.preventDefault();
      onChange({ code: itemCode(target) });
      focusOption(event.currentTarget, index);
    };

    const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
      if (event.key === 'Home') return select(event, 0);
      if (event.key === 'End') return select(event, items.length - 1);
      const step = horizontalStep(event.key, ctx.dir) || verticalStep(event.key);
      if (step === 0 || items.length === 0) return;
      const from = selectedIndex >= 0 ? selectedIndex : 0;
      // Skip disabled options rather than landing on them: a disabled option is disabled in the
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
        className={`rs-binary rs-binary--${question.config.display}`}
        onKeyDown={onKeyDown}
      >
        {items.map((item, index) => (
          <label key={item.ref} className={`rs-binary__item ${TOUCH_TARGET_CLASS}`} data-testid={`opt-${item.ref}`}>
            <input
              type="radio"
              name={ctx.ids.groupId}
              value={String(itemCode(item))}
              checked={itemCode(item) === selected}
              disabled={!item.enabled}
              tabIndex={index === tabStop ? 0 : -1}
              onChange={() => onChange({ code: itemCode(item) })}
            />
            <span>{ctx.pipe(item.labelKey)}</span>
          </label>
        ))}
      </div>
    );
  },
);

/** Focus follows selection in a radiogroup. DOM access in a handler, never during render (F §8). */
function focusOption(group: HTMLElement, index: number): void {
  const inputs = group.querySelectorAll<HTMLInputElement>('input[type="radio"]');
  inputs.item(index)?.focus();
}

/**
 * The studio editor. Patches only, inside the allowlist — see `single-select/view.tsx` for why an
 * editor never returns a whole question. The two options themselves are edited through studio's
 * shared item list, not here: their labels and codes are the client's data, not plugin config.
 */
export function BinaryEditor({ question, patch, ctx }: EditorProps<BinaryConfig>): ReactNode {
  return (
    <div className="rs-editor rs-editor--binary">
      <label>
        {ctx.t('editor.display')}
        <select
          value={question.config.display}
          onChange={(event) =>
            patch([{ op: 'replace', path: '/config/display', value: event.target.value }])
          }
        >
          {(['buttons', 'toggle', 'radio'] as const).map((display) => (
            <option key={display} value={display}>
              {ctx.t(`editor.display.${display}`)}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
