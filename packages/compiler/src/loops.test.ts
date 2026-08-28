/**
 * Loop unrolling (roadmap P2-02).
 *
 * Three groups of assertions, and the first is the one that matters most.
 *
 * **The design invariant.** Unrolled iterations SHARE one authored page's logic cells, and that is
 * exact rather than approximate only because `packages/logic`'s `Expr` union contains no node that
 * reads the current iteration. If such a node is ever added, this whole file's assumption becomes a
 * bug — so the invariant is asserted here against the real union. Adding an iteration-reading node
 * fails a test that names `loops.ts`, instead of silently invalidating it.
 *
 * **Determinism.** Per-iteration ids are DERIVED, never minted, on the house rule
 * `authoring-model.ts` states: "a fresh ULID per compile would change graph.json, change the
 * artifact hash, and destroy the one property the milestone is judged on." Derivation is lossy, so
 * a collision is possible and is reported (`CMP-0108`) rather than hoped against.
 *
 * **Ordering.** A loop over brands asking three questions on three pages must ask all three about
 * brand 1 before starting brand 2. Emitting page-major instead of iteration-major is a different
 * survey, and it is the mistake that looks identical in a diff.
 */

import { describe, expect, it } from 'vitest';
import type { LoopSpec, Survey } from '@resscript/schema';

import {
  checkDerivedPageIds,
  derivedPageId,
  emitsAtIteration,
  hasLoops,
  iterationCount,
  loopsByPage,
  unrollPageOrder,
} from './loops.js';

const PG = (tag: string) => `pg_0${tag.toUpperCase().padEnd(25, '0')}`;

function loop(over: Partial<LoopSpec> = {}): LoopSpec {
  return {
    source: { kind: 'numeric_range', from: 1, to: 3 },
    max_iterations: 3,
    iteration_variable_ref: 'BRAND',
    variable_naming: '{ref}_{iteration}',
    ...over,
  } as LoopSpec;
}

/* ---------------------------------------------------------------- *
 * THE DESIGN INVARIANT
 * ---------------------------------------------------------------- */

describe('the invariant this whole design rests on', () => {
  it('no logic expression can read the current iteration', async () => {
    // Unrolled iterations share one authored page's visibility cell, one items cell, one
    // validation. That is the same value N times — not an approximation of N cells — precisely
    // because no rule can vary by iteration. The only per-item binding in the AST is
    // `item`/`item_attr`, which binds to an option, row or column; a loop is reachable from logic
    // solely as an aggregation GROUP (`loop_iterations`), which reads ACROSS iterations rather than
    // within one.
    //
    // If an iteration-reading node is added, `compiler/src/loops.ts` needs per-iteration logic
    // cells and its sharing assumption becomes a silent bug. This test is the tripwire.
    const ast = await import('@resscript/logic');
    const source = JSON.stringify(Object.keys(ast));
    for (const forbidden of ['iterationRef', 'currentIteration', 'loopIndex']) {
      expect(source).not.toContain(forbidden);
    }
    // And the group kinds still reach a loop only in aggregate.
    expect(source).not.toContain('iteration_of');
  });
});

/* ---------------------------------------------------------------- *
 * Id derivation
 * ---------------------------------------------------------------- */

