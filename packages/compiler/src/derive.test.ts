/**
 * The synthesized expressions, checked the only way that proves anything: by type-checking them.
 *
 * A snapshot of the tree would pin the *encoding* and say nothing about whether the encoding is
 * legal — and the encoding is the open question here, because no `agg` function in
 * `packages/logic` returns a set (see `setViewExpression`'s comment), so the set view is a
 * `union` fold and the only evidence that this is right is that `checkExpr` infers
 * `set<dom_q5>` from it with an empty diagnostic list. So every test below runs the produced
 * tree through the checker against the `TypeEnv` this package's own adapter built. That round
 * trip — adapter → derivation → checker → adapter's domains — is the contract.
 *
 * The second thing asserted everywhere is node-id density. `astBuilder` owns the counter, so a
 * duplicate `n` should be impossible; it is asserted anyway because the failure mode is a wrong
 * memo hit rather than a crash (D §5.4), which no other test in this package would notice.
 */

import { describe, expect, it } from 'vitest';
import {
  applyVariableRegistry,
  NPS_BAND_DOMAIN,
  type ContentNode,
  type IdFactory,
  type JsonObject,
  type PageNode,
  type QuestionItem,
  type QuestionNode,
  type Survey,
  type Variable,
} from '@resscript/schema';
import {
  asDomainId,
  asVariableId,
  checkExpr,
  exprEq,
  readsOf,
  walkExpr,
  type Expr,
  type Type,
  type TypeEnv,
  type VarDecl,
} from '@resscript/logic';
import {
  createRegistry,
  FIRST_PARTY_CORES,
  NPS_BANDS,
  type AnyPluginCore,
  type PluginRegistry,
} from '@resscript/question-kit';
import { deterministicIds, makeMiniSurvey } from '../../schema/src/__fixtures__/mini.js';

import { synthesizeDerived } from './derive.js';
import { buildRegistryInput, buildTypeEnvFor } from './registry.js';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

function surveyWith(
  questions: readonly QuestionNode[],
  options: { readonly ids?: IdFactory; readonly loop?: boolean } = {},
): Survey {
  const ids = options.ids ?? deterministicIds();
  const base = makeMiniSurvey(ids);
  const page: PageNode = { id: ids.next('page'), type: 'page', ref: 'P9', children: questions };
  const blockId = ids.next('block');
  const block: ContentNode = {
    id: blockId,
    type: 'block',
    ref: 'B9',
    children: [page],
    ...(options.loop !== true
      ? {}
      : {
          settings: {
            loop: {
              source: { kind: 'numeric_range', from: 1, to: 2 },
              max_iterations: 2,
              iteration_variable_ref: 'IT',
              variable_naming: '{ref}_{iteration}',
            },
          },
        }),
  };
  const start = ids.next('flow_node');
  const sequence = ids.next('flow_node');
  const end = ids.next('flow_node');
  return applyVariableRegistry(
    {
      ...base,
      variables: [],
      content: [block],
      flow: {
        nodes: [
          { id: start, type: 'start', next: sequence },
          { id: sequence, type: 'sequence', target_id: blockId, next: end },
          { id: end, type: 'end', disposition: 'COMPLETE' },
        ],
      },
    },
    { ids },
  );
}

function item(ids: IdFactory, ref: string, code: number, labelKey: string): QuestionItem {
  return { id: ids.next('option'), ref, code, label: { key: labelKey }, position: code };
}

const MULTI_SELECT_CONFIG: JsonObject = {
  display: 'vertical',
  columns: 1,
  minSelected: 0,
  maxSelected: 0,
  other: { enabled: false, maxLen: 200, required: true },
};

function multiSelect(ids: IdFactory, ref: string, codes: readonly number[]): QuestionNode {
  return {
    id: ids.next('question'),
    type: 'question',
    ref,
    question_type: 'multi_select',
    label: { key: `${ref}.label` },
    required: false,
    config: MULTI_SELECT_CONFIG,
    options: codes.map((code) => item(ids, `o${code}`, code, `${ref}.o${code}`)),
  };
}

function nps(ids: IdFactory, ref: string): QuestionNode {
  return {
    id: ids.next('question'),
    type: 'question',
    ref,
    question_type: 'nps',
    label: { key: `${ref}.label` },
    required: true,
    config: { lowLabelKey: `${ref}.low`, highLabelKey: `${ref}.high`, display: 'buttons' },
  };
}

function firstPartyRegistry(): PluginRegistry<AnyPluginCore> {
  const registry = createRegistry<AnyPluginCore>();
  for (const core of FIRST_PARTY_CORES) registry.register(core, { trust: 'first_party' });
  return registry;
}

