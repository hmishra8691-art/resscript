/**
 * Tests for the logic-to-renderer seam.
 *
 * `packages/runtime-core` cannot import `@resscript/compiler` (that is the whole point of the
 * deserializer living here), so these build a `RehydratedLogic` by hand rather than by compiling a
 * fixture. The compiler side of the seam — a real artifact, rehydrated, evaluated — is covered in
 * `packages/compiler/src/emit/logic.test.ts`, which has both halves available.
 *
 * What is asserted here is the wiring: that `evaluatePage` computes orders BEFORE evaluating, hands
 * the same orders to both the engine and the renderer, and translates a verdict into hooks the
 * renderer already knows how to consume.
 */

import { describe, expect, it, vi } from 'vitest';
import { evaluatePage, type PageVerdict } from './evaluate-page.js';
import { computeOrders, orderScope, renderPage, type RenderPage } from './render.js';
import type { RehydratedLogic } from './artifact-logic.js';

/* ---------------------------------------------------------------- *
 * Fixtures
 * ---------------------------------------------------------------- */

const SEED = 'a3f9c1d2e4b6a8f0c2d4e6b8a0f2c4d6';

const BRANDS = [
  { id: 'opt_coca', code: 1, ref: 'o1', label: 'Coca-Cola' },
  { id: 'opt_pepsi', code: 2, ref: 'o2', label: 'Pepsi' },
  { id: 'opt_sprite', code: 3, ref: 'o3', label: 'Sprite' },
  { id: 'opt_fanta', code: 4, ref: 'o4', label: 'Fanta' },
];

function page(over: Partial<RenderPage> = {}): RenderPage {
  return {
    id: 'pg_1',
    ref: 'P1',
    questions: [
      {
        id: 'qst_1',
        ref: 'Q1',
        question_type: 'multi_select',
        options: BRANDS,
        randomize_options: { mode: 'shuffle' },
        label: 'Which brands?',
      },
    ],
    ...over,
  };
}

/**
 * A `RehydratedLogic` with just enough shape for `toCompiledLogic`.
 *
 * `withItemsCell` adds an `items` cell for `qst_1.options`, which is what a compiled mask rule
 * produces. It matters because `itemsFor` asks whether the program HAS such a cell rather than
 * inferring a narrowing from the value: with no cell there is no mask, so the answer is `null`
 * whatever the verdict says.
 */
function emptyLogic(opts: { withItemsCell?: boolean } = {}): RehydratedLogic {
  const cells = opts.withItemsCell
    ? [{ c: 'items', question_id: 'qst_1', axis: 'options' }]
    : [];
  return {
    cells,
    cellKeys: cells.map(() => 'items(qst_1.options)'),
    topo: Int32Array.from([]),
    topoPos: Int32Array.from([]),
    dependents: [],
    inputs: [],
    writers: [],
    triggers: new Map(),
    validCells: new Map(),
    rules: [],
    nodes: [],
    derived: new Map(),
    baseVisible: () => true,
    baseItems: () => [],
    baseOption: () => true,
    indexOf: () => undefined,
    schema: {
      labelKey: () => undefined,
      questionVariables: () => [],
      pageQuestions: () => [],
      ownerQuestion: () => undefined,
      pageOf: () => undefined,
      declaredVisible: () => true,
    },
  } as unknown as RehydratedLogic;
}

/** A verdict stub. Defaults say "nothing is masked, everything is visible and enabled". */
function verdict(over: Partial<PageVerdict> = {}): PageVerdict {
  return {
    visible: () => true,
    items: (() => [1, 2, 3, 4]) as never,
    option: () => true,
    value: () => null,
    validations: [],
    termination: undefined,
    maskFallbacks: [],
    ...over,
  };
}

function run(opts: {
  page?: RenderPage;
  v?: PageVerdict;
  withItemsCell?: boolean;
  onEvaluate?: (program: unknown, vars: unknown, ctx: unknown) => void;
} = {}) {
  const evaluate = vi.fn((program: unknown, vars: unknown, ctx: unknown) => {
    opts.onEvaluate?.(program, vars, ctx);
    return opts.v ?? verdict();
  });
  const result = evaluatePage({
    page: opts.page ?? page(),
    logic: emptyLogic({ ...(opts.withItemsCell ? { withItemsCell: true } : {}) }),
    seed: SEED,
    vars: {},
    taggedVars: {},
    evaluate,
    varStateOf: values => values,
  });
  return { result, evaluate };
}

