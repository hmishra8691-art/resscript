/**
 * `matrix` — the composing grid (F §3), and the plugin that proves the contract is real.
 *
 * A matrix knows nothing about what its cells contain. Every row delegates to another plugin —
 * `single_select` over the shared columns by default, or whatever a per-row override names —
 * through the four seams the contract reserves: `ctx.compose` at declaration time, `delegate*`
 * in the codec, `delegateValidate` in the validator, `ctx.renderChild` in the renderer. The
 * acceptance line this file exists for (roadmap P1-05): a mixed matrix with rows
 * `[numeric 0–100, text max 200, single_select over columns]` declares exactly `Qr1 : number`,
 * `Qr2 : text`, `Qr3 : enum` — three plugins' worth of typed variables, none of which this file
 * knows how to produce. And its inverse: no file in the compiler, the logic engine or the
 * runtime contains the string `'matrix'`, because "grid" is authoring vocabulary, not platform
 * vocabulary.
 *
 * Two shape decisions worth their comments:
 *
 * 1. **Per-ROW composition only.** `ctx.cells` overrides are honoured when they name a whole row
 *    (`column_ref` absent); a per-cell (`row × column`) override is diagnosed and skipped. The
 *    schema can express a true per-cell grid (`matrix_grid` in its builtin table), but one row =
 *    one control is what "mixed matrix" means in F §3's own sample and in the acceptance
 *    criterion, and the export layout for a ragged per-cell grid is an unresolved design
 *    question (which column does `Q5r3c2` sort under?) that P1 does not need answered.
 *
 * 2. **The answer is keyed by row REF, values are OPAQUE.** `MatrixAnswer.rows[rowRef]` holds
 *    whatever the row's child codec parses to — this plugin never looks inside. Peeking would
 *    couple the matrix to every child's answer shape, and the first child added after that
 *    coupling ships is the one the matrix corrupts.
 */

import type { JsonObject } from '@resscript/schema';
import { asPlainObject, err, ok, type ResponseCodec } from '../../contract/codec.js';
import type { ValidationIssue } from '../../contract/validate.js';
import type { PluginDiagnostic } from '../../contract/diagnostics.js';
import type { QuestionTypePluginCore } from '../../contract/plugin.js';
import type { A11yContract } from '../../contract/a11y.js';
import type { JsonSchema } from '../../json-schema.js';
import type { AuthoredItem } from '../../contract/items.js';
import type {
  CellControl,
  CellOverride,
  ComposeScope,
  VariableDeclaration,
} from '../../contract/variables.js';

export interface MatrixConfig {
  /** What an un-overridden row is: one choice across the columns, or one checkbox per column. */
  readonly responseMode: 'single' | 'multi';
  /**
   * Config for the DEFAULT cell control, or null for the plugin's own compact defaults.
   * Validated against the CHILD's schema at compose time (F §3.1 rule 3), not here — this
   * plugin cannot know what keys `single_select` accepts, and guessing is the coupling the
   * header forswears.
   */
  readonly defaultCellConfig: JsonObject | null;
  /** How the grid degrades on a phone: stacked rows, or a horizontally scrolling table. */
  readonly mobileLayout: 'stacked' | 'scroll';
}

export interface MatrixAnswer {
  /** rowRef -> the row's child answer, opaque to this plugin (see the header). */
  readonly rows: Readonly<Record<string, unknown>>;
}

export const MATRIX_CONFIG_SCHEMA: JsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['responseMode'],
  properties: {
    responseMode: { enum: ['single', 'multi'] },
    defaultCellConfig: { type: ['object', 'null'], default: null },
    mobileLayout: { enum: ['stacked', 'scroll'], default: 'stacked' },
  },
};

/**
 * The default controls. Complete configs, not `{}`: `compose` validates the child's config
 * against the child's schema after applying the child's DEFAULTS, and both select schemas
 * require `display` — which deliberately has no schema default, because a control that guesses
 * its own layout is a control whose layout changes under it when the guess changes. A dropdown
 * for single (the same call `single_select.defaultConfig` makes for `asCellControl`, for the
 * same reason: a 7-across button group inside a table cell is unanswerable on a phone), a
 * plain vertical list for multi.
 */
function defaultControl(config: MatrixConfig): CellControl {
  return config.responseMode === 'single'
    ? {
        question_type: 'single_select',
        use_columns: true,
        config: config.defaultCellConfig ?? { display: 'dropdown', other: { enabled: false } },
      }
    : {
        question_type: 'multi_select',
        use_columns: true,
        config: config.defaultCellConfig ?? { display: 'vertical', other: { enabled: false } },
      };
}

