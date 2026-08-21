// @vitest-environment jsdom
/**
 * `matrix` against the conformance harness — the P1-05 acceptance test.
 *
 * The `mixed` fixture IS the roadmap's acceptance line: rows `[numeric 0–100, text max 200,
 * single_select over columns]` must declare exactly `Q1r1 : number`, `Q1r2 : text`,
 * `Q1r3 : enum` with the columns as the domain — three plugins' variables through one grid,
 * with the matrix knowing none of their shapes. The codec and validation cases then prove the
 * OTHER half of delegation: a submitted payload parses into three differently-typed values and
 * each row is validated by its own plugin's rules.
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
import { multiSelectCore } from '../multi-select/core.js';
import { multiSelect } from '../multi-select/react.js';
import { numericCore } from '../numeric/core.js';
import { numeric } from '../numeric/react.js';
import { textCore } from '../text/core.js';
import { text } from '../text/react.js';
import { matrix } from './react.js';
import type { MatrixConfig } from './core.js';

const CHILD_CORES: readonly AnyPluginCore[] = [
  singleSelectCore,
  multiSelectCore,
  numericCore,
  textCore,
];
const CHILD_REACT = { single_select: singleSelect, multi_select: multiSelect, numeric, text } as const;

const base: MatrixConfig = {
  responseMode: 'single',
  defaultCellConfig: null,
  mobileLayout: 'stacked',
};

const ROWS = [item('r1', 1), item('r2', 2), item('r3', 3)];
const COLUMNS = [item('c1', 1), item('c2', 2), item('c3', 3), item('c4', 4)];

/** THE mixed fixture: a numeric row, a text row, and a default single-select row. */
const MIXED_CELLS = [
  {
    row_ref: 'r1',
    control: {
      question_type: 'numeric',
      config: { display: 'input', decimals: 0, min: 0, max: 100 },
    },
  },
  {
    row_ref: 'r2',
    control: { question_type: 'text', config: { maxLen: 200 } },
  },
] as const;

/**
 * The render-side host: resolve the child exactly the way the codec host does, then render the
 * child's own React renderer. This function is what studio's preview and the runtime's
 * hydration will each implement over the same `resolveComposedChild` — the test uses the real
 * construction so a drift between "the cell that parsed" and "the cell that rendered" fails
 * here first.
 */
function renderChildFor(question: AuthoredQuestion<MatrixConfig>): RenderContext['renderChild'] {
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
  config: base,
  required: true,
  rows: ROWS,
  columns: COLUMNS,
  cells: [...MIXED_CELLS],
};

