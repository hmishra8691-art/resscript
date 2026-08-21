/**
 * The `[builder | code]` toggle's decision function (§7.3).
 *
 * The property with teeth: **unparseable source cannot reach the builder**. The outcome type has
 * no member carrying both an error and a program, so "show a half-built tree" is not expressible —
 * these tests pin the behaviour that makes that typing true rather than decorative.
 */

import { describe, expect, it } from 'vitest';
import { parse } from '@resscript/rescript-dsl';
import { describeTriviaLoss, toBuilder, toCode, totalLoss, triviaLossOf } from '@/code-editor/mode-toggle';
import { fixtureRegistry } from '@/test/dsl-fixture';

const registry = fixtureRegistry();

describe('builder → code', () => {
  it('prints the AST', () => {
    const { program } = parse('IF S1 = S1.Yes AND AGE >= 18 THEN SHOW Q12\n', registry);
    const result = toCode(program, registry);
    expect(result.kind).toBe('switched');
    if (result.kind !== 'switched' || result.mode !== 'code') return;
    expect(result.source.trim()).toBe('IF S1 = S1.Yes AND AGE >= 18 THEN SHOW Q12');
  });
});

describe('code → builder', () => {
  it('blocks on unparseable source and hands back the diagnostic at its span', () => {
    const source = 'IF S1 = ';
    const result = toBuilder({ source, registry, authoredIn: 'dsl' });
    expect(result.kind).toBe('blocked');
    if (result.kind !== 'blocked') return;
    expect(result.diagnostic.severity).toBe('error');
    expect(result.diagnostic.span?.start).toBe(source.length);
    // Nothing resembling a program comes back with it.
    expect(Object.keys(result)).toEqual(['kind', 'reason', 'diagnostic']);
  });

  it('blocks on a TYPE error too, not just a syntax error', () => {
    // `Q5 < 2` is LGC-T003/T009: the source lexes and parses, and the builder still must not open
    // on it, because a rule that does not type-check has no legal renderer for its comparison.
    const result = toBuilder({ source: 'IF Q5 < 2 THEN SHOW Q12\n', registry, authoredIn: 'dsl' });
    expect(result.kind).toBe('blocked');
  });

  it('does NOT block on a warning — an unresolved page ref is the normal case', () => {
    const result = toBuilder({
      source: 'IF S1 = 1 THEN SKIP TO PAGE P9\n',
      registry,
      authoredIn: 'dsl',
    });
    expect(result.kind).toBe('switched');
  });

  it('switches straight through for a visually authored rule, warning about nothing', () => {
    const result = toBuilder({
      // Comments and blank lines in the SOURCE, but `authored_in: 'visual'` says the rule's stored
      // form has no trivia to lose — the source here was printed, not typed.
      source: '# a comment\n\nIF S1 = 1 THEN SHOW Q12\n',
      registry,
      authoredIn: 'visual',
    });
    expect(result.kind).toBe('switched');
  });

  it('asks for confirmation before dropping a DSL rule\'s trivia, once', () => {
    const source = '# heavy buyers only, per R2 feedback\nIF S1 = 1 THEN SHOW Q12\n';
    const first = toBuilder({ source, registry, authoredIn: 'dsl' });
    expect(first.kind).toBe('confirm');
    if (first.kind !== 'confirm') return;
    expect(first.loss.comments).toBe(1);

    // Acknowledged: the same call now switches, with no second warning.
    const second = toBuilder({ source, registry, authoredIn: 'dsl', triviaWarningAcknowledged: true });
    expect(second.kind).toBe('switched');
  });

  it('counts author parentheses and symbolic refs as losses, because the printer drops them', () => {
    const source = 'IF (S1 = S1.Yes AND AGE >= 18) OR HEAVY_BUYER THEN SHOW Q12\n';
    const { program } = parse(source, registry);
    const loss = triviaLossOf(program.statements);
    expect(totalLoss(loss)).toBeGreaterThan(0);
    expect(loss.parenHints + loss.symbolicRefs).toBeGreaterThan(0);
    expect(describeTriviaLoss(loss)).toContain('discards');
  });

  it('says nothing about logic changing, because none does', () => {
    expect(describeTriviaLoss({ comments: 2, blankLineGroups: 1, parenHints: 0, symbolicRefs: 0 })).toBe(
      'Opening this rule in the builder discards 2 comments and blank-line grouping. The logic is unchanged.',
    );
  });
});
