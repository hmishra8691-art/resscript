/**
 * `tagVars`, and the end-to-end proof that a rule reading a respondent's answer now fires.
 *
 * THE DEFECT, and why nothing caught it. `apps/runtime` stored `session.vars` as raw JSON and
 * handed that map to `varStateOf`, which reads tagged `Value`s. So `Q1 == <code>` was FALSE for
 * a respondent who had answered that very code — every screener, display rule and termination
 * that compares an answer to a literal, silently wrong. The runtime's own suite was blind to it
 * because every fixture's logic program was EMPTY: with no rules, a wrong variable state renders
 * the same page as a right one.
 *
 * So the second half of this file proves the fix at the two seams that carry it: the ENGINE (a
 * real compiled rule, evaluated with each map) and `evaluatePage` (which of the two maps it
 * actually hands to `varStateOf`). Both matter — a correct tagger wired to the wrong field is
 * the same outage.
 */

import { describe, expect, it } from 'vitest';
import {
  astBuilder,
  asVariableId,
  buildTypeEnv,
  compileLogic,
  evalCondition,
  evaluate,
  varStateOf,
} from '@resscript/logic';
import { tagValue, tagVars, domainIdFor } from './var-values.js';
import { rehydrate } from './artifact-logic.js';
import { evaluatePage } from './evaluate-page.js';
import type { RenderPage } from './render.js';

/** The artifact's logic section for a survey with no rules — fully materialized, as emitted. */
const EMPTY_ARTIFACT_LOGIC = {
  cells: [], topo: [], topo_pos: [], dependents: [], inputs: [], writers: [],
  by_trigger_variable: {}, valid_by_target: {}, rules: [], nodes: [],
  base_visible: {}, base_items: {}, base_option: {}, derived: {},
  schema: { question_variables: {}, page_questions: {}, page_of: {}, label_keys: {} },
};

/* ------------------------------------------------------------------ *
 * The tagger itself
 * ------------------------------------------------------------------ */

const MANIFEST = {
  variable_manifest: [
    { id: 'var_num', name: 'AGE', kind: 'response', type: 'number',
      export_column: 'AGE', export_include: true, pii: false, persist: true },
    { id: 'var_text', name: 'WHY', kind: 'response', type: 'text',
      export_column: 'WHY', export_include: true, pii: true, persist: true },
    { id: 'var_bool', name: 'OK', kind: 'response', type: 'boolean',
      export_column: 'OK', export_include: true, pii: false, persist: true },
    { id: 'var_enum', name: 'Q1', kind: 'response', type: 'enum',
      export_column: 'Q1', export_include: true, pii: false, persist: true },
    { id: 'var_set', name: 'Q5', kind: 'response', type: 'set',
      export_column: 'Q5', export_include: true, pii: false, persist: true },
    { id: 'var_date', name: 'DOB', kind: 'response', type: 'date',
      export_column: 'DOB', export_include: true, pii: true, persist: true },
  ],
} as never;

