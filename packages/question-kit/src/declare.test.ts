/**
 * `declareVariablesFor` — the composition rules (F §3.1) and the declaration invariants.
 *
 * Every one of F §3.1's six numbered rules gets a test that *violates* it and asserts the
 * diagnostic. A composition engine whose rules are only exercised by conforming input is a
 * composition engine with no rules: the failure mode is a cell control quietly writing a column
 * that belongs to another question, which is discovered by a client's analyst rather than by us.
 */

import { describe, expect, it } from 'vitest';
import { declareVariablesFor, verifyDeclarations } from './declare.js';
import { createRegistry, type PluginRegistry } from './registry.js';
import { singleSelectCore } from './plugins/single-select/core.js';
import { multiSelectCore } from './plugins/multi-select/core.js';
import { npsCore } from './plugins/nps/core.js';
import { testParentCore, type TestParentConfig } from './testkit/parent.js';
import { item } from './testkit/spec.js';
import type { AnyPluginCore } from './contract/plugin.js';
import type { AuthoredQuestion } from './contract/authored.js';
import type { VariableDeclaration } from './contract/variables.js';
import type { NamerSpec } from './naming.js';

const columns = [item('c1', 1), item('c2', 2), item('c3', 3)];
const rows = [item('r1', 1), item('r2', 2)];

const childConfig = {
  display: 'dropdown',
  columns: 1,
  other: { enabled: false, optionRef: null, maxLen: 200, required: true },
  allowDeselect: false,
};

function parentQuestion(
  overrides: Partial<AuthoredQuestion<TestParentConfig>> = {},
  config: Partial<TestParentConfig> = {},
): AuthoredQuestion<TestParentConfig> {
  return {
    ref: 'Q5',
    questionType: 'test_parent',
    label: 'Q5.label',
    instruction: null,
    required: true,
    config: {
      childType: 'single_select',
      useColumns: true,
      childConfig,
      ...config,
    },
    options: [],
    rows,
    columns,
    cells: [],
    flags: { pii: false, excludeFromExport: false },
    loop: null,
    ...overrides,
  };
}

function registryWith(
  entries: readonly (readonly [AnyPluginCore, Parameters<PluginRegistry<AnyPluginCore>['register']>[1]])[],
  options: Parameters<typeof createRegistry>[0] = {},
): PluginRegistry<AnyPluginCore> {
  const registry = createRegistry<AnyPluginCore>(options);
  for (const [plugin, source] of entries) registry.register(plugin, source);
  return registry;
}

const codes = (diagnostics: readonly { readonly code: string }[]): readonly string[] =>
  diagnostics.map((diagnostic) => diagnostic.code);

describe('composition, the happy path', () => {
  const registry = registryWith([
    [singleSelectCore, { trust: 'first_party' }],
    [testParentCore, { trust: 'first_party' }],
  ]);

  it('delegates declaration to the child and contributes only the name scope and domain', () => {
    const result = declareVariablesFor(testParentCore, parentQuestion(), { registry });
    expect(result.diagnostics).toEqual([]);
    expect(result.declarations.map((declaration) => declaration.name)).toEqual(['Q5r1', 'Q5r2']);
    // The child is a single_select, so each cell is an enum — over the *parent's* columns, which is
    // the only thing `use_columns` means.
    for (const declaration of result.declarations) {
      expect(declaration.type).toBe('enum');
      expect(declaration.enumDomain?.map((entry) => entry.code)).toEqual([1, 2, 3]);
      expect(declaration.source.part).toEqual({
        kind: 'cell',
        rowRef: declaration.name === 'Q5r1' ? 'r1' : 'r2',
      });
    }
  });

  it('gives the parent room to order columns by row code, not by iteration index', () => {
    const result = declareVariablesFor(
      testParentCore,
      parentQuestion({ rows: [item('r1', 10), item('r2', 20)] }),
      { registry },
    );
    expect(result.declarations.map((declaration) => declaration.export.order)).toEqual([1000, 2000]);
  });

  it('is independent of the order the rows were authored in', () => {
    const forwards = declareVariablesFor(testParentCore, parentQuestion(), { registry });
    const backwards = declareVariablesFor(
      testParentCore,
      parentQuestion({ rows: [...rows].reverse(), columns: [...columns].reverse() }),
      { registry },
    );
    expect(backwards.declarations).toEqual(forwards.declarations);
  });

  it('passes no columns to the child when use_columns is false', () => {
    const result = declareVariablesFor(
      testParentCore,
      parentQuestion({}, { useColumns: false }),
      { registry },
    );
    // The child then has an empty domain, which its own invariant rejects — the useful part is
    // that it is reported as a *declaration* problem rather than silently emitting an empty enum.
    expect(codes(result.diagnostics)).toContain('QK-test_parent-missing_enum_domain');
  });
});

