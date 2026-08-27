/**
 * Cell resolution — which quota cells a respondent occupies (E §10, roadmap P2-06).
 *
 * The properties under test are the ones that decide whether a client's sample plan fills
 * correctly, and every one of them has a plausible wrong answer that no type would catch:
 *
 *  - **UNKNOWN is not a match.** A respondent whose age was never asked must land in NO age bucket.
 *    Treating unknown as a match, or falling back to the first bucket, loads one cell with everyone
 *    who skipped the question and the overshoot is indistinguishable from real data.
 *  - **Interlocked needs every dimension; marginal does not.** They are different mathematical
 *    objects (schema `quotas.ts`), and conflating them either invents cells that do not exist or
 *    drops respondents who should be counted.
 *  - **Declared bucket order is the tie-break** for overlapping buckets, so the answer is the one
 *    the author wrote rather than an iteration accident.
 *  - **No cell means the respondent passes** — asserted here as "resolves to zero cells", with the
 *    gate's half of that decision tested in `handler.test.ts`.
 *
 * Bucket `match` ASTs are represented as opaque tokens and decided by a stub evaluator. That is
 * deliberate: this module's job is bucket selection and key construction, not expression semantics,
 * and `packages/logic` already owns the latter with 397 tests. A real engine here would test the
 * engine twice and this module's actual contract once.
 */

import { describe, expect, it } from 'vitest';
import type { QuotaConfig } from '@resscript/schema';

import { overflowFor, planFor, resolveCells } from './cells.js';

/* ---------------------------------------------------------------- *
 * Fixtures
 * ---------------------------------------------------------------- */

/**
 * A bucket `match` stands in for its AST as `{ t: '<token>' }`; the evaluator below is told which
 * tokens are true. `as never` because the field is typed as a real `Expr` and this module never
 * looks inside it.
 */
const m = (token: string) => ({ t: token }) as never;

function verdicts(trueTokens: readonly string[], unknownTokens: readonly string[] = []) {
  return (condition: unknown): boolean | null => {
    const token = (condition as { t?: string } | null)?.t ?? '';
    if (unknownTokens.includes(token)) return null;
    return trueTokens.includes(token);
  };
}

const POLICY: QuotaConfig['policy'] = {
  count_at: 'reservation',
  reservation_ttl_s: 5400,
  on_store_unavailable: 'fail_closed',
  counter_scope: 'survey',
};

/** Two dimensions — gender (M/F) and age band (18_24/25_34) — the schema §8 worked example. */
function config(planType: 'interlocked' | 'marginal'): QuotaConfig {
  return {
    policy: POLICY,
    dimensions: [
      {
        id: 'qd_gender' as never,
        ref: 'GENDER',
        variable_id: 'var_s2' as never,
        buckets: [
          { ref: 'M', match: m('is_m') },
          { ref: 'F', match: m('is_f') },
        ],
      },
      {
        id: 'qd_age' as never,
        ref: 'AGE_BAND',
        variable_id: 'var_age' as never,
        buckets: [
          { ref: '18_24', match: m('is_18_24') },
          { ref: '25_34', match: m('is_25_34') },
        ],
      },
    ],
    plans: [
      {
        id: 'qp_main' as never,
        ref: 'MAIN',
        type: planType,
        dimension_ids: ['qd_gender' as never, 'qd_age' as never],
        cells:
          planType === 'interlocked'
            ? [
                { key: ['M', '18_24'], target: 100, mode: 'hard' },
                { key: ['F', '18_24'], target: 100, mode: 'hard' },
                { key: ['M', '25_34'], target: 50, mode: 'soft' },
              ]
            : [
                { key: ['M'], target: 200, mode: 'hard' },
                { key: ['F'], target: 200, mode: 'hard' },
                { key: ['18_24'], target: 150, mode: 'soft' },
              ],
        overflow: 'SCREENOUT',
      },
    ],
  };
}

const SCOPE = 'srv_01ABC';

function resolve(
  planType: 'interlocked' | 'marginal',
  trueTokens: readonly string[],
  unknownTokens: readonly string[] = [],
) {
  return resolveCells({
    config: config(planType),
    planRef: 'MAIN',
    scope: SCOPE,
    evalCondition: verdicts(trueTokens, unknownTokens),
  });
}

/* ---------------------------------------------------------------- *
 * Interlocked
 * ---------------------------------------------------------------- */

