/**
 * `resolveQuestion` and the variable index.
 *
 * The index is what lets a validator attach an error to `Q2r5_other` without building the string
 * (F §1.2). Every part kind has to land somewhere in it, or a plugin that emits that part has no
 * way to point at its own variable — and the fallback in practice is string concatenation, which is
 * the thing the whole naming design exists to prevent.
 */

import { describe, expect, it } from 'vitest';
import { indexVariables, resolveQuestion } from './resolve.js';
import { declareVariablesFor } from './declare.js';
import { multiSelectCore } from './plugins/multi-select/core.js';
import { npsCore } from './plugins/nps/core.js';
import { fixtureQuestion, item } from './testkit/spec.js';
import type { VariableDeclaration } from './contract/variables.js';

const declaration = (
  name: string,
  part: VariableDeclaration['source']['part'],
  overrides: Partial<VariableDeclaration> = {},
): VariableDeclaration =>
  ({
    name,
    kind: 'response',
    type: 'text',
    source: { part },
    export: { include: true, column: name, labelKey: 'l', order: 0 },
    pii: false,
    persist: true,
    ...overrides,
  }) as VariableDeclaration;

describe('indexVariables', () => {
  it('indexes every part kind somewhere reachable', () => {
    const index = indexVariables([
      declaration('Q1', { kind: 'self' }),
      declaration('Q1_other', { kind: 'other_specify' }),
      declaration('Q1r5_other', { kind: 'other_specify', ofRef: 'o5' }),
      declaration('Q1r1', { kind: 'option', optionRef: 'o1' }),
      declaration('Q1r2', { kind: 'row', rowRef: 'r2' }),
      declaration('Q1c3', { kind: 'column', columnRef: 'c3' }),
      declaration('Q1r2c3', { kind: 'cell', rowRef: 'r2', columnRef: 'c3' }),
      declaration('Q1_band', { kind: 'meta', label: 'band', suffix: 'band' }),
    ]);

    expect(index.self).toBe('Q1');
    expect(index.other).toBe('Q1_other');
    expect(index.otherByItem).toEqual({ o5: 'Q1r5_other' });
    expect(index.byRow).toEqual({
      o1: 'Q1r1',
      r2: 'Q1r2',
      c3: 'Q1c3',
      'r2:c3': 'Q1r2c3',
      'meta:band': 'Q1_band',
    });
  });

  it('prefers the response variable over a same-named derived view for `self`', () => {
    // On a multi-select `Q2` is the set view, which nobody can fix; on a single-select it is the
    // answer. An error attached to "the question" has to land on something a respondent can act on.
    const index = indexVariables([
      declaration('Q1', { kind: 'set_view' }, { kind: 'derived', type: 'set', derivation: { kind: 'structural', structural: { computation: 'set_view', members: [] } } }),
      declaration('Q1', { kind: 'self' }),
    ]);
    expect(index.self).toBe('Q1');
  });
});

describe('resolveQuestion', () => {
  const question = fixtureQuestion('multi_select', {
    config: {
      display: 'vertical',
      columns: 1,
      minSelected: 0,
      maxSelected: 0,
      other: { enabled: true, maxLen: 200, required: true },
    },
    options: [item('o1', 1), item('o2', 2, { otherSpecify: true, valueOverride: 'OTHER' })],
    required: true,
    itemStates: { o2: { enabled: false } },
  });
  const declarations = declareVariablesFor(multiSelectCore, question).declarations;
  const resolved = resolveQuestion(question, declarations, { itemStates: { o2: { enabled: false } } });

  it('applies the runtime-evaluated item state rather than guessing it', () => {
    expect(resolved.options.map((option) => option.enabled)).toEqual([true, false]);
    expect(resolved.options.every((option) => option.visible)).toBe(true);
  });

  it('resolves a code back to the item that stores it, override included', () => {
    expect(resolved.optionRefOf(1)).toBe('o1');
    expect(resolved.optionRefOf('OTHER')).toBe('o2');
    // Strict: `'1'` is not code 1. The codec fixes types at the boundary; loosening it here would
    // let a forged payload match a code the UI never offered.
    expect(resolved.optionRefOf('1')).toBeUndefined();
    expect(resolved.optionRefOf(99)).toBeUndefined();
  });

  it('throws for a row it has no variable for, rather than returning a blank name', () => {
    expect(() => resolved.variableFor('nope')).toThrow(/declares no variable/);
    expect(resolved.variableFor('o1')).toBe('Q1r1');
  });

  it('falls back to a derived label key so a renderer never sees null', () => {
    const unlabelled = { ...question, label: null };
    expect(resolveQuestion(unlabelled, declarations).label).toBe('Q1.label');
  });

  it('exposes a companion variable through the meta index', () => {
    const npsQuestion = fixtureQuestion('nps', {
      config: { lowLabelKey: 'low', highLabelKey: 'high', display: 'buttons' },
    });
    const npsDeclarations = declareVariablesFor(npsCore, npsQuestion).declarations;
    const npsResolved = resolveQuestion(npsQuestion, npsDeclarations);
    expect(npsResolved.variables.self).toBe('Q1');
    expect(npsResolved.variables.byRow['meta:band']).toBe('Q1_band');
  });
});
