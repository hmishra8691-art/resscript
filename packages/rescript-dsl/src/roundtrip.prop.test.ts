/**
 * The eight round-trip properties of D §6.4, as `fast-check` property tests.
 *
 * | Property | Assertion |
 * |---|---|
 * | P1 AST identity          | `parse(print(a)) ≡ a` |
 * | P2 Printer idempotence   | `print(parse(print(a))) = print(a)` |
 * | P3 Source normalization  | `print(parse(s')) = print(parse(s))` for a re-indented / re-cased `s'` |
 * | P4 Trivia preservation   | comments and their attachment points survive byte for byte |
 * | P5 Semantic equivalence  | `eval(a, st) = eval(parse(print(a)), st)` over null-heavy states |
 * | P6 Type preservation     | `typecheck(parse(print(a)))` produces zero diagnostics |
 * | P7 Corpus regression     | every file in `fixtures/corpus/` round-trips |
 * | P8 Error recovery        | random single-character mutation: no throw, positioned diagnostic |
 *
 * **Case count.** `runs()` defaults to a modest number and reads `RESSCRIPT_PROPERTY_RUNS`. The
 * roadmap's acceptance criterion is 10,000 cases; R1's mitigation is explicit that those belong in a
 * nightly job rather than in every PR, because a property suite slow enough to be skipped is a
 * property suite nobody runs. See this package's README.
 *
 * **Two places where the properties as written in D §6.4 needed qualifying**, both reported rather
 * than quietly weakened:
 *
 *  1. **P3 cannot re-parenthesize.** D §6.4 lists "redundant parentheses" among the things the
 *     printer may change, *and* introduces `paren_hints` so that the author's redundant parentheses
 *     are preserved. Both cannot hold: if `(A AND B) OR C` prints back with its parentheses, then a
 *     re-parenthesized `s'` does not print identically to `s`. `paren_hints` wins — it is explicit,
 *     it is named in the risk register, and dropping an author's clarifying parentheses in a rule
 *     they are about to review with a client is the failure R1 describes. So P3 mutates whitespace,
 *     keyword case and the `=`/`==`/`<>`/`!=` synonyms, which cannot touch trivia.
 *  2. **P8's "produces ≥1 diagnostic" needs a qualifier.** Deleting a character inside a comment,
 *     a string literal or a run of whitespace produces a *valid* program, and so must produce no
 *     diagnostic. The unconditional claims are "never throws" and "always terminates"; the
 *     positioned-diagnostic claim is conditional on the mutation actually breaking something.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { readFileSync, readdirSync } from 'node:fs';
import {
  NO_CELLS,
  annotate,
  astBuilder,
  buildEvalSchema,
  checkExpr,
  evalExpr,
  valueEq,
  varStateOf,
  type Expr,
  type Value,
} from '@resscript/logic';
import { canonicalStatement, structuralStatement, type Statement, type Trivia } from './ast.js';
import { parse } from './index.js';
import { lex } from './lexer.js';
import { print, printStatement } from './printer.js';
import { registry } from './__fixtures__/survey.js';
import {
  LABELS,
  arbCondition,
  arbProgramBuilders,
  arbStatement,
  arbTrivia,
  arbVarState,
  runs,
} from './__fixtures__/arbitrary.js';

const REG = registry();
const SCHEMA = buildEvalSchema(REG.env);
const CORPUS_DIR = new URL('../fixtures/corpus/', import.meta.url);

function build(f: (b: ReturnType<typeof astBuilder>) => Statement<Expr>): Statement<Expr> {
  return f(astBuilder(1));
}

function parseOne(source: string): { readonly statement: Statement<Expr>; readonly source: string } {
  const result = parse(source, REG);
  const errors = result.diagnostics.filter((d) => d.severity === 'error');
  expect(errors, `unexpected errors parsing:\n${source}`).toEqual([]);
  expect(result.program.statements).toHaveLength(1);
  const statement = result.program.statements[0];
  if (statement === undefined) throw new Error('unreachable: length was asserted');
  return { statement, source };
}

/* ========================================================================== */
/* P1 — AST identity                                                          */
/* ========================================================================== */