describe('composition rule 1 — the child must exist and be composable', () => {
  it('rejects an unregistered cell control', () => {
    const registry = registryWith([[testParentCore, { trust: 'first_party' }]]);
    const result = declareVariablesFor(testParentCore, parentQuestion(), { registry });
    expect(codes(result.diagnostics)).toEqual(['QK-test_parent-compose_unknown_plugin']);
    expect(result.declarations).toEqual([]);
  });

  it('rejects a registered but non-composable control', () => {
    // `nps` is the canonical non-composable: its `_band` companion has no cell-scoped part.
    // (`multi_select` used to play this role, until the row-scope fan-out made it composable.)
    const registry = registryWith([
      [npsCore, { trust: 'first_party' }],
      [testParentCore, { trust: 'first_party' }],
    ]);
    const result = declareVariablesFor(
      testParentCore,
      parentQuestion({}, { childType: 'nps' }),
      { registry },
    );
    expect(codes(result.diagnostics)).toEqual(['QK-test_parent-compose_not_composable']);
  });

  it('rejects compose() with no registry at all', () => {
    const result = declareVariablesFor(testParentCore, parentQuestion(), {});
    expect(codes(result.diagnostics)).toEqual(['QK-test_parent-compose_unknown_plugin']);
  });
});

describe('composition rule 2 — trust may only go down', () => {
  it('refuses a marketplace child inside a first-party parent', () => {
    const registry = registryWith([
      [singleSelectCore, { trust: 'marketplace', sha384: 'sha384-x' }],
      [testParentCore, { trust: 'first_party' }],
    ]);
    const result = declareVariablesFor(testParentCore, parentQuestion(), { registry });
    expect(codes(result.diagnostics)).toEqual(['QK-test_parent-compose_trust_violation']);
  });

  it('allows it with an explicit allowlist entry, and only then', () => {
    const allowed = registryWith(
      [
        [singleSelectCore, { trust: 'marketplace', sha384: 'sha384-x' }],
        [testParentCore, { trust: 'first_party' }],
      ],
      { composeTrustAllowlist: ['single_select'] },
    );
    expect(declareVariablesFor(testParentCore, parentQuestion(), { registry: allowed }).diagnostics).toEqual(
      [],
    );
  });

  it('allows a first-party child inside a marketplace parent', () => {
    const registry = registryWith([
      [singleSelectCore, { trust: 'first_party' }],
      [testParentCore, { trust: 'marketplace', sha384: 'sha384-y' }],
    ]);
    // Composition downwards is fine: the parent already runs under the tighter regime.
    const parent = registry.resolveEntry('test_parent@1');
    expect(parent).toBeDefined();
    const result = declareVariablesFor(
      { ...testParentCore, meta: { ...testParentCore.meta, trust: 'marketplace' } },
      parentQuestion(),
      { registry },
    );
    expect(result.diagnostics).toEqual([]);
  });
});

describe('composition rule 3 — the child config validates against the child schema', () => {
  const registry = registryWith([
    [singleSelectCore, { trust: 'first_party' }],
    [testParentCore, { trust: 'first_party' }],
  ]);

  it('rejects a config the child would not accept', () => {
    const result = declareVariablesFor(
      testParentCore,
      parentQuestion({}, { childConfig: { ...childConfig, display: 'carousel' } }),
      { registry },
    );
    expect(codes(result.diagnostics)).toEqual(['QK-test_parent-compose_invalid_config']);
    expect(result.diagnostics[0]?.message).toContain('display');
  });

  it('rejects a config with unknown properties, so a typo is not silently ignored', () => {
    const result = declareVariablesFor(
      testParentCore,
      parentQuestion({}, { childConfig: { ...childConfig, colums: 2 } }),
      { registry },
    );
    expect(codes(result.diagnostics)).toEqual(['QK-test_parent-compose_invalid_config']);
  });

  it('tops the child config up with its own defaults before validating', () => {
    // `columns` and `allowDeselect` are omitted; both have schema defaults, so F §5's "new optional
    // field with a default" promise has to hold on this path.
    const result = declareVariablesFor(
      testParentCore,
      parentQuestion(
        {},
        { childConfig: { display: 'dropdown', other: { enabled: false } } },
      ),
      { registry },
    );
    expect(result.diagnostics).toEqual([]);
  });
});

