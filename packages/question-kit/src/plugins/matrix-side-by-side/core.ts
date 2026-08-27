/**
 * `matrix_side_by_side` — the same rows, asked several things at once (F §3, roadmap P2-05).
 *
 * "For each brand: rate quality 1-5, rate value 1-5, and would you recommend it?" — one grid, one
 * set of rows, several independent control BLOCKS across the top. Each block is its own child
 * plugin with its own columns, so a block can be a scale while the next is a yes/no.
 *
 * **This is the regular case of the per-cell grid `matrix` deliberately defers, and regularity is
 * what makes it buildable.** `matrix`'s header says a per-cell (row × column) override is
 * diagnosed and skipped because "the export layout for a ragged per-cell grid is an unresolved
 * design question (which column does `Q5r3c2` sort under?)". That question has no general answer —
 * but it has an obvious one here, because a side-by-side grid is not ragged: EVERY row gets EVERY
 * block, by construction. So the layout is `row.code * 100 + block.code`, one level down from
 * `matrix`'s own `row.code * 100 + child.export.order`, and the columns sort row-major with each
 * row's blocks adjacent — which is how an analyst reads the grid on paper.
 *
 * That regularity is enforced, not assumed: `blocks` is a config array rather than per-cell
 * overrides, so a ragged grid is not expressible. An author who wants one is asking for a
 * different question type, and `matrix` will diagnose it for them.
 *
 * **The child knows nothing about the grid, and this plugin knows nothing about the child.** Same
 * four seams `matrix` uses — `ctx.compose`, `delegateParse`/`delegateToVariables`,
 * `delegateValidate`, `ctx.renderChild` — and the same rule: the answer is keyed by
 * `rowRef` then `blockRef` and the values are OPAQUE. Peeking inside would couple this plugin to
 * every child's answer shape, and the first child added after that coupling ships is the one it
 * corrupts.
 *
 * **Why not just author three matrices side by side in the layout?** Because the rows would be
 * three separate questions, so a respondent scrolling a phone would answer brand A's quality, then
 * every brand's quality, then come back for value. One question means one row per brand with its
 * blocks together, which is the whole usability claim of the format — and it means the columns
 * export adjacent, which is the analysis claim.
 *
 * **A BLOCK IS A COLUMN.** The first draft carried blocks entirely in config, with their own refs
 * and codes, and the compose machinery rejected it: `compose_unnameable_part`, "no option, row or
 * column has ref "quality"". That refusal is correct and it is structural — a `cell` scope means
 * (row, column) where the column is one the QUESTION declares, because that is the only way the
 * resulting `Qr1c2` can be rebuilt from the variable registry (schema §4's `cell` part carries a
 * `column_ref`, not an arbitrary string). Config-only blocks would have produced export columns
 * that no round-trip could reconstruct.
 *
 * So the grid's `columns` ARE its blocks — their labels are the block headers and their codes are
 * the `c` in `Qr1c2` — and config carries only the mapping from a column to the control that
 * renders it. That is also the shape schema already has for this (`QuestionCell`'s
 * `row_ref`/`column_ref`/`control`), which is a good sign the model is the intended one rather
 * than a workaround.
 *
 * **And that forced one contract addition, `CellControl.options`.** With the columns spent on the
 * blocks, a choice block had no way to declare an answer scale: a composed child's options came
 * only from `question.columns` under `use_columns`, and `[]` otherwise — which is fine for a
 * `numeric` or `text` cell and fatal for every enum child, since `single_select`, `rating` and
 * `binary` all build their domain from `ctx.options`. The gap was invisible while `matrix` was the
 * only composing plugin, because a matrix's choice rows always use the shared columns. A
 * side-by-side grid of rating scales — the canonical use of the format — is the case that cannot,
 * so `CellControl` now carries an optional own-options list, `use_columns` still wins, and an
 * absent list is still `[]`. Nothing any existing cell does changes.
 */

import type { JsonObject, JsonValue } from '@resscript/schema';
import { asPlainObject, err, ok, type ResponseCodec } from '../../contract/codec.js';
import type { ValidationIssue } from '../../contract/validate.js';
import type { PluginDiagnostic } from '../../contract/diagnostics.js';
import type { QuestionTypePluginCore } from '../../contract/plugin.js';
import type { A11yContract } from '../../contract/a11y.js';
import type { JsonSchema } from '../../json-schema.js';
import type { AuthoredItem } from '../../contract/items.js';
import type {
  CellControl,
  ComposeScope,
  VariableDeclaration,
} from '../../contract/variables.js';

