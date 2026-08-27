/**
 * A PROBE, not a feature test: does the engine accept the raw variable map `apps/runtime` hands
 * it, or only the tagged `Value` map its own types declare?
 *
 * Written as a test rather than a scratch script because the answer is a claim about the engine's
 * contract, and a claim about a contract belongs where it fails if the contract changes. If the
 * conversion ever moves INTO `varStateOf`, this file's second case starts passing and the file
 * should be deleted with a note in the commit — that is a real design change, not a regression.
 */

import { describe, expect, it } from 'vitest';
import { buildEvalSchema } from './compile.js';
import { evalCondition, NO_CELLS } from './evaluator.js';
import { varStateOf } from './state.js';
import { astBuilder } from './build.js';
import { env, V } from './__fixtures__/survey.js';
import type { Value } from './value.js';

const E = env();
const SCHEMA = buildEvalSchema(E);

function verdictFor(values: Record<string, unknown>): string {
  const b = astBuilder();
  // `AGE == 34`: the shape of every screener rule in every survey ever written.
  const condition = b.cmp('==', b.variable(V.age), b.numLit(34));
  return evalCondition(condition, {
    vars: varStateOf(values as { readonly [id: string]: Value }),
    ctx: {},
    cells: NO_CELLS,
    schema: SCHEMA,
  });
}

describe('varStateOf takes TAGGED values, and a raw one is not a near-miss', () => {
  it('a tagged number compares TRUE', () => {
    expect(verdictFor({ [V.age]: { k: 'num', v: 34 } })).toBe('T');
  });

  it('THE DEFECT: a raw number does not compare TRUE', () => {
    // `apps/runtime` stores `session.vars` as raw JSON (`{var_age: 34}`) — that is the shape the
    // codec writes and `response_documents.vars` holds — and hands it straight to `varStateOf`.
    // The engine reads `Value`s. So the comparison a respondent's answer participates in does
    // not see a number at all.
    const verdict = verdictFor({ [V.age]: 34 });
    expect(verdict).not.toBe('T');
  });
});