definePluginTests(matrix, {
  host: {
    childCores: CHILD_CORES,
    renderChild: renderChildFor(fixtureQuestion('matrix', MIXED_FIXTURE)),
  },

  fixtures: {
    minimal: { config: base, rows: ROWS.slice(0, 2), columns: COLUMNS },
    mixed: MIXED_FIXTURE,
    multi_mode: {
      config: { ...base, responseMode: 'multi' },
      rows: ROWS.slice(0, 2),
      columns: COLUMNS.slice(0, 2),
    },
    excluded_from_export: {
      config: base,
      rows: ROWS.slice(0, 1),
      columns: COLUMNS,
      flags: { excludeFromExport: true },
    },
  },

  variableSnapshots: {
    expected: {
      minimal: ['Q1r1 response enum [1,2,3,4]', 'Q1r2 response enum [1,2,3,4]'],
      // THE ACCEPTANCE LINE: three types from three plugins, one grid. The text row is (pii)
      // because `text` hard-defaults open-ends to PII — the matrix inherits the child's honesty.
      mixed: [
        'Q1r1 response number',
        'Q1r2 response text (pii)',
        'Q1r3 response enum [1,2,3,4]',
      ],
      // multi mode: each row is a multi_select over the columns — per-column booleans plus the
      // set view, exactly what the child declares for itself.
      multi_mode: [
        'Q1r1c1 response boolean',
        'Q1r1c2 response boolean',
        'Q1r1 derived set [1,2] <set_view> (unexported,transient)',
        'Q1r2c1 response boolean',
        'Q1r2c2 response boolean',
        'Q1r2 derived set [1,2] <set_view> (unexported,transient)',
      ],
      excluded_from_export: ['Q1r1 response enum [1,2,3,4] (unexported)'],
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
      partially_answered: {
        value: { rows: { r3: { code: 2, otherText: null } } },
      },
      with_errors: {
        value: { rows: {} },
        issues: [
          {
            variableName: 'Q1r1',
            messageKey: 'err.required',
            severity: 'error',
            focus: { rowRef: 'r1' },
          },
        ],
      },
    },
    assertSsrHydrationClean: true,
    assertNoPhysicalDirectionLeak: true,
  },

  validation: [
    // A required grid: every row's own plugin reports its own emptiness.
    {
      fixture: 'mixed',
      value: { rows: {} },
      required: true,
      expect: ['err.required', 'err.required', 'err.required'],
      expectFocus: { rowRef: 'r1' },
    },
    // Fill two rows: only the remaining row complains, and the focus names it.
    {
      fixture: 'mixed',
      value: {
        rows: {
          r1: { value: 50 },
          r3: { code: 2, otherText: null },
        },
      },
      required: true,
      expect: ['err.required'],
      expectFocus: { rowRef: 'r2' },
    },
    // The numeric row's OWN range rule fires through the delegation seam.
    {
      fixture: 'mixed',
      value: {
        rows: {
          r1: { value: 250 },
          r2: { text: 'fine' },
          r3: { code: 2, otherText: null },
        },
      },
      required: true,
      expect: ['err.out_of_range'],
      expectFocus: { rowRef: 'r1' },
    },
    { fixture: 'mixed', value: { rows: {} }, required: false, expect: [] },
    {
      fixture: 'mixed',
      value: {
        rows: {
          r1: { value: 50 },
          r2: { text: 'because' },
          r3: { code: 2, otherText: null },
        },
      },
      required: true,
      expect: [],
    },
  ],
  assertValidationSidesAgree: true,

  codec: {
    roundTrip: {
      // Complete answers only: `fromVariables` reconstructs EVERY row (an unanswered row is the
      // child's own empty answer), so a round-trippable answer names each row.
      mixed: [
        {
          rows: {
            r1: { value: 42 },
            r2: { text: 'verbatim' },
            r3: { code: 3, otherText: null },
          },
        },
        {
          rows: {
            r1: { value: null },
            r2: { text: null },
            r3: { code: null, otherText: null },
          },
        },
      ],
    },
    extraHostileInputs: [
      { rows: 'not-an-object' },
      { rows: { r1: { value: 'NaN' } } },
      { rows: { ghost_row: { value: 1 } } },
      { rows: { r1: { __proto__: { polluted: true } } } },
    ],
    assertNoThrow: true,
    assertVariablesSubsetOfDeclared: true,
  },

  a11y: {
    assertContractRolesPresent: true,
    // A grid is MANY groups: each cell's control is its own radiogroup/textbox with its own
    // tab stop, and F §8's one-stop rule applies per group, not per grid. Asserted false here,
    // honestly, rather than gamed with a container that hides its children from the counter.
    assertSingleTabStopPerGroup: false,
    assertTouchTargets: true,
    assertNoLocalLiveRegion: true,
    assertErrorWiring: true,
  },

  staticChecks: [
    { fixture: 'mixed', expect: [] },
    {
      fixture: 'mixed',
      // Removing the rows also strands the two per-row overrides — both facts diagnosed.
      mutate: (q) => ({ ...q, rows: [] }),
      expect: ['no_rows', 'override_unknown_row', 'override_unknown_row'],
    },
    {
      fixture: 'minimal',
      mutate: (q) => ({ ...q, columns: [] }),
      expect: ['no_columns'],
    },
    {
      fixture: 'mixed',
      mutate: (q) => ({
        ...q,
        cells: [...q.cells, { row_ref: 'ghost', control: { question_type: 'text' } }],
      }),
      expect: ['override_unknown_row'],
    },
    {
      fixture: 'mixed',
      mutate: (q) => ({
        ...q,
        cells: [
          ...q.cells,
          { row_ref: 'r3', column_ref: 'c1', control: { question_type: 'text' } },
        ],
      }),
      expect: ['per_cell_override_unsupported'],
    },
    {
      fixture: 'mixed',
      mutate: (q) => ({ ...q, options: [item('o1', 1)] }),
      expect: ['options_ignored'],
    },
  ],

  composition: {
    asChildOf: [], // rule 4: a grid does not nest
    asParentOf: ['single_select', 'multi_select', 'numeric', 'text'],
    assertChildNamespacing: false,
    assertTrustCompatibility: false,
  },
});

