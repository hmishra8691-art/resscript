/**
 * Completion, hover and go-to-definition — the language services behind §7.4.
 *
 * The assertion that matters most is the type-constrained operator list: §7.4 says "completion that
 * offers an illegal operator teaches the user wrong", and the specific bug it protects against is
 * D §3.3's top-2-box — `<` on a brand list. Because `operators.ts` derives legality from
 * `checkExpr` rather than from a table, this suite is also the test that the derivation works: a
 * regression in `packages/logic`'s ordinality rule shows up here as an offered `<`.
 */

import { describe, expect, it } from 'vitest';
import { completionsAt } from '@/code-editor/completion';
import { definitionAt, hoverAt, tokenAt } from '@/code-editor/hover';
import { legalOperatorsFor } from '@/code-editor/operators';
import { DOM, Q, V, fixtureFlowOrder, fixtureRegistry } from '@/test/dsl-fixture';

const registry = fixtureRegistry();
const env = { registry, labelOf: (key: string) => ({ 'fruit.alpha': 'Alpha', 'fruit.beta': 'Beta', 'fruit.gamma': 'Gamma', 'fruit.none': 'None of these' })[key] };

/** Completion at the end of `source`, which is where a keystroke leaves the cursor. */
function complete(source: string, extra: Partial<Parameters<typeof completionsAt>[2]> = {}) {
  return completionsAt(source, source.length, { ...env, ...extra });
}

describe('statement position', () => {
  it('offers §7.4\'s rule keywords first', () => {
    const { items, context } = complete('');
    expect(context.expecting).toBe('statement');
    const labels = [...items].sort((a, b) => (a.sortText ?? '').localeCompare(b.sortText ?? '')).map((i) => i.label);
    expect(labels.slice(0, 7)).toEqual(['IF', 'SHOW', 'HIDE', 'TERMINATE', 'SET', 'MASK', 'VALIDATE']);
  });
});

describe('variable position', () => {
  it('offers the registry, not a static list', () => {
    const { items, context } = complete('IF ');
    expect(context.expecting).toBe('variable');
    expect(items.map((i) => i.label).sort()).toEqual(['AGE', 'HEAVY_BUYER', 'Q5', 'Q9', 'S1', 'SEGMENT']);
  });

  it('states the type and the emitting question in `detail`', () => {
    const q5 = complete('IF ').items.find((i) => i.label === 'Q5');
    expect(q5?.detail).toContain('set<');
    expect(q5?.detail).toContain('from Q5');
  });

  it('ranks variables set earlier in the flow first and marks the later ones', () => {
    // `here = 1` is a rule on page 1: Q9 (2) and AGE (4) are collected afterwards.
    const { items } = complete('IF ', { flow: fixtureFlowOrder(1) });
    const age = items.find((i) => i.label === 'AGE');
    const s1 = items.find((i) => i.label === 'S1');
    expect(age?.forwardReference).toBe(true);
    expect(age?.detail).toContain('⚠ forward reference');
    expect(age?.documentation).toContain('LGC-F001');
    expect(s1?.forwardReference).toBeUndefined();
    // The ranking is expressed in `sortText`, which is what Monaco sorts on.
    expect((s1?.sortText ?? '') < (age?.sortText ?? '')).toBe(true);
  });

  it('never marks a hidden variable as forward — it is set at entry (D §8.1)', () => {
    const { items } = complete('IF ', { flow: fixtureFlowOrder(0) });
    expect(items.find((i) => i.label === 'HEAVY_BUYER')?.forwardReference).toBeUndefined();
  });
});

describe('operator position — type-constrained', () => {
  it('offers ordered comparisons on a number', () => {
    const { items, context } = complete('IF AGE ');
    expect(context.expecting).toBe('operator');
    expect(items.map((i) => i.label)).toEqual(expect.arrayContaining(['=', '<', '>=', 'BETWEEN']));
    // A number is not a set.
    expect(items.map((i) => i.label)).not.toContain('CONTAINS');
  });

  it('offers the set predicates on a set<enum> and no ordered comparison', () => {
    const labels = complete('IF Q5 ').items.map((i) => i.label);
    expect(labels).toEqual(expect.arrayContaining(['CONTAINS', 'ANY OF', 'ALL OF', 'NONE OF']));
    expect(labels).not.toContain('<');
    expect(labels).not.toContain('BETWEEN');
  });

  it('withholds `<` on a NOMINAL enum and offers it on an ORDINAL one (D §3.3)', () => {
    // The top-2-box bug, as a test. S1 is a nominal yes/no; Q9 is a Likert scale.
    expect(complete('IF S1 ').items.map((i) => i.label)).not.toContain('<');
    expect(complete('IF Q9 ').items.map((i) => i.label)).toContain('<');
  });

  it('derives the list from the checker rather than from a table', () => {
    // Same question asked of the module directly: an unknown left type offers everything (the
    // honest "any of these might be legal"), and a bool offers equality but not ordering.
    expect(legalOperatorsFor(undefined, registry.env).length).toBeGreaterThan(5);
    const boolOps = legalOperatorsFor({ k: 'bool' }, registry.env).map((o) => o.label);
    expect(boolOps).toContain('=');
    expect(boolOps).not.toContain('<');
  });

  it('documents the null behaviour, which is where the confusion lives (§7.4)', () => {
    const noneOf = complete('IF Q5 ').items.find((i) => i.label === 'NONE OF');
    expect(noneOf?.documentation).toContain('UNKNOWN');
  });
});