describe('P1 — AST identity: parse(print(a)) ≡ a', () => {
  it('holds for arbitrary well-typed statements', () => {
    fc.assert(
      fc.property(arbStatement, (make) => {
        const original = build(make);
        const printed = printStatement(original, REG);
        const { statement } = parseOne(printed);
        // `≡` is structural equality *after* removing trivia (D §6.4). See `structuralStatement`.
        expect(structuralStatement(statement)).toEqual(structuralStatement(original));
      }),
      { numRuns: runs() },
    );
  });

  it('holds for whole programs', () => {
    fc.assert(
      fc.property(arbProgramBuilders, (makers) => {
        const statements = makers.map((make) => build(make));
        const printed = print({ statements }, REG);
        const result = parse(printed, REG);
        expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
        expect(result.program.statements.map(structuralStatement)).toEqual(statements.map(structuralStatement));
      }),
      { numRuns: runs(100) },
    );
  });
});

/* ========================================================================== */
/* P2 — printer idempotence                                                   */
/* ========================================================================== */

describe('P2 — printer idempotence: print(parse(print(a))) = print(a)', () => {
  it('holds for arbitrary statements', () => {
    fc.assert(
      fc.property(arbStatement, (make) => {
        const first = printStatement(build(make), REG);
        const second = print(parse(first, REG).program, REG);
        expect(second).toBe(first);
      }),
      { numRuns: runs() },
    );
  });
});

/* ========================================================================== */
/* P3 — source normalization                                                  */
/* ========================================================================== */

/** Re-indent, re-case keywords, and swap operator synonyms. Never touches trivia. */
function perturb(source: string, seed: number): string {
  const { tokens } = lex(source);
  let out = '';
  let cursor = 0;
  let state = seed >>> 0;
  const next = (): number => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state;
  };
  let previous = '';
  for (const token of tokens) {
    if (token.kind === 'eof') break;
    out += source.slice(cursor, token.start);
    cursor = token.end;
    const wasDot = previous === '.';
    previous = token.text;
    // A token after `.` is a *name*, not a keyword, even when it spells one: `Q5.None` names the
    // option whose ref is `None`, and refs are case-sensitive (D §6.2). Recasing it would change
    // which option the source names — which is a real wart in the language, reported, and not
    // something this perturbation is entitled to do.
    if (token.kind === 'keyword' && !wasDot) {
      out += next() % 2 === 0 ? token.text.toLowerCase() : token.text.toUpperCase();
      continue;
    }
    if (token.kind === 'punct') {
      // `=`/`==` and `<>`/`!=` both parse the same and print as `=`/`!=` (D §6.2).
      if (token.text === '=') out += next() % 2 === 0 ? '==' : '=';
      else if (token.text === '!=') out += next() % 2 === 0 ? '<>' : '!=';
      else out += token.text;
      continue;
    }
    out += token.text;
  }
  out += source.slice(cursor);
  // Re-indent every line that is not inside a comment or a string. Lines are safe to prefix because
  // the language is newline-insensitive; only the leading whitespace changes.
  return out
    .split('\n')
    .map((line) => (line.trim() === '' ? line : `${' '.repeat(next() % 5)}${line}`))
    .join('\n');
}

describe('P3 — source normalization: print(parse(s′)) = print(parse(s))', () => {
  it('is invariant under re-indentation, keyword case and operator synonyms', () => {
    fc.assert(
      fc.property(arbStatement, fc.integer({ min: 0, max: 2 ** 30 }), (make, seed) => {
        const source = printStatement(build(make), REG);
        const perturbed = perturb(source, seed);
        expect(print(parse(perturbed, REG).program, REG)).toBe(print(parse(source, REG).program, REG));
      }),
      { numRuns: runs() },
    );
  });
});

/* ========================================================================== */
/* P4 — trivia preservation                                                   */
/* ========================================================================== */

