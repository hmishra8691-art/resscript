/**
 * `single_select` renderer and editor — Deliverable F §2 and §8.
 *
 * Everything in here is a contract term rather than a styling choice:
 *
 *  - **One tab stop.** The group carries a roving `tabindex`; a 60-option list that is 60 tab
 *    stops is technically conformant and practically unusable (F §8).
 *  - **Arrow keys go through `ctx.dir`.** Mapping `ArrowRight` to "next" unconditionally is the
 *    single most common RTL bug in survey instruments, and it is invisible to an LTR reviewer.
 *  - **No physical CSS.** Layout is class-driven (`rs-choice--horizontal`), so the theme layer
 *    owns direction with logical properties. No inline `marginLeft`, ever.
 *  - **Codes stay attached to labels, not to positions.** The value written is `itemCode(option)`,
 *    so an Arabic respondent reading right-to-left still stores 1 for the same label (F §8).
 */

import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { defineRenderer, type EditorProps, type RendererProps } from '../../contract/view.js';
import { TOUCH_TARGET_CLASS } from '../../contract/a11y.js';
import { itemCode, type ResolvedItem } from '../../contract/items.js';
import type { SingleSelectAnswer, SingleSelectConfig } from './core.js';

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

export const SingleSelectRenderer = defineRenderer<SingleSelectConfig, SingleSelectAnswer>(
  ({ question, value, onChange, issues, ctx }: RendererProps<SingleSelectConfig, SingleSelectAnswer>): ReactNode => {
    // Order comes from the seeded PRNG (ADR-006). Never Math.random, never a local shuffle: a
    // replayed session has to reproduce what the respondent actually saw.
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
    // Roving tabindex: the selected option is the tab stop, or the first enabled one when nothing
    // is selected yet — that is the ARIA radiogroup pattern, and it is what makes the group one
    // stop instead of n.
    const tabStop = selectedIndex >= 0 ? selectedIndex : items.findIndex((item) => item.enabled);

    const move = (event: ReactKeyboardEvent<HTMLDivElement>, step: number): void => {
      if (step === 0 || items.length === 0) return;
      event.preventDefault();
      const from = selectedIndex >= 0 ? selectedIndex : 0;
      let next = from;
      // Skip disabled options rather than landing on them: a disabled option is disabled in the
      // accessibility tree (F §8), so stopping there would be a dead keystroke.
      for (let i = 0; i < items.length; i += 1) {
        next = (next + step + items.length) % items.length;
        if (items[next]?.enabled === true) break;
      }
      const target = items[next];
      if (target === undefined) return;
      onChange({ code: itemCode(target), otherText: value?.otherText ?? null });
      focusOption(event.currentTarget, next);
    };

    const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
      if (event.key === 'Home' || event.key === 'End') {
        const index = event.key === 'Home' ? 0 : items.length - 1;
        const target = items[index];
        if (target === undefined) return;
        event.preventDefault();
        onChange({ code: itemCode(target), otherText: value?.otherText ?? null });
        focusOption(event.currentTarget, index);
        return;
      }
      const step = horizontalStep(event.key, ctx.dir) || verticalStep(event.key);
      move(event, step);
    };

    if (question.config.display === 'dropdown') {
      return (
        <select
          id={ctx.ids.groupId}
          className={`rs-choice rs-choice--dropdown ${TOUCH_TARGET_CLASS}`}
          aria-labelledby={ctx.ids.labelId}
          aria-describedby={describedBy === '' ? undefined : describedBy}
          aria-required={question.required ? true : undefined}
          aria-invalid={invalid ? true : undefined}
          value={selected === null ? '' : String(selected)}
          onChange={(event) => {
            const hit = items.find((item) => String(itemCode(item)) === event.target.value);
            onChange({
              code: hit === undefined ? null : itemCode(hit),
              otherText: value?.otherText ?? null,
            });
          }}
        >
          <option value="">{ctx.pipe('common.select_one')}</option>
          {items.map((item) => (
            <option key={item.ref} value={String(itemCode(item))} disabled={!item.enabled}>
              {ctx.pipe(item.labelKey)}
            </option>
          ))}
        </select>
      );
    }

    return (
      <div
        role="radiogroup"
        id={ctx.ids.groupId}
        aria-labelledby={ctx.ids.labelId}
        aria-describedby={describedBy === '' ? undefined : describedBy}
        aria-required={question.required ? true : undefined}
        aria-invalid={invalid ? true : undefined}
        className={`rs-choice rs-choice--${question.config.display} rs-cols-${question.config.columns}`}
        onKeyDown={onKeyDown}
      >
        {items.map((item, index) => (
          <label key={item.ref} className={`rs-choice__item ${TOUCH_TARGET_CLASS}`} data-testid={`opt-${item.ref}`}>
            <input
              type="radio"
              name={ctx.ids.groupId}
              value={String(itemCode(item))}
              checked={itemCode(item) === selected}
              disabled={!item.enabled}
              tabIndex={index === tabStop ? 0 : -1}
              onChange={() => onChange({ code: itemCode(item), otherText: value?.otherText ?? null })}
              onClick={() => {
                if (itemCode(item) === selected && question.config.allowDeselect) {
                  onChange({ code: null, otherText: value?.otherText ?? null });
                }
              }}
            />
            <span>{ctx.pipe(item.labelKey)}</span>
            {renderMedia(item, ctx.pipe)}
          </label>
        ))}
        {isOtherSelected(question.config, selected, items) && (
          <input
            type="text"
            className={TOUCH_TARGET_CLASS}
            aria-label={ctx.pipe('common.other_specify')}
            maxLength={question.config.other.maxLen}
            value={value?.otherText ?? ''}
            onChange={(event) => onChange({ code: selected, otherText: event.target.value })}
          />
        )}
      </div>
    );
  },
);

