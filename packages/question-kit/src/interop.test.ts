/**
 * The boundary with `@resscript/schema`, in both directions.
 *
 * The load-bearing test is `produces the same variable names as schema's interim emission table`.
 * `packages/schema` shipped a builtin emission table in P1-02 precisely because the canonical model
 * had to be usable before this package existed, and its own header says P1-04 replaces it with
 * `declareVariables`. A replacement that emits *different* names would silently move the export
 * columns of every survey authored before the switch — so the two have to agree for the Phase-1
 * types, and that agreement is asserted rather than assumed.
 */

import { describe, expect, it } from 'vitest';
import {
  createIdFactory,
  deriveVariableName,
  planQuestionEmissions,
  type OptionId,
  type QuestionNode,
} from '@resscript/schema';
import { fromQuestionNode, toPlannedVariables, toVariablePart } from './interop.js';
import { declareVariablesFor } from './declare.js';
import { multiSelectCore } from './plugins/multi-select/core.js';
import { npsCore } from './plugins/nps/core.js';
import { singleSelectCore } from './plugins/single-select/core.js';
import type { AnyPluginCore } from './contract/plugin.js';
import type { VariableDeclaration } from './contract/variables.js';

const ids = createIdFactory();

function option(ref: string, code: number, extra: Partial<QuestionNode['options'] extends readonly (infer T)[] | undefined ? T : never> = {}) {
  return {
    id: ids.next('option'),
    ref,
    code,
    label: { key: `opt.${ref}` },
    position: code,
    ...extra,
  };
}

function questionNode(overrides: Partial<QuestionNode>): QuestionNode {
  return {
    id: ids.next('question'),
    type: 'question',
    ref: 'Q1',
    question_type: 'single_select',
    label: { key: 'Q1.label' },
    required: true,
    ...overrides,
  } as QuestionNode;
}

/** The ref -> id resolver the compiler supplies; a plugin never sees an id. */
function resolverFor(node: QuestionNode): (ref: string) => OptionId | undefined {
  const map = new Map<string, OptionId>();
  for (const list of [node.options ?? [], node.rows ?? [], node.columns ?? []]) {
    for (const entry of list) map.set(entry.ref, entry.id);
  }
  return (ref) => map.get(ref);
}

describe('fromQuestionNode', () => {
  const node = questionNode({
    options: [option('o3', 3), option('o1', 1), option('o2', 2)],
    config: { display: 'vertical', other: { enabled: false } },
    flags: { pii: true, exclude_from_export: true },
  });

  it('sorts items by code, so a plugin cannot depend on authored order', () => {
    expect(fromQuestionNode(node).options.map((item) => item.code)).toEqual([1, 2, 3]);
  });

  it('carries the flags a plugin is allowed to read, and nothing else', () => {
    const authored = fromQuestionNode(node);
    expect(authored.flags).toEqual({ pii: true, excludeFromExport: true });
    // No ids reach the plugin: it cannot resolve one, and one that stored it would be reaching
    // across the ADR-010 boundary.
    expect(Object.keys(authored.options[0] ?? {})).not.toContain('id');
  });

  it('maps a loop spec into the naming context', () => {
    const looped = fromQuestionNode(node, {
      loop: {
        spec: {
          source: { kind: 'numeric_range', from: 1, to: 3 },
          max_iterations: 3,
          iteration_variable_ref: 'BRAND',
          variable_naming: '{ref}_{iteration}',
        },
        iteration: 2,
      },
    });
    expect(looped.loop).toEqual({
      iterationVariableRef: 'BRAND',
      naming: '{ref}_{iteration}',
      iteration: 2,
    });
  });

  it('maps cell overrides without inventing a config', () => {
    const withCells = questionNode({
      question_type: 'matrix',
      rows: [option('r1', 1)],
      cells: [{ row_ref: 'r1', control: { question_type: 'numeric' } }],
    });
    const authored = fromQuestionNode(withCells);
    expect(authored.cells).toEqual([{ row_ref: 'r1', control: { question_type: 'numeric' } }]);
  });
});

describe('toVariablePart', () => {
  const node = questionNode({
    options: [option('o1', 1)],
    rows: [option('r1', 1)],
    columns: [option('c2', 2)],
  });
  const codeOf = (ref: string): number | undefined =>
    fromQuestionNode(node)
      .options.concat(fromQuestionNode(node).rows, fromQuestionNode(node).columns)
      .find((item) => item.ref === ref)?.code;

  it('maps a row-spanning cell onto schema’s row part', () => {
    // A numeric or text row in a mixed matrix carries one value for the whole row, so its name is
    // `Q1r1` and its part is `row` — only a true row x column cell is schema's `cell`.
    const part = toVariablePart({ kind: 'cell', rowRef: 'r1' }, codeOf, resolverFor(node));
    expect(part?.kind).toBe('row');
  });

  it('maps a grid cell onto schema’s cell part with both codes', () => {
    const part = toVariablePart(
      { kind: 'cell', rowRef: 'r1', columnRef: 'c2' },
      codeOf,
      resolverFor(node),
    );
    expect(part).toMatchObject({ kind: 'cell', row_code: 1, column_code: 2 });
  });

  it('returns undefined for a ref the question does not have', () => {
    expect(toVariablePart({ kind: 'row', rowRef: 'nope' }, codeOf, resolverFor(node))).toBeUndefined();
  });
});