function byName(variables: readonly VarDecl[], name: string): VarDecl {
  const hit = variables.find((v) => v.name === name);
  expect(hit, `no variable named ${name}`).toBeDefined();
  return hit as VarDecl;
}

/**
 * Type-check a synthesized expression and return its inferred type.
 *
 * Fails the test on any diagnostic, and prints the codes rather than the count: a synthesized
 * expression that produces `LGC-T021` is a different bug from one that produces `LGC-T011`, and
 * the assertion should say which.
 */
function typeOfClean(expression: Expr, env: TypeEnv): Type {
  const result = checkExpr(expression, env);
  expect(result.diagnostics.map((d) => d.code)).toEqual([]);
  return result.type;
}

function nodeIds(expression: Expr): readonly number[] {
  const out: number[] = [];
  walkExpr(expression, (e) => out.push(e.n));
  return out;
}

/** Every node id appears once, and they are 1..count with no gaps. */
function expectDenseIds(expression: Expr): void {
  const ids = nodeIds(expression);
  expect(new Set(ids).size).toBe(ids.length);
  expect([...ids].sort((a, b) => a - b)).toEqual(ids.map((_, i) => i + 1));
}

/* -------------------------------------------------------------------------- */
/* The set view                                                                */
/* -------------------------------------------------------------------------- */

describe('the set view over a multi-select fan-out', () => {
  const ids = deterministicIds();
  const q = multiSelect(ids, 'Q5', [1, 2, 3]);
  const survey = surveyWith([q], { ids });
  const { env, input } = buildTypeEnvFor(survey);
  const view = byName(input.variables, 'Q5');
  const expression = view.expression as Expr;

  it('type-checks to set<domain> against the domain the adapter synthesized', () => {
    expect(typeOfClean(expression, env)).toEqual({ k: 'set', d: asDomainId(`dom_${q.id}`) });
    // The same domain the declaration claims, which is what makes the derived cell's write
    // type-check against its own variable rather than against a second synthesized id.
    expect(view.domain).toBe(`dom_${q.id}`);
  });

  it('is a left-associated union of one case per option, not an aggregation', () => {
    // No `AggFn` returns a set — `aggResultType` maps every one of them to num, bool, or the
    // member type, and the members here are booleans. Pinned so that a future `collect`
    // aggregate is a deliberate change to this test rather than a silent divergence.
    expect(expression.op).toBe('union');
    const [left, right] = expression.op === 'union' ? expression.args : [];
    expect(left?.op).toBe('union');
    expect(right?.op).toBe('case');
  });

  it('reads exactly the fan-out booleans, in code order', () => {
    expect(readsOf(expression)).toEqual([
      byName(input.variables, 'Q5r1').id,
      byName(input.variables, 'Q5r2').id,
      byName(input.variables, 'Q5r3').id,
    ]);
  });

  it('numbers its nodes densely from one', () => {
    expectDenseIds(expression);
  });

  it('collapses to a single case when the question has one option', () => {
    const oneIds = deterministicIds(31);
    const single = multiSelect(oneIds, 'S1', [4]);
    const built = buildTypeEnvFor(surveyWith([single], { ids: oneIds }));
    const expr = byName(built.input.variables, 'S1').expression as Expr;
    expect(expr.op).toBe('case');
    expect(typeOfClean(expr, built.env)).toEqual({ k: 'set', d: asDomainId(`dom_${single.id}`) });
  });

  it('is identical whether the plugin declared it or the sibling scan reconstructed it', () => {
    const withPlugins = buildRegistryInput(survey, { plugins: firstPartyRegistry() });
    const declared = byName(withPlugins.input.variables, 'Q5').expression as Expr;
    // `exprEq` ignores node ids, which is the right relation: the two paths must agree on the
    // tree, and both build it with their own builder.
    expect(exprEq(declared, expression)).toBe(true);
    expect(withPlugins.diagnostics).toEqual([]);
  });

  /**
   * The previous test cannot tell the two paths apart — `multi_select` declares exactly the
   * members the sibling scan reconstructs, which is the point of the fallback. This one can: a
   * stub plugin declares a set view over *two* of the three booleans, the shape a plugin uses
   * when one option is an exclusive "None of these" that must not join the set. If the sibling
   * scan were winning, the third boolean would be in there.
   *
   * Stubbed at the registry seam rather than built as a real plugin core: `createRegistry`
   * validates the a11y contract and the codec, none of which this assertion is about, and
   * `declareVariablesFor` reaches for exactly `meta.id` and `declareVariables`.
   */
  it('follows the plugin\'s declared members rather than rediscovering the fan-out', () => {
    const stub = {
      meta: { id: 'stub_ms', trust: 'first_party' },
      declareVariables: (ctx: {
        readonly options: readonly { readonly ref: string; readonly code: number }[];
        readonly name: { option(code: number): string; self(): string };
      }) => [
        ...ctx.options.map((option) => ({
          name: ctx.name.option(option.code),
          kind: 'response' as const,
          type: 'boolean' as const,
          source: { part: { kind: 'option' as const, optionRef: option.ref } },
          export: {
            include: true,
            column: ctx.name.option(option.code),
            labelKey: 'x',
            order: option.code,
          },
          pii: false,
          persist: true,
        })),
        {
          name: ctx.name.self(),
          kind: 'derived' as const,
          type: 'set' as const,
          enumDomain: [
            { code: 1, labelKey: 'a' },
            { code: 2, labelKey: 'b' },
          ],
          source: { part: { kind: 'set_view' as const } },
          export: { include: false, column: ctx.name.self(), labelKey: 'x', order: 0 },
          pii: false,
          persist: false,
          derivation: {
            kind: 'structural' as const,
            structural: {
              computation: 'set_view' as const,
              members: [
                { variableName: ctx.name.option(1), code: 1 },
                { variableName: ctx.name.option(2), code: 2 },
              ],
            },
          },
        },
      ],
      configSchema: { type: 'object' as const },
    };
    const plugins = {
      resolveForCompile: () => ({
        plugin: stub as unknown as AnyPluginCore,
        meta: stub.meta,
        version: '1.0.0',
        key: 'stub_ms@1',
      }),
    } as unknown as PluginRegistry<AnyPluginCore>;

    const built = buildRegistryInput(survey, { plugins });
    const declared = byName(built.input.variables, 'Q5').expression as Expr;
    expect(readsOf(declared)).toEqual([
      byName(built.input.variables, 'Q5r1').id,
      byName(built.input.variables, 'Q5r2').id,
    ]);
    expect(readsOf(declared)).not.toContain(byName(built.input.variables, 'Q5r3').id);
    // Still a legal `set<dom_q5>`: dropping a member changes the members, not the domain.
    expect(typeOfClean(declared, buildTypeEnvFor(survey, { plugins }).env)).toEqual({
      k: 'set',
      d: asDomainId(`dom_${q.id}`),
    });
  });
});