describe('composition rule 4 — depth 1', () => {
  it('refuses a cell control that itself composes', () => {
    /**
     * A child that composes unconditionally.
     *
     * It cannot reuse `testParentCore`: a composed child is handed no rows (its scope is one cell),
     * so a row-driven parent would simply never call `compose` and the rule would look satisfied
     * for the wrong reason. Reaching for `compose` regardless is what a nested grid actually does.
     */
    const nested: AnyPluginCore = {
      ...testParentCore,
      meta: { ...testParentCore.meta, id: 'nested_parent', composable: true },
      declareVariables: (ctx) =>
        ctx.compose(
          { kind: 'row', rowRef: 'r1', rowCode: 1, index: 1 },
          { question_type: 'single_select', config: childConfig },
        ),
    };
    const registry = registryWith([
      [nested, { trust: 'first_party' }],
      [singleSelectCore, { trust: 'first_party' }],
      [testParentCore, { trust: 'first_party' }],
    ]);
    const result = declareVariablesFor(
      testParentCore,
      parentQuestion(
        {},
        {
          childType: 'nested_parent',
          childConfig: { childType: 'single_select', useColumns: false, childConfig: {} },
        },
      ),
      { registry },
    );
    // `Q5r3r2` is representable and makes schema §13's loop naming ambiguous. The answer to a
    // nested grid is a loop.
    expect(codes(result.diagnostics)).toEqual(['QK-test_parent-compose_depth']);
  });
});

describe('composition rule 5 — the child stays in its namespace', () => {
  it('refuses a child that names something outside its cell scope', () => {
    const escapee: AnyPluginCore = {
      ...singleSelectCore,
      meta: { ...singleSelectCore.meta, id: 'escapee' },
      declareVariables: (): readonly VariableDeclaration[] => [
        {
          // A hardcoded name pointing at another question's column. The scoped namer would never
          // produce this, which is exactly why the check is on the *result* and not on the namer.
          name: 'Q9',
          kind: 'response',
          type: 'text',
          source: { part: { kind: 'self' } },
          export: { include: true, column: 'Q9', labelKey: 'l', order: 0 },
          pii: false,
          persist: true,
        },
      ],
    };
    const registry = registryWith([
      [escapee, { trust: 'first_party' }],
      [testParentCore, { trust: 'first_party' }],
    ]);
    const result = declareVariablesFor(
      testParentCore,
      parentQuestion({}, { childType: 'escapee', childConfig: childConfig }),
      { registry },
    );
    expect(codes(result.diagnostics)).toEqual(['QK-test_parent-plugin_namespace_violation']);
    expect(result.declarations).toEqual([]);
  });
});

describe('composition rule 6 — one response variable per scalar cell', () => {
  const registry = registryWith([
    [singleSelectCore, { trust: 'first_party' }],
    [testParentCore, { trust: 'first_party' }],
  ]);
  const twoVarChild = {
    ...childConfig,
    other: { enabled: true, optionRef: 'c1', maxLen: 200, required: true },
  };

  it('refuses two response variables in one cell by default', () => {
    const result = declareVariablesFor(
      testParentCore,
      parentQuestion({}, { childConfig: twoVarChild }),
      { registry },
    );
    expect(codes(result.diagnostics)).toEqual(['QK-test_parent-compose_multi_var_cell']);
  });

  it('allows it when the parent opts in', () => {
    const result = declareVariablesFor(
      testParentCore,
      parentQuestion({}, { childConfig: twoVarChild }),
      { registry, allowMultiVarCells: true },
    );
    expect(result.diagnostics).toEqual([]);
    // The cell's verbatim is `Q5r1_other`: the child's other-specify, rescoped onto the row.
    expect(result.declarations.map((declaration) => declaration.name)).toEqual([
      'Q5r1',
      'Q5r1_other',
      'Q5r2',
      'Q5r2_other',
    ]);
  });
});