describe('interlocked plans', () => {
  it('resolves the cross-product cell and keys it q:{scope}:{plan}:{cell}', () => {
    const r = resolve('interlocked', ['is_m', 'is_18_24']);

    expect(r.cells).toEqual([{ key: `q:${SCOPE}:qp_main:M|18_24`, mode: 'hard' }]);
    expect(r.buckets).toEqual({ GENDER: 'M', AGE_BAND: '18_24' });
    expect(r.unresolved).toEqual([]);
  });

  it('carries the cell\'s own mode, so a soft cell is reserved as soft', () => {
    const r = resolve('interlocked', ['is_m', 'is_25_34']);

    expect(r.cells).toEqual([{ key: `q:${SCOPE}:qp_main:M|25_34`, mode: 'soft' }]);
  });

  it('resolves to NO cell when one dimension does not resolve', () => {
    // A cell key is a tuple with one bucket per dimension; with age unresolved there is no tuple.
    const r = resolve('interlocked', ['is_m']);

    expect(r.cells).toEqual([]);
    expect(r.buckets).toEqual({ GENDER: 'M' });
    expect(r.unresolved).toEqual(['AGE_BAND']);
  });

  it('treats an UNKNOWN bucket condition as not matched, not as a match', () => {
    // The headline. `is_18_24` is UNKNOWN — the respondent never answered age — so they occupy no
    // age bucket and therefore no interlocked cell, rather than being loaded into 18_24.
    const r = resolve('interlocked', ['is_m'], ['is_18_24']);

    expect(r.cells).toEqual([]);
    expect(r.unresolved).toEqual(['AGE_BAND']);
  });

  it('resolves to no cell when the tuple is one the plan does not declare', () => {
    // [F, 25_34] is a legitimate combination the author chose not to give a target. Uncounted is
    // the right answer: there is no target to be full of. `LGC-Q002` reports a plan that does not
    // add up, at publish, where it can be fixed.
    const r = resolve('interlocked', ['is_f', 'is_25_34']);

    expect(r.cells).toEqual([]);
    expect(r.buckets).toEqual({ GENDER: 'F', AGE_BAND: '25_34' });
    // Both dimensions DID resolve — this is not an unresolved-dimension case, and conflating the
    // two would hide a plan with a missing cell behind a message about a missing answer.
    expect(r.unresolved).toEqual([]);
  });

  it('picks the first matching bucket when two overlap, in declared order', () => {
    const r = resolve('interlocked', ['is_m', 'is_f', 'is_18_24']);

    expect(r.buckets['GENDER']).toBe('M');
  });
});

/* ---------------------------------------------------------------- *
 * Marginal
 * ---------------------------------------------------------------- */

describe('marginal plans', () => {
  it('produces one independent cell per resolved dimension', () => {
    const r = resolve('marginal', ['is_m', 'is_18_24']);

    expect(r.cells).toEqual([
      { key: `q:${SCOPE}:qp_main:M`, mode: 'hard' },
      { key: `q:${SCOPE}:qp_main:18_24`, mode: 'soft' },
    ]);
  });

  it('still counts the dimensions that DID resolve when another does not', () => {
    // The difference from interlocked, and the reason the two are not one code path: a marginal
    // target is per-dimension by definition, so an unresolved age band does not remove the
    // respondent from the gender counter.
    const r = resolve('marginal', ['is_m'], ['is_18_24']);

    expect(r.cells).toEqual([{ key: `q:${SCOPE}:qp_main:M`, mode: 'hard' }]);
    expect(r.unresolved).toEqual(['AGE_BAND']);
  });

  it('skips a resolved bucket the plan gives no target', () => {
    // 25_34 has no marginal cell in this plan.
    const r = resolve('marginal', ['is_f', 'is_25_34']);

    expect(r.cells).toEqual([{ key: `q:${SCOPE}:qp_main:F`, mode: 'hard' }]);
  });

  it('resolves to no cells when nothing resolves', () => {
    const r = resolve('marginal', []);

    expect(r.cells).toEqual([]);
    expect(r.unresolved).toEqual(['GENDER', 'AGE_BAND']);
  });
});

/* ---------------------------------------------------------------- *
 * Scope, missing plans, overflow
 * ---------------------------------------------------------------- */

describe('scope and plan lookup', () => {
  it('keys counters by the scope it is given and never guesses one', () => {
    // `counter_scope` decides whether counters survive a mid-field republish, and schema states it
    // has no safe default. The caller resolves it; this module only interpolates.
    const a = resolveCells({
      config: config('interlocked'),
      planRef: 'MAIN',
      scope: 'srv_A',
      evalCondition: verdicts(['is_m', 'is_18_24']),
    });
    const b = resolveCells({
      config: config('interlocked'),
      planRef: 'MAIN',
      scope: 'ver_B',
      evalCondition: verdicts(['is_m', 'is_18_24']),
    });

    expect(a.cells[0]?.key).toBe('q:srv_A:qp_main:M|18_24');
    expect(b.cells[0]?.key).toBe('q:ver_B:qp_main:M|18_24');
  });

  it('reports a plan the config does not have rather than throwing', () => {
    // `SCH-1004` rejects this at publish, so reaching it means a hand-edited artifact — and a
    // respondent mid-survey is not the right place to fail.
    const r = resolveCells({
      config: config('interlocked'),
      planRef: 'GHOST',
      scope: SCOPE,
      evalCondition: verdicts(['is_m']),
    });

    expect(r.planMissing).toBe(true);
    expect(r.cells).toEqual([]);
  });

  it('treats a dimension the config does not define as unresolved', () => {
    const broken: QuotaConfig = {
      ...config('interlocked'),
      dimensions: [],
    };
    const r = resolveCells({
      config: broken,
      planRef: 'MAIN',
      scope: SCOPE,
      evalCondition: verdicts(['is_m', 'is_18_24']),
    });

    expect(r.cells).toEqual([]);
    expect(r.unresolved).toHaveLength(2);
  });

  it('planFor finds a plan by ref and tolerates no config at all', () => {
    expect(planFor(config('marginal'), 'MAIN')?.ref).toBe('MAIN');
    expect(planFor(config('marginal'), 'GHOST')).toBeUndefined();
    expect(planFor(undefined, 'MAIN')).toBeUndefined();
  });

  it('overflowFor prefers the authored disposition and falls back to QUOTA_FULL', () => {
    expect(overflowFor(planFor(config('marginal'), 'MAIN'))).toBe('SCREENOUT');
    // The fallback is a disposition `CMP-0300` guarantees the artifact has a redirect for.
    expect(overflowFor(undefined)).toBe('QUOTA_FULL');
  });
});