describe('P4 — trivia preservation: comments survive byte for byte', () => {
  it('preserves leading comments, trailing comments and blank-line grouping', () => {
    fc.assert(
      fc.property(arbStatement, arbTrivia, (make, trivia) => {
        const original: Statement<Expr> = { ...build(make), trivia } as Statement<Expr>;
        const printed = printStatement(original, REG);
        const { statement } = parseOne(printed);
        const round = statement.trivia ?? {};
        expect(round.leading ?? []).toEqual(trivia.leading ?? []);
        expect(round.trailing).toBe(trivia.trailing);
        expect(round.blank_before ?? 0).toBe(trivia.blank_before ?? 0);
      }),
      { numRuns: runs() },
    );
  });

  it('preserves a comment on a statement inside a BLOCK', () => {
    const source = [
      'BLOCK MAIN',
      '  -- why this rule exists',
      '  IF S1 = 1 THEN SHOW Q12 # and a trailing note',
      'END',
      '',
    ].join('\n');
    expect(print(parse(source, REG).program, REG)).toBe(source);
  });
});

/* ========================================================================== */
/* P5 — semantic equivalence                                                  */
/* ========================================================================== */

function evaluate(expr: Expr, state: { readonly [id: string]: Value }): Value {
  return evalExpr(annotate(expr, REG.env), {
    vars: varStateOf(state),
    ctx: { labels: LABELS },
    cells: NO_CELLS,
    schema: SCHEMA,
  });
}

describe('P5 — semantic equivalence over null-heavy states', () => {
  it('evaluates identically before and after a round trip', () => {
    fc.assert(
      fc.property(arbCondition(4), fc.array(arbVarState, { minLength: 4, maxLength: 8 }), (make, states) => {
        const original = build((b) => ({
          s: 'rule',
          condition: make(b),
          then: [{ a: 'show', target: { ref: { ref: 'Q12', kind: 'question', id: REG.env.questions()[7]?.id ?? undefined } } }],
        }) as Statement<Expr>);
        const printed = printStatement(original, REG);
        const { statement } = parseOne(printed);
        if (original.s !== 'rule' || statement.s !== 'rule') throw new Error('unreachable');
        for (const state of states) {
          const before = evaluate(original.condition, state);
          const after = evaluate(statement.condition, state);
          expect(valueEq(after, before), `state ${JSON.stringify(state)}\nsource: ${printed}`).toBe(true);
        }
      }),
      { numRuns: runs(150) },
    );
  });

  it('is asserted over at least 200 states in aggregate, per D §6.4 P5', () => {
    // D §6.4 states P5 as "arbitrary AST + 200 arbitrary variable states". The property above uses
    // 4–8 states per case so that a failure shrinks to a small state, and this test pins the
    // aggregate: 200 states against one non-trivial condition, including the all-null state.
    const b = astBuilder(1);
    const condition = b.and(
      b.cmp('==', b.variable(REG.env.byRef('S1')?.id ?? throwMissing('S1')), b.enumLit(1, domainOf('S1'))),
      b.cmp('>=', b.variable(REG.env.byRef('AGE')?.id ?? throwMissing('AGE')), b.numLit(18)),
      b.not(b.setOp('none_of', b.variable(REG.env.byRef('Q5')?.id ?? throwMissing('Q5')), b.setLit([99], domainOf('Q5')))),
    );
    const printed = printStatement({ s: 'rule', condition, then: [{ a: 'hide', target: { ref: { ref: 'Q12', kind: 'question' } } }] }, REG);
    const reparsed = parse(printed, REG).program.statements[0];
    if (reparsed === undefined || reparsed.s !== 'rule') throw new Error('unreachable');
    const states = fc.sample(arbVarState, { numRuns: 199, seed: 7 });
    states.push({});
    for (const state of states) {
      expect(valueEq(evaluate(reparsed.condition, state), evaluate(condition, state))).toBe(true);
    }
    expect(states).toHaveLength(200);
  });
});

function throwMissing(ref: string): never {
  throw new Error(`fixture is missing ${ref}`);
}

function domainOf(ref: string): never | ReturnType<typeof domainOfImpl> {
  return domainOfImpl(ref);
}

function domainOfImpl(ref: string) {
  const decl = REG.env.byRef(ref);
  const type = decl === undefined ? undefined : REG.env.typeOf(decl);
  if (type === undefined || (type.k !== 'enum' && type.k !== 'set')) throwMissing(ref);
  return type.d;
}

