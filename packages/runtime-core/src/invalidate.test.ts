/**
 * Test suite for invalidate-forward (task 58).
 *
 * The behaviour E §7.2 is trying to buy is *selective* invalidation, so the tests that matter
 * most are the ones asserting a page SURVIVES. A blanket "invalidate everything downstream"
 * implementation passes every invalidation test and fails the survival ones.
 */

import { describe, it, expect } from 'vitest';
import {
  dependentVariables,
  invalidateForward,
  invalidationCost,
  valueEquals,
  type InvalidateInput,
  type InvalidationArtifact,
  type InvalidationVisit,
  type RecomputeProbe,
} from './invalidate.js';

/* ---------------------------------------------------------------- *
 * Fixtures
 * ---------------------------------------------------------------- */

/**
 * A cell graph where `var_q1` feeds `var_derived`, and `var_postcode` feeds nothing.
 * `by_trigger_variable` mirrors the compiler's precomputed transitive closure.
 */
function cellGraph(): InvalidationArtifact {
  return {
    logic: {
      cells: [
        { key: 'value(var_q1)', kind: 'value', cell: { variable_id: 'var_q1' } },
        { key: 'value(var_derived)', kind: 'value', cell: { variable_id: 'var_derived' } },
        { key: 'visible(pg_3)', kind: 'visible', cell: { node_id: 'pg_3' } },
        { key: 'value(var_q2)', kind: 'value', cell: { variable_id: 'var_q2' } },
      ],
      by_trigger_variable: {
        var_q1: [0, 1, 2], // itself, the derived variable, and pg_3's visibility
        var_postcode: [],
      },
    },
  };
}

/** Every page visible, every digest stable — the "nothing drifted" baseline. */
function stableProbe(overrides: Partial<RecomputeProbe> = {}): RecomputeProbe {
  return {
    isPageVisible: () => true,
    recomputeDigest: page_id => `digest:${page_id}`,
    ...overrides,
  };
}

function visit(
  page_id: string,
  wrote: string[],
  shown: string[] = [],
  digest: string | null = `digest:${page_id}`,
): InvalidationVisit {
  return { page_id, wrote, shown, render_digest: digest };
}

function input(overrides: Partial<InvalidateInput> = {}): InvalidateInput {
  return {
    trigger_page_id: 'pg_1',
    history: [
      visit('pg_1', ['var_q1'], ['qst_1']),
      visit('pg_2', ['var_postcode'], ['qst_2']),
      visit('pg_3', ['var_q2'], ['qst_3', 'qst_4']),
    ],
    vars: { var_q1: 'yes', var_postcode: 'SW1A', var_q2: 'blue', var_derived: 7 },
    writes: { var_q1: 'no' },
    artifact: cellGraph(),
    probe: stableProbe(),
    now_ms: 5_000,
    ...overrides,
  };
}

/* ---------------------------------------------------------------- *
 * Value comparison
 * ---------------------------------------------------------------- */