/* ------------------------------------------------------------------ *
 * The delegation properties the generic harness cannot express
 * ------------------------------------------------------------------ */

describe('matrix delegation (F §3)', () => {
  const registryOf = () => {
    const registry = createRegistry<AnyPluginCore>();
    for (const core of CHILD_CORES) registry.register(core, { trust: 'first_party' });
    return registry;
  };
  const question = fixtureQuestion('matrix', MIXED_FIXTURE);

  it('THE ACCEPTANCE CRITERION: three row types declare three typed variables', () => {
    const result = declareVariablesFor(matrix, question, { registry: registryOf() });
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const byName = Object.fromEntries(result.declarations.map((d) => [d.name, d]));

    expect(byName['Q1r1']?.type).toBe('number');
    expect(byName['Q1r2']?.type).toBe('text');
    expect(byName['Q1r3']?.type).toBe('enum');
    // The enum domain IS the shared column list — `use_columns` handed over, codes intact.
    expect((byName['Q1r3']?.enumDomain ?? []).map((entry) => entry.code)).toEqual([1, 2, 3, 4]);
  });

  it('export order is row-code arithmetic, so dragging a row cannot renumber a tracker', () => {
    const result = declareVariablesFor(matrix, question, { registry: registryOf() });
    const orders = Object.fromEntries(
      result.declarations.map((d) => [d.name, d.export.order]),
    );
    expect(orders['Q1r1']).toBe(100); // row code 1 × 100 + child order 0
    expect(orders['Q1r2']).toBe(200);
    expect(orders['Q1r3']).toBe(300);
  });

  it('every declaration is one battery, keyed by the QUESTION', () => {
    const result = declareVariablesFor(matrix, question, { registry: registryOf() });
    for (const declaration of result.declarations) {
      expect(declaration.analysis?.batteryRef).toBe('Q1');
    }
  });

  it('a submitted mixed payload parses into three differently-typed stored values', async () => {
    const { createComposeDelegates } = await import('../../compose-host.js');
    const { createCodecContext, resolveQuestion } = await import('../../resolve.js');
    const registry = registryOf();
    const result = declareVariablesFor(matrix, question, { registry });
    const resolved = resolveQuestion(question, result.declarations);
    const ctx = createCodecContext({
      question,
      resolved,
      delegates: createComposeDelegates(question as AuthoredQuestion<unknown>, registry),
    });

    const parsed = matrix.codec.parse(
      { rows: { r1: { value: 42 }, r2: { text: 'because' }, r3: { code: 2, otherText: null } } },
      ctx,
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const vars = matrix.codec.toVariables(parsed.value, ctx);
    expect(vars).toEqual({ Q1r1: 42, Q1r2: 'because', Q1r3: 2 });

    // And back: storage -> answer, each row through its own child's fromVariables.
    const back = matrix.codec.fromVariables(vars, ctx);
    expect(back).toEqual({
      rows: { r1: { value: 42 }, r2: { text: 'because' }, r3: { code: 2, otherText: null } },
    });
  });

  it("a child's codec rejection surfaces with the row on its path", async () => {
    const { createComposeDelegates } = await import('../../compose-host.js');
    const { createCodecContext, resolveQuestion } = await import('../../resolve.js');
    const registry = registryOf();
    const result = declareVariablesFor(matrix, question, { registry });
    const resolved = resolveQuestion(question, result.declarations);
    const ctx = createCodecContext({
      question,
      resolved,
      delegates: createComposeDelegates(question as AuthoredQuestion<unknown>, registry),
    });

    const parsed = matrix.codec.parse({ rows: { r1: { value: 'forty-two' } } }, ctx);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.path).toContain('/rows/r1');
  });
});
