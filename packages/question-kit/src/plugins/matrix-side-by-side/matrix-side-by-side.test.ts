// @vitest-environment jsdom
/**
 * `matrix_side_by_side` against the conformance harness.
 *
 * The fixture that carries the weight is `mixed_blocks`: the same three brands asked a numeric
 * question, a text question and a single-select over the shared columns, all in one grid. It must
 * declare nine columns — three rows x three blocks — of three different types, with this plugin
 * knowing none of their shapes. That is `matrix`'s acceptance line taken one dimension further,
 * and it is the whole claim of the format.
 *
 * The other property under test is the EXPORT ORDER. `matrix` defers the per-cell grid because
 * "which column does `Q5r3c2` sort under?" has no general answer for a ragged grid. It has an
 * obvious one here, because every row gets every block: `row.code * 100 + column.code * 10 +
 * child.order`, which puts each row's blocks adjacent and the rows in order — how the grid reads on
 * paper. `block_code_too_large` is the check that keeps that arithmetic from carrying between rows.
 *
 * Note the model: **a block IS a column.** Config maps a column ref to the control that fills it;
 * the block's identity (ref, code, label) is the column item's. `core.ts`' header records why —
 * the compose machinery refuses a `cell` scope whose column the question does not declare, because
 * schema §4's `cell` part carries a `column_ref` and nothing else could be rebuilt from the
 * registry.
 */

