/**
 * `CMP-0100` and the loop-spec checks (roadmap P2-02).
 *
 * The headline is that CMP-0100 fires at all. It has been DECLARED in `diagnostics.ts` at severity
 * `error` since P1-08 and emitted by nothing, while `derive.ts` reasoned from its existence —
 * "nested loops are `CMP-0100` anyway" — to justify keeping only the innermost loop. So a nested
 * loop compiled clean and the compiler then silently unrolled one loop's worth of variables instead
 * of the product: a survey asking three questions about each of four brands in each of two countries
 * emitted a quarter of its columns, with no diagnostic, and the gap surfaced as an analyst's
 * confusion months later.
 *
 * A declared-and-never-emitted error code is worse than an absent one, because the code's existence
 * is what convinces the next reader the case is handled.
 *
 * The remaining cases are the ones `validate.ts` does not check — it makes exactly one loop check —
 * and each is a survey that publishes and then misbehaves rather than one that fails to publish.
 */

import { describe, expect, it } from 'vitest';
import type { LoopSpec, Survey } from '@resscript/schema';

import { analyzeLoops } from './loops.js';

const codes = (d: readonly { code: string }[]): string[] => d.map((x) => x.code);

function loop(over: Partial<LoopSpec> = {}): LoopSpec {
  return {
    source: { kind: 'numeric_range', from: 1, to: 3 },
    max_iterations: 3,
    iteration_variable_ref: 'BRAND',
    variable_naming: '{ref}_{iteration}',
    ...over,
  } as LoopSpec;
}

/** A block tree from a nesting description: `blockTree([loopA, undefined, loopB])` is 3 deep. */
function blockTree(levels: readonly (LoopSpec | undefined)[]): Survey {
  let inner: unknown[] = [
    { id: 'qst_leaf', kind: 'question', ref: 'Q1', question_type: 'single_select' },
  ];
  for (let i = levels.length - 1; i >= 0; i -= 1) {
    const spec = levels[i];
    inner = [
      {
        id: `blk_${String(i)}`,
        kind: 'block',
        ref: `B${String(i)}`,
        content: inner,
        ...(spec === undefined ? {} : { settings: { loop: spec } }),
      },
    ];
  }
  return { content: inner } as unknown as Survey;
}

/* ---------------------------------------------------------------- *
 * CMP-0100
 * ---------------------------------------------------------------- */