describe('tagVars', () => {
  it('tags each declared type as the engine spells it', () => {
    const tagged = tagVars(
      {
        var_num: 34,
        var_text: 'because',
        var_bool: true,
        var_enum: 2,
        var_set: [3, 1, 3],
        var_date: '1991-04-05',
      },
      MANIFEST,
      id => (id === 'var_enum' ? 'qst_1' : undefined),
    );

    expect(tagged['var_num']).toEqual({ k: 'num', v: 34 });
    expect(tagged['var_text']).toEqual({ k: 'text', v: 'because' });
    expect(tagged['var_bool']).toEqual({ k: 'bool', v: true });
    // The domain follows the OWNING QUESTION — `dom_qst_1`, not `dom_var_enum`.
    expect(tagged['var_enum']).toEqual({ k: 'enum', v: 2, d: 'dom_qst_1' });
    // Sorted and deduped: schema §1's sets are order-free and the engine compares member by
    // member, so two spellings of one set must not differ.
    expect(tagged['var_set']).toEqual({ k: 'set', v: [1, 3], d: 'dom_var_set' });
    expect(tagged['var_date']).toEqual({ k: 'date', v: '1991-04-05' });
  });

  it('a stored null is a null VALUE, and an absent key stays absent', () => {
    const tagged = tagVars({ var_num: null }, MANIFEST);
    expect(tagged['var_num']).toEqual({ k: 'null' });
    // Absent, not `{k:'null'}`: the engine reads a missing key as NULL already, and materializing
    // every unanswered variable would allocate the whole manifest on every page.
    expect('var_text' in tagged).toBe(false);
  });

  it('a shape that contradicts its declared type is NULL, never coerced', () => {
    // The anti-tamper boundary (E §5 step 3) must not be undone one layer later by a helper
    // trying to be kind: a text "34" comparing equal to the number 34 in a screener is the whole
    // class of bug this refuses.
    expect(tagValue('34', 'number', () => 'd')).toEqual({ k: 'null' });
    expect(tagValue(34, 'text', () => 'd')).toEqual({ k: 'null' });
    expect(tagValue('1', 'enum', () => 'd')).toEqual({ k: 'null' });
    expect(tagValue([1, 'two'], 'set', () => 'd')).toEqual({ k: 'null' });
    expect(tagValue(Number.NaN, 'number', () => 'd')).toEqual({ k: 'null' });
    expect(tagValue(Number.POSITIVE_INFINITY, 'number', () => 'd')).toEqual({ k: 'null' });
  });

  it('drops variables the manifest does not declare', () => {
    // The manifest is the closed world the anti-tamper filter reads; an undeclared key is a stale
    // artifact's leftover or something that should never have been stored, and handing the engine
    // an untyped value is how one of those becomes a rule verdict.
    const tagged = tagVars({ var_num: 1, var_ghost: 9 }, MANIFEST);
    expect(Object.keys(tagged)).toEqual(['var_num']);
  });

  it('domainIdFor falls back to the variable when no question owns it', () => {
    expect(domainIdFor('var_x', () => 'qst_9')).toBe('dom_qst_9');
    expect(domainIdFor('var_x', () => undefined)).toBe('dom_var_x');
    expect(domainIdFor('var_x')).toBe('dom_var_x');
  });
});

/* ------------------------------------------------------------------ *
 * The verdict, at the two seams that matter
 * ------------------------------------------------------------------ */

/**
 * Seam 1: the ENGINE. A compiled rule whose condition reads a respondent's answer, evaluated
 * with each map. No artifact round-trip — serializing a program is `emit/logic.ts`' job and a
 * second serializer written here to make a test pass would be the duplication this codebase
 * keeps refusing. The compiled program IS what the artifact carries, so evaluating it directly
 * tests the same thing with one fewer thing to get wrong.
 */
function hideVerdictWith(values: Record<string, unknown>): boolean | undefined {
  const b = astBuilder();
  const env = buildTypeEnv({
    variables: [
      {
        id: 'var_q1', name: 'Q1', kind: 'response', type: 'enum',
        domain: 'dom_qst_1', persist: true, pii: false, question_id: 'qst_1',
      },
    ],
    domains: [{ id: 'dom_qst_1', entries: [{ code: 1 }, { code: 2 }], ordinal: false }],
    questions: [
      { id: 'qst_1', ref: 'Q1', page_id: 'pg_1', required: true, emits: ['var_q1'],
        options: [{ code: 1 }, { code: 2 }], rows: [], columns: [] },
      { id: 'qst_2', ref: 'Q2', page_id: 'pg_1', required: false, emits: [],
        options: [], rows: [], columns: [] },
    ],
    pages: [{ id: 'pg_1', question_ids: ['qst_1', 'qst_2'] }],
  } as never);

  const program = compileLogic(
    [
      {
        id: 'rul_hide_q2',
        kind: 'display',
        target: { type: 'question', id: 'qst_2' },
        // An ENUM literal, not a bare number: the checker refuses `enum == number` (LGC-T003),
        // and that refusal is the type system doing its job — a `1` could be any domain's code.
        condition: b.cmp('==', b.variable(asVariableId('var_q1')), b.enumLit(1, 'dom_qst_1' as never)),
        effect: { action: 'hide' },
        order_key: 10,
        label: 'Hide Q2 when Q1 is 1',
        evaluation: 'on_change',
        authored_in: 'visual',
      },
    ] as never,
    env,
  );
  expect(program.diagnostics.filter((d: { severity: string }) => d.severity === 'error')).toEqual([]);

  const verdict = evaluate(program, varStateOf(values as never), {});
  return verdict.visible('qst_2');
}

