/**
 * `RECODE` — the explicit cross-domain escape (D §3.2).
 *
 * The audit that motivated this node found that the brief's §35 acceptance case ("show only
 * options selected in Q1 AND NOT in Q2 AND in Q3") already worked on the engine as it stood —
 * but only when all four questions shared one enum domain. With separate domains it was
 * `LGC-T021`, correctly, because enums are nominal: that is what stops a rule copy-pasted from a
 * satisfaction scale silently "working" on a frequency scale.
 *
 * So the escape exists, and the last test here is the one that matters: the same acceptance case,
 * across four questions with four different option lists, matched by code because the author said
 * to. The point of a node rather than a coercion is that the saying-so is visible.
 */

import { describe, expect, it } from 'vitest';
import { astBuilder } from './build.js';
import { checkExpr } from './check.js';
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
  type DomainId,
  type VariableId,
} from './ids.js';
import { buildTypeEnv, type LogicRegistryInput, type VarDecl } from './registry.js';
import type { Rule } from './rules.js';
import { varStateOf } from './state.js';
import { setValue, type Value } from './value.js';

/* ---- a four-question survey, each with its OWN domain --------------------- */

const BRANDS = ['apple', 'nike', 'adidas', 'samsung'] as const;
const REFS = ['Q1', 'Q2', 'Q3', 'Q4'] as const;

const domainOf = (ref: string): DomainId => asDomainId(`dom_${ref.toLowerCase()}`);
const questionOf = (ref: string) => asQuestionId(`qst_${ref.toLowerCase()}`);
const variableOf = (ref: string): VariableId => asVariableId(`var_${ref.toLowerCase()}set`);
const PAGE = asPageId('pg_1');

/** Q4 declares only three of the four brands, so a dropped code has somewhere to be dropped. */
const codesOf = (ref: string): readonly number[] => (ref === 'Q4' ? [1, 2, 3] : [1, 2, 3, 4]);

function registry(): LogicRegistryInput {
  const variables: VarDecl[] = REFS.map((ref) => ({
    id: variableOf(ref),
    name: ref,
    kind: 'response',
    type: 'set',
    domain: domainOf(ref),
    question_id: questionOf(ref),
    part: 'set_view',
    persist: true,
    pii: false,
  }));
  return {
    variables,
    domains: REFS.map((ref) => ({
      id: domainOf(ref),
      entries: codesOf(ref).map((code) => ({
        code,
        label_key: `${ref.toLowerCase()}.${BRANDS[code - 1] ?? String(code)}`,
      })),
      ordinal: false,
    })),
    questions: REFS.map((ref) => ({
      id: questionOf(ref),
      ref,
      page_id: PAGE,
      required: false,
      domain: domainOf(ref),
      options: codesOf(ref).map((code, index) => ({
        option_id: asOptionId(`opt_${ref.toLowerCase()}_${String(code)}`),
        code,
        label_key: `${ref.toLowerCase()}.${BRANDS[code - 1] ?? String(code)}`,
        position: index,
      })),
      rows: [],
      columns: [],
      emits: [variableOf(ref)],
    })),
    pages: [{ id: PAGE, question_ids: REFS.map(questionOf) }],
  };
}

const E = buildTypeEnv(registry());

/* ---- the checker ---------------------------------------------------------- */

