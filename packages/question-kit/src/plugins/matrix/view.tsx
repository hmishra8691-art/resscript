/**
 * `matrix` renderer and editor.
 *
 * The renderer draws the TABLE — row headers, column headers, the grid skeleton — and nothing
 * inside a cell: every cell body is `ctx.renderChild`, which is the render-time face of the
 * same delegation the codec and validator do (F §3). This file staying ignorant of what a cell
 * contains is the acceptance criterion in miniature: a numeric row and a text row render here
 * without this file naming either plugin.
 *
 * The header row is a real `<thead>` with `scope="col"` and rows carry `scope="row"` headers:
 * a screen-reader user navigating a 20×5 grid hears "Satisfaction — Brand C — column 4 of 5",
 * and that sentence is assembled from exactly these attributes. The interaction model declared
 * in core.ts is `grid`; the roving-tabindex behaviour INSIDE a cell belongs to the cell's own
 * control (each child is its own radiogroup/textbox), so the table itself adds no key handling
 * — grids whose parent intercepts arrows fight their own cells over who owns "right".
 */

import type { ReactNode } from 'react';
import { defineRenderer, type EditorProps, type RendererProps } from '../../contract/view.js';
import { controlForRow, rowScope, type MatrixAnswer, type MatrixConfig } from './core.js';

export const MatrixRenderer = defineRenderer<MatrixConfig, MatrixAnswer>(
  ({ question, value, onChange, issues, ctx }: RendererProps<MatrixConfig, MatrixAnswer>): ReactNode => {
    const rows = ctx.order('rows', question.rows);
    const columns = ctx.order('columns', question.columns);
    const invalid = issues.length > 0;
    const describedBy = [
      question.instruction === null ? undefined : ctx.ids.instructionId,
      invalid ? ctx.ids.errorId : undefined,
    ]
      .filter((id): id is string => id !== undefined)
      .join(' ');

    // Column headers exist when any row draws on the shared columns. A grid of text rows has
    // no column axis to head.
    const anyUsesColumns = rows.some(
      (row) => controlForRow(question.config, question.cells, row.ref).use_columns === true,
    );

    return (
      <table
        role="grid"
        id={ctx.ids.groupId}
        aria-labelledby={ctx.ids.labelId}
        aria-describedby={describedBy === '' ? undefined : describedBy}
        aria-required={question.required ? true : undefined}
        aria-invalid={invalid ? true : undefined}
        className={`rs-matrix rs-matrix--${question.config.mobileLayout}`}
      >
        {anyUsesColumns ? (
          <thead>
            <tr>
              {/* The corner cell: present so the header row's column count matches the body's,
                  which is what keeps a screen reader's column arithmetic honest. */}
              <td className="rs-matrix__corner" />
              <th scope="col" colSpan={columns.length} className="rs-matrix__colhead">
                {columns.map((column) => (
                  <span key={column.ref} className="rs-matrix__collabel">
                    {ctx.pipe(column.labelKey)}
                  </span>
                ))}
              </th>
            </tr>
          </thead>
        ) : null}
        <tbody>
          {rows.map((row, index) => {
            const control = controlForRow(question.config, question.cells, row.ref);
            const scope = rowScope(row, index);
            const rowIssues = issues.filter((issue) => issue.focus?.rowRef === row.ref);
            const rowLabelId = `${ctx.ids.groupId}-r-${row.ref}`;
            return (
              <tr key={row.ref} className="rs-matrix__row">
                <th scope="row" id={rowLabelId} className="rs-matrix__rowhead">
                  {ctx.pipe(row.labelKey)}
                </th>
                <td role="gridcell" className="rs-matrix__cell">
                  {ctx.renderChild(scope, control, {
                    value: value?.rows[row.ref],
                    onChange: (next: unknown) =>
                      onChange({ rows: { ...(value?.rows ?? {}), [row.ref]: next } }),
                    issues: rowIssues,
                    labelledBy: rowLabelId,
                    ...(control.use_columns === true ? { injectedOptions: columns } : {}),
                  })}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    );
  },
);

export function MatrixEditor({ question, patch, ctx }: EditorProps<MatrixConfig>): ReactNode {
  return (
    <div className="rs-matrix-editor">
      <label>
        {ctx.t('editor.matrix.response_mode')}
        <select
          value={question.config.responseMode}
          onChange={(event) =>
            patch([{ op: 'replace', path: '/config/responseMode', value: event.target.value }])
          }
        >
          {(['single', 'multi'] as const).map((mode) => (
            <option key={mode} value={mode}>
              {ctx.t(`editor.matrix.mode.${mode}`)}
            </option>
          ))}
        </select>
      </label>
      <label>
        {ctx.t('editor.matrix.mobile_layout')}
        <select
          value={question.config.mobileLayout}
          onChange={(event) =>
            patch([{ op: 'replace', path: '/config/mobileLayout', value: event.target.value }])
          }
        >
          {(['stacked', 'scroll'] as const).map((layout) => (
            <option key={layout} value={layout}>
              {ctx.t(`editor.matrix.layout.${layout}`)}
            </option>
          ))}
        </select>
      </label>
      {/* Row/column/cell editing is the studio's grid editor over `rows`/`columns`/`cells`
          (schema §5.2); the config editor here owns only what lives in config. */}
    </div>
  );
}