describe('a looped set view', () => {
  it('collects its own iteration\'s booleans and no others', () => {
    const ids = deterministicIds(77);
    const q = multiSelect(ids, 'L1', [1, 2]);
    const built = buildTypeEnvFor(surveyWith([q], { ids, loop: true }));
    const second = byName(built.input.variables, 'L1_2');
    expect(second.iteration).toBe(2);
    const expression = second.expression as Expr;
    expect(typeOfClean(expression, built.env)).toEqual({ k: 'set', d: asDomainId(`dom_${q.id}`) });
    expect(readsOf(expression)).toEqual([
      byName(built.input.variables, 'L1r1_2').id,
      byName(built.input.variables, 'L1r2_2').id,
    ]);
    // The bug this pins: an iteration-2 view that reads iteration 1 type-checks perfectly and is
    // wrong for every respondent past the first loop pass.
    expect(readsOf(expression)).not.toContain(byName(built.input.variables, 'L1r1_1').id);
  });
});

/* -------------------------------------------------------------------------- */
/* The band                                                                    */
/* -------------------------------------------------------------------------- */

describe('the NPS band', () => {
  const ids = deterministicIds();
  const q = nps(ids, 'Q7');
  const survey = surveyWith([q], { ids });
  const { env, input } = buildTypeEnvFor(survey);
  const band = byName(input.variables, 'Q7_band');
  const expression = band.expression as Expr;

  it('type-checks to enum<domain> over the band domain', () => {
    expect(typeOfClean(expression, env)).toEqual({ k: 'enum', d: asDomainId(`dom_${q.id}`) });
    expect(env.domain(asDomainId(`dom_${q.id}`))?.entries).toEqual(NPS_BAND_DOMAIN);
  });

  it('is a case with one arm per band and an explicit null else', () => {
    expect(expression.op).toBe('case');
    if (expression.op !== 'case') return;
    expect(expression.cases).toHaveLength(NPS_BANDS.length);
    // Out of every band is null, not the nearest band: `evaluateDerivation` refuses to round a
    // 12 into "promoter", and the else arm is where that refusal lives.
    expect(expression.else).toEqual(expect.objectContaining({ op: 'lit', v: { k: 'null' } }));
  });

  it('reads only the scalar score', () => {
    expect(readsOf(expression)).toEqual([byName(input.variables, 'Q7').id]);
  });

  it('numbers its nodes densely from one', () => {
    expectDenseIds(expression);
  });

  it('is identical whether the plugin declared it or the fallback table supplied it', () => {
    const withPlugins = buildRegistryInput(survey, { plugins: firstPartyRegistry() });
    const declared = byName(withPlugins.input.variables, 'Q7_band').expression as Expr;
    expect(exprEq(declared, expression)).toBe(true);
    // The fallback is not a second band table: it is `question-kit`'s own constant, which pins
    // itself to schema's `NPS_BAND_DOMAIN`.
    expect(NPS_BANDS.map((b) => b.code)).toEqual(NPS_BAND_DOMAIN.map((e) => e.code));
  });
});