/* ========================================================================== */
/* P6 — type preservation                                                     */
/* ========================================================================== */

describe('P6 — type preservation: the reparsed tree type-checks clean', () => {
  it('produces zero diagnostics for arbitrary well-typed conditions', () => {
    fc.assert(
      fc.property(arbCondition(4), (make) => {
        const condition = build((b) => ({ s: 'set', variable: { ref: 'HEAVY_BUYER', id: REG.env.byRef('HEAVY_BUYER')?.id }, value: make(b) }) as Statement<Expr>);
        if (condition.s !== 'set') throw new Error('unreachable');
        // The generator claims to produce well-typed trees; if it does not, this is where it shows,
        // and the failure is the generator's, not the printer's.
        expect(checkExpr(condition.value, REG.env).diagnostics).toEqual([]);
        const printed = printStatement(condition, REG);
        const { statement } = parseOne(printed);
        if (statement.s !== 'set') throw new Error('unreachable');
        expect(checkExpr(statement.value, REG.env).diagnostics).toEqual([]);
      }),
      { numRuns: runs() },
    );
  });
});

/* ========================================================================== */
/* P7 — corpus regression                                                     */
/* ========================================================================== */

const CORPUS = readdirSync(CORPUS_DIR).filter((name) => name.endsWith('.rsl')).sort();

describe('P7 — corpus regression', () => {
  it('has a corpus', () => {
    expect(CORPUS.length).toBeGreaterThan(0);
  });

  for (const name of CORPUS) {
    it(`round-trips ${name}`, () => {
      const source = readFileSync(new URL(name, CORPUS_DIR), 'utf8');
      const first = parse(source, REG);
      const printed = print(first.program, REG);
      const second = parse(printed, REG);

      // T2 idempotence, byte for byte.
      expect(print(second.program, REG)).toBe(printed);
      // T1 over the whole file: the tree that produced the text and the tree the text produces are
      // the same tree, trivia included.
      expect(second.program.statements.map(structuralStatement)).toEqual(
        first.program.statements.map(structuralStatement),
      );
      // Trivia is compared separately, because it is not part of `≡` — and because a corpus file's
      // comments surviving is the assertion R1 says protects code mode's credibility.
      expect(second.program.statements.map((s) => s.trivia ?? {})).toEqual(
        first.program.statements.map((s) => s.trivia ?? {}),
      );
      // Every comment in the source is still in the printed output, verbatim.
      for (const comment of lex(source).comments) {
        expect(printed).toContain(comment.text);
      }
      // The diagnostics are stable across the round trip: a printer that changed meaning would show
      // up here even when the tree comparison passed.
      expect(second.diagnostics.map((d) => d.code)).toEqual(first.diagnostics.map((d) => d.code));
    });
  }

  it('reports the expected errors on every corpus file, and no others', () => {
    // Two files carry deliberate errors: the deferred QUOTA block, and the regression file's last
    // statement (an unresolvable ref, which must print back as itself rather than as NULL).
    const expected: { readonly [file: string]: readonly string[] } = {
      'quota-deferred.rsl': ['RSL-0007'],
      'regressions.rsl': ['LGC-T001'],
    };
    for (const name of CORPUS) {
      const source = readFileSync(new URL(name, CORPUS_DIR), 'utf8');
      const codes = parse(source, REG)
        .diagnostics.filter((d) => d.severity === 'error')
        .map((d) => d.code);
      expect(codes, `${name} produced ${codes.join(', ')}`).toEqual(expected[name] ?? []);
    }
  });
});

/* ========================================================================== */
/* P8 — error recovery                                                        */
/* ========================================================================== */

const CORPUS_SOURCES = CORPUS.map((name) => readFileSync(new URL(name, CORPUS_DIR), 'utf8'));

/** A mutation: delete or insert one character at `offset`. */
function mutate(source: string, offset: number, insert: string | undefined): string {
  const at = Math.max(0, Math.min(offset, Math.max(0, source.length - 1)));
  return insert === undefined ? source.slice(0, at) + source.slice(at + 1) : source.slice(0, at) + insert + source.slice(at);
}

