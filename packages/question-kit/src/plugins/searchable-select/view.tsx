/**
 * `searchable_select` renderer and editor.
 *
 * **The ARIA combobox pattern, implemented rather than gestured at.** The input carries
 * `role="combobox"`, `aria-expanded`, `aria-controls` and `aria-activedescendant`; the popup is a
 * `role="listbox"` of `role="option"` items with stable ids. That set is not decoration — it is what
 * makes the control announce "combobox, 12 of 250 available" instead of an unlabelled text box next
 * to a mystery list, and `aria-activedescendant` is specifically what lets a screen reader follow
 * arrow keys without moving DOM focus off the input the respondent is typing into.
 *
 * **Keyboard is the primary path, and the roving highlight is state, not focus.** Arrow keys move an
 * index; focus stays on the input. Enter commits the highlighted option, Escape closes the popup
 * WITHOUT clearing the choice (clearing on Escape is the behaviour that makes people retype a
 * country they already found), and Home/End reach the ends of the filtered list.
 *
 * **What the respondent typed is never emitted.** `onChange` fires with a code and nothing else —
 * see `core.ts` on why recording the query would be a privacy liability dressed as telemetry.
 *
 * Nothing here names a side: the popup is a block below the input in DOM order, and the theme owns
 * its placement through logical properties (F §8).
 *
 * **Why the interactive part is a nested component rather than the renderer itself.** A
 * `RendererComponent` is a NODE FACTORY: the harness (and the runtime) call it directly to obtain a
 * `ReactNode`, not through React's renderer, so hooks are structurally unavailable inside it — which
 * is exactly what makes `ssr: true` meaningful, since a function React never mounted cannot hold
 * state. This is the first plugin with genuine interaction state (the query, the popup, the
 * highlighted index), and the state has nowhere else to live: it is per-respondent UI, not an
 * answer, so it must not go through `onChange`. So the renderer returns `<SearchableCombobox …/>` —
 * an element of a real component, which React mounts and which may therefore use hooks. SSR still
 * holds: React renders the element on the server exactly as it does any other.
 */

import { useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import { defineRenderer, type EditorProps, type RendererProps } from '../../contract/view.js';
import { TOUCH_TARGET_CLASS } from '../../contract/a11y.js';
import { itemCode } from '../../contract/items.js';
import {
  searchMatches,
  type SearchableSelectAnswer,
  type SearchableSelectConfig,
} from './core.js';

export const SearchableSelectRenderer = defineRenderer<
  SearchableSelectConfig,
  SearchableSelectAnswer
>((props: RendererProps<SearchableSelectConfig, SearchableSelectAnswer>): ReactNode => (
  <SearchableCombobox {...props} />
));

/**
 * The stateful half. See the file header for why this is a component and the renderer is not.
 */
function SearchableCombobox({
  question,
  value,
  onChange,
  issues,
  ctx,
}: RendererProps<SearchableSelectConfig, SearchableSelectAnswer>): ReactNode {
  const config = question.config;
  const items = question.options.filter((option) => option.visible);
  const selected = value?.code ?? null;
  const invalid = issues.length > 0;
  const minChars = config.min_chars ?? 0;
  const maxVisible = config.max_visible ?? 50;

  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  const listboxId = `${ctx.ids.groupId}-listbox`;
  const optionId = (ref: string): string => `${ctx.ids.groupId}-opt-${ref}`;

  const visible = useMemo(() => {
    // Below `min_chars` nothing is shown — the whole point of the setting is to avoid rendering a
    // 250-option list before the respondent has narrowed it.
    if (query.trim().length < minChars) return [];
    const matchOpts = config.match === undefined ? {} : { match: config.match };
    return searchMatches(items, query, {
      ...matchOpts,
      label: (item) => ctx.pipe(item.labelKey),
    }).slice(0, maxVisible);
  }, [items, query, minChars, maxVisible, config.match, ctx]);

  const selectedItem = items.find((item) => itemCode(item) === selected);
  const describedBy = [
    question.instruction === null ? undefined : ctx.ids.instructionId,
    invalid ? ctx.ids.errorId : undefined,
  ]
    .filter((id): id is string => id !== undefined)
    .join(' ');

  const commit = (index: number): void => {
    const item = visible[index];
    if (item === undefined || !item.enabled) return;
    onChange({ code: itemCode(item) });
    // The label replaces the query, so the box shows the answer rather than the search that found
    // it — and the popup closes, because the question is answered.
    setQuery(ctx.pipe(item.labelKey));
    setOpen(false);
    setActive(0);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        setOpen(true);
        setActive((current) => Math.min(current + 1, Math.max(visible.length - 1, 0)));
        return;
      case 'ArrowUp':
        event.preventDefault();
        setActive((current) => Math.max(current - 1, 0));
        return;
      case 'Home':
        if (!open) return;
        event.preventDefault();
        setActive(0);
        return;
      case 'End':
        if (!open) return;
        event.preventDefault();
        setActive(Math.max(visible.length - 1, 0));
        return;
      case 'Enter':
        if (!open) return;
        event.preventDefault();
        commit(active);
        return;
      case 'Escape':
        // Closes the popup and keeps the choice. Clearing here is what makes people retype a
        // country they already found.
        event.preventDefault();
        setOpen(false);
        return;
      default:
        return;
    }
  };

  return (
    <div className="rs-searchable">
      <input
        type="text"
        role="combobox"
        id={ctx.ids.groupId}
        className={`rs-searchable__input ${TOUCH_TARGET_CLASS}`}
        aria-labelledby={ctx.ids.labelId}
        aria-describedby={describedBy === '' ? undefined : describedBy}
        aria-required={question.required ? true : undefined}
        aria-invalid={invalid ? true : undefined}
        aria-expanded={open}
        aria-controls={listboxId}
        aria-autocomplete="list"
        {...(open && visible[active] !== undefined
          ? { 'aria-activedescendant': optionId(visible[active]?.ref ?? '') }
          : {})}
        placeholder={
          config.placeholderKey === undefined || config.placeholderKey === null
            ? undefined
            : ctx.pipe(config.placeholderKey)
        }
        // The selected label when there is one and the respondent has not started retyping.
        value={query === '' && selectedItem !== undefined ? ctx.pipe(selectedItem.labelKey) : query}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
          setActive(0);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        data-testid="searchable-input"
      />

      {/* Always rendered, so `aria-controls` never dangles and the listbox role is findable even
          while empty — a combobox pointing at a node that does not exist is worse than an empty
          one. */}
      <ul
        role="listbox"
        id={listboxId}
        className="rs-searchable__list"
        aria-labelledby={ctx.ids.labelId}
        data-open={open ? 'true' : undefined}
      >
        {visible.map((item, index) => (
          <li
            key={item.ref}
            role="option"
            id={optionId(item.ref)}
            aria-selected={itemCode(item) === selected}
            aria-disabled={item.enabled ? undefined : true}
            className={`rs-searchable__option ${TOUCH_TARGET_CLASS}`}
            data-active={index === active ? 'true' : undefined}
            data-testid={`opt-${item.ref}`}
            onMouseDown={(event) => {
              // `mousedown`, not `click`: the input would blur first and close the popup.
              event.preventDefault();
              commit(index);
            }}
          >
            {ctx.pipe(item.labelKey)}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Studio editor. Patches only, inside the allowlist — see `single-select/view.tsx`. */
export function SearchableSelectEditor({
  question,
  patch,
  ctx,
}: EditorProps<SearchableSelectConfig>): ReactNode {
  const config = question.config;
  return (
    <div className="rs-editor rs-editor--searchable">
      <label>
        {ctx.t('editor.searchable.min_chars')}
        <input
          type="number"
          min={0}
          max={5}
          value={config.min_chars ?? 0}
          onChange={(event) =>
            patch([
              {
                op: 'replace',
                path: '/config/min_chars',
                value: Number.isFinite(event.target.valueAsNumber)
                  ? event.target.valueAsNumber
                  : 0,
              },
            ])
          }
        />
      </label>
      <label>
        {ctx.t('editor.searchable.max_visible')}
        <input
          type="number"
          min={1}
          max={500}
          value={config.max_visible ?? 50}
          onChange={(event) =>
            patch([
              {
                op: 'replace',
                path: '/config/max_visible',
                value: Number.isFinite(event.target.valueAsNumber)
                  ? event.target.valueAsNumber
                  : 50,
              },
            ])
          }
        />
      </label>
      <label>
        {ctx.t('editor.searchable.match')}
        <select
          value={config.match ?? 'contains'}
          onChange={(event) =>
            patch([{ op: 'replace', path: '/config/match', value: event.target.value }])
          }
        >
          {(['contains', 'prefix'] as const).map((mode) => (
            <option key={mode} value={mode}>
              {ctx.t(`editor.searchable.match.${mode}`)}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
