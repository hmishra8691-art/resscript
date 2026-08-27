/**
 * `media_select` renderer and editor.
 *
 * **The picture is the label.** Each tile is a `<label>` wrapping a real radio or checkbox and an
 * `<img>`, so the platform owns selection, focus and the roving tabindex — there is no custom
 * widget here, and that is deliberate. A grid of `div`s with click handlers and `role="radio"`
 * reimplements what the browser already does correctly and gets the keyboard wrong in a way nobody
 * notices until an accessibility audit.
 *
 * **`alt` is never omitted and never empty.** `core.ts` makes a missing alt a publish ERROR, so by
 * the time this renders there is text to use; passing `alt=""` would claim the image is decorative,
 * which for an option a respondent is choosing between is the opposite of true.
 *
 * **Labels are optional, alt text is not.** `show_labels: false` is a legitimate design ("pick the
 * pack you recognise") and hides the visible caption only — the alt text still reaches assistive
 * technology, so turning captions off cannot make the question unanswerable.
 *
 * Grid columns come from a class, not an inline `grid-template-columns` with a direction in it; the
 * theme owns flow direction through logical properties (F §8).
 */

import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { defineRenderer, type EditorProps, type RendererProps } from '../../contract/view.js';
import { TOUCH_TARGET_CLASS } from '../../contract/a11y.js';
import { itemCode, type ResolvedItem } from '../../contract/items.js';
import type { MediaSelectAnswer, MediaSelectConfig } from './core.js';