describe('toPlannedVariables', () => {
  it('produces planned variables whose names schema re-derives identically', () => {
    const node = questionNode({
      options: [option('o1', 1), option('o2', 2), option('o3', 3, { other_specify: true })],
      question_type: 'multi_select',
      config: { display: 'vertical', other: { enabled: true } },
    });
    const authored = fromQuestionNode(node);
    const declarations = declareVariablesFor(multiSelectCore as AnyPluginCore, authored).declarations;
    const { planned, issues } = toPlannedVariables(declarations, {
      question: authored,
      idOf: resolverFor(node),
    });

    expect(issues).toEqual([]);
    expect(planned.length).toBe(declarations.length);
    planned.forEach((entry, index) => {
      const declared = declarations[index];
      expect(declared).toBeDefined();
      // The round trip that matters: kit name -> schema part -> schema name is the identity.
      expect(deriveVariableName({ ref: authored.ref, part: entry.part })).toBe(declared?.name);
      expect(entry.kind).toBe(declared?.kind);
      expect(entry.type).toBe(declared?.type);
    });
  });

  it('reports a non-numeric enum code instead of coercing it', () => {
    const node = questionNode({
      options: [option('o1', 1, { value_override: 'BRAND_A' }), option('o2', 2)],
      config: { display: 'vertical', other: { enabled: false } },
    });
    const authored = fromQuestionNode(node);
    const declarations = declareVariablesFor(singleSelectCore as AnyPluginCore, authored).declarations;
    const { issues } = toPlannedVariables(declarations, {
      question: authored,
      idOf: resolverFor(node),
    });
    // `Number('BRAND_A')` is NaN and `Number('07')` is 7: a silent coercion either fabricates a
    // code or collides with an existing one, and the client's analyst finds out.
    expect(issues.map((issue) => issue.code)).toEqual(['enum_code_not_numeric']);
  });

  it('reports a declaration whose part names an item that is gone', () => {
    const node = questionNode({ options: [option('o1', 1)], config: { display: 'vertical', other: { enabled: false } } });
    const authored = fromQuestionNode(node);
    const orphan: VariableDeclaration = {
      name: 'Q1r9',
      kind: 'response',
      type: 'boolean',
      source: { part: { kind: 'option', optionRef: 'o9' } },
      export: { include: true, column: 'Q1r9', labelKey: 'l', order: 9 },
      pii: false,
      persist: true,
    };
    const { issues, planned } = toPlannedVariables([orphan], {
      question: authored,
      idOf: resolverFor(node),
    });
    expect(issues.map((issue) => issue.code)).toEqual(['unknown_item_ref']);
    expect(planned).toEqual([]);
  });
});

describe('the kit agrees with schema’s interim emission table', () => {
  const cases: readonly {
    readonly label: string;
    readonly plugin: AnyPluginCore;
    readonly node: QuestionNode;
  }[] = [
    {
      label: 'single_select',
      plugin: singleSelectCore as AnyPluginCore,
      node: questionNode({
        question_type: 'single_select',
        options: [option('o1', 1), option('o2', 2)],
        config: { display: 'vertical', other: { enabled: false } },
      }),
    },
    {
      label: 'single_select with other-specify',
      plugin: singleSelectCore as AnyPluginCore,
      node: questionNode({
        question_type: 'single_select',
        options: [option('o1', 1), option('o9', 9, { other_specify: true })],
        config: { display: 'vertical', other: { enabled: true, optionRef: 'o9' } },
      }),
    },
    {
      label: 'multi_select',
      plugin: multiSelectCore as AnyPluginCore,
      node: questionNode({
        question_type: 'multi_select',
        options: [option('o1', 1), option('o2', 2), option('o5', 5)],
        config: { display: 'vertical', other: { enabled: false } },
      }),
    },
    {
      label: 'nps',
      plugin: npsCore as AnyPluginCore,
      node: questionNode({
        question_type: 'nps',
        config: { lowLabelKey: 'low', highLabelKey: 'high' },
      }),
    },
  ];

  for (const { label, plugin, node } of cases) {
    it(`emits the same variable names for ${label}`, () => {
      const authored = fromQuestionNode(node);
      const declarations = declareVariablesFor(plugin, authored).declarations;
      const kitNames = [...declarations.map((declaration) => declaration.name)].sort();

      const schemaNames = [...planQuestionEmissions(node)]
        .map((emission) => deriveVariableName({ ref: node.ref, part: emission.part }))
        .sort();

      expect(kitNames).toEqual(schemaNames);
    });

    it(`emits the same variable kinds and types for ${label}`, () => {
      const authored = fromQuestionNode(node);
      const declarations = declareVariablesFor(plugin, authored).declarations;
      const kit = new Map(
        declarations.map((declaration) => [
          declaration.name,
          `${declaration.kind}:${declaration.type}`,
        ]),
      );
      for (const emission of planQuestionEmissions(node)) {
        const name = deriveVariableName({ ref: node.ref, part: emission.part });
        // A type change is a new major (F §5's table) — including the "major" that is switching
        // from schema's table to the plugin.
        expect(kit.get(name), `${name} type/kind`).toBe(`${emission.kind}:${emission.type}`);
      }
    });
  }
});