describe('CMP-0100 — nested loops', () => {
  it('emits NOTHING for a survey with no loops', () => {
    expect(analyzeLoops({ survey: blockTree([undefined, undefined]) })).toEqual([]);
  });

  it('emits nothing for ONE loop, however deep the tree', () => {
    expect(codes(analyzeLoops({ survey: blockTree([undefined, loop(), undefined]) }))).toEqual([]);
  });

  it('FIRES for two directly nested loops', () => {
    // The bug. This compiled clean before P2-02.
    const d = analyzeLoops({ survey: blockTree([loop(), loop({ iteration_variable_ref: 'CTRY' })]) });
    expect(codes(d)).toEqual(['CMP-0100']);
    expect(d[0]?.detail?.['depth']).toBe(2);
  });

  it('fires for two loops separated by a plain block', () => {
    // The nesting that matters is the LOOP chain, not adjacency in the tree — a non-loop block
    // between them changes nothing about how many times the inner one runs.
    const d = analyzeLoops({
      survey: blockTree([loop(), undefined, loop({ iteration_variable_ref: 'CTRY' })]),
    });
    expect(codes(d)).toEqual(['CMP-0100']);
  });

  it('reports ONCE for a three-deep nesting, not twice', () => {
    // One authoring mistake, one row: the fix is the same edit whichever depth is named, and two
    // rows for one cause is how a diagnostic list becomes noise.
    const d = analyzeLoops({
      survey: blockTree([
        loop(),
        loop({ iteration_variable_ref: 'CTRY' }),
        loop({ iteration_variable_ref: 'WAVE' }),
      ]),
    });
    expect(codes(d).filter((c) => c === 'CMP-0100')).toHaveLength(1);
    expect(d[0]?.detail?.['depth']).toBe(3);
  });

  it('names every loop in the chain, so the author can see which two to separate', () => {
    const d = analyzeLoops({ survey: blockTree([loop(), loop({ iteration_variable_ref: 'CTRY' })]) });
    expect(d[0]?.detail?.['iteration_refs']).toEqual(['BRAND', 'CTRY']);
  });

  it('does NOT fire for two loops in SIBLING branches', () => {
    // Two independent loops are the normal way to loop over two things, and refusing them would
    // make the check useless.
    const survey = {
      content: [
        {
          id: 'blk_root',
          kind: 'block',
          ref: 'B',
          content: [
            { id: 'blk_a', kind: 'block', ref: 'BA', settings: { loop: loop() }, content: [] },
            {
              id: 'blk_b',
              kind: 'block',
              ref: 'BB',
              settings: { loop: loop({ iteration_variable_ref: 'CTRY' }) },
              content: [],
            },
          ],
        },
      ],
    } as unknown as Survey;
    expect(codes(analyzeLoops({ survey }))).toEqual([]);
  });

  it('explains WHY in the message, not just that it is unsupported', () => {
    // The author's question is "what breaks if I leave it", and the answer — a fraction of the
    // export columns, silently — is the part that makes them act.
    const d = analyzeLoops({ survey: blockTree([loop(), loop()]) });
    expect(d[0]?.message).toContain('INNERMOST');
    expect(d[0]?.message).toContain('export');
  });
});

/* ---------------------------------------------------------------- *
 * max_iterations
 * ---------------------------------------------------------------- */

describe('CMP-0104 — a loop that iterates zero times', () => {
  it('fires for max_iterations 0', () => {
    // Unrolls nothing: no variables, no pages. Reads as the loop block having vanished.
    expect(codes(analyzeLoops({ survey: blockTree([loop({ max_iterations: 0 })]) }))).toEqual([
      'CMP-0104',
    ]);
  });

  it('fires for a negative or non-integer count', () => {
    for (const n of [-1, 1.5]) {
      expect(codes(analyzeLoops({ survey: blockTree([loop({ max_iterations: n })]) }))).toContain(
        'CMP-0104',
      );
    }
  });

  it('accepts 1 — a loop that runs once is odd, not wrong', () => {
    expect(codes(analyzeLoops({ survey: blockTree([loop({ max_iterations: 1 })]) }))).toEqual([]);
  });

  it('fires for an empty explicit list', () => {
    const d = analyzeLoops({
      survey: blockTree([loop({ source: { kind: 'explicit_list', items: [] } })]),
    });
    expect(codes(d)).toContain('CMP-0104');
  });

  it('fires for a backwards numeric range', () => {
    const d = analyzeLoops({
      survey: blockTree([loop({ source: { kind: 'numeric_range', from: 5, to: 2 } })]),
    });
    expect(codes(d)).toContain('CMP-0104');
  });

  it('accepts a single-value range (from === to)', () => {
    const d = analyzeLoops({
      survey: blockTree([loop({ source: { kind: 'numeric_range', from: 3, to: 3 } })]),
    });
    expect(codes(d)).toEqual([]);
  });
});

describe('CMP-0105 — a very large iteration count', () => {
  it('warns above the threshold', () => {
    expect(codes(analyzeLoops({ survey: blockTree([loop({ max_iterations: 500 })]) }))).toEqual([
      'CMP-0105',
    ]);
  });

  it('is a WARNING, not an error — a long loop is sometimes right', () => {
    const d = analyzeLoops({ survey: blockTree([loop({ max_iterations: 500 })]) });
    expect(d[0]?.severity).toBe('warning');
  });

  it('says nothing at a normal count', () => {
    expect(codes(analyzeLoops({ survey: blockTree([loop({ max_iterations: 12 })]) }))).toEqual([]);
  });
});