export const MediaSelectRenderer = defineRenderer<MediaSelectConfig, MediaSelectAnswer>(
  ({ question, value, onChange, issues, ctx }: RendererProps<MediaSelectConfig, MediaSelectAnswer>): ReactNode => {
    const config = question.config;
    const items = ctx.order('options', question.options).filter((option) => option.visible);
    const multi = config.mode === 'multi';
    const selected = value?.code ?? null;
    const chosen = new Set(value?.codes ?? []);
    const invalid = issues.length > 0;

    const describedBy = [
      question.instruction === null ? undefined : ctx.ids.instructionId,
      invalid ? ctx.ids.errorId : undefined,
    ]
      .filter((id): id is string => id !== undefined)
      .join(' ');

    // One tab stop for the whole group, in BOTH modes (F §8, and `groupTabStops`' own rationale:
    // a 60-option list must not be 60 stops). The house rule applies to checkbox groups as well as
    // radio ones — `multi_select` does the same — so a tile grid of twelve pictures is one stop with
    // arrows moving inside it, not twelve stops a keyboard user tabs through.
    //
    // The stop is the chosen tile where there is one, so returning to a partly-answered question
    // puts focus where the respondent left it.
    const firstChosen = items.findIndex((option) =>
      multi ? chosen.has(itemCode(option)) : itemCode(option) === selected,
    );
    const tabStop = firstChosen >= 0 ? firstChosen : items.findIndex((option) => option.enabled);

    const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
      // Arrows MOVE FOCUS; they never toggle. Toggling on arrow would make a keyboard user select
      // every tile they scroll past — and in a picture grid that is a whole answer set.
      //
      // Forward follows reading order rather than a fixed key, which is the one place this file
      // consults `ctx.dir`: in RTL, ArrowLeft is "next". That is a keyboard-semantics fact, not a
      // layout one, so it does not conflict with the no-physical-direction rule for styling.
      const forward = ctx.dir === 'rtl' ? 'ArrowLeft' : 'ArrowRight';
      const back = ctx.dir === 'rtl' ? 'ArrowRight' : 'ArrowLeft';
      const step =
        event.key === forward || event.key === 'ArrowDown'
          ? 1
          : event.key === back || event.key === 'ArrowUp'
            ? -1
            : 0;
      const controls = event.currentTarget.querySelectorAll<HTMLInputElement>(
        'input[type="checkbox"], input[type="radio"]',
      );
      if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        controls.item(event.key === 'Home' ? 0 : controls.length - 1)?.focus();
        return;
      }
      if (step === 0 || controls.length === 0) return;
      event.preventDefault();
      const active = [...controls].findIndex((control) => control === document.activeElement);
      const from = active >= 0 ? active : Math.max(tabStop, 0);
      controls.item((from + step + controls.length) % controls.length)?.focus();
    };

    const toggle = (option: ResolvedItem): void => {
      const code = itemCode(option);
      if (!multi) {
        onChange({ code, codes: [] });
        return;
      }
      const next = new Set(chosen);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      // Sorted, so the answer has one representation — matching the codec's normalization.
      const codes = [...next].sort((a, b) =>
        String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0,
      );
      onChange({ code: null, codes });
    };

    return (
      <div
        role={multi ? 'group' : 'radiogroup'}
        id={ctx.ids.groupId}
        aria-labelledby={ctx.ids.labelId}
        aria-describedby={describedBy === '' ? undefined : describedBy}
        aria-required={question.required ? true : undefined}
        aria-invalid={invalid ? true : undefined}
        className={`rs-media-select rs-cols-${config.columns}`}
        onKeyDown={onKeyDown}
      >
        {items.map((option, index) => {
          const code = itemCode(option);
          const isChosen = multi ? chosen.has(code) : code === selected;
          const url = option.media?.imageUrl;
          return (
            <label
              key={option.ref}
              className={`rs-media-select__tile ${TOUCH_TARGET_CLASS}`}
              data-chosen={isChosen ? 'true' : undefined}
              data-testid={`opt-${option.ref}`}
            >
              <input
                type={multi ? 'checkbox' : 'radio'}
                name={multi ? undefined : ctx.ids.groupId}
                className="rs-media-select__control"
                value={String(code)}
                checked={isChosen}
                disabled={!option.enabled}
                tabIndex={index === tabStop ? 0 : -1}
                onChange={() => toggle(option)}
              />
              {url === undefined || url === null ? (
                // `option_without_media` is a publish error, so this branch is unreachable for a
                // published survey. It renders the label rather than an empty tile so a PREVIEW of
                // a half-authored question is still usable.
                <span className="rs-media-select__missing">{ctx.pipe(option.labelKey)}</span>
              ) : (
                <img
                  className="rs-media-select__image"
                  src={url}
                  // Never empty: an option image with no text alternative is unanswerable for a
                  // screen-reader user, and `alt=""` would claim it is decorative.
                  alt={ctx.pipe(option.media?.altKey ?? option.labelKey)}
                />
              )}
              {config.show_labels !== false && (
                <span className="rs-media-select__caption">{ctx.pipe(option.labelKey)}</span>
              )}
            </label>
          );
        })}
      </div>
    );
  },
);

/** Studio editor. Patches only, inside the allowlist — see `single-select/view.tsx`. */
export function MediaSelectEditor({ question, patch, ctx }: EditorProps<MediaSelectConfig>): ReactNode {
  const config = question.config;
  return (
    <div className="rs-editor rs-editor--media-select">
      <label>
        {ctx.t('editor.media_select.mode')}
        <select
          value={config.mode}
          onChange={(event) =>
            patch([{ op: 'replace', path: '/config/mode', value: event.target.value }])
          }
        >
          {(['single', 'multi'] as const).map((mode) => (
            <option key={mode} value={mode}>
              {ctx.t(`editor.media_select.mode.${mode}`)}
            </option>
          ))}
        </select>
      </label>
      <label>
        {ctx.t('editor.columns')}
        <select
          value={String(config.columns)}
          onChange={(event) =>
            patch([
              { op: 'replace', path: '/config/columns', value: Number(event.target.value) },
            ])
          }
        >
          {[1, 2, 3, 4].map((columns) => (
            <option key={columns} value={String(columns)}>
              {String(columns)}
            </option>
          ))}
        </select>
      </label>
      <label>
        {ctx.t('editor.media_select.show_labels')}
        <input
          type="checkbox"
          checked={config.show_labels !== false}
          onChange={(event) =>
            patch([{ op: 'replace', path: '/config/show_labels', value: event.target.checked }])
          }
        />
      </label>
    </div>
  );
}