/* ---------------------------------------------------------------- *
 * Order-before-evaluate
 * ---------------------------------------------------------------- */

describe('orders are computed before evaluation and shared with it', () => {
  it('passes orders into EvalContext', () => {
    // `EvalContext.orders` is an INPUT to evaluation: the engine reads it for
    // `item_attr:'position'` and never shuffles. An evaluation that received no orders would
    // reason about declared positions while the respondent saw shuffled ones.
    let seen: { orders?: Record<string, readonly number[]> } | undefined;
    run({ onEvaluate: (_p, _v, ctx) => { seen = ctx as typeof seen; } });

    expect(seen?.orders).toBeDefined();
    expect(seen?.orders?.[orderScope('qst_1', 'options')]).toHaveLength(4);
  });

  it('hands the renderer the SAME orders, not a second computation', () => {
    // The agreement is structural. When each side computed its own it held only as long as nobody
    // edited one of the two call sites.
    const { result } = run();

    expect(result.renderHooks.orders).toBe(result.orders);
  });

  it('the shared orders match computeOrders for the same seed', () => {
    const { result } = run();

    expect(result.orders).toEqual(computeOrders(page(), SEED));
  });

  it('the rendered order equals the order the engine was given', () => {
    // The property the whole arrangement exists for.
    const { result } = run();
    const rendered = renderPage(page(), SEED, { vars: {}, ...result.renderHooks });

    expect(rendered.questions[0]?.options?.items.map(i => i.code)).toEqual(
      result.orders[orderScope('qst_1', 'options')],
    );
  });

  it('an unrandomized axis is absent from orders', () => {
    // Absent means "no order was imposed"; the engine's own default is declared position. Mapping
    // it to the declared codes would be indistinguishable from a shuffle that happened to be the
    // identity.
    const plain = page({
      questions: [{ id: 'qst_1', ref: 'Q1', question_type: 'multi_select', options: BRANDS }],
    });
    const { result } = run({ page: plain });

    expect(result.orders[orderScope('qst_1', 'options')]).toBeUndefined();
  });
});

/* ---------------------------------------------------------------- *
 * Verdict to hooks
 * ---------------------------------------------------------------- */

describe('verdict becomes renderer hooks', () => {
  it('visible becomes isQuestionVisible', () => {
    const { result } = run({ v: verdict({ visible: id => id !== 'qst_1' }) });

    expect(result.renderHooks.isQuestionVisible?.('qst_1')).toBe(false);
    expect(result.renderHooks.isQuestionVisible?.('qst_2')).toBe(true);
  });

  it('visible also answers page-level visibility for the machine', () => {
    const { result } = run({ v: verdict({ visible: id => id !== 'pg_1' }) });

    expect(result.isPageVisible('pg_1')).toBe(false);
  });

  it('items becomes itemsFor when a mask narrowed the set', () => {
    const { result } = run({ withItemsCell: true, v: verdict({ items: (() => [1, 3]) as never }) });

    expect(result.renderHooks.itemsFor?.('qst_1', 'options')).toEqual([1, 3]);
  });

  it('reports null when the program has no items cell for the axis', () => {
    // No cell means no mask rule targets it. Asked directly rather than inferred from the value,
    // because `Verdict.items` falls through to `baseItems` when there is no cell — which returns
    // `[]` for an axis absent from `base_items`, and reading that `[]` as "a mask emptied this axis"
    // fires the fallback and drops the question, silently.
    const { result } = run({ v: verdict({ items: (() => []) as never }) });

    expect(result.renderHooks.itemsFor?.('qst_1', 'options')).toBeNull();
  });

  it('items equal to the declared set reports null, not the full list', () => {
    // A question with no mask has an `items` cell holding the base list. Reporting that as a
    // narrowing would be harmless for the item set but would make `[]` and "no mask" the only two
    // states — and `[]` has to stay distinguishable, because it is what fires the fallback.
    const { result } = run({ v: verdict({ items: (() => [1, 2, 3, 4]) as never }) });

    expect(result.renderHooks.itemsFor?.('qst_1', 'options')).toBeNull();
  });

  it('an empty items set is reported as empty, not as null', () => {
    const { result } = run({ withItemsCell: true, v: verdict({ items: (() => []) as never }) });

    expect(result.renderHooks.itemsFor?.('qst_1', 'options')).toEqual([]);
  });

  it('reports null for an axis the question does not have', () => {
    const { result } = run();
    expect(result.renderHooks.itemsFor?.('qst_1', 'rows')).toBeNull();
  });

  it('reports null for a question not on this page', () => {
    const { result } = run();
    expect(result.renderHooks.itemsFor?.('qst_elsewhere', 'options')).toBeNull();
  });

  it('option visible=false becomes hidden, enabled=false becomes disabled', () => {
    // Two different props: a hidden option is gone from the render, a disabled one is shown and not
    // selectable. Collapsing them would silently drop an option the author meant to grey out.
    const { result } = run({
      v: verdict({
        option: (optionId, prop) =>
          optionId === 'opt_pepsi' ? prop !== ('visible' as never) : prop !== ('enabled' as never),
      }),
    });

    const state = (id: string) =>
      result.renderHooks.optionState?.('qst_1', 'options', { id, code: 0 });

    expect(state('opt_pepsi')).toEqual({ hidden: true });
    expect(state('opt_coca')).toEqual({ disabled: true });
  });

  it('a fully permitted option yields an empty state', () => {
    const { result } = run();
    expect(result.renderHooks.optionState?.('qst_1', 'options', { id: 'opt_coca', code: 1 })).toEqual(
      {},
    );
  });

  it('passes validations through', () => {
    const failure = {
      rule_id: 'rul_1',
      message_key: 'err.required',
      scope: 'field' as const,
      target: 'qst_1',
    };
    const { result } = run({ v: verdict({ validations: [failure] }) });

    expect(result.validations).toEqual([failure]);
  });

  it('reports a termination without acting on it', () => {
    // Acting means releasing a quota reservation and writing an event — the caller's, and not
    // something a pure function should do.
    const term = { rule_id: 'rul_9', disposition: 'SCREENOUT' };
    const { result } = run({ v: verdict({ termination: term }) });

    expect(result.termination).toEqual(term);
  });
});