describe('the checker', () => {
  it('retypes a set into the target domain', () => {
    const b = astBuilder();
    const result = checkExpr(b.recode(b.variable(variableOf('Q1')), domainOf('Q4')), E);
    expect(errorsOnly(result.diagnostics)).toEqual([]);
    expect(result.type).toEqual({ k: 'set', d: domainOf('Q4') });
  });

  it('makes cross-domain set algebra legal that was LGC-T021 without it', () => {
    const b = astBuilder();
    const bare = checkExpr(
      b.setOp('difference', b.variable(variableOf('Q1')), b.variable(variableOf('Q2'))),
      E,
    );
    expect(errorsOnly(bare.diagnostics).map((d) => d.code)).toContain('LGC-T021');

    const b2 = astBuilder();
    const recoded = checkExpr(
      b2.setOp(
        'difference',
        b2.recode(b2.variable(variableOf('Q1')), domainOf('Q4')),
        b2.recode(b2.variable(variableOf('Q2')), domainOf('Q4')),
      ),
      E,
    );
    expect(errorsOnly(recoded.diagnostics)).toEqual([]);
    expect(recoded.type).toEqual({ k: 'set', d: domainOf('Q4') });
  });

  it('refuses an operand that has no codes to reinterpret', () => {
    const b = astBuilder();
    const result = checkExpr(b.recode(b.numLit(3), domainOf('Q4')), E);
    expect(errorsOnly(result.diagnostics).map((d) => d.code)).toEqual(['LGC-T011']);
  });

  it('refuses a target domain that does not exist', () => {
    const b = astBuilder();
    const result = checkExpr(b.recode(b.variable(variableOf('Q1')), asDomainId('dom_nope')), E);
    expect(errorsOnly(result.diagnostics).map((d) => d.code)).toEqual(['LGC-T001']);
  });

  it('warns when the recode is the identity, because it is a leftover from an edit', () => {
    const b = astBuilder();
    const result = checkExpr(b.recode(b.variable(variableOf('Q1')), domainOf('Q1')), E);
    expect(result.diagnostics.map((d) => d.code)).toContain('LGC-W030');
    expect(errorsOnly(result.diagnostics)).toEqual([]);
  });
});

/* ---- the evaluator -------------------------------------------------------- */

/** `MASK Q4 OPTIONS TO WHERE item IN RECODE((Q1 − Q2) ∩ Q3, Q4)` */
function acceptanceMask(recoded: boolean): Rule {
  const b = astBuilder(1);
  // Each operand is recoded into Q4's list FIRST. Recoding only the result would not help: the
  // difference between Q1 and Q2 is itself cross-domain, and that is the correct complaint — the
  // author has to say, once per source, that these lists share a coding frame.
  const src = (ref: string) =>
    recoded
      ? b.recode(b.variable(variableOf(ref)), domainOf('Q4'))
      : b.variable(variableOf(ref));
  const computed = b.setOp('intersect', b.setOp('difference', src('Q1'), src('Q2')), src('Q3'));
  return {
    id: asRuleId('rul_q4_mask'),
    kind: 'mask',
    target: { type: 'question', id: questionOf('Q4') },
    condition: b.boolLit(true),
    effect: {
      action: 'mask',
      applies_to: 'options',
      mode: 'include',
      per_item: b.setOp('contains', computed, b.item()),
      fallback: { when_empty: 'skip_question' },
    },
    evaluation: 'on_change',
    authored_in: 'dsl',
    order_key: 1,
  };
}

describe('the brief §35 acceptance case, across four DIFFERENT option lists', () => {
  // Used all four; have NOT used Apple and Samsung; currently use Apple and Nike.
  // (Q1 − Q2) ∩ Q3 = {2} — Nike alone.
  const answers: { readonly [id: string]: Value } = {
    [variableOf('Q1')]: setValue([1, 2, 3, 4], domainOf('Q1')),
    [variableOf('Q2')]: setValue([1, 4], domainOf('Q2')),
    [variableOf('Q3')]: setValue([1, 2], domainOf('Q3')),
  };

  it('is refused without RECODE, which is the nominal-enum rule doing its job', () => {
    const program = compileLogic([acceptanceMask(false)], E);
    expect(errorsOnly(program.diagnostics).map((d) => d.code)).toContain('LGC-T021');
  });

  it('computes Nike alone with RECODE', () => {
    const program = compileLogic([acceptanceMask(true)], E);
    expect(errorsOnly(program.diagnostics)).toEqual([]);
    const verdict = evaluate(program, varStateOf({ ...answers }), {});
    expect([...verdict.items(questionOf('Q4'), 'options')]).toEqual([2]);
  });

  it('drops a code the target list does not declare, rather than inventing an option', () => {
    // Samsung (4) survives the set algebra here but Q4 has no option 4, so it cannot be shown.
    const program = compileLogic([acceptanceMask(true)], E);
    const verdict = evaluate(
      program,
      varStateOf({
        [variableOf('Q1')]: setValue([4], domainOf('Q1')),
        [variableOf('Q2')]: setValue([], domainOf('Q2')),
        [variableOf('Q3')]: setValue([4], domainOf('Q3')),
      }),
      {},
    );
    expect([...verdict.items(questionOf('Q4'), 'options')]).toEqual([]);
  });
});
