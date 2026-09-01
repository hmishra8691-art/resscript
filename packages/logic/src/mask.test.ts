/**
 * Mask composition, and the pin that survives it — D §4.6, schema §5.1.
 *
 * `applyMask` had no test of its own: masks are exercised end to end in `packages/compiler` and
 * `apps/runtime`, which meant the fold itself was only ever asserted through two other layers.
 * The pin makes that gap worth closing, because "an item no mask can remove" is exactly the kind
 * of rule that looks right in a shape assertion and is wrong in the fold.
 */

import { describe, expect, it } from 'vitest';
import { astBuilder } from './build.js';
import { compileLogic } from './compile.js';
import { errorsOnly } from './diagnostics.js';
import { evaluate } from './engine.js';
import {
  asDomainId,
  asOptionId,
  asPageId,
  asQuestionId,
  asRuleId,
  asVariableId,
  type VariableId,
} from './ids.js';
import { buildTypeEnv, type ItemDecl, type LogicRegistryInput } from './registry.js';
import { applyMask, type Rule } from './rules.js';
import { varStateOf } from './state.js';
import { setValue, type Value } from './value.js';

describe('applyMask', () => {
  const current = [1, 2, 3, 99];

  it('include keeps the intersection', () => {
    expect(applyMask(current, [2, 3], 'include')).toEqual([2, 3]);
  });

  it('exclude keeps the difference', () => {
    expect(applyMask(current, [2, 3], 'exclude')).toEqual([1, 99]);
  });

  it('keeps a pinned code an include mask did not match', () => {
    expect(applyMask(current, [2, 3], 'include', new Set([99]))).toEqual([2, 3, 99]);
  });

  it('keeps a pinned code an exclude mask did match', () => {
    expect(applyMask(current, [2, 99], 'exclude', new Set([99]))).toEqual([1, 3, 99]);
  });

  it('preserves the incoming order, so a pin does not move an item', () => {
    expect(applyMask([99, 1, 2], [1], 'include', new Set([99]))).toEqual([99, 1]);
  });

  it('is order-independent across a mixed chain, pins included', () => {
    const pins = new Set([99]);
    const a = applyMask(applyMask(current, [1, 2, 99], 'include', pins), [2], 'exclude', pins);
    const b = applyMask(applyMask(current, [2], 'exclude', pins), [1, 2, 99], 'include', pins);
    expect(a).toEqual(b);
  });
});

/* -------------------------------------------------------------------------- */
/* End to end: the "None of these" case                                        */
/* -------------------------------------------------------------------------- */

const DOM = asDomainId('dom_brand');
const Q = asQuestionId('qst_q2');
const SOURCE: VariableId = asVariableId('var_q1set');
const PAGE = asPageId('pg_1');

const BRANDS = [
  { code: 1, label_key: 'b.apple' },
  { code: 2, label_key: 'b.nike' },
  { code: 99, label_key: 'b.none' },
] as const;

function registry(pinnedCodes: readonly number[]): LogicRegistryInput {
  const options: ItemDecl[] = BRANDS.map((brand, index) => ({
    option_id: asOptionId(`opt_q2_${String(brand.code)}`),
    code: brand.code,
    label_key: brand.label_key,
    position: index,
    ...(pinnedCodes.includes(brand.code) ? { pin: true } : {}),
  }));
  return {
    variables: [
      {
        id: SOURCE,
        name: 'Q1',
        kind: 'response',
        type: 'set',
        domain: DOM,
        question_id: asQuestionId('qst_q1'),
        part: 'set_view',
        persist: true,
        pii: false,
      },
    ],
    domains: [{ id: DOM, entries: [...BRANDS], ordinal: false }],
    questions: [
      {
        id: asQuestionId('qst_q1'),
        ref: 'Q1',
        page_id: PAGE,
        required: false,
        domain: DOM,
        options: [],
        rows: [],
        columns: [],
        emits: [SOURCE],
      },
      {
        id: Q,
        ref: 'Q2',
        page_id: PAGE,
        required: false,
        domain: DOM,
        options,
        rows: [],
        columns: [],
        emits: [],
      },
    ],
    pages: [{ id: PAGE, question_ids: [asQuestionId('qst_q1'), Q] }],
  };
}

/** `MASK Q2 OPTIONS TO SELECTED IN Q1` — the ordinary carry-forward. */
function carryForward(): Rule {
  const b = astBuilder(1);
  return {
    id: asRuleId('rul_carry'),
    kind: 'mask',
    target: { type: 'question', id: Q },
    condition: b.boolLit(true),
    effect: {
      action: 'mask',
      applies_to: 'options',
      mode: 'include',
      per_item: b.setOp('contains', b.variable(SOURCE), b.item()),
      fallback: { when_empty: 'skip_question' },
    },
    evaluation: 'on_change',
    authored_in: 'dsl',
    order_key: 1,
  };
}

function surviving(pinnedCodes: readonly number[], answer: readonly number[]): readonly number[] {
  const environment = buildTypeEnv(registry(pinnedCodes));
  const program = compileLogic([carryForward()], environment);
  expect(errorsOnly(program.diagnostics)).toEqual([]);
  const answers: { readonly [id: string]: Value } = { [SOURCE]: setValue(answer, DOM) };
  return evaluate(program, varStateOf({ ...answers }), {}).items(Q, 'options');
}

describe('a pinned item survives a carry-forward mask', () => {
  it('is dropped when it is not pinned', () => {
    expect([...surviving([], [1])]).toEqual([1]);
  });

  it('is kept when it is pinned, alongside what the mask did match', () => {
    expect([...surviving([99], [1])]).toEqual([1, 99]);
  });

  it('keeps the question alive when the mask matches nothing at all', () => {
    // Without the pin this is an emptied axis and the question is skipped. "None of these"
    // surviving is the difference between a dead end and an answerable question.
    expect([...surviving([], [])]).toEqual([]);
    expect([...surviving([99], [])]).toEqual([99]);
  });

  it('does not reorder: the pin keeps the item in its declared position', () => {
    expect([...surviving([1], [2])]).toEqual([1, 2]);
  });
});