describe('enum-code position', () => {
  it('offers that domain\'s option refs, labels in detail and codes in documentation', () => {
    const { items, context } = complete('IF Q5 CONTAINS ');
    expect(context.expecting).toBe('enum_code');
    expect(context.domainId).toBe(DOM.fruit);
    const alpha = items.find((i) => i.label === 'Q5.Alpha');
    expect(alpha, 'the symbolic form D §3.4 recommends').toBeDefined();
    expect(alpha?.detail).toBe('Alpha');
    expect(alpha?.documentation).toBe('code 1');
    // Codes, not display order: `None of these` is code 99 and sorts last.
    expect(items[items.length - 1]?.detail).toBe('None of these');
  });

  it('offers the OTHER domain\'s codes after the other question, because domains are nominal', () => {
    const { items } = complete('IF S1 = ');
    expect(items.map((i) => i.label)).toEqual(['S1.Yes', 'S1.No']);
  });
});

describe('question position', () => {
  it('offers question refs after SHOW', () => {
    const { items, context } = complete('IF S1 = 1 THEN SHOW ');
    expect(context.expecting).toBe('question');
    expect(items.map((i) => i.label)).toEqual(expect.arrayContaining(['Q12', 'Q5', 'S1']));
  });
});

describe('hover', () => {
  it('describes a variable: type, kind, emitting question, domain preview', () => {
    const source = 'IF Q5 CONTAINS Q5.Alpha THEN SHOW Q12\n';
    const hover = hoverAt(source, source.indexOf('Q5') + 1, env);
    const text = (hover?.contents ?? []).join('\n');
    expect(text).toContain('**Q5**');
    expect(text).toContain('set<');
    expect(text).toContain('Collected by **Q5**');
    expect(text).toContain('nominal domain');
    expect(text).toContain('Alpha');
  });

  it('describes an operator with its type rule and its null propagation', () => {
    const source = 'IF Q5 NONE OF [99] THEN SHOW Q12\n';
    const hover = hoverAt(source, source.indexOf('NONE') + 1, env);
    expect((hover?.contents ?? []).join('\n')).toContain('UNKNOWN');
  });

  it('explains AND\'s Kleene behaviour, the highest-value hover in the language', () => {
    const source = 'IF S1 = 1 AND AGE >= 18 THEN SHOW Q12\n';
    const hover = hoverAt(source, source.indexOf('AND') + 1, env);
    expect((hover?.contents ?? []).join('\n')).toContain('F AND U = F');
  });

  it('says so plainly when a ref is not in the registry', () => {
    const source = 'IF NOPE = 1 THEN SHOW Q12\n';
    expect((hoverAt(source, 4, env)?.contents ?? []).join('\n')).toContain('is not a variable or a question');
  });

  it('uses the lexer, so the two halves of a dotted ref hover separately', () => {
    const source = 'IF Q5 CONTAINS Q5.Alpha THEN SHOW Q12\n';
    expect(tokenAt(source, source.indexOf('.Alpha') + 2)?.text).toBe('Alpha');
  });
});

describe('go-to-definition', () => {
  it('resolves a question ref to its node id, for a studio navigation', () => {
    const source = 'IF S1 = 1 THEN SHOW Q12\n';
    expect(definitionAt(source, source.indexOf('Q12') + 1, registry)).toMatchObject({
      kind: 'question',
      id: Q.q12,
      ref: 'Q12',
    });
  });

  it('resolves a response variable to its EMITTING question, which is what the tree can select', () => {
    const source = 'IF AGE >= 18 THEN SHOW Q12\n';
    expect(definitionAt(source, source.indexOf('AGE') + 1, registry)).toMatchObject({
      kind: 'question',
      id: Q.age,
    });
  });

  it('resolves a hidden variable to the variable itself — it has no question', () => {
    const source = 'IF HEAVY_BUYER THEN SHOW Q12\n';
    expect(definitionAt(source, source.indexOf('HEAVY') + 1, registry)).toMatchObject({
      kind: 'variable',
      id: V.heavy,
    });
  });

  it('is undefined on an operator', () => {
    const source = 'IF AGE >= 18 THEN SHOW Q12\n';
    expect(definitionAt(source, source.indexOf('>=') + 1, registry)).toBeUndefined();
  });
});