const MANIFEST_Q1 = {
  variable_manifest: [
    { id: 'var_q1', name: 'Q1', kind: 'response', type: 'enum',
      export_column: 'Q1', export_include: true, pii: false, persist: true },
  ],
} as never;

describe('THE REGRESSION: a rule comparing an answer to a literal', () => {
  const raw = { var_q1: 1 };

  it('FIRES with the map tagVars produces — Q2 is hidden for a respondent who answered 1', () => {
    expect(hideVerdictWith(tagVars(raw, MANIFEST_Q1, () => 'qst_1'))).toBe(false);
  });

  it('does NOT fire with the raw map the runtime used to pass — the defect, pinned', () => {
    // Kept as a failing-direction assertion rather than deleted: it is the only thing that will
    // notice if the raw map ever reaches the engine again, and the symptom of that regression —
    // every screener silently false — is invisible in a rendered page.
    expect(hideVerdictWith(raw)).toBe(true);
  });

  it('a tag with the WRONG domain RAISES rather than quietly not firing', () => {
    // Better than expected, and worth pinning: the engine treats an enum from another domain as
    // an invariant violation, not as a value that happens to be unequal. So `domainIdFor`
    // choosing `dom_var_q1` where `dom_qst_1` was meant would fail loudly at the first
    // comparison rather than reproducing the original silent defect. That is the difference
    // between a bug you find in CI and one a client's analyst finds in the data.
    expect(() => hideVerdictWith(tagVars(raw, MANIFEST_Q1, () => undefined))).toThrow(
      /enum domain mismatch/,
    );
  });
});

/**
 * Seam 2: `evaluatePage` must hand the engine the TAGGED map. Both fields are
 * `Record<string, unknown>` to TypeScript, so nothing but this test stands between a correct
 * tagger and a call site that passes it to the wrong parameter.
 */
describe('evaluatePage passes taggedVars, never vars', () => {
  it('gives varStateOf the tagged map', () => {
    const seen: unknown[] = [];
    const page = {
      id: 'pg_1',
      ref: 'P1',
      questions: [{ id: 'qst_1', ref: 'Q1', question_type: 'text' }],
    } as unknown as RenderPage;

    evaluatePage({
      page,
      // A real (empty) rehydrated program: `{}` would throw inside `toCompiledLogic`, and a
      // hand-stubbed one would be a third opinion about the engine's shape.
      logic: rehydrate(EMPTY_ARTIFACT_LOGIC as never),
      seed: 'a3f9c1d2e4b6a8f0c2d4e6b8a0f2c4d6',
      vars: { var_q1: 'RAW' },
      taggedVars: { var_q1: 'TAGGED' },
      evaluate: (() => ({
        visible: () => true,
        items: () => undefined,
        option: () => undefined,
        validations: [],
        terminate: undefined,
        trace: undefined,
      })) as never,
      varStateOf: ((values: unknown) => {
        seen.push(values);
        return { value: () => ({ k: 'null' }) };
      }) as never,
    });

    expect(seen).toContainEqual({ var_q1: 'TAGGED' });
    expect(seen).not.toContainEqual({ var_q1: 'RAW' });
  });
});