/* ---------------------------------------------------------------- *
 * variable_naming
 * ---------------------------------------------------------------- */

describe('CMP-0106 — a naming template without {iteration}', () => {
  it('warns, because every iteration would derive the same name', () => {
    const d = analyzeLoops({ survey: blockTree([loop({ variable_naming: '{ref}_x' })]) });
    expect(codes(d)).toEqual(['CMP-0106']);
    expect(d[0]?.severity).toBe('warning');
  });

  it('explains that the variables stay DISTINCT and the export does not', () => {
    // The subtle part, and the reason this is a warning rather than an error: identity is keyed on
    // (question, part, iteration), so nothing breaks at compile time. The damage is two export
    // columns under one header, which an analyst finds by opening the file.
    const d = analyzeLoops({ survey: blockTree([loop({ variable_naming: '{ref}' })]) });
    expect(d[0]?.message).toContain('distinct');
    expect(d[0]?.message).toContain('export');
  });

  it('accepts any template that contains it, in any position', () => {
    for (const t of ['{ref}_{iteration}', 'i{iteration}_{ref}', '{iteration}']) {
      expect(codes(analyzeLoops({ survey: blockTree([loop({ variable_naming: t })]) }))).toEqual([]);
    }
  });
});

/* ---------------------------------------------------------------- *
 * explicit_list duplicates
 * ---------------------------------------------------------------- */

describe('CMP-0107 — duplicate loop items', () => {
  const items = (specs: readonly [string, number][]) =>
    specs.map(([ref, code]) => ({ ref, code }));

  it('fires on a duplicate ref', () => {
    // A ref is how {{BRAND.label}} resolves, so a duplicate makes the piped text a respondent
    // reads ambiguous.
    const d = analyzeLoops({
      survey: blockTree([
        loop({ source: { kind: 'explicit_list', items: items([['A', 1], ['A', 2]]) } as never }),
      ]),
    });
    expect(codes(d)).toEqual(['CMP-0107']);
    expect(d[0]?.detail?.['duplicate_refs']).toEqual(['A']);
  });

  it('fires on a duplicate code', () => {
    // A code is how an iteration joins to an answer.
    const d = analyzeLoops({
      survey: blockTree([
        loop({ source: { kind: 'explicit_list', items: items([['A', 1], ['B', 1]]) } as never }),
      ]),
    });
    expect(codes(d)).toEqual(['CMP-0107']);
    expect(d[0]?.detail?.['duplicate_codes']).toEqual([1]);
  });

  it('accepts a clean list', () => {
    const d = analyzeLoops({
      survey: blockTree([
        loop({
          source: { kind: 'explicit_list', items: items([['A', 1], ['B', 2], ['C', 3]]) } as never,
        }),
      ]),
    });
    expect(codes(d)).toEqual([]);
  });
});

/* ---------------------------------------------------------------- *
 * Stability
 * ---------------------------------------------------------------- */

describe('stability', () => {
  it('reports one loop once even when several descendants reach it', () => {
    // One loop with three pages under it is one authoring object, not three.
    const survey = {
      content: [
        {
          id: 'blk_0',
          kind: 'block',
          ref: 'B0',
          settings: { loop: loop({ max_iterations: 0 }) },
          content: [
            { id: 'blk_a', kind: 'block', ref: 'BA', content: [] },
            { id: 'blk_b', kind: 'block', ref: 'BB', content: [] },
            { id: 'blk_c', kind: 'block', ref: 'BC', content: [] },
          ],
        },
      ],
    } as unknown as Survey;
    expect(codes(analyzeLoops({ survey })).filter((c) => c === 'CMP-0104')).toHaveLength(1);
  });

  it('tolerates a survey with no content at all', () => {
    expect(analyzeLoops({ survey: {} as Survey })).toEqual([]);
  });
});