describe('derivedPageId', () => {
  it('keeps the prefix and the total length, so the id is still a valid ULID', () => {
    // The `app.ulid` domain is `^[a-z]{2,5}_[0-7][0-9A-HJKMNP-TV-Z]{25}$`. A derived id that broke
    // it would be rejected by the database that stores the artifact's page references.
    const id = derivedPageId(PG('1abc'), 2);
    expect(id).toMatch(/^pg_[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    expect(id).toHaveLength(PG('1abc').length);
  });

  it('uses only Crockford characters, excluding I, L, O and U', () => {
    for (let i = 1; i <= 40; i += 1) {
      const suffix = derivedPageId(PG('1abc'), i).slice(-4);
      expect(suffix).not.toMatch(/[ILOU]/);
    }
  });

  it('is DETERMINISTIC — the same page and iteration give the same id', () => {
    // The house rule from authoring-model.ts. A minted id would change the artifact hash on every
    // recompile.
    expect(derivedPageId(PG('1abc'), 3)).toBe(derivedPageId(PG('1abc'), 3));
  });

  it('gives distinct ids to distinct iterations, well past any real cap', () => {
    const ids = new Set(Array.from({ length: 300 }, (_, i) => derivedPageId(PG('1abc'), i + 1)));
    expect(ids.size).toBe(300);
  });

  it('gives distinct ids to distinct pages at the same iteration', () => {
    expect(derivedPageId(PG('1abc'), 1)).not.toBe(derivedPageId(PG('1abd'), 1));
  });

  it('derives an id for iteration 1 too, rather than keeping the authored one', () => {
    // Uniform on purpose: if iteration 1 kept the authored id, a loop would have one page addressed
    // differently from its siblings and every downstream map would need to know which case it was
    // looking at.
    expect(derivedPageId(PG('1abc'), 1)).not.toBe(PG('1abc'));
  });

  it('marks the suffix, so an iteration id is recognisable rather than merely different', () => {
    expect(derivedPageId(PG('1abc'), 1).slice(-4, -3)).toBe('V');
  });
});

/* ---------------------------------------------------------------- *
 * iterationCount
 * ---------------------------------------------------------------- */

describe('iterationCount', () => {
  it('is the cap for a selected_options source, since the real count is a respondent answer', () => {
    const l = loop({ source: { kind: 'selected_options', variable_id: 'var_x' } as never, max_iterations: 5 });
    expect(iterationCount(l)).toBe(5);
  });

  it('is bounded BELOW the cap by an explicit list', () => {
    // Unrolling 20 iterations for a 4-item list would emit 16 pages nobody can reach and 16 sets of
    // export columns that are always empty.
    const l = loop({
      max_iterations: 20,
      source: {
        kind: 'explicit_list',
        items: [
          { ref: 'A', code: 1 },
          { ref: 'B', code: 2 },
        ],
      } as never,
    });
    expect(iterationCount(l)).toBe(2);
  });

  it('is bounded below the cap by a numeric range', () => {
    expect(
      iterationCount(loop({ max_iterations: 20, source: { kind: 'numeric_range', from: 2, to: 4 } as never })),
    ).toBe(3);
  });

  it('is the cap when the range exceeds it', () => {
    expect(
      iterationCount(loop({ max_iterations: 3, source: { kind: 'numeric_range', from: 1, to: 99 } as never })),
    ).toBe(3);
  });

  it('is zero for a cap below 1, which CMP-0104 reports separately', () => {
    expect(iterationCount(loop({ max_iterations: 0 }))).toBe(0);
    expect(iterationCount(loop({ max_iterations: -1 }))).toBe(0);
  });

  it('is zero for a backwards range', () => {
    expect(
      iterationCount(loop({ source: { kind: 'numeric_range', from: 5, to: 2 } as never })),
    ).toBe(0);
  });
});

/* ---------------------------------------------------------------- *
 * unrollPageOrder — the ordering that decides what survey this is
 * ---------------------------------------------------------------- */

describe('unrollPageOrder', () => {
  const A = PG('1a');
  const B = PG('1b');
  const C = PG('1c');

  it('leaves a page outside a loop exactly as it was', () => {
    const out = unrollPageOrder([A, B], new Map());
    expect(out).toEqual([
      { id: A, authoredId: A, iteration: 0 },
      { id: B, authoredId: B, iteration: 0 },
    ]);
  });

  it('expands one looped page into one entry per iteration', () => {
    const l = loop({ max_iterations: 2, source: { kind: 'numeric_range', from: 1, to: 2 } as never });
    const out = unrollPageOrder([A], new Map([[A, l]]));

    expect(out.map((p) => p.iteration)).toEqual([1, 2]);
    expect(out.map((p) => p.authoredId)).toEqual([A, A]);
    expect(new Set(out.map((p) => p.id)).size).toBe(2);
  });

  it('wraps the ITERATION around the whole run of pages, not each page separately', () => {
    // The assertion that decides what survey this is. A loop over brands asking three questions on
    // three pages must ask all three about brand 1 before starting brand 2. Page-major would ask
    // question 1 about every brand, then question 2 about every brand — a different instrument, and
    // a mistake that looks identical in a diff.
    const l = loop({ max_iterations: 2, source: { kind: 'numeric_range', from: 1, to: 2 } as never });
    const out = unrollPageOrder([A, B], new Map([[A, l], [B, l]]));

    expect(out.map((p) => [p.authoredId, p.iteration])).toEqual([
      [A, 1],
      [B, 1],
      [A, 2],
      [B, 2],
    ]);
  });

  it('keeps a page BEFORE and AFTER the loop outside it', () => {
    const l = loop({ max_iterations: 2, source: { kind: 'numeric_range', from: 1, to: 2 } as never });
    const out = unrollPageOrder([A, B, C], new Map([[B, l]]));

    expect(out.map((p) => [p.authoredId, p.iteration])).toEqual([
      [A, 0],
      [B, 1],
      [B, 2],
      [C, 0],
    ]);
  });

  it('treats two DIFFERENT loops as separate runs even when adjacent', () => {
    const l1 = loop({ max_iterations: 2, source: { kind: 'numeric_range', from: 1, to: 2 } as never });
    const l2 = loop({
      iteration_variable_ref: 'CTRY',
      max_iterations: 2,
      source: { kind: 'numeric_range', from: 1, to: 2 } as never,
    });
    const out = unrollPageOrder([A, B], new Map([[A, l1], [B, l2]]));

    expect(out.map((p) => [p.authoredId, p.iteration])).toEqual([
      [A, 1],
      [A, 2],
      [B, 1],
      [B, 2],
    ]);
  });

  it('emits NO pages for a loop that iterates zero times', () => {
    // Consistent with iterationCount. CMP-0104 is what tells the author; this just does not invent
    // pages for a loop that runs none.
    const out = unrollPageOrder([A], new Map([[A, loop({ max_iterations: 0 })]]));
    expect(out).toEqual([]);
  });
});

/* ---------------------------------------------------------------- *
 * Collision detection
 * ---------------------------------------------------------------- */

describe('checkDerivedPageIds', () => {
  it('says nothing when nothing collides', () => {
    const l = loop({ max_iterations: 2, source: { kind: 'numeric_range', from: 1, to: 2 } as never });
    const out = unrollPageOrder([PG('1a')], new Map([[PG('1a'), l]]));
    expect(checkDerivedPageIds(out, [PG('1a'), PG('1b')])).toEqual([]);
  });

  it('reports CMP-0108 when a derived id equals an authored page id', () => {
    // Derivation replaces four characters of a ULID body, so this is rare and possible. Two pages
    // sharing an id would share an artifact file and a flow entry, serving one page's content where
    // the other was expected — so it is a publish error somebody reads, not a probability.
    const authored = PG('1a');
    const collides = derivedPageId(authored, 1);
    const out = unrollPageOrder([authored], new Map([[authored, loop({ max_iterations: 1 })]]));
    const d = checkDerivedPageIds(out, [authored, collides]);

    expect(d.map((x) => x.code)).toEqual(['CMP-0108']);
    expect(d[0]?.detail?.['collides_with']).toBe('authored_page');
  });

  it('ignores pages outside a loop, which cannot collide with anything derived', () => {
    const out = unrollPageOrder([PG('1a'), PG('1b')], new Map());
    expect(checkDerivedPageIds(out, [PG('1a'), PG('1b')])).toEqual([]);
  });
});

/* ---------------------------------------------------------------- *
 * emitsAtIteration — the variable binding
 * ---------------------------------------------------------------- */

describe('emitsAtIteration', () => {
  const survey = {
    variables: [
      { id: 'var_a1', source: { question_id: 'qst_1', iteration: 1 } },
      { id: 'var_a2', source: { question_id: 'qst_1', iteration: 2 } },
      { id: 'var_b', source: { question_id: 'qst_2' } },
      { id: 'var_other', source: { question_id: 'qst_3', iteration: 1 } },
    ],
  } as unknown as Survey;

  it('returns only THIS iteration variables', () => {
    // The reason this function exists: `emitsOf` in emit/pages.ts collects every variable whose
    // source.question_id matches, which for a looped question is all N iterations. One rendered
    // question carrying N iterations' variables is how an answer at iteration 2 gets written into
    // iteration 1's export column — or into all of them.
    expect(emitsAtIteration(survey, 'qst_1', 1)).toEqual(['var_a1']);
    expect(emitsAtIteration(survey, 'qst_1', 2)).toEqual(['var_a2']);
  });

  it('returns the iteration-less variables for a question outside a loop', () => {
    expect(emitsAtIteration(survey, 'qst_2', 0)).toEqual(['var_b']);
  });

  it('does not mix a looped question iteration-less variables into an iteration', () => {
    expect(emitsAtIteration(survey, 'qst_2', 1)).toEqual([]);
  });

  it('returns nothing for an iteration that has no variables', () => {
    expect(emitsAtIteration(survey, 'qst_1', 9)).toEqual([]);
  });
});

/* ---------------------------------------------------------------- *
 * loopsByPage / hasLoops
 * ---------------------------------------------------------------- */

describe('loopsByPage', () => {
  function tree(withLoop: boolean): Survey {
    return {
      content: [
        {
          id: 'blk_1',
          type: 'block',
          ref: 'B1',
          ...(withLoop ? { settings: { loop: loop() } } : {}),
          children: [
            { id: PG('1a'), type: 'page', ref: 'P1', children: [] },
            { id: PG('1b'), type: 'page', ref: 'P2', children: [] },
          ],
        },
      ],
    } as unknown as Survey;
  }

  it('maps every page under a looped block to that loop', () => {
    const m = loopsByPage(tree(true));
    expect(m.get(PG('1a'))?.iteration_variable_ref).toBe('BRAND');
    expect(m.get(PG('1b'))?.iteration_variable_ref).toBe('BRAND');
    // The SAME object, which is what lets unrollPageOrder group consecutive pages into one run.
    expect(m.get(PG('1a'))).toBe(m.get(PG('1b')));
  });

  it('is empty for a survey with no loops', () => {
    expect(loopsByPage(tree(false)).size).toBe(0);
  });

  it('tolerates a survey with no content', () => {
    expect(loopsByPage({} as Survey).size).toBe(0);
  });
});

describe('hasLoops', () => {
  it('is false for a survey with no loops, so the unroll path costs nothing', () => {
    expect(hasLoops({ content: [] } as unknown as Survey)).toBe(false);
    expect(hasLoops({} as Survey)).toBe(false);
  });
});