describe('P8 — error recovery under single-character mutation', () => {
  it('never throws and always terminates', () => {
    fc.assert(
      fc.property(
        fc.nat(CORPUS_SOURCES.length - 1),
        fc.nat(4000),
        fc.option(fc.constantFrom('(', ')', '[', ']', '"', 'X', '\n', ' ', '=', '{'), { nil: undefined }),
        (which, offset, insert) => {
          const source = CORPUS_SOURCES[which] ?? '';
          const mutated = mutate(source, offset % Math.max(1, source.length), insert);
          const result = parse(mutated, REG);
          // A program is always returned, even when nothing parsed.
          expect(Array.isArray(result.program.statements)).toBe(true);
        },
      ),
      { numRuns: runs(400) },
    );
  });

  it('positions a diagnostic near the mutation whenever the mutation broke something', () => {
    fc.assert(
      fc.property(
        fc.nat(CORPUS_SOURCES.length - 1),
        fc.nat(4000),
        fc.option(fc.constantFrom('(', ')', '"', 'X', '='), { nil: undefined }),
        (which, offset, insert) => {
          const source = CORPUS_SOURCES[which] ?? '';
          if (source.length === 0) return;
          const at = offset % source.length;
          const baseline = parse(source, REG).diagnostics.length;
          const mutated = mutate(source, at, insert);
          const diagnostics = parse(mutated, REG).diagnostics;
          if (diagnostics.length <= baseline) return; // the mutation was benign — see the header
          const positioned = diagnostics.filter((d) => d.span !== undefined);
          expect(positioned.length).toBeGreaterThan(0);
          // "Inside the offending region": the nearest diagnostic is on the mutated line or within
          // a statement's reach of it. An unterminated construct legitimately reports at the token
          // that could not be closed, which may be the following line.
          const nearest = Math.min(...positioned.map((d) => Math.abs((d.span?.start ?? 0) - at)));
          expect(nearest).toBeLessThan(220);
        },
      ),
      { numRuns: runs(400) },
    );
  });

  it('never throws on arbitrary text', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 400 }), (source) => {
        const result = parse(source, REG);
        expect(result.program.statements.length).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: runs(300) },
    );
  });

  it('never throws on arbitrary keyword soup', () => {
    const words = fc.constantFrom(
      'IF', 'THEN', 'ELSE', 'QUESTION', 'END', 'OPTIONS', 'AND', 'OR', 'NOT', 'CASE', 'WHEN',
      'Q5', 'S1', '(', ')', '[', ']', ',', '=', '"x"', '1', 'MASK', 'RANDOMIZE', 'QUOTA', '{', '}',
      'PRIORITY', 'GROUP', 'TERMINATE', 'SET', 'SHOW', 'HIDE', 'ON', 'UNKNOWN', 'WHERE', 'item',
    );
    fc.assert(
      fc.property(fc.array(words, { maxLength: 40 }), (parts) => {
        const result = parse(parts.join(' '), REG);
        expect(result.program.statements.length).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: runs(300) },
    );
  });
});

/* ========================================================================== */
/* Trivia is not part of `≡`                                                  */
/* ========================================================================== */

describe('trivia does not participate in structural equality (D §6.4)', () => {
  it('two statements differing only in trivia are the same rule', () => {
    const withComment = parse('-- a note\nIF S1 = 1 THEN SHOW Q12\n', REG).program.statements[0];
    const without = parse('IF S1 = 1 THEN SHOW Q12\n', REG).program.statements[0];
    if (withComment === undefined || without === undefined) throw new Error('unreachable');
    const strip = (statement: Statement<Expr>): Statement<Expr> => {
      const { trivia: _drop, ...rest } = canonicalStatement(statement) as Statement<Expr> & {
        trivia?: Trivia;
      };
      void _drop;
      return rest as Statement<Expr>;
    };
    expect(strip(withComment)).toEqual(strip(without));
    expect(canonicalStatement(withComment)).not.toEqual(canonicalStatement(without));
  });
});
