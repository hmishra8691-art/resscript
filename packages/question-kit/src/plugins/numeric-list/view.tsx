/**
 * `numeric_list` renderer and editor.
 *
 * A column of labelled number boxes. The layout discipline is F §8's: the label/box pair is one
 * flex row whose direction the theme owns through logical CSS — nothing in here says left or
 * right, so an Arabic allocation grid reads label-then-box right to left with no plugin change.
 * Per-box error placement comes from `issues[].focus.rowRef`, which is also what the harness's
 * `expectFocus` pins; the group carries the aria wiring so a screen reader hears the battery's
 * label once, not once per box.
 */

import type { ReactNode } from 'react';
import { defineRenderer, type EditorProps, type RendererProps } from '../../contract/view.js';
import { TOUCH_TARGET_CLASS } from '../../contract/a11y.js';
import type { NumericListAnswer, NumericListConfig } from './core.js';

export const NumericListRenderer = defineRenderer<NumericListConfig, NumericListAnswer>(
  ({ question, value, onChange, issues, ctx }: RendererProps<NumericListConfig, NumericListAnswer>): ReactNode => {
    const config = question.config;
    const rows = ctx.order('rows', question.rows).filter((row) => row.visible);
    const values = value?.values ?? {};
    const invalid = issues.length > 0;
    const describedBy = [
      question.instruction === null ? undefined : ctx.ids.instructionId,
      invalid ? ctx.ids.errorId : undefined,
    ]
      .filter((id): id is string => id !== undefined)
      .join(' ');

    const step = config.decimals === 0 ? 1 : 10 ** -config.decimals;

    const setRow = (ref: string, raw: number): void => {
      const next: Record<string, number> = { ...values };
      // A cleared box leaves the map entirely: `values[ref] === 0` is an answer ("zero"), and
      // conflating it with blank would make a required check pass on an untouched box.
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
        className="rs-numeric-list"
      >
        {rows.map((row) => {
          const rowInvalid = issues.some((issue) => issue.focus?.rowRef === row.ref);
          return (
            <label
              key={row.ref}
              className={`rs-numeric-list__row ${TOUCH_TARGET_CLASS}`}
              data-testid={`row-${row.ref}`}
            >
              <span>{ctx.pipe(row.labelKey)}</span>
              <input
                type="number"
                className="rs-numeric-list__input"
                disabled={!row.enabled}
                aria-invalid={rowInvalid ? true : undefined}
                value={values[row.ref] ?? ''}
                min={config.min}
                max={config.max}
                step={step}
                onChange={(event) => setRow(row.ref, event.target.valueAsNumber)}
              />
            </label>
          );
        })}
      </div>
    );
  },
);

/** Studio editor. Patches only, inside the allowlist — see `single-select/view.tsx`. */
export function NumericListEditor({ question, patch, ctx }: EditorProps<NumericListConfig>): ReactNode {
  const boundPatch = (path: string, raw: number): void =>
    // `remove` for an emptied field: "no bound" and "bound of zero" are different questions,
    // and `Number('')` is 0.
    patch([Number.isFinite(raw) ? { op: 'add', path, value: raw } : { op: 'remove', path }]);

  return (
    <div className="rs-editor rs-editor--numeric-list">
      <label>
        {ctx.t('editor.decimals')}
        <input
          type="number"
          min={0}
          max={6}
          value={question.config.decimals}
          onChange={(event) =>
            patch([
              {
                op: 'replace',
                path: '/config/decimals',
                value: Number.isFinite(event.target.valueAsNumber) ? event.target.valueAsNumber : 0,
              },
            ])
          }
        />
      </label>
      <label>
        {ctx.t('editor.min')}
        <input
          type="number"
          value={question.config.min ?? ''}
          onChange={(event) => boundPatch('/config/min', event.target.valueAsNumber)}
        />
      </label>
      <label>
        {ctx.t('editor.max')}
        <input
          type="number"
          value={question.config.max ?? ''}
          onChange={(event) => boundPatch('/config/max', event.target.valueAsNumber)}
        />
      </label>
      <label>
        {ctx.t('editor.sum_equals')}
        <input
          type="number"
          value={question.config.sum?.equals ?? ''}
          onChange={(event) => {
            const raw = event.target.valueAsNumber;
            // The whole `sum` object comes and goes with its `equals`: a `{}` sum constraint
            // validates but constrains nothing, which reads as a bug in the problems panel.
            patch([
              Number.isFinite(raw)
                ? { op: 'add', path: '/config/sum', value: { equals: raw } }
                : { op: 'remove', path: '/config/sum' },
            ]);
          }}
        />
      </label>
    </div>
  );
}
