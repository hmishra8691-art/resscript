/**
 * `matrix_side_by_side` renderer and editor.
 *
 * The renderer draws the TABLE and nothing inside a cell: every cell body is `ctx.renderChild`,
 * the render-time face of the same delegation the codec and validator do (F §3). This file staying
 * ignorant of what a cell contains is the point — a scale block beside a yes/no block renders here
 * without this file naming either plugin.
 *
 * **The header is two rows deep, and it has to be.** A side-by-side grid has one column per block,
 * so a single header row would give three columns all reading "Brand A" for a screen-reader user
 * navigating by column. The block labels are the column headers (`scope="col"`), the row labels are
 * the row headers (`scope="row"`), and every cell is `headers`-associated to BOTH — which is what
 * assembles "Quality — Brand C" instead of "column 2 of 3". `matrix` needs only one header row
 * because it has one cell per row; this one does not, and the difference is the whole accessibility
 * story of the format.
 *
 * **No key handling on the table.** The roving-tabindex behaviour inside a cell belongs to the
 * cell's own control (each child is its own radiogroup/textbox), and a grid whose parent intercepts
 * arrows fights its own cells over who owns "right". Same position `matrix` takes.
 */

import type { ReactNode } from 'react';
import { defineRenderer, type EditorProps, type RendererProps } from '../../contract/view.js';
import {
  blockScope,
  controlForBlock,
  type MatrixSideBySideAnswer,
  type MatrixSideBySideConfig,
} from './core.js';

export const MatrixSideBySideRenderer = defineRenderer<
  MatrixSideBySideConfig,
  MatrixSideBySideAnswer
>(({ question, value, onChange, issues, ctx }: RendererProps<MatrixSideBySideConfig, MatrixSideBySideAnswer>): ReactNode => {
  const rows = ctx.order('rows', question.rows);
  // The COLUMNS are the blocks — see `core.ts`' header on why a block cannot be a config-only
  // concept. Their labels are the block headers and their codes are the `c` in `Q1r1c2`.
  const blocks = ctx.order('columns', question.columns);
  const invalid = issues.length > 0;

  const describedBy = [
    question.instruction === null ? undefined : ctx.ids.instructionId,
    invalid ? ctx.ids.errorId : undefined,
  ]
    .filter((id): id is string => id !== undefined)
    .join(' ');

  const blockHeadId = (ref: string): string => `${ctx.ids.groupId}-b-${ref}`;
  const rowHeadId = (ref: string): string => `${ctx.ids.groupId}-r-${ref}`;

  return (
    <table
      role="grid"
      id={ctx.ids.groupId}
      aria-labelledby={ctx.ids.labelId}
      aria-describedby={describedBy === '' ? undefined : describedBy}
      aria-required={question.required ? true : undefined}
      aria-invalid={invalid ? true : undefined}
      className={`rs-sbs rs-sbs--${question.config.mobileLayout}`}
    >
      <thead>
        <tr>
          {/* The corner cell: present so the header row's column count matches the body's, which
              is what keeps a screen reader's column arithmetic honest. */}
          <td className="rs-sbs__corner" />
          {blocks.map((block) => (
            <th
              key={block.ref}
              scope="col"
              id={blockHeadId(block.ref)}
              className="rs-sbs__blockhead"
            >
              {ctx.pipe(block.labelKey)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, rowIndex) => (
          <tr key={row.ref} className="rs-sbs__row">
            <th scope="row" id={rowHeadId(row.ref)} className="rs-sbs__rowhead">
              {ctx.pipe(row.labelKey)}
            </th>
            {blocks.map((block, blockIndex) => {
              const scope = blockScope(row, block, rowIndex * blocks.length + blockIndex);
              const control = controlForBlock(question.config, block.ref);
              const cellIssues = issues.filter(
                (issue) => issue.focus?.rowRef === row.ref && issue.focus?.columnRef === block.ref,
              );
              return (
                <td
                  key={block.ref}
                  role="gridcell"
                  className="rs-sbs__cell"
                  // Both headers, so the cell announces "Quality — Brand C" rather than a column
                  // number. This is the attribute that makes the two-row header pay off.
                  headers={`${rowHeadId(row.ref)} ${blockHeadId(block.ref)}`}
                >
                  {ctx.renderChild(scope, control, {
                    value: value?.rows[row.ref]?.[block.ref],
                    onChange: (next: unknown) =>
                      onChange({
                        rows: {
                          ...(value?.rows ?? {}),
                          [row.ref]: { ...(value?.rows[row.ref] ?? {}), [block.ref]: next },
                        },
                      }),
                    issues: cellIssues,
                    // Labelled by BOTH: a child rendering its own group needs the full sentence,
                    // and it cannot assemble it because it knows neither coordinate.
                    labelledBy: `${rowHeadId(row.ref)} ${blockHeadId(block.ref)}`,
                    // `use_columns` is deliberately NOT honoured here: in this grid the columns ARE
                    // the blocks, so "draw your options from the shared columns" would offer a
                    // choice block the set of blocks as its answers. Each block carries its own
                    // options in its own config, which is what makes one block a 1-5 scale while
                    // the next is a yes/no.
                  })}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
});

/** Studio editor. Patches only, inside the allowlist — see `single-select/view.tsx`. */
export function MatrixSideBySideEditor({
  question,
  patch,
  ctx,
}: EditorProps<MatrixSideBySideConfig>): ReactNode {
  return (
    <div className="rs-editor rs-editor--sbs">
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
              {ctx.t(`editor.matrix.mobile_layout.${layout}`)}
            </option>
          ))}
        </select>
      </label>
      {/* The block LIST is edited by a dedicated panel, not here: each block carries a child
          question type and its config, and a nested plugin editor inside this one is the studio's
          composition surface (P2-05 frontend) rather than a text field. The count is shown so an
          author can see the config is populated. */}
      <p className="rs-editor__note">
        {ctx.t('editor.sbs.block_count')}: {String(question.config.blocks.length)}
      </p>
    </div>
  );
}