/* ---------------------------------------------------------------- *
 * maskItems
 * ---------------------------------------------------------------- */

describe('branch conditions', () => {
  it('translates the Kleene verdict, with U becoming null', () => {
    // `null` is what the machine treats as UNKNOWN, and it answers by taking the else arm —
    // matching the compiler's CMP-0700. Mapping U to `false` would be indistinguishable from a
    // condition that genuinely evaluated false, and mapping it to `true` would route a respondent
    // into a block whose preconditions were never checked.
    for (const [tri, expected] of [['T', true], ['F', false], ['U', null]] as const) {
      const result = evaluatePage({
        page: page(),
        logic: emptyLogic(),
        seed: SEED,
        vars: {},
        taggedVars: {},
        evaluate: () => verdict(),
        varStateOf: v => v,
        evalCondition: () => tri,
      });
      expect(result.evalCondition?.({})).toBe(expected);
    }
  });

  it('is absent when no evaluator was injected', () => {
    // A caller that forgot gets a missing hook rather than every branch silently taking the first
    // arm.
    const { result } = run();
    expect(result.evalCondition).toBeUndefined();
  });

  it("evaluates against this page's verdict, not a second evaluation", () => {
    // A branch condition can read cells the page evaluation produced (`SHOWN(Q5)`), so it must see
    // the same verdict — re-evaluating could give a different answer for the same request.
    let env: { cells?: { visible?: (id: string) => boolean | undefined } } | undefined;
    const result = evaluatePage({
      page: page(),
      logic: emptyLogic(),
      seed: SEED,
      vars: {},
      taggedVars: {},
      evaluate: () => verdict({ visible: id => id !== 'qst_1' }),
      varStateOf: v => v,
      evalCondition: (_c, e) => {
        env = e as typeof env;
        return 'T';
      },
    });
    result.evalCondition?.({});

    expect(env?.cells?.visible?.('qst_1')).toBe(false);
    expect(env?.cells?.visible?.('qst_2')).toBe(true);
  });

  it('passes the same orders into the condition environment', () => {
    let env: { ctx?: { orders?: Record<string, readonly number[]> } } | undefined;
    const result = evaluatePage({
      page: page(),
      logic: emptyLogic(),
      seed: SEED,
      vars: {},
      taggedVars: {},
      evaluate: () => verdict(),
      varStateOf: v => v,
      evalCondition: (_c, e) => {
        env = e as typeof env;
        return 'T';
      },
    });
    result.evalCondition?.({});

    expect(env?.ctx?.orders?.[orderScope('qst_1', 'options')]).toEqual(
      result.orders[orderScope('qst_1', 'options')],
    );
  });

  it('a cell with no entry reads undefined, not false', () => {
    // `NO_CELLS` exists because "no entry" is meaningful. Coercing a missing `valid` cell to false
    // would make every unvalidated node read as invalid.
    let env: { cells?: { valid?: (id: string) => boolean | undefined } } | undefined;
    const result = evaluatePage({
      page: page(),
      logic: emptyLogic(),
      seed: SEED,
      vars: {},
      taggedVars: {},
      evaluate: () => verdict(),
      varStateOf: v => v,
      evalCondition: (_c, e) => {
        env = e as typeof env;
        return 'T';
      },
    });
    result.evalCondition?.({});

    expect(env?.cells?.valid?.('qst_1')).toBeUndefined();
  });

  it('a failing validation makes valid read false for its target', () => {
    let env: { cells?: { valid?: (id: string) => boolean | undefined } } | undefined;
    const result = evaluatePage({
      page: page(),
      logic: emptyLogic(),
      seed: SEED,
      vars: {},
      taggedVars: {},
      evaluate: () =>
        verdict({
          validations: [
            { rule_id: 'rul_1', message_key: 'err.x', scope: 'field', target: 'qst_1' },
          ],
        }),
      varStateOf: v => v,
      evalCondition: (_c, e) => {
        env = e as typeof env;
        return 'T';
      },
    });
    result.evalCondition?.({});

    expect(env?.cells?.valid?.('qst_1')).toBe(false);
    expect(env?.cells?.valid?.('qst_2')).toBeUndefined();
  });
});