/** The row's control: its whole-row override when one exists, the mode default otherwise. */
export function controlForRow(
  config: MatrixConfig,
  cells: readonly CellOverride[],
  rowRef: string,
): CellControl {
  const override = cells.find((cell) => cell.row_ref === rowRef && cell.column_ref == null);
  return override?.control ?? defaultControl(config);
}

/** The scope a row composes under. `index` is 1-based, per `ComposeScope`'s contract. */
export function rowScope(row: AuthoredItem, index: number): ComposeScope {
  return { kind: 'row', rowRef: row.ref, rowCode: row.code, index: index + 1 };
}

const codec: ResponseCodec<MatrixConfig, MatrixAnswer> = {
  parse(raw, ctx) {
    if (raw === null || raw === undefined) return ok({ rows: {} });
    const record = asPlainObject(raw);
    if (record === undefined) return err({ code: 'shape', message: 'expected an object' });
    const rawRows = record['rows'] === undefined ? {} : asPlainObject(record['rows']);
    if (rawRows === undefined) {
      return err({ code: 'shape', message: 'rows must be an object', path: '/rows' });
    }

    const rows: Record<string, unknown> = {};
    for (const [index, row] of ctx.question.rows.entries()) {
      // EVERY row is present in the canonical answer — an absent submission parses as the
      // child's own empty. One spelling of "unanswered" (see `emptyAnswer`), so a round-trip
      // through storage cannot manufacture a second one.
      const child = ctx.delegateParse(
        rowScope(row, index),
        controlForRow(ctx.config, ctx.question.cells, row.ref),
        rawRows[row.ref] ?? null,
      );
      if (!child.ok) {
        // The child's own error, with the row prepended to its path — a 200-row grid that says
        // only "shape" sends the author reading two hundred cells.
        return err({
          code: child.error.code,
          message: child.error.message,
          path: `/rows/${row.ref}${child.error.path ?? ''}`,
        });
      }
      rows[row.ref] = child.value;
    }
    // Keys that name no row are DROPPED, not errors: the anti-tamper layer upstream records
    // unknown-variable writes; a stale row ref in a resubmitted form should not strand the
    // respondent behind an error they cannot see.
    return ok({ rows });
  },

  toVariables(answer, ctx) {
    const out: Record<string, ReturnType<typeof JSON.parse>> = {};
    for (const [index, row] of ctx.question.rows.entries()) {
      const cell = answer.rows[row.ref];
      if (cell === undefined) continue;
      Object.assign(
        out,
        ctx.delegateToVariables(
          rowScope(row, index),
          controlForRow(ctx.config, ctx.question.cells, row.ref),
          cell,
        ),
      );
    }
    return out;
  },

  fromVariables(vars, ctx) {
    const rows: Record<string, unknown> = {};
    for (const [index, row] of ctx.question.rows.entries()) {
      rows[row.ref] = ctx.delegateFromVariables(
        rowScope(row, index),
        controlForRow(ctx.config, ctx.question.cells, row.ref),
        vars,
      );
    }
    return { rows };
  },

  // The canonical empty carries EVERY row as its child's empty answer — built through the same
  // delegate `fromVariables` uses, so "never answered" and "answered nothing" are one value and
  // the round-trip law (`fromVariables(toVariables(empty)) ≡ empty`) holds by construction.
  emptyAnswer: (ctx) => {
    const rows: Record<string, unknown> = {};
    for (const [index, row] of ctx.question.rows.entries()) {
      rows[row.ref] = ctx.delegateFromVariables(
        rowScope(row, index),
        controlForRow(ctx.config, ctx.question.cells, row.ref),
        {},
      );
    }
    return { rows };
  },
};