describe('a plugin that throws is diagnosed, not propagated', () => {
  it('turns an unexpected throw into a compile diagnostic', () => {
    const broken: AnyPluginCore = {
      ...npsCore,
      meta: { ...npsCore.meta, id: 'broken' },
      declareVariables: () => {
        throw new TypeError('cannot read properties of undefined');
      },
    };
    const result = declareVariablesFor(broken, {
      ref: 'Q1',
      questionType: 'broken',
      label: null,
      instruction: null,
      required: false,
      config: {},
      options: [],
      rows: [],
      columns: [],
      cells: [],
      flags: { pii: false, excludeFromExport: false },
      loop: null,
    });
    // The compiler's job is to name the plugin and the reason, not to crash the compile job for
    // every other question in the survey.
    expect(codes(result.diagnostics)).toEqual(['QK-broken-declare_variables_threw']);
    expect(result.diagnostics[0]?.message).toContain('cannot read properties');
  });
});

describe('verifyDeclarations', () => {
  const spec: NamerSpec = {
    ref: 'Q1',
    loop: null,
    options: [item('o1', 1), item('o2', 2)],
    rows: [],
    columns: [],
  };
  const good: VariableDeclaration = {
    name: 'Q1',
    kind: 'response',
    type: 'enum',
    enumDomain: [{ code: 1, labelKey: 'a' }],
    source: { part: { kind: 'self' } },
    export: { include: true, column: 'Q1', labelKey: 'l', order: 0 },
    pii: false,
    persist: true,
  };

  it('accepts a conforming set', () => {
    expect(verifyDeclarations([good], spec)).toEqual([]);
  });

  it('accepts an empty set — a content node emits nothing', () => {
    // `content_text` has `emitsData: false`; an empty declaration list must not be an error, or
    // every instruction block becomes a publish failure.
    expect(verifyDeclarations([], spec)).toEqual([]);
  });

  it('rejects a duplicate export column even when the names differ', () => {
    const problems = verifyDeclarations(
      [
        good,
        {
          ...good,
          name: 'Q1r1',
          source: { part: { kind: 'option', optionRef: 'o1' } },
          export: { ...good.export, column: 'Q1' },
        },
      ],
      spec,
    );
    expect(codes(problems)).toContain('duplicate_export_column');
  });

  it('rejects a response variable that is not persisted', () => {
    const problems = verifyDeclarations([{ ...good, persist: false }], spec);
    expect(codes(problems)).toContain('response_not_persisted');
  });

  it('rejects a duplicated enum code', () => {
    const problems = verifyDeclarations(
      [{ ...good, enumDomain: [{ code: 1, labelKey: 'a' }, { code: 1, labelKey: 'b' }] }],
      spec,
    );
    expect(codes(problems)).toContain('duplicate_enum_code');
  });

  it('rejects a structural derivation pointing at a variable this question does not declare', () => {
    const problems = verifyDeclarations(
      [
        good,
        {
          name: 'Q1_x',
          kind: 'derived',
          type: 'set',
          enumDomain: [{ code: 1, labelKey: 'a' }],
          source: { part: { kind: 'meta', label: 'x', suffix: 'x' } },
          export: { include: false, column: 'Q1_x', labelKey: 'l', order: 1 },
          pii: false,
          persist: false,
          derivation: {
            kind: 'structural',
            structural: {
              computation: 'set_view',
              // A typo here silently produces an empty set for every respondent, which looks
              // exactly like real data.
              members: [{ variableName: 'Q1r7', code: 7 }],
            },
          },
        },
      ],
      spec,
    );
    expect(codes(problems)).toContain('derivation_unresolved_source');
  });

  it('accepts a non-scalar declaration when a scalar projection accompanies it', () => {
    // F §4's heatmap shape: an object for fidelity plus scalars for analysis.
    const problems = verifyDeclarations(
      [
        {
          name: 'Q1_raw',
          kind: 'response',
          type: 'object',
          source: { part: { kind: 'meta', label: 'raw', suffix: 'raw' } },
          export: { include: false, column: 'Q1_raw', labelKey: 'l', order: 900 },
          pii: false,
          persist: true,
        },
        {
          name: 'Q1_n',
          kind: 'derived',
          type: 'number',
          source: { part: { kind: 'meta', label: 'count', suffix: 'n' } },
          export: { include: true, column: 'Q1_n', labelKey: 'l', order: 800 },
          pii: false,
          persist: true,
          derivation: {
            kind: 'expression',
            expression: { op: 'array_len', args: [{ var: 'Q1_raw' }] },
          },
        },
      ],
      spec,
    );
    expect(problems).toEqual([]);
  });
});