/**
 * Which control renders one block, addressed by the COLUMN that is the block.
 *
 * The block's identity — ref, code, label — lives on the column item, not here: the column is the
 * block (see the header), so duplicating its ref in config would create two sources of truth for
 * the name of an export column. Config carries only what a column cannot: the child plugin.
 */
export interface SideBySideBlock {
  /** The `ref` of the question column this control renders. */
  readonly column_ref: string;
  /** The child plugin and its config. Validated against the CHILD's schema at compose time. */
  readonly control: CellControl;
}

export interface MatrixSideBySideConfig {
  /**
   * One entry per column, naming the control that fills it.
   *
   * A column with no entry falls back to `defaultControl` — a dropdown over its own options — so a
   * half-configured grid still renders rather than showing empty cells.
   */
  readonly blocks: readonly SideBySideBlock[];
  /** How the grid degrades on a phone. `stacked` renders one row's blocks as a vertical group. */
  readonly mobileLayout: 'stacked' | 'scroll';
}

/**
 * The control for a column: its configured block, else a plain text box.
 *
 * **The fallback is `text`, not a choice control**, and that is the one decision in this function.
 * A choice fallback would need an answer scale, and there is none to give it — the shared column
 * list IS the block list here, so an unconfigured choice block would declare an enum with an empty
 * domain, which `declareVariables`' own invariant rejects. A text box needs nothing, renders
 * honestly, and keeps a half-authored grid previewable; `block_column_missing` and `no_blocks` are
 * what tell the author to finish the job, at publish, where the message is actionable.
 */
export function controlForBlock(
  config: MatrixSideBySideConfig,
  columnRef: string,
): CellControl {
  const block = config.blocks.find((entry) => entry.column_ref === columnRef);
  return (
    block?.control ?? {
      question_type: 'text',
      config: { maxLen: 200, placeholderKey: null, inputMode: 'text' },
    }
  );
}

export interface MatrixSideBySideAnswer {
  /**
   * `rowRef -> blockRef -> the child's answer`, opaque to this plugin (see the header).
   *
   * Two levels rather than a flat `"row:block"` key: the flat form needs a separator that cannot
   * appear in a ref, and the moment one can the two keys become ambiguous.
   */
  readonly rows: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

export const MATRIX_SIDE_BY_SIDE_CONFIG_SCHEMA: JsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['blocks', 'mobileLayout'],
  properties: {
    blocks: {
      type: 'array',
      // No `minItems`: a freshly-created question has no blocks yet, and `defaultConfig()` must
      // validate against this schema (the test kit asserts it) — a schema that rejected the
      // plugin's own default would make the question uncreatable in the studio. A grid with no
      // COLUMNS is caught by `no_blocks`, which runs at PUBLISH, where "you have not finished
      // authoring this" is the right thing to say and there is something to say it about.
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['column_ref', 'control'],
        properties: {
          column_ref: { type: 'string', minLength: 1 },
          // Mirrors `CellControl` exactly — including `use_columns`, which is how a choice block
          // draws its options from the grid's shared columns. `additionalProperties: false` means
          // an omission here is a rejected config rather than an ignored field, so the three keys
          // have to match the contract's interface and not a subset of it.
          control: {
            type: 'object',
            additionalProperties: false,
            required: ['question_type'],
            properties: {
              question_type: { type: 'string', minLength: 1 },
              config: { type: 'object' },
              use_columns: { type: 'boolean' },
              // The block's own answer scale. A choice block needs one: in this grid the shared
              // column list is spent on the blocks themselves, so `use_columns` would offer a
              // rating control the set of blocks as its answers. See `CellControl.options`.
              options: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['ref', 'code', 'labelKey'],
                  properties: {
                    ref: { type: 'string', minLength: 1 },
                    code: { type: 'integer' },
                    labelKey: { type: 'string', minLength: 1 },
                    position: { type: 'integer' },
                  },
                },
              },
            },
          },
        },
      },
    },
    mobileLayout: { enum: ['stacked', 'scroll'], default: 'scroll' },
  },
};

