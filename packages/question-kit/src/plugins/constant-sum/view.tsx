/**
 * `constant_sum` renderer and editor.
 *
 * **The live remainder is the feature.** Eight numeric boxes plus a validation message at the end
 * is `numeric_list`; a respondent who can see what is left as they type is a constant sum. The
 * counter is computed by `allocation` from `core.ts` — the same function the validator uses — so
 * the control cannot tell someone they are done while validation disagrees. Two implementations of
 * "what is left" is exactly how that happens.
 *
 * **The remainder is `aria-live`-free on purpose.** It is a `role="status"`-shaped fact, but plugins
 * must not create their own live regions: two `aria-live` nodes on a page means one is silently
 * ignored and which one is a screen-reader implementation detail (F §8, `RenderCtx.announce`). The
 * counter is rendered as plain text tied to the group by `aria-describedby`, and the page-level
 * announcer is the caller's to use.
 *
 * Nothing here names a side. Label-then-box is one flex row whose direction the theme owns through
 * logical CSS, so an Arabic allocation grid reads right to left with no plugin change.
 */

import type { ReactNode } from 'react';
import { defineRenderer, type EditorProps, type RendererProps } from '../../contract/view.js';
import { TOUCH_TARGET_CLASS } from '../../contract/a11y.js';
import { allocation, type ConstantSumAnswer, type ConstantSumConfig } from './core.js';

export const ConstantSumRenderer = defineRenderer<ConstantSumConfig, ConstantSumAnswer>(
  ({ question, value, onChange, issues, ctx }: RendererProps<ConstantSumConfig, ConstantSumAnswer>): ReactNode => {
    const config = question.config;
    const rows = ctx.order('rows', question.rows).filter((row) => row.visible);
    const values = value?.values ?? {};
    const invalid = issues.length > 0;
    const step = config.decimals === 0 ? 1 : 10 ** -config.decimals;
    const perItemMax = config.max_per_item ?? config.total;
    const showRemaining = config.show_remaining !== false;
    const remainderId = `${ctx.ids.groupId}-remaining`;

    const { allocated, remaining } = allocation(
      values,
      rows.map((row) => row.ref),
      config,
    );

    const describedBy = [
      question.instruction === null ? undefined : ctx.ids.instructionId,
      showRemaining ? remainderId : undefined,
      invalid ? ctx.ids.errorId : undefined,
    ]
      .filter((id): id is string => id !== undefined)
      .join(' ');

    const setRow = (ref: string, raw: number): void => {
      const next: Record<string, number> = { ...values };
      // A cleared box leaves the map entirely: `values[ref] === 0` is a real allocation ("none to
      // this one"), and conflating it with blank would make a required check pass on an untouched
      // box — and would count a blank as an allocated zero in the remainder.
      if (Number.isFinite(raw)) next[ref] = raw;
      else delete next[ref];
      onChange({ values: next });
    };

    return (
      <div
        role="group"
        id={ctx.ids.groupId}
        aria-labelledby={ctx.ids.labelId}
        aria-describedby={describedBy === '' ? undefined : describedBy}
        aria-required={question.required ? true : undefined}
        aria-invalid={invalid ? true : undefined}
        className={`rs-constant-sum rs-constant-sum--${config.unit ?? 'points'}`}
      >
        {rows.map((row) => {
          const rowInvalid = issues.some((issue) => issue.focus?.rowRef === row.ref);
          return (
            <label
              key={row.ref}
              className={`rs-constant-sum__row ${TOUCH_TARGET_CLASS}`}
              data-testid={`row-${row.ref}`}
            >
              <span>{ctx.pipe(row.labelKey)}</span>
              <input
                type="number"
                className="rs-constant-sum__input"
                disabled={!row.enabled}
                aria-invalid={rowInvalid ? true : undefined}
                value={values[row.ref] ?? ''}
                min={0}
                max={perItemMax}
                step={step}
                onChange={(event) => setRow(row.ref, event.target.valueAsNumber)}
              />
            </label>
          );
        })}

        {showRemaining && (
          <p className="rs-constant-sum__remaining" id={remainderId} data-testid="constant-sum-remaining">
            <span data-testid="constant-sum-allocated">{String(allocated)}</span>
            {' / '}
            <span data-testid="constant-sum-total">{String(config.total)}</span>
            {' — '}
            {/* `remaining` can be negative, and showing it as such is the point: "-20 left" tells
                a respondent they are over budget more directly than any message. */}
            <span data-testid="constant-sum-left">{String(remaining)}</span>
          </p>
        )}
      </div>
    );
  },
);

/** Studio editor. Patches only, inside the allowlist — see `single-select/view.tsx`. */
export function ConstantSumEditor({ question, patch, ctx }: EditorProps<ConstantSumConfig>): ReactNode {
  const config = question.config;
  // `total` and `decimals` are REQUIRED, so an emptied field is a `replace` with a usable number
  // rather than a `remove`: removing either would make the config invalid against its own schema.
  const requiredNumber = (path: string, raw: number, fallback: number): void =>
    patch([{ op: 'replace', path, value: Number.isFinite(raw) ? raw : fallback }]);

  return (
    <div className="rs-editor rs-editor--constant-sum">
      <label>
        {ctx.t('editor.constant_sum.total')}
        <input
          type="number"
          value={config.total}
          onChange={(event) => requiredNumber('/config/total', event.target.valueAsNumber, 100)}
        />
      </label>
      <label>
        {ctx.t('editor.decimals')}
        <input
          type="number"
          min={0}
          max={6}
          value={config.decimals}
          onChange={(event) => requiredNumber('/config/decimals', event.target.valueAsNumber, 0)}
        />
      </label>
      <label>
        {ctx.t('editor.constant_sum.max_per_item')}
        <input
          type="number"
          value={config.max_per_item ?? ''}
          onChange={(event) => {
            const raw = event.target.valueAsNumber;
            // Optional: "no per-item cap" and "a cap of zero" are different questions.
            patch([
              Number.isFinite(raw) && raw > 0
                ? { op: 'add', path: '/config/max_per_item', value: raw }
                : { op: 'remove', path: '/config/max_per_item' },
            ]);
          }}
        />
      </label>
      <label>
        {ctx.t('editor.constant_sum.allow_partial')}
        <input
          type="checkbox"
          checked={config.allow_partial === true}
          onChange={(event) =>
            patch([{ op: 'replace', path: '/config/allow_partial', value: event.target.checked }])
          }
        />
      </label>
    </div>
  );
}
