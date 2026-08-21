/**
 * Parity between the kit's namer and `@resscript/schema`'s `deriveVariableName`.
 *
 * Two implementations of one rule exist because a plugin has no ids and schema's `VariablePart`
 * needs them (see `naming.ts`'s header). That is defensible only with a test that fails the moment
 * they disagree — the same guarantee `packages/logic-parity` is set up to make for the evaluator.
 * Every `DeclarationPart` kind appears below; the exhaustive switches in `naming.ts` and
 * `interop.ts` make adding a kind a compile error, and this file makes adding one without a
 * *matching* schema rule a test failure.
 */

import { describe, expect, it } from 'vitest';
import { createIdFactory, deriveVariableName, type OptionId } from '@resscript/schema';
import { createNamer, createScopedNamer, deriveDeclarationName, rescopePart, type NamerSpec } from './naming.js';
import { toVariablePart } from './interop.js';
import { PluginComposeError } from './errors.js';
import { item } from './testkit/spec.js';
import type { DeclarationPart } from './contract/variables.js';

const ids = createIdFactory();
const idFor = new Map<string, OptionId>();
const idOf = (ref: string): OptionId => {
  const existing = idFor.get(ref);
  if (existing !== undefined) return existing;
  const created = ids.next('option');
  idFor.set(ref, created);
  return created;
};

const spec: NamerSpec = {
  ref: 'Q5',
  loop: null,
  options: [item('o1', 1), item('o5', 5)],
  rows: [item('r1', 1), item('r3', 3)],
  columns: [item('c1', 1), item('c2', 2)],
};

const codeOf = (ref: string): number | undefined => {
  for (const list of [spec.options, spec.rows, spec.columns]) {
    const hit = list.find((entry) => entry.ref === ref);
    if (hit !== undefined) return hit.code;
  }
  return undefined;
};

const PARTS: readonly { readonly label: string; readonly part: DeclarationPart }[] = [
  { label: 'self', part: { kind: 'self' } },
  { label: 'set_view', part: { kind: 'set_view' } },
  { label: 'option', part: { kind: 'option', optionRef: 'o5' } },
  { label: 'row', part: { kind: 'row', rowRef: 'r3' } },
  { label: 'column', part: { kind: 'column', columnRef: 'c2' } },
  { label: 'row-spanning cell', part: { kind: 'cell', rowRef: 'r3' } },
  { label: 'grid cell', part: { kind: 'cell', rowRef: 'r3', columnRef: 'c2' } },
  { label: 'question other-specify', part: { kind: 'other_specify' } },
  { label: 'option other-specify', part: { kind: 'other_specify', ofRef: 'o5' } },
  { label: 'suffix', part: { kind: 'meta', label: 'nps band', suffix: 'band' } },
];

describe('the kit namer matches schema deriveVariableName', () => {
  for (const { label, part } of PARTS) {
    it(`agrees for a ${label} part`, () => {
      const schemaPart = toVariablePart(part, codeOf, idOf);
      expect(schemaPart, 'every declaration part must map to a schema variable part').toBeDefined();
      if (schemaPart === undefined) return;
      expect(deriveDeclarationName(spec, part)).toBe(
        deriveVariableName({ ref: spec.ref, part: schemaPart }),
      );
    });

    it(`agrees for a ${label} part inside a loop`, () => {
      const looped: NamerSpec = {
        ...spec,
        loop: { iterationVariableRef: 'BRAND', naming: '{ref}_{iteration}', iteration: 4 },
      };
      const schemaPart = toVariablePart(part, codeOf, idOf);
      if (schemaPart === undefined) return;
      expect(deriveDeclarationName(looped, part)).toBe(
        deriveVariableName({
          ref: spec.ref,
          part: schemaPart,
          iteration: 4,
          loop_naming: '{ref}_{iteration}',
        }),
      );
    });
  }

  it('produces the names schema §3’s table lists', () => {
    // Spot-checked against the table rather than only against the other implementation: two
    // implementations can agree and both be wrong.
    const namer = createNamer(spec);
    expect(namer.self()).toBe('Q5');
    expect(namer.option(5)).toBe('Q5r5');
    expect(namer.row(3)).toBe('Q5r3');
    expect(namer.column(2)).toBe('Q5c2');
    expect(namer.cell(3, 2)).toBe('Q5r3c2');
    expect(namer.other()).toBe('Q5_other');
    expect(namer.other(5)).toBe('Q5r5_other');
    expect(namer.suffixed('band')).toBe('Q5_band');
  });

  it('names by code, not by position', () => {
    // `r5` is the *second* option; naming by index would produce `Q5r2`.
    expect(createNamer(spec).option(5)).toBe('Q5r5');
    expect(createNamer({ ...spec, options: [...spec.options].reverse() }).option(5)).toBe('Q5r5');
  });

  it('rejects an unknown ref rather than inventing a name', () => {
    expect(() => deriveDeclarationName(spec, { kind: 'row', rowRef: 'nope' })).toThrow(
      PluginComposeError,
    );
    expect(() => createNamer(spec).option(999)).toThrow(PluginComposeError);
  });

  it('rejects a suffix outside the export-safe charset', () => {
    // A suffix becomes an export column, an SPSS variable name and a Parquet field name.
    expect(() => createNamer(spec).suffixed('has space')).toThrow(PluginComposeError);
    expect(() => createNamer(spec).suffixed('')).toThrow(PluginComposeError);
    expect(() => createNamer(spec).suffixed('x'.repeat(25))).toThrow(PluginComposeError);
  });
});