/**
 * The scope one (row, block) cell composes under.
 *
 * A `cell` scope, which is what makes the child's `self()` resolve to `Qr{row}c{column}` — the name
 * shape the compose machinery sanctions, and the only one schema §4's `cell` part can rebuild. The
 * `code`s come from the authored items and never from array indices, so reordering rows or columns
 * in the editor cannot renumber a tracker's export columns (F §1.1 rule 2).
 */
export function blockScope(row: AuthoredItem, column: AuthoredItem, index: number): ComposeScope {
  return {
    kind: 'cell',
    rowRef: row.ref,
    rowCode: row.code,
    columnRef: column.ref,
    columnCode: column.code,
    index: index + 1,
  };
}

const codec: ResponseCodec<MatrixSideBySideConfig, MatrixSideBySideAnswer> = {
  parse(raw, ctx) {
    if (raw === null || raw === undefined) return ok({ rows: emptyRows(ctx, {}) });
    const record = asPlainObject(raw);
    if (record === undefined) return err({ code: 'shape', message: 'expected an object' });
    const rawRows = record['rows'] === undefined ? {} : asPlainObject(record['rows']);
    if (rawRows === undefined) {
      return err({ code: 'shape', message: 'rows must be an object', path: '/rows' });
    }

    const rows: Record<string, Record<string, unknown>> = {};
    for (const [rowIndex, row] of ctx.question.rows.entries()) {
      const rawRow = asPlainObject(rawRows[row.ref]) ?? {};
      const blocks: Record<string, unknown> = {};
      for (const [blockIndex, column] of ctx.question.columns.entries()) {
        // EVERY (row, block) is present in the canonical answer — an absent submission parses as
        // the child's own empty. One spelling of "unanswered", so a round-trip through storage
        // cannot manufacture a second one. Same rule `matrix` states for its rows.
        const child = ctx.delegateParse(
          blockScope(row, column, rowIndex * ctx.question.columns.length + blockIndex),
          controlForBlock(ctx.config, column.ref),
          rawRow[column.ref] ?? null,
        );
        if (!child.ok) {
          // The child's own error with the cell prepended — a 200-cell grid that says only
          // "shape" sends the author reading two hundred cells. `matrix` prefixes the row; this
          // needs both coordinates to name one cell.
          return err({
            code: child.error.code,
            message: child.error.message,
            path: `/rows/${row.ref}/${column.ref}${child.error.path ?? ''}`,
          });
        }
        blocks[column.ref] = child.value;
      }
      rows[row.ref] = blocks;
    }
    return ok({ rows });
  },

  toVariables(answer, ctx) {
    const out: Record<string, unknown> = {};
    for (const [rowIndex, row] of ctx.question.rows.entries()) {
      const rowAnswer = answer.rows[row.ref] ?? {};
      for (const [blockIndex, column] of ctx.question.columns.entries()) {
        const written = ctx.delegateToVariables(
          blockScope(row, column, rowIndex * ctx.question.columns.length + blockIndex),
          controlForBlock(ctx.config, column.ref),
          rowAnswer[column.ref] ?? null,
        );
        for (const [name, value] of Object.entries(written)) out[name] = value;
      }
    }
    return out as Record<string, never>;
  },

  fromVariables(vars, ctx) {
    const rows: Record<string, Record<string, unknown>> = {};
    for (const [rowIndex, row] of ctx.question.rows.entries()) {
      const blocks: Record<string, unknown> = {};
      for (const [blockIndex, column] of ctx.question.columns.entries()) {
        blocks[column.ref] = ctx.delegateFromVariables(
          blockScope(row, column, rowIndex * ctx.question.columns.length + blockIndex),
          controlForBlock(ctx.config, column.ref),
          vars,
        );
      }
      rows[row.ref] = blocks;
    }
    return { rows };
  },

  // The canonical empty carries EVERY (row, block) as its child's empty answer — built through the
  // same delegate `fromVariables` uses, so "never answered" and "answered nothing" are one value
  // and the round-trip law (`fromVariables(toVariables(empty)) ≡ empty`) holds by construction.
  // Same construction `matrix` uses, for the same reason.
  emptyAnswer: (ctx) => ({ rows: emptyRows(ctx, {}) }),
};