import { createElement, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { definePluginTests, item } from '../../testkit/index.js';
import { createRenderContext } from '../../testkit/render.js';
import { fixtureQuestion } from '../../testkit/spec.js';
import { createRegistry } from '../../registry.js';
import { resolveComposedChild } from '../../compose-host.js';
import { declareVariablesFor } from '../../declare.js';
import type { AnyPluginCore } from '../../contract/plugin.js';
import type { AuthoredQuestion } from '../../contract/authored.js';
import type { RenderContext } from '../../contract/view.js';
import { singleSelectCore } from '../single-select/core.js';
import { singleSelect } from '../single-select/react.js';
import { numericCore } from '../numeric/core.js';
import { numeric } from '../numeric/react.js';
import { textCore } from '../text/core.js';
import { text } from '../text/react.js';
import { matrixSideBySide } from './react.js';
import type { MatrixSideBySideConfig, SideBySideBlock } from './core.js';

const CHILD_CORES: readonly AnyPluginCore[] = [singleSelectCore, numericCore, textCore];
const CHILD_REACT = { single_select: singleSelect, numeric, text } as const;

const ROWS = [item('r1', 1), item('r2', 2), item('r3', 3)];

/**
 * The COLUMNS are the blocks: `quality` (a scale), `spend` (numeric), `note` (text).
 *
 * Every fixture shares this list, because the render host resolves a child against ONE question —
 * the same constraint `matrix.test.ts` works within. Fixtures vary the rows, the config and which
 * blocks are configured, which is where the interesting differences are anyway.
 */
const BLOCKS = [
  item('quality', 1, { labelKey: 'block.quality' }),
  item('spend', 2, { labelKey: 'block.spend' }),
  item('note', 3, { labelKey: 'block.note' }),
];

/**
 * A choice block carries its OWN options rather than drawing on shared columns — in this grid the
 * columns are the blocks, so `use_columns` would offer the block list as the answers. This is what
 * `CellControl.options` was added for; see `core.ts`' header.
 */
const SCALE = [
  item('s1', 1, { labelKey: 'scale.low' }),
  item('s2', 2, { labelKey: 'scale.mid' }),
  item('s3', 3, { labelKey: 'scale.high' }),
];

const scaleControl = {
  question_type: 'single_select',
  config: { display: 'dropdown', other: { enabled: false } },
  options: SCALE,
} as const;

const SCALE_BLOCK: SideBySideBlock = { column_ref: 'quality', control: scaleControl };

const SPEND_BLOCK: SideBySideBlock = {
  column_ref: 'spend',
  control: {
    question_type: 'numeric',
    config: { display: 'input', decimals: 0, min: 0, max: 100 },
  },
};
const NOTE_BLOCK: SideBySideBlock = {
  column_ref: 'note',
  control: {
    question_type: 'text',
    config: { maxLen: 200, placeholderKey: null, inputMode: 'text' },
  },
};

/** The headline: three brands x (scale, numeric, text) — nine columns, three types, one grid. */
const MIXED: MatrixSideBySideConfig = {
  blocks: [SCALE_BLOCK, SPEND_BLOCK, NOTE_BLOCK],
  mobileLayout: 'scroll',
};

/**
 * Only the scale block configured: `spend` and `note` fall back to a text box.
 *
 * Exercises `controlForBlock`'s fallback, which is `text` rather than a choice control precisely
 * because an unconfigured choice block would have no answer scale — see its comment.
 */
const PARTIAL: MatrixSideBySideConfig = {
  blocks: [SCALE_BLOCK],
  mobileLayout: 'scroll',
};

/**
 * The render-side host: resolve the child exactly the way the codec host does, then render the
 * child's own React renderer — the construction studio's preview and the runtime's hydration will
 * each implement over the same `resolveComposedChild`, so a drift between "the cell that parsed"
 * and "the cell that rendered" fails here first. Same shape `matrix.test.ts` uses.
 */
function renderChildFor(
  question: AuthoredQuestion<MatrixSideBySideConfig>,
): RenderContext['renderChild'] {
  const registry = createRegistry<AnyPluginCore>();
  for (const core of CHILD_CORES) registry.register(core, { trust: 'first_party' });
  return (scope, control, props): ReactNode => {
    const seat = resolveComposedChild(
      question as AuthoredQuestion<unknown>,
      registry,
      scope,
      control,
    );
    const child = CHILD_REACT[control.question_type as keyof typeof CHILD_REACT];
    return createElement(child.renderer as never, {
      question: seat.resolved,
      value: props.value,
      onChange: props.onChange,
      issues: props.issues,
      ctx: createRenderContext(),
    } as never);
  };
}

const MIXED_FIXTURE = {
  config: MIXED,
  required: true,
  rows: ROWS,
  columns: BLOCKS,
};

definePluginTests(matrixSideBySide, {
  host: {
    childCores: CHILD_CORES,
    renderChild: renderChildFor(fixtureQuestion('matrix_side_by_side', MIXED_FIXTURE)),
  },

  fixtures: {
    minimal: { config: MIXED, rows: ROWS.slice(0, 2), columns: BLOCKS },
    mixed_blocks: MIXED_FIXTURE,
    partial_config: { config: PARTIAL, rows: ROWS.slice(0, 1), columns: BLOCKS },
    stacked: {
      config: { ...MIXED, mobileLayout: 'stacked' },
      rows: ROWS.slice(0, 1),
      columns: BLOCKS,
    },
    excluded_from_export: {
      config: MIXED,
      rows: ROWS.slice(0, 1),
      columns: BLOCKS,
      flags: { excludeFromExport: true },
    },
  },

  variableSnapshots: {
    expected: {
      // Two rows x two scale blocks: `Qr{row}c{block}`, the cell name shape the compose machinery
      // sanctions for a row-scope fan-out.
      minimal: [
        'Q1r1c1 response enum [1,2,3]',
        'Q1r1c2 response number',
        'Q1r1c3 response text (pii)',
        'Q1r2c1 response enum [1,2,3]',
        'Q1r2c2 response number',
        'Q1r2c3 response text (pii)',
      ],
      // The two unconfigured blocks fall back to text boxes.
      partial_config: [
        'Q1r1c1 response enum [1,2,3]',
        'Q1r1c2 response text (pii)',
        'Q1r1c3 response text (pii)',
      ],
      // THE ACCEPTANCE LINE, one dimension past `matrix`'s: three rows x three blocks = nine
      // columns of three different types, none of whose shapes this plugin knows. The text block
      // is (pii) because `text` hard-defaults open-ends to PII — the grid inherits the child's
      // honesty rather than overriding it.
      mixed_blocks: [
        'Q1r1c1 response enum [1,2,3]',
        'Q1r1c2 response number',
        'Q1r1c3 response text (pii)',
        'Q1r2c1 response enum [1,2,3]',
        'Q1r2c2 response number',
        'Q1r2c3 response text (pii)',
        'Q1r3c1 response enum [1,2,3]',
        'Q1r3c2 response number',
        'Q1r3c3 response text (pii)',
      ],
      stacked: [
        'Q1r1c1 response enum [1,2,3]',
        'Q1r1c2 response number',
        'Q1r1c3 response text (pii)',
      ],
      excluded_from_export: [
        'Q1r1c1 response enum [1,2,3] (unexported)',
        'Q1r1c2 response number (unexported)',
        'Q1r1c3 response text (unexported,pii)',
      ],
    },
    assertOrderIndependent: true,
    assertDeterministic: true,
    assertRenameCoherent: true,
    assertAnalysable: true,
  },

  render: {
    dirs: ['ltr', 'rtl'],
    devices: ['desktop', 'tablet', 'mobile'],
    states: {
      empty: {},
      partial: { value: { rows: { r1: { quality: { code: 2, otherText: null } } } } },
      with_errors: {
        value: { rows: {} },
        issues: [
          {
            variableName: 'Q1r1c1',
            messageKey: 'err.required',
            severity: 'error',
            focus: { rowRef: 'r1', columnRef: 'quality' },
          },
        ],
      },
    },
    assertSsrHydrationClean: true,
    // Table layout, no physical offsets: the two-row header and the cells are DOM structure, and
    // the theme owns direction.
    assertNoPhysicalDirectionLeak: true,
  },

  validation: [
    { fixture: 'minimal', value: undefined, required: false, expect: [] },
    // A required grid means every cell — the same position `matrix` takes on per-row.
    {
      // A required grid means every cell: two rows x three blocks = six messages.
      fixture: 'minimal',
      value: { rows: {} },
      required: true,
      expect: [
        'err.required', 'err.required', 'err.required',
        'err.required', 'err.required', 'err.required',
      ],
    },
    {
      fixture: 'minimal',
      value: {
        rows: {
          r1: { quality: { code: 1, otherText: null }, spend: { value: 10 }, note: { text: 'a' } },
          r2: { quality: { code: 2, otherText: null }, spend: { value: 20 }, note: { text: 'b' } },
        },
      },
      required: true,
      expect: [],
    },
  ],
  assertValidationSidesAgree: true,

  codec: {
    roundTrip: {
      minimal: [
        {
          rows: {
            r1: { quality: { code: 1, otherText: null }, spend: { value: 5 }, note: { text: 'x' } },
            r2: {
              quality: { code: null, otherText: null },
              spend: { value: null },
              note: { text: null },
            },
          },
        },
      ],
    },
    extraHostileInputs: [
      { rows: 5 },
      { rows: [] },
      { rows: { r1: 5 } },
      { rows: { ghost: {} } },
      { rows: { r1: { quality: { code: 99 } } } },
      { rows: { r1: { ghostblock: { code: 1 } } } },
      { rows: { r1: [] } },
    ],
    assertNoThrow: true,
    assertVariablesSubsetOfDeclared: true,
  },

  a11y: {
    assertContractRolesPresent: true,
    assertSingleTabStopPerGroup: true,
    assertTouchTargets: true,
    assertNoLocalLiveRegion: true,
    assertErrorWiring: true,
  },

  staticChecks: [
    { fixture: 'minimal', expect: [] },
    { fixture: 'mixed_blocks', expect: [] },
    {
      // No columns means no blocks: the grid has nothing to ask about each row.
      //
      // The config's blocks are cleared alongside them, so this case isolates ONE diagnostic:
      // leaving them would also (correctly) report three orphaned `block_column_missing`, and a
      // fixture that trips two checks makes a failure ambiguous about which one regressed.
      fixture: 'minimal',
      mutate: (q) => ({ ...q, columns: [], config: { ...q.config, blocks: [] } }),
      expect: ['no_blocks'],
    },
    {
      fixture: 'minimal',
      mutate: (q) => ({
        ...q,
        columns: BLOCKS.slice(0, 1),
        config: { ...q.config, blocks: [SCALE_BLOCK] },
      }),
      expect: ['single_block'],
    },
    {
      fixture: 'minimal',
      mutate: (q) => ({ ...q, rows: [] }),
      expect: ['no_rows'],
    },
    {
      // The arithmetic guard: `row*100 + column*10 + child`, so a column code above 9 carries into
      // the next row's band and columns from different rows interleave.
      fixture: 'minimal',
      mutate: (q) => ({
        ...q,
        columns: [BLOCKS[0] as never, item('spend', 12, { labelKey: 'block.spend' })],
        config: { ...q.config, blocks: [SCALE_BLOCK, SPEND_BLOCK] },
      }),
      expect: ['block_code_too_large'],
    },
    {
      // A stale block: what an author leaves behind by deleting a column without clearing its
      // control. It would silently never render.
      fixture: 'minimal',
      mutate: (q) => ({
        ...q,
        config: { ...q.config, blocks: [SCALE_BLOCK, { ...SPEND_BLOCK, column_ref: 'ghost' }] },
      }),
      expect: ['block_column_missing'],
    },
    {
      // Two controls for one column: the second wins by array order, which is not a decision an
      // author made.
      fixture: 'minimal',
      mutate: (q) => ({
        ...q,
        config: { ...q.config, blocks: [SCALE_BLOCK, { ...SPEND_BLOCK, column_ref: 'quality' }] },
      }),
      expect: ['duplicate_block_column'],
    },
    {
      // Per-cell overrides are how a ragged grid would sneak in, and raggedness is exactly what
      // makes the export layout undecidable.
      fixture: 'minimal',
      mutate: (q) => ({
        ...q,
        cells: [{ row_ref: 'r1', column_ref: 'quality', control: { question_type: 'text' } }],
      }),
      expect: ['cell_overrides_ignored'],
    },
  ],

  composition: {
    // A parent, never a child: F §3.1 rule 4 forbids a composed control from composing.
    asChildOf: [],
    asParentOf: ['single_select', 'numeric', 'text'],
    assertChildNamespacing: false,
    assertTrustCompatibility: true,
  },
});

/* -------------------------------------------------------------------------- */
/* Properties specific to this plugin                                         */
/* -------------------------------------------------------------------------- */

describe('export order', () => {
  function ordersFor(
    config: MatrixSideBySideConfig,
    columns: readonly ReturnType<typeof item>[] = BLOCKS,
  ) {
    const question = fixtureQuestion('matrix_side_by_side', { config, rows: ROWS, columns });
    const registry = createRegistry<AnyPluginCore>();
    for (const core of CHILD_CORES) registry.register(core, { trust: 'first_party' });
    return declareVariablesFor(matrixSideBySide, question, { registry }).declarations.map((d) => ({
      name: d.name,
      order: d.export.order,
    }));
  }

  it('sorts row-major, so each row\'s blocks export adjacent', () => {
    // The question `matrix` defers ("which column does Q5r3c2 sort under?"), answered — and the
    // answer is only available because a side-by-side grid is regular by construction.
    const orders = ordersFor(MIXED);
    const sorted = [...orders].sort((a, b) => a.order - b.order).map((o) => o.name);

    expect(sorted).toEqual([
      'Q1r1c1', 'Q1r1c2', 'Q1r1c3',
      'Q1r2c1', 'Q1r2c2', 'Q1r2c3',
      'Q1r3c1', 'Q1r3c2', 'Q1r3c3',
    ]);
  });

  it('is derived from codes, so reordering columns does not renumber export columns', () => {
    // The same rule an option's code follows: dragging in the editor must not move a tracker's
    // columns (F §1.1 rule 2). Both the config order AND the column order are varied, because
    // either could have leaked an array index into the arithmetic.
    const forward = ordersFor(MIXED);
    const reversedConfig = ordersFor({ ...MIXED, blocks: [...MIXED.blocks].reverse() });
    const reversedColumns = ordersFor(MIXED, [...BLOCKS].reverse());

    const byName = (list: readonly { name: string; order: number }[]) =>
      Object.fromEntries(list.map((o) => [o.name, o.order]));
    expect(byName(reversedConfig)).toEqual(byName(forward));
    expect(byName(reversedColumns)).toEqual(byName(forward));
  });

  it('gives every cell a distinct order', () => {
    // A collision means two variables competing for one export column, which is what
    // `duplicate_block_code` and `block_code_too_large` exist to prevent at publish.
    const orders = ordersFor(MIXED).map((o) => o.order);

    expect(new Set(orders).size).toBe(orders.length);
  });
});

describe('the grid is opaque to its cells', () => {
  it('declares nine typed columns from three plugins without naming their shapes', () => {
    // The acceptance line, asserted as a property rather than only as a snapshot.
    const question = fixtureQuestion('matrix_side_by_side', MIXED_FIXTURE);
    const registry = createRegistry<AnyPluginCore>();
    for (const core of CHILD_CORES) registry.register(core, { trust: 'first_party' });

    const declarations = declareVariablesFor(matrixSideBySide, question, { registry }).declarations;

    expect(declarations).toHaveLength(9);
    const types = new Set(declarations.map((d) => d.type));
    expect([...types].sort()).toEqual(['enum', 'number', 'text']);
    // Every column is in the ONE battery, so banners group by the question rather than by
    // whichever plugin produced each column.
    expect(declarations.every((d) => d.analysis?.batteryRef === 'Q1')).toBe(true);
  });
});