describe('valueEquals', () => {
  it('compares scalars', () => {
    expect(valueEquals('a', 'a')).toBe(true);
    expect(valueEquals('a', 'b')).toBe(false);
    expect(valueEquals(1, 1)).toBe(true);
    expect(valueEquals(1, '1')).toBe(false);
  });

  it('treats null and undefined as the same no-answer state', () => {
    expect(valueEquals(null, undefined)).toBe(true);
    expect(valueEquals(null, null)).toBe(true);
    expect(valueEquals(null, '')).toBe(false);
    expect(valueEquals(undefined, 0)).toBe(false);
  });

  it('compares arrays in order, not as sets', () => {
    // A ranking question's value is an ordered array where reordering IS the answer. An
    // order-insensitive compare would keep every page downstream of a changed ranking.
    expect(valueEquals(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(valueEquals(['a', 'b'], ['b', 'a'])).toBe(false);
    expect(valueEquals(['a'], ['a', 'b'])).toBe(false);
  });

  it('compares objects by key regardless of insertion order', () => {
    expect(valueEquals({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(valueEquals({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(valueEquals({ a: 1 }, { a: 2 })).toBe(false);
  });

  it('recurses into nested structures', () => {
    expect(valueEquals({ x: [1, { y: 2 }] }, { x: [1, { y: 2 }] })).toBe(true);
    expect(valueEquals({ x: [1, { y: 2 }] }, { x: [1, { y: 3 }] })).toBe(false);
  });
});

/* ---------------------------------------------------------------- *
 * Dependency closure
 * ---------------------------------------------------------------- */

describe('dependentVariables', () => {
  it('reads the compiler-precomputed closure', () => {
    const deps = dependentVariables(cellGraph(), ['var_q1']);
    expect([...deps]).toEqual(['var_derived']);
  });

  it('excludes the changed variables themselves', () => {
    // The trigger page's writes are being set, not invalidated.
    const deps = dependentVariables(cellGraph(), ['var_q1']);
    expect(deps.has('var_q1')).toBe(false);
  });

  it('ignores non-value cells', () => {
    // visible(pg_3) is in var_q1's closure but names no variable.
    const deps = dependentVariables(cellGraph(), ['var_q1']);
    expect([...deps]).not.toContain('pg_3');
  });

  it('is empty for a variable nothing depends on', () => {
    expect([...dependentVariables(cellGraph(), ['var_postcode'])]).toEqual([]);
  });

  it('is empty for a variable absent from the graph', () => {
    expect([...dependentVariables(cellGraph(), ['var_unknown'])]).toEqual([]);
  });
});

/* ---------------------------------------------------------------- *
 * Step 2 — nothing changed
 * ---------------------------------------------------------------- */

describe('no-op when nothing changed', () => {
  it('a back-submit with identical values invalidates nothing', () => {
    // The common case: the respondent went back to LOOK at Q1, not to change it.
    const r = invalidateForward(input({ writes: { var_q1: 'yes' } }));

    expect(r.changed).toEqual([]);
    expect(r.invalidated_pages).toEqual([]);
    expect(r.invalidated_variables).toEqual([]);
    expect(r.event).toBeNull();
  });

  it('leaves downstream answers intact', () => {
    const r = invalidateForward(input({ writes: { var_q1: 'yes' } }));

    expect(r.vars['var_q2']).toBe('blue');
    expect(r.vars['var_derived']).toBe(7);
  });

  it('leaves history unmarked', () => {
    const r = invalidateForward(input({ writes: { var_q1: 'yes' } }));
    expect(r.history.every(v => !v.invalidated)).toBe(true);
  });

  it('still applies the writes', () => {
    const r = invalidateForward(input({ writes: { var_q1: 'yes', var_extra: 'new' } }));
    expect(r.vars['var_extra']).toBe('new');
    expect(r.changed).toEqual(['var_extra']);
  });
});

/* ---------------------------------------------------------------- *
 * Step 3 — survival
 * ---------------------------------------------------------------- */

describe('survival test', () => {
  it('keeps a downstream page that does not depend on the change', () => {
    // The postcode-typo case from E §7.2: nothing about pg_2 or pg_3 depends on var_postcode,
    // so a respondent fixing a typo keeps their downstream answers.
    const r = invalidateForward(
      input({
        trigger_page_id: 'pg_1',
        history: [
          visit('pg_1', ['var_postcode'], ['qst_1']),
          visit('pg_2', ['var_q2'], ['qst_2']),
          visit('pg_3', ['var_q3'], ['qst_3']),
        ],
        vars: { var_postcode: 'SW1A', var_q2: 'blue', var_q3: 'red' },
        writes: { var_postcode: 'SW1B' },
      }),
    );

    expect(r.changed).toEqual(['var_postcode']);
    expect(r.invalidated_pages).toEqual([]);
    expect(r.kept_pages).toEqual(['pg_2', 'pg_3']);
    expect(r.vars['var_q2']).toBe('blue');
    expect(r.vars['var_q3']).toBe('red');
  });

  it('invalidates a page whose write depends on the change', () => {
    const r = invalidateForward(
      input({
        history: [visit('pg_1', ['var_q1'], ['qst_1']), visit('pg_2', ['var_derived'], ['qst_2'])],
      }),
    );

    expect(r.invalidated_pages).toEqual(['pg_2']);
    expect(r.invalidated_variables).toEqual(['var_derived']);
    expect(r.vars['var_derived']).toBeNull();
  });

  it('invalidates a page that is no longer visible', () => {
    const r = invalidateForward(
      input({ probe: stableProbe({ isPageVisible: id => id !== 'pg_3' }) }),
    );

    expect(r.invalidated_pages).toEqual(['pg_3']);
    expect(r.kept_pages).toEqual(['pg_2']);
    expect(r.vars['var_q2']).toBeNull();
  });

  it('invalidates a page whose render drifted (mask or piping changed)', () => {
    const r = invalidateForward(
      input({
        probe: stableProbe({
          recomputeDigest: id => (id === 'pg_2' ? 'digest:pg_2:CHANGED' : `digest:${id}`),
        }),
      }),
    );

    expect(r.invalidated_pages).toEqual(['pg_2']);
    expect(r.kept_pages).toEqual(['pg_3']);
  });

  it('invalidates a visit with no recorded digest (fail-safe)', () => {
    // Cannot prove it is unchanged, so re-ask. Re-asking is recoverable; keeping a stale
    // answer to a differently-masked question is not.
    const r = invalidateForward(
      input({
        history: [
          visit('pg_1', ['var_q1'], ['qst_1']),
          visit('pg_2', ['var_postcode'], ['qst_2'], null),
        ],
      }),
    );

    expect(r.invalidated_pages).toEqual(['pg_2']);
  });

  it('invalidates when recomputation cannot answer', () => {
    const r = invalidateForward(input({ probe: stableProbe({ recomputeDigest: () => null }) }));
    expect(r.invalidated_pages).toEqual(['pg_2', 'pg_3']);
  });

  it('never touches pages at or before the trigger', () => {
    const r = invalidateForward(input({ trigger_page_id: 'pg_2' }));

    expect(r.invalidated_pages).not.toContain('pg_1');
    expect(r.invalidated_pages).not.toContain('pg_2');
    expect(r.vars['var_postcode']).toBe('SW1A');
  });

  it('uses the most recent visit of the trigger page as the frontier', () => {
    // On a re-visit the relevant entry is the current one, not the original.
    const r = invalidateForward(
      input({
        trigger_page_id: 'pg_1',
        history: [
          visit('pg_1', ['var_q1'], ['qst_1']),
          visit('pg_2', ['var_derived'], ['qst_2']),
          visit('pg_1', ['var_q1'], ['qst_1']),
        ],
      }),
    );

    // pg_2 is behind the *latest* pg_1 visit, so it is not downstream.
    expect(r.invalidated_pages).toEqual([]);
  });

  it('keeps an already-invalidated visit invalidated', () => {
    const r = invalidateForward(
      input({
        history: [
          visit('pg_1', ['var_q1'], ['qst_1']),
          { ...visit('pg_2', ['var_postcode'], ['qst_2']), invalidated: true },
        ],
      }),
    );

    expect(r.invalidated_pages).toEqual(['pg_2']);
    expect(r.history[1]?.invalidated).toBe(true);
  });
});

/* ---------------------------------------------------------------- *
 * Steps 4–5 — state and the event
 * ---------------------------------------------------------------- */

describe('invalidation effects', () => {
  it('nulls invalidated variables and stamps provenance', () => {
    const r = invalidateForward(
      input({ probe: stableProbe({ isPageVisible: id => id !== 'pg_3' }) }),
    );

    expect(r.vars['var_q2']).toBeNull();
    expect(r.provenance['var_q2']).toEqual({
      p: 'invalidated',
      by_page: 'pg_1',
      at: 5_000,
    });
  });

  it('does not stamp provenance for surviving variables', () => {
    const r = invalidateForward(
      input({ probe: stableProbe({ isPageVisible: id => id !== 'pg_3' }) }),
    );
    expect(r.provenance['var_postcode']).toBeUndefined();
  });

  it('keeps invalidated visits in history rather than deleting them', () => {
    const r = invalidateForward(
      input({ probe: stableProbe({ isPageVisible: id => id !== 'pg_3' }) }),
    );

    expect(r.history).toHaveLength(3);
    expect(r.history.map(v => v.page_id)).toEqual(['pg_1', 'pg_2', 'pg_3']);
    expect(r.history[2]?.invalidated).toBe(true);
    expect(r.history[1]?.invalidated).toBeFalsy();
  });

  it('emits exactly one event with the old values', () => {
    const r = invalidateForward(
      input({ probe: stableProbe({ isPageVisible: id => id !== 'pg_3' }) }),
    );

    expect(r.event).toEqual({
      type: 'answers_invalidated',
      trigger_page: 'pg_1',
      changed_variables: ['var_q1'],
      invalidated_pages: ['pg_3'],
      invalidated_variables: ['var_q2'],
      kept_pages: ['pg_2'],
      old_values: { var_q2: 'blue', var_q1: 'yes' },
    });
  });

  it('old values live in the event, never in the document', () => {
    const r = invalidateForward(
      input({ probe: stableProbe({ isPageVisible: id => id !== 'pg_3' }) }),
    );

    expect(r.event?.old_values['var_q2']).toBe('blue'); // recoverable forever (ADR-007)
    expect(r.vars['var_q2']).toBeNull(); // gone from the current document
  });

  it('does not mutate the input state', () => {
    const i = input({ probe: stableProbe({ isPageVisible: () => false }) });
    const before = JSON.stringify({ vars: i.vars, history: i.history });
    invalidateForward(i);

    expect(JSON.stringify({ vars: i.vars, history: i.history })).toBe(before);
  });

  it('is deterministic', () => {
    const i = input({ probe: stableProbe({ isPageVisible: id => id !== 'pg_3' }) });
    expect(invalidateForward(i)).toEqual(invalidateForward(i));
  });
});

/* ---------------------------------------------------------------- *
 * The confirmation prompt
 * ---------------------------------------------------------------- */

describe('invalidationCost', () => {
  it('counts the questions a back-submit would re-ask', () => {
    // pg_3 shows two questions and is the only invalidated page.
    const cost = invalidationCost(
      input({ probe: stableProbe({ isPageVisible: id => id !== 'pg_3' }) }),
    );

    expect(cost).toEqual({ questions: 2, pages: 1 });
  });

  it('is zero when nothing would be invalidated', () => {
    const cost = invalidationCost(input({ writes: { var_q1: 'yes' } }));
    expect(cost).toEqual({ questions: 0, pages: 0 });
  });

  it('agrees with what invalidateForward actually does', () => {
    // The number shown to the respondent and the invalidation they get must not disagree.
    const i = input({ probe: stableProbe({ recomputeDigest: () => null }) });
    const cost = invalidationCost(i);
    const result = invalidateForward(i);

    expect(cost.pages).toBe(result.invalidated_pages.length);
  });
});