/** Every (row, block) at its child's own empty — the one spelling of "unanswered". */
function emptyRows(
  ctx: {
    readonly question: {
      readonly rows: readonly AuthoredItem[];
      readonly columns: readonly AuthoredItem[];
    };
    readonly config: MatrixSideBySideConfig;
    readonly delegateFromVariables: (
      scope: ComposeScope,
      control: CellControl,
      vars: Readonly<Record<string, JsonValue>>,
    ) => unknown;
  },
  vars: Readonly<Record<string, JsonValue>>,
): Record<string, Record<string, unknown>> {
  const rows: Record<string, Record<string, unknown>> = {};
  for (const [rowIndex, row] of ctx.question.rows.entries()) {
    const blocks: Record<string, unknown> = {};
    for (const [blockIndex, column] of ctx.question.columns.entries()) {
      blocks[column.ref] = ctx.delegateFromVariables(
        blockScope(row, column, rowIndex * ctx.question.columns.length + blockIndex),
        controlForBlock(ctx.config, column.ref),
        vars,
      );
    }
    rows[row.ref] = blocks;
  }
  return rows;
}

export const matrixSideBySideCore: QuestionTypePluginCore<
  MatrixSideBySideConfig,
  MatrixSideBySideAnswer
> = {
  meta: {
    id: 'matrix_side_by_side',
    version: '1.0.0',
    displayName: 'qt.matrix_side_by_side.name',
    description: 'qt.matrix_side_by_side.desc',
    category: 'grid',
    icon: 'columns',
    entitlementKey: null,
    trust: 'first_party',
    // A parent, never a child: F §3.1 rule 4 forbids a composed control from composing, and a
    // side-by-side grid inside a grid cell has no name shape anyway.
    composable: false,
    emitsData: true,
  },

  configSchema: MATRIX_SIDE_BY_SIDE_CONFIG_SCHEMA,

  defaultConfig: () => ({ blocks: [], mobileLayout: 'scroll' }),

  declareVariables(ctx) {
    const out: VariableDeclaration[] = [];
    ctx.rows.forEach((row, rowIndex) => {
      ctx.columns.forEach((column, blockIndex) => {
        const children = ctx.compose(
          blockScope(row, column, rowIndex * ctx.columns.length + blockIndex),
          controlForBlock(ctx.config, column.ref),
        );
        for (const child of children) {
          out.push({
            ...child,
            export: {
              ...child.export,
              // `matrix`'s arithmetic, one level deeper: the row's block of a hundred, then the
              // BLOCK's code, then the child's own order inside the cell. Derived from codes and
              // never from array indices, so reordering rows or blocks in the editor does not
              // renumber a tracker's columns. Row-major, so each row's blocks export adjacent —
              // which is how the grid reads on paper.
              order: row.code * 100 + column.code * 10 + child.export.order,
              labelKey: row.labelKey,
            },
            // One battery: banners group the grid's variables by the QUESTION, not by whichever
            // plugin produced each column.
            analysis: {
              ...(child.analysis ?? { measure: 'nominal' }),
              batteryRef: ctx.ref,
            },
          });
        }
      });
    });
    return out;
  },

  validate(ctx) {
    const issues: ValidationIssue[] = [];
    const answer = ctx.value ?? { rows: {} };
    ctx.question.rows.forEach((row, rowIndex) => {
      ctx.question.columns.forEach((column, blockIndex) => {
        const childIssues = ctx.delegateValidate(
          blockScope(row, column, rowIndex * ctx.question.columns.length + blockIndex),
          controlForBlock(ctx.question.config, column.ref),
          {
            value: answer.rows[row.ref]?.[column.ref],
            // A required grid means every cell, which is what a respondent expects a grid's
            // asterisk to mean. Per-block requiredness is an authoring feature the schema does not
            // carry yet — the same position `matrix` takes on per-row.
            required: ctx.required,
          },
        );
        for (const issue of childIssues) {
          issues.push({
            ...issue,
            // The child knows neither its row nor its block; both are the parent's knowledge, and
            // the focus target needs both to point at one cell.
            focus: { ...(issue.focus ?? {}), rowRef: row.ref, columnRef: column.ref },
          });
        }
      });
    });
    return issues;
  },

  codec,

  exportContribution: {
    // "question — row — block", because a bare row label on a side-by-side grid is ambiguous by
    // construction: three columns would all read "Brand A". This is the label an analysis deck
    // ends up typing by hand when a tool exports bare row labels.
    columnLabel: (declaration, ctx) => {
      const part = declaration.source.part;
      const column =
        part.kind === 'cell' && part.columnRef !== undefined
          ? ctx.question.columns.find((c) => c.ref === part.columnRef)
          : undefined;
      const base = `${ctx.t(ctx.question.label)} — ${ctx.t(declaration.export.labelKey)}`;
      return column === undefined ? base : `${base} — ${ctx.t(column.labelKey)}`;
    },
    valueLabels: (declaration, ctx) =>
      declaration.type === 'enum'
        ? (declaration.enumDomain ?? []).map((entry) => ({
            code: entry.code,
            label: ctx.t(entry.labelKey),
          }))
        : [],
  },

  a11y: {
    // A real table: rows are rows and blocks are column groups, so `grid` is what the markup is
    // and what a screen reader can navigate cell by cell. Same declaration `matrix` makes.
    interactionModel: 'grid',
    requiredRoles: ['grid'],
    keys: ['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'],
    minTouchTargetPx: 44,
    pointerDependent: false,
    rtlSafe: true,
  } satisfies A11yContract,

  staticChecks(ctx) {
    const out: PluginDiagnostic[] = [];
    const columns = ctx.columns;

    if (columns.length === 0) {
      out.push({
        code: 'no_blocks',
        severity: 'error',
        message:
          'a side-by-side grid needs columns: the columns ARE the blocks, so a grid with none has ' +
          'nothing to ask about each row',
        path: '/columns',
      });
    } else if (columns.length === 1) {
      // One block is a plain matrix, which renders better and exports the same. Worth saying: an
      // author usually got here by deleting columns, not by choosing one.
      out.push({
        code: 'single_block',
        severity: 'warning',
        message:
          'one block is a plain matrix — `matrix` renders it better and exports the same columns',
        path: '/columns',
      });
    }
    if (ctx.rows.length === 0) {
      out.push({
        code: 'no_rows',
        severity: 'error',
        message: 'a side-by-side grid needs rows to ask about',
        path: '/rows',
      });
    }

    for (const [i, column] of columns.entries()) {
      if (column.code > 9) {
        // The export arithmetic is `row * 100 + column * 10 + child`, so a column code above 9
        // carries into the next row's band and columns from different rows interleave. This is the
        // one constraint the format adds to an ordinary column list, and it is the price of the
        // row-major layout that makes the grid read on paper the way it reads on screen.
        out.push({
          code: 'block_code_too_large',
          severity: 'error',
          message:
            `column code ${String(column.code)} exceeds 9: the export order is ` +
            'row*100 + column*10 + child, so a larger code carries into the next row band',
          path: `/columns/${String(i)}/code`,
        });
      }
    }

    // Every configured block must name a real column. A stale entry is what an author leaves behind
    // by deleting a column without clearing its control, and it would silently do nothing.
    const columnRefs = new Set(columns.map((column) => column.ref));
    const seen = new Set<string>();
    for (const [i, block] of ctx.config.blocks.entries()) {
      if (!columnRefs.has(block.column_ref)) {
        out.push({
          code: 'block_column_missing',
          severity: 'error',
          message:
            `block ${String(i)} names column ${JSON.stringify(block.column_ref)}, which this ` +
            'question does not declare — the control would silently never render',
          path: `/config/blocks/${String(i)}/column_ref`,
        });
      }
      if (seen.has(block.column_ref)) {
        // Two controls for one column: the second would win by array order, which is not a
        // decision an author made.
        out.push({
          code: 'duplicate_block_column',
          severity: 'error',
          message: `two blocks both configure column ${JSON.stringify(block.column_ref)}`,
          path: `/config/blocks/${String(i)}/column_ref`,
        });
      }
      seen.add(block.column_ref);
    }

    if (ctx.cells.length > 0) {
      // Per-cell overrides are how a RAGGED grid would sneak in, and raggedness is exactly what
      // makes the export layout undecidable — the question `matrix` defers. Per-column blocks are
      // the regular alternative, so an override is refused rather than partially honoured.
      out.push({
        code: 'cell_overrides_ignored',
        severity: 'warning',
        message:
          'a side-by-side grid takes one control per COLUMN from config.blocks; per-cell ' +
          'overrides are ignored, because a ragged grid has no well-defined export layout',
        path: '/cells',
      });
    }
    return out;
  },
};