function renderMedia(item: ResolvedItem, pipe: (key: string) => string): ReactNode {
  const url = item.media?.imageUrl;
  if (url === undefined || url === null) return null;
  // `alt` is never omitted: an option image with no text alternative is an unanswerable question
  // for a screen-reader user, and an empty string would claim it is decorative.
  return <img src={url} alt={pipe(item.media?.altKey ?? '')} />;
}

function isOtherSelected(
  config: SingleSelectConfig,
  selected: SingleSelectAnswer['code'],
  items: readonly ResolvedItem[],
): boolean {
  if (!config.other.enabled || config.other.optionRef === null || selected === null) return false;
  return items.some((item) => item.ref === config.other.optionRef && itemCode(item) === selected);
}

/** Focus follows selection in a radiogroup. DOM access in a handler, never during render (F §8). */
function focusOption(group: HTMLElement, index: number): void {
  const inputs = group.querySelectorAll<HTMLInputElement>('input[type="radio"]');
  inputs.item(index)?.focus();
}

/**
 * The studio editor.
 *
 * It emits JSON Patches and never a whole question (F §6): studio owns the authoring model, and
 * a component that returns a full object can silently drop a field it does not understand —
 * `required`, `flags.pii`, another plugin's leftover config. Every path here is inside
 * `EDITOR_PATCH_PATH_ALLOWLIST`, and studio re-checks that before applying, so a first-party
 * editor exercises the same allowlist the untrusted ones are confined by.
 */
export function SingleSelectEditor({ question, patch, ctx }: EditorProps<SingleSelectConfig>): ReactNode {
  return (
    <div className="rs-editor rs-editor--single-select">
      <label>
        {ctx.t('editor.display')}
        <select
          value={question.config.display}
          onChange={(event) =>
            patch([{ op: 'replace', path: '/config/display', value: event.target.value }])
          }
        >
          {(['vertical', 'horizontal', 'dropdown', 'button_group', 'image_grid'] as const).map(
            (display) => (
              <option key={display} value={display}>
                {ctx.t(`editor.display.${display}`)}
              </option>
            ),
          )}
        </select>
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
      <label>
        {ctx.t('editor.allow_deselect')}
        <input
          type="checkbox"
          checked={question.config.allowDeselect}
          onChange={(event) =>
            patch([{ op: 'replace', path: '/config/allowDeselect', value: event.target.checked }])
          }
        />
      </label>
    </div>
  );
}