describe('the scoped namer a composed child receives', () => {
  const rowScope = { kind: 'row', rowRef: 'r3', rowCode: 3, index: 1 } as const;
  const cellScope = {
    kind: 'cell',
    rowRef: 'r3',
    rowCode: 3,
    columnRef: 'c2',
    columnCode: 2,
    index: 1,
  } as const;

  it('makes the child’s self() the cell’s name', () => {
    expect(createScopedNamer(spec, rowScope).self()).toBe('Q5r3');
    expect(createScopedNamer(spec, cellScope).self()).toBe('Q5r3c2');
  });

  it('allows an other-specify in a row scope, because Q5r3_other is representable', () => {
    expect(createScopedNamer(spec, rowScope).other()).toBe('Q5r3_other');
  });

  it('refuses every part schema §4 cannot name in that scope', () => {
    const namer = createScopedNamer(spec, rowScope);
    // Each of these would produce a name no `VariablePart` describes, so it could not survive a
    // round-trip through the variable registry — see ComposeErrorCode.compose_unnameable_part.
    expect(() => namer.suffixed('band')).toThrow(/cannot name/);
    expect(() => namer.row(1)).toThrow(/cannot name/);
    expect(() => namer.column(1)).toThrow(/cannot name/);
    expect(() => namer.cell(1, 1)).toThrow(/cannot name/);
    // `option` in a ROW scope is the sanctioned fan-out (P1-05): under use_columns the child's
    // options ARE the shared columns, so the name is the true grid cell.
    expect(namer.option(2)).toBe('Q5r3c2');
    // ...but only for codes that resolve among the columns: a child with its own option list
    // still cannot fan out (`Q5r3r2` remains unnameable).
    expect(() => namer.option(99)).toThrow(/cannot name/);
    // And in a grid cell, neither options nor the other-specify.
    expect(() => createScopedNamer(spec, cellScope).option(1)).toThrow(/cannot name/);
    expect(() => createScopedNamer(spec, cellScope).other()).toThrow(/cannot name/);
  });

  it('rescopes a child part into the parent’s coordinates', () => {
    expect(rescopePart({ kind: 'self' }, rowScope)).toEqual({ kind: 'cell', rowRef: 'r3' });
    expect(rescopePart({ kind: 'self' }, cellScope)).toEqual({
      kind: 'cell',
      rowRef: 'r3',
      columnRef: 'c2',
    });
    expect(rescopePart({ kind: 'other_specify' }, rowScope)).toEqual({
      kind: 'other_specify',
      ofRef: 'r3',
    });
    // The row-scope fan-out: the child's option (the parent's column) becomes the grid cell.
    expect(rescopePart({ kind: 'option', optionRef: 'c2' }, rowScope)).toEqual({
      kind: 'cell',
      rowRef: 'r3',
      columnRef: 'c2',
    });
    // In a full grid cell the fan-out stays impossible.
    expect(() => rescopePart({ kind: 'option', optionRef: 'o1' }, cellScope)).toThrow(
      PluginComposeError,
    );
  });

  it('rescoped names still agree with schema, so a composed column is derivable', () => {
    const namer = createScopedNamer(spec, cellScope);
    const part = rescopePart({ kind: 'self' }, cellScope);
    const schemaPart = toVariablePart(part, codeOf, idOf);
    expect(schemaPart).toBeDefined();
    if (schemaPart === undefined) return;
    expect(namer.self()).toBe(deriveVariableName({ ref: spec.ref, part: schemaPart }));
  });
});