describe('maskItems', () => {
  it('is built from the page being rendered', () => {
    // The one view the artifact cannot carry, because it is scoped to the question. An empty one
    // would make every per-item mask condition evaluate over nothing, silently.
    let program: { maskItems?: (q: never, a: never) => readonly unknown[] } | undefined;
    run({ onEvaluate: p => { program = p as typeof program; } });

    const items = program?.maskItems?.('qst_1' as never, 'options' as never);
    expect(items).toHaveLength(4);
    expect(items?.[0]).toEqual({ option_id: 'opt_coca', code: 1 });
  });

  it('is empty for a question not on the page', () => {
    let program: { maskItems?: (q: never, a: never) => readonly unknown[] } | undefined;
    run({ onEvaluate: p => { program = p as typeof program; } });

    expect(program?.maskItems?.('qst_nope' as never, 'options' as never)).toEqual([]);
  });
});

/* ---------------------------------------------------------------- *
 * Composition and purity
 * ---------------------------------------------------------------- */

describe('composition', () => {
  it('evaluate is called exactly once per page', () => {
    // Per-question evaluation would multiply the cost by the page size and break the <1 ms budget
    // D §5.1 is about.
    const { evaluate } = run();
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it('a masked render preserves the engine-given order', () => {
    const { result } = run({ withItemsCell: true, v: verdict({ items: (() => [1, 3]) as never }) });
    const rendered = renderPage(page(), SEED, { vars: {}, ...result.renderHooks });
    const full = result.orders[orderScope('qst_1', 'options')] ?? [];

    expect(rendered.questions[0]?.options?.items.map(i => i.code)).toEqual(
      full.filter(c => c === 1 || c === 3),
    );
  });

  it('a hidden question is skipped by the renderer', () => {
    const { result } = run({ v: verdict({ visible: id => id !== 'qst_1' }) });
    const rendered = renderPage(page(), SEED, { vars: {}, ...result.renderHooks });

    expect(rendered.questions).toEqual([]);
    expect(rendered.skipped).toEqual([{ question_id: 'qst_1', reason: 'hidden' }]);
  });

  it('is deterministic', () => {
    const a = run().result;
    const b = run().result;

    expect(a.orders).toEqual(b.orders);
  });

  it('does not mutate the page', () => {
    const p = page();
    const before = JSON.stringify(p);
    const { result } = run({ page: p });
    renderPage(p, SEED, { vars: {}, ...result.renderHooks });

    expect(JSON.stringify(p)).toBe(before);
  });
});