export const matrixCore: QuestionTypePluginCore<MatrixConfig, MatrixAnswer> = {
  meta: {
    id: 'matrix',
    version: '1.0.0',
    displayName: 'qt.matrix.name',
    description: 'qt.matrix.desc',
    category: 'grid',
    icon: 'grid',
    entitlementKey: null,
    trust: 'first_party',
    // Rule 4: a grid does not nest. `compose` enforces it; declaring it here keeps the picker
    // from ever offering a matrix as a cell control.
    composable: false,
    emitsData: true,
  },

  configSchema: MATRIX_CONFIG_SCHEMA,

  defaultConfig: () => ({
    responseMode: 'single',
    defaultCellConfig: null,
    mobileLayout: 'stacked',
  }),

  declareVariables(ctx) {
    const out: VariableDeclaration[] = [];
    ctx.rows.forEach((row, index) => {
      const children = ctx.compose(rowScope(row, index), controlForRow(ctx.config, ctx.cells, row.ref));
      for (const child of children) {
        out.push({
          ...child,
          export: {
            ...child.export,
            // F §3.1's arithmetic: the row's block of a hundred, then the child's own order
            // within the cell. Derived from the row CODE, so dragging a row in the editor does
            // not renumber a tracker's columns.
            order: row.code * 100 + child.export.order,
            labelKey: row.labelKey,
          },
          // One battery: banners and analysis group the grid's variables by the QUESTION, not
          // by whichever plugin happened to produce each column.
          analysis: { ...(child.analysis ?? { measure: 'nominal' }), batteryRef: ctx.ref },
        });
      }
    });
    return out;
  },

  validate(ctx) {
    const issues: ValidationIssue[] = [];
    const answer = ctx.value ?? { rows: {} };
    ctx.question.rows.forEach((row, index) => {
      const childIssues = ctx.delegateValidate(
        rowScope(row, index),
        controlForRow(ctx.question.config, ctx.question.cells, row.ref),
        // Row-level required inherits the question's: a required grid means every row, which is
        // what every respondent expects a grid's asterisk to mean. Per-row requiredness is an
        // authoring feature the schema does not carry yet.
        { value: answer.rows[row.ref], required: ctx.required },
      );
      for (const issue of childIssues) {
        issues.push({
          ...issue,
          // The child cannot know which row it is; the focus target is the parent's knowledge.
          focus: { ...(issue.focus ?? {}), rowRef: row.ref },
        });
      }
    });
    return issues;
  },

  codec,

  exportContribution: {
    // The row's own label is already the column's `labelKey` (declareVariables); the readable
    // column label is "question — row", which is what every analysis deck ends up typing by
    // hand when a tool exports bare row labels.
    columnLabel: (declaration, ctx) =>
      `${ctx.t(ctx.question.label)} — ${ctx.t(declaration.export.labelKey)}`,
    valueLabels: (declaration, ctx) =>
      declaration.type === 'enum'
        ? (declaration.enumDomain ?? []).map((entry) => ({
            code: entry.code,
            label: ctx.t(entry.labelKey),
          }))
        : [],
  },

  a11y: {
    // A grid of radios is navigated as a grid: arrows move within it, Tab leaves it (F §8).
    interactionModel: 'grid',
    requiredRoles: ['grid'],
    keys: ['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Space'],
    minTouchTargetPx: 44,
    pointerDependent: false,
    rtlSafe: true,
  } satisfies A11yContract,

  staticChecks(ctx) {
    const out: PluginDiagnostic[] = [];
    if (ctx.rows.length === 0) {
      out.push({
        code: 'no_rows',
        severity: 'error',
        message: 'a matrix requires at least one row',
        path: '/rows',
      });
    }
    // Columns are required whenever any row draws on them — which is every row without an
    // override, and any override that says use_columns.
    const rowsNeedingColumns = ctx.rows.filter((row) => {
      const control = controlForRow(ctx.config, ctx.cells, row.ref);
      return control.use_columns === true;
    });
    if (rowsNeedingColumns.length > 0 && ctx.columns.length === 0) {
      out.push({
        code: 'no_columns',
        severity: 'error',
        message: `${rowsNeedingColumns.length} row(s) draw their choices from the shared columns, and there are none`,
        path: '/columns',
      });
    }
    for (const cell of ctx.cells) {
      if (!ctx.rows.some((row) => row.ref === cell.row_ref)) {
        out.push({
          code: 'override_unknown_row',
          severity: 'error',
          message: `a cell override names row ${JSON.stringify(cell.row_ref)}, which does not exist`,
          path: '/cells',
        });
      }
      if (cell.column_ref != null) {
        // Per-row only in P1 — see the header's shape decision 1. A diagnosed skip, not a
        // silent one: the author wrote a per-cell override and must learn it did nothing.
        out.push({
          code: 'per_cell_override_unsupported',
          severity: 'error',
          message:
            `the override on ${cell.row_ref}×${cell.column_ref} targets a single cell; ` +
            'P1 matrices compose per row (omit column_ref)',
          path: '/cells',
        });
      }
    }
    if (ctx.options.length > 0) {
      out.push({
        code: 'options_ignored',
        severity: 'warning',
        message: 'a matrix reads rows and columns; authored options are ignored',
        path: '/options',
      });
    }
    if (ctx.rows.length > 30) {
      out.push({
        code: 'long_grid',
        severity: 'warning',
        message:
          `${ctx.rows.length} rows in one grid measurably increases straightlining; ` +
          'consider splitting or looping',
        path: '/rows',
      });
    }
    return out;
  },
};