/* -------------------------------------------------------------------------- */
/* What it refuses                                                             */
/* -------------------------------------------------------------------------- */

describe('synthesizeDerived', () => {
  const ids = deterministicIds();
  const q = multiSelect(ids, 'Q5', [1, 2]);
  const survey = surveyWith([q], { ids });
  const { input } = buildRegistryInput(survey);

  const context = () => ({
    question: q,
    domain: asDomainId(`dom_${q.id}`),
    variablesOfQuestion: survey.variables,
    variableId: (name: string) => {
      const hit = survey.variables.find((v) => v.name === name);
      return hit === undefined ? undefined : asVariableId(hit.id);
    },
  });

  const variable = (name: string): Variable => {
    const hit = survey.variables.find((v) => v.name === name);
    expect(hit).toBeDefined();
    return hit as Variable;
  };

  it('declines a response variable, which has nothing to derive', () => {
    const member = variable('Q5r1');
    expect(synthesizeDerived(survey, member, context())).toBeUndefined();
  });

  it('declines a suffix it has no table for, rather than banding the wrong scalar', () => {
    const view = variable('Q5');
    const invented: Variable = {
      ...view,
      name: 'Q5_raw',
      source: { question_id: q.id, part: { kind: 'suffix', suffix: 'raw' } },
      type: 'enum',
    };
    // Without the suffix guard this would compile to the NPS band table over whatever scalar the
    // question emits: legal, evaluable, and wrong.
    expect(synthesizeDerived(survey, invented, context())).toBeUndefined();
  });

  it('declines when the variable carries no domain to build literals in', () => {
    const view = variable('Q5');
    const undomained = { ...context(), domain: undefined };
    expect(synthesizeDerived(survey, view, undomained)).toBeUndefined();
  });

  it('declines a set view over a question with no options at all', () => {
    const emptyIds = deterministicIds(5);
    const empty: QuestionNode = {
      id: emptyIds.next('question'),
      type: 'question',
      ref: 'E1',
      question_type: 'multi_select',
      label: { key: 'E1.label' },
      required: false,
      config: MULTI_SELECT_CONFIG,
      options: [],
    };
    const built = buildRegistryInput(surveyWith([empty], { ids: emptyIds }));
    // An options-less multi-select is the defect; a set view that is always `{}` would read as
    // real data, so the compiler refuses it by name.
    expect(built.diagnostics.map((d) => d.code)).toEqual(['CMP-0103']);
    expect(byName(built.input.variables, 'E1').expression).toBeUndefined();
  });

  it('has produced an expression for every derived variable in these fixtures', () => {
    for (const decl of input.variables) {
      if (decl.kind !== 'derived') continue;
      expect(decl.expression, decl.name).toBeDefined();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The whole registry, checked together                                        */
/* -------------------------------------------------------------------------- */

describe('every derived expression in a mixed survey', () => {
  it('type-checks clean against the environment this adapter built', () => {
    const ids = deterministicIds(2024);
    const questions = [
      multiSelect(ids, 'Q1x', [1, 2, 3, 4]),
      nps(ids, 'Q2x'),
      multiSelect(ids, 'Q3x', [7, 9]),
    ];
    const survey = surveyWith(questions, { ids });
    for (const plugins of [undefined, firstPartyRegistry()]) {
      const { env, input, diagnostics } = buildTypeEnvFor(
        survey,
        plugins === undefined ? {} : { plugins },
      );
      expect(diagnostics).toEqual([]);
      const derived = input.variables.filter((v) => v.kind === 'derived');
      expect(derived).toHaveLength(3);
      for (const decl of derived) {
        const expression = decl.expression as Expr;
        const inferred = typeOfClean(expression, env);
        // The declaration's own type, not merely "some type": a derived variable whose expression
        // infers `set<a>` while the variable is declared `set<b>` is the failure this whole file
        // is arranged to catch, and `compileLogic` would only report it as LGC-T031 much later.
        expect(inferred).toEqual(env.typeOf(decl));
        expectDenseIds(expression);
      }
    }
  });
});
