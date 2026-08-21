/**
 * What `buildRules` must get right: one test per schema `RuleAction`, and one per property a
 * later pass silently depends on.
 *
 * Every action test asserts two things about the same rule — the `Effect` arm it produced, and
 * that `checkRule` against a real `TypeEnv` reports *nothing* about it. The second half is what
 * makes the first half worth having: an arm can be structurally right and still be a rule the
 * checker rejects (a condition that is not boolean, a `set` at a response variable, a target the
 * kind does not permit), and a mapping table that produced those would pass a shape assertion and
 * fail at publish. Conditions are therefore `ANSWERED(...)` probes rather than `TRUE`: a constant
 * condition is `LGC-W030` and a possibly-unknown one on a terminate rule is `LGC-W021`, so a
 * lazier fixture would drown the assertion it is making.
 *
 * The one expected diagnostic is `LGC-W030` on a rule synthesized from a `QuestionNode` mask,
 * whose condition is the literal `TRUE` because a `Mask` carries no condition at all. It is
 * asserted explicitly rather than filtered out, so that the day somebody gives masks a condition
 * this file says what changed.
 *
 * Diagnostics are asserted by code and `detail`, never by message prose.
 */

import { describe, expect, it } from 'vitest';
import {
  applyVariableRegistry,
  type BlockId,
  type ContentNode,
  type FlowNodeId,
  type IdFactory,
  type JsonObject,
  type LogicRule,
  type Mask,
  type MaskSource,
  type OptionId,
  type PageId,
  type PageNode,
  type QuestionId,
  type QuestionItem,
  type QuestionNode,
  type RuleAction,
  type RuleEffect,
  type RuleTarget,
  type Survey,
  type Variable,
  type VariableId,
  type Expr as SchemaExpr,
} from '@resscript/schema';
import {
  asVariableId,
  astBuilder,
  checkRule,
  writesOf,
  type Expr,
  type Rule,
  type TypeEnv,
} from '@resscript/logic';
import { deterministicIds, makeMiniSurvey } from '../../schema/src/__fixtures__/mini.js';

import { buildFlowGraph } from './flow.js';
import { buildTypeEnvFor } from './registry.js';
import { buildRules, ORDER_KEY_SITE_STRIDE, synthesizedMaskRuleId } from './rules.js';
import type { FlowGraph } from './types.js';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const MULTI_SELECT_CONFIG: JsonObject = {
  display: 'vertical',
  columns: 1,
  minSelected: 0,
  maxSelected: 0,
  other: { enabled: false, maxLen: 200, required: true },
};

function item(ids: IdFactory, ref: string, code: number, labelKey: string): QuestionItem {
  return { id: ids.next('option'), ref, code, label: { key: labelKey }, position: code };
}

/**
 * Two pages, so a `skip_to` has somewhere to go and two rules can sit at different flow
 * positions; a hidden boolean, so a `set` rule has a writable target of a matching type.
 *
 * The flow is deliberately a single `sequence` over the whole block: every question therefore
 * shares one flow site, which is the case that makes the `order_key` slots visible (authored
 * rules and synthesized masks have to stay apart *within* a site, not merely between sites).
 */
interface Scaffold {
  readonly q1: QuestionNode;
  readonly q5: QuestionNode;
  readonly q7: QuestionNode;
  readonly page1: PageNode;
  readonly page2: PageNode;
  readonly blockId: BlockId;
  readonly sequenceId: FlowNodeId;
  readonly endId: FlowNodeId;
  readonly hidden: Variable;
  readonly rules: readonly LogicRule[];
  readonly ids: IdFactory;
  /** `laidOut: false` drops the sequence node, so no content has a flow site. */
  readonly build: (options?: { readonly laidOut?: boolean }) => Built;
}

interface Built {
  readonly survey: Survey;
  readonly graph: FlowGraph;
  readonly env: TypeEnv;
}

function scaffold(
  spec: {
    readonly masks?: readonly Mask[];
    readonly masksOn?: 'q1' | 'q5';
    readonly rules?: (s: Ids) => readonly LogicRule[];
  } = {},
): Scaffold {
  const ids = deterministicIds();
  const base = makeMiniSurvey(ids);

  const masksOf = (which: 'q1' | 'q5'): { readonly masks?: readonly Mask[] } =>
    spec.masks === undefined || (spec.masksOn ?? 'q5') !== which ? {} : { masks: spec.masks };

  const q1: QuestionNode = {
    id: ids.next('question'),
    type: 'question',
    ref: 'Q1',
    question_type: 'single_select',
    label: { key: 'q1.label' },
    required: true,
    options: [item(ids, 'o1', 1, 'q1.o1'), item(ids, 'o2', 2, 'q1.o2')],
    ...masksOf('q1'),
  };
  const q5: QuestionNode = {
    id: ids.next('question'),
    type: 'question',
    ref: 'Q5',
    question_type: 'multi_select',
    label: { key: 'q5.label' },
    required: false,
    config: MULTI_SELECT_CONFIG,
    options: [item(ids, 'o1', 1, 'q5.o1'), item(ids, 'o2', 2, 'q5.o2'), item(ids, 'o3', 3, 'q5.o3')],
    ...masksOf('q5'),
  };
  const q7: QuestionNode = {
    id: ids.next('question'),
    type: 'question',
    ref: 'Q7',
    question_type: 'numeric',
    label: { key: 'q7.label' },
    required: false,
    config: { min: 0, max: 10 },
  };

  const page1: PageNode = { id: ids.next('page'), type: 'page', ref: 'P1', children: [q1, q5] };
  const page2: PageNode = { id: ids.next('page'), type: 'page', ref: 'P2', children: [q7] };
  const blockId = ids.next('block');
  const block: ContentNode = {
    id: blockId,
    type: 'block',
    ref: 'B9',
    children: [page1, page2],
  };

  const startId = ids.next('flow_node');
  const sequenceId = ids.next('flow_node');
  const endId = ids.next('flow_node');

  const hidden: Variable = {
    id: ids.next('variable'),
    name: 'FLAG_A',
    kind: 'hidden',
    type: 'boolean',
    export: { include: true, column: 'FLAG_A' },
    pii: false,
    persist: true,
  };

  const build = (options: { readonly laidOut?: boolean } = {}): Built => {
    const laidOut = options.laidOut !== false;
    const survey = applyVariableRegistry(
      {
        ...base,
        variables: [hidden],
        content: [block],
        flow: {
          nodes: laidOut
            ? [
                { id: startId, type: 'start', next: sequenceId },
                { id: sequenceId, type: 'sequence', target_id: blockId, next: endId },
                { id: endId, type: 'end', disposition: 'COMPLETE' },
              ]
            : [
                { id: startId, type: 'start', next: endId },
                { id: endId, type: 'end', disposition: 'COMPLETE' },
              ],
        },
        logic_rules: [],
      },
      { ids },
    );
    const withRules: Survey = {
      ...survey,
      logic_rules:
        spec.rules === undefined
          ? []
          : spec.rules({
              q1: q1.id,
              q5: q5.id,
              q7: q7.id,
              page1: page1.id,
              page2: page2.id,
              block: blockId,
              q1Option: optionId(q1, 'o1'),
              q5Option: optionId(q5, 'o1'),
              hidden: hidden.id,
              q1Variable: variableOf(survey, q1.id, 'scalar').id,
              q5Variable: variableOf(survey, q5.id, 'set_view').id,
              ids,
            }),
    };
    return {
      survey: withRules,
      graph: buildFlowGraph(withRules),
      env: buildTypeEnvFor(withRules).env,
    };
  };

  return {
    q1,
    q5,
    q7,
    page1,
    page2,
    blockId,
    sequenceId,
    endId,
    hidden,
    rules: [],
    ids,
    build,
  };
}

/** The ids a fixture rule needs, resolved after the registry has been built. */
interface Ids {
  readonly q1: QuestionId;
  readonly q5: QuestionId;
  readonly q7: QuestionId;
  readonly page1: PageId;
  readonly page2: PageId;
  readonly block: BlockId;
  readonly q1Option: OptionId;
  readonly q5Option: OptionId;
  readonly hidden: VariableId;
  readonly q1Variable: VariableId;
  readonly q5Variable: VariableId;
  readonly ids: IdFactory;
}

function optionId(question: QuestionNode, ref: string): OptionId {
  const found = (question.options ?? []).find((option) => option.ref === ref);
  if (found === undefined) throw new Error(`no option ${ref} on ${question.ref}`);
  return found.id;
}

function variableOf(survey: Survey, questionId: string, part: string): Variable {
  const found = survey.variables.find(
    (variable) =>
      variable.source?.question_id === questionId && variable.source.part.kind === part,
  );
  if (found === undefined) throw new Error(`no ${part} variable for ${questionId}`);
  return found;
}

/** `ANSWERED(v)`: boolean, never unknown, never constant. */
function answered(variableId: string): SchemaExpr {
  return toSchema(
    astBuilder().probe('answered', { kind: 'variable', id: asVariableId(variableId) }),
  );
}

function toSchema(expression: Expr): SchemaExpr {
  return expression as unknown as SchemaExpr;
}

function rule(spec: {
  readonly id: string;
  readonly kind: LogicRule['kind'];
  readonly target: RuleTarget;
  readonly effect: RuleEffect;
  readonly condition: SchemaExpr;
  readonly notes?: string;
}): LogicRule {
  return {
    id: spec.id,
    kind: spec.kind,
    target: spec.target,
    condition: spec.condition,
    effect: spec.effect,
    ...(spec.notes === undefined ? {} : { notes: spec.notes }),
  } as LogicRule;
}

function codesOf(target: Rule, env: TypeEnv): readonly string[] {
  return checkRule(target, env).diagnostics.map((diagnostic) => diagnostic.code);
}

function only(rules: readonly Rule[]): Rule {
  expect(rules).toHaveLength(1);
  const first = rules[0];
  if (first === undefined) throw new Error('no rule produced');
  return first;
}

/**
 * One rule with the given effect, plus everything needed to check it.
 *
 * `target` and `kind` are per-action because `checkTargetKind` is not permissive: a `display`
 * rule may not target an option and an `option_state` rule may not target a page, so a fixture
 * that used one target for all twelve actions would be asserting `LGC-T034`.
 */
function oneRule(
  make: (ids: Ids) => { readonly kind: LogicRule['kind']; readonly target: RuleTarget; readonly effect: RuleEffect },
): { readonly rule: Rule; readonly env: TypeEnv; readonly built: Built } {
  const fixture = scaffold({
    rules: (ids) => {
      const spec = make(ids);
      return [
        rule({
          id: ids.ids.next('rule'),
          kind: spec.kind,
          target: spec.target,
          effect: spec.effect,
          condition: answered(ids.q1Variable),
        }),
      ];
    },
  });
  const built = fixture.build();
  const result = buildRules(built.survey, built.graph, built.env);
  expect(result.diagnostics).toEqual([]);
  return { rule: only(result.rules), env: built.env, built };
}

function permutations<T>(items: readonly T[]): readonly (readonly T[])[] {
  if (items.length <= 1) return [items];
  const out: T[][] = [];
  items.forEach((head, index) => {
    const rest = [...items.slice(0, index), ...items.slice(index + 1)];
    for (const tail of permutations(rest)) out.push([head, ...tail]);
  });
  return out;
}

/* -------------------------------------------------------------------------- */
/* The twelve actions                                                          */
/* -------------------------------------------------------------------------- */

describe('a show or hide action', () => {
  it('becomes the show arm for a question target', () => {
    const { rule: produced, env } = oneRule((ids) => ({
      kind: 'display',
      target: { type: 'question', id: ids.q5 },
      effect: { action: 'show' },
    }));
    expect(produced.effect).toEqual({ action: 'show' });
    expect(codesOf(produced, env)).toEqual([]);
  });

  it('becomes the hide arm for a page target', () => {
    const { rule: produced, env } = oneRule((ids) => ({
      kind: 'display',
      target: { type: 'page', id: ids.page2 },
      effect: { action: 'hide' },
    }));
    expect(produced.effect).toEqual({ action: 'hide' });
    expect(codesOf(produced, env)).toEqual([]);
  });

  /**
   * The failure this pins: `writesOf` returns `[]` for a `show`/`hide` effect on an option
   * target, so the visibility arm there is a rule that ships and does nothing.
   */
  it('becomes an option_state visible write for an option target, which is the cell that exists', () => {
    const { rule: produced, env } = oneRule((ids) => ({
      kind: 'option_state',
      target: { type: 'option', id: ids.q5Option },
      effect: { action: 'hide' },
    }));
    expect(produced.effect).toMatchObject({
      action: 'option_state',
      prop: 'visible',
      value: { op: 'lit', v: { k: 'bool', v: false } },
    });
    expect(writesOf(produced)).toEqual([
      { c: 'opt', option_id: produced.target.type === 'option' ? produced.target.id : '', prop: 'visible' },
    ]);
    expect(codesOf(produced, env)).toEqual([]);
  });
});

describe('a skip_to action', () => {
  it('becomes skip_to with the destination page when effect.target_id names one', () => {
    const { rule: produced, env } = oneRule((ids) => ({
      kind: 'skip',
      target: { type: 'question', id: ids.q1 },
      effect: { action: 'skip_to', target_id: ids.page2 },
    }));
    expect(produced.effect).toMatchObject({ action: 'skip_to' });
    expect(codesOf(produced, env)).toEqual([]);
  });

  it('becomes skip_this when it names none, because RULE_ACTIONS has no skip member', () => {
    const { rule: produced, env } = oneRule((ids) => ({
      kind: 'skip',
      target: { type: 'question', id: ids.q1 },
      effect: { action: 'skip_to' },
    }));
    expect(produced.effect).toEqual({ action: 'skip_this' });
    expect(codesOf(produced, env)).toEqual([]);
  });

  it('resolves a question destination to the page that lays it out', () => {
    const fixture = scaffold({
      rules: (ids) => [
        rule({
          id: ids.ids.next('rule'),
          kind: 'skip',
          target: { type: 'question', id: ids.q1 },
          effect: { action: 'skip_to', target_id: ids.q7 },
          condition: answered(ids.q1Variable),
        }),
      ],
    });
    const built = fixture.build();
    const produced = only(buildRules(built.survey, built.graph, built.env).rules);
    expect(produced.effect).toEqual({ action: 'skip_to', node_id: fixture.page2.id });
  });
});

describe('an option or question state action', () => {
  const cases: readonly {
    readonly action: RuleAction;
    readonly prop: string;
    readonly value: boolean;
  }[] = [
    { action: 'require', prop: 'required', value: true },
    { action: 'unrequire', prop: 'required', value: false },
    { action: 'enable', prop: 'enabled', value: true },
    { action: 'disable', prop: 'enabled', value: false },
    { action: 'select', prop: 'preselected', value: true },
    { action: 'deselect', prop: 'preselected', value: false },
  ];

  for (const testCase of cases) {
    it(`maps ${testCase.action} onto option_state ${testCase.prop} = ${String(testCase.value)}`, () => {
      const { rule: produced, env } = oneRule((ids) => ({
        kind: 'option_state',
        target: { type: 'option', id: ids.q5Option },
        effect: { action: testCase.action },
      }));
      expect(produced.effect).toMatchObject({
        action: 'option_state',
        prop: testCase.prop,
        value: { op: 'lit', v: { k: 'bool', v: testCase.value } },
      });
      expect(codesOf(produced, env)).toEqual([]);
    });
  }

  it('refuses to invent a cell for a question-scoped require', () => {
    const fixture = scaffold({
      rules: (ids) => [
        rule({
          id: ids.ids.next('rule'),
          kind: 'validate',
          target: { type: 'question', id: ids.q5 },
          effect: { action: 'require' },
          condition: answered(ids.q1Variable),
        }),
      ],
    });
    const built = fixture.build();
    const result = buildRules(built.survey, built.graph, built.env);
    expect(result.rules).toEqual([]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.code).toBe('CMP-0702');
    expect(result.diagnostics[0]?.detail).toMatchObject({
      reason: 'no_option_cell',
      action: 'require',
      target_type: 'question',
      prop: 'required',
    });
  });
});

describe('a set action', () => {
  it('writes the variable the rule targets, with the effect value', () => {
    const { rule: produced, env } = oneRule((ids) => ({
      kind: 'set_variable',
      target: { type: 'variable', id: ids.hidden },
      effect: { action: 'set', value: toSchema(astBuilder().boolLit(true)) },
    }));
    expect(produced.effect).toMatchObject({
      action: 'set',
      value: { op: 'lit', v: { k: 'bool', v: true } },
    });
    expect(writesOf(produced)).toHaveLength(1);
    expect(codesOf(produced, env)).toEqual([]);
  });

  it('treats an absent value as an assignment of null rather than as a missing field', () => {
    const { rule: produced, env } = oneRule((ids) => ({
      kind: 'set_variable',
      target: { type: 'variable', id: ids.hidden },
      effect: { action: 'set' },
    }));
    expect(produced.effect).toMatchObject({ value: { op: 'lit', v: { k: 'null' } } });
    expect(codesOf(produced, env)).toEqual([]);
  });
});

describe('a fail action', () => {
  it('becomes require_valid with the message key and a field scope for a question target', () => {
    const { rule: produced, env } = oneRule((ids) => ({
      kind: 'validate',
      target: { type: 'question', id: ids.q5 },
      effect: { action: 'fail', message_key: 'q5.too_few' },
    }));
    expect(produced.effect).toEqual({
      action: 'require_valid',
      message_key: 'q5.too_few',
      scope: 'field',
    });
    expect(codesOf(produced, env)).toEqual([]);
  });

  it('widens the scope to the page when the rule targets one', () => {
    const { rule: produced, env } = oneRule((ids) => ({
      kind: 'validate',
      target: { type: 'page', id: ids.page1 },
      effect: { action: 'fail', message_key: 'p1.incomplete' },
    }));
    expect(produced.effect).toMatchObject({ scope: 'page' });
    expect(codesOf(produced, env)).toEqual([]);
  });
});

describe('a terminate action', () => {
  it('carries the disposition through', () => {
    const { rule: produced, env } = oneRule(() => ({
      kind: 'terminate',
      target: { type: 'survey' },
      effect: { action: 'terminate', disposition: 'SCREENOUT' },
    }));
    expect(produced.effect).toEqual({ action: 'terminate', disposition: 'SCREENOUT' });
    expect(codesOf(produced, env)).toEqual([]);
  });

  it('defaults a missing disposition to TERMINATE, not to SCREENOUT', () => {
    const { rule: produced } = oneRule(() => ({
      kind: 'terminate',
      target: { type: 'survey' },
      effect: { action: 'terminate' },
    }));
    expect(produced.effect).toEqual({ action: 'terminate', disposition: 'TERMINATE' });
  });
});

describe('an action this compiler does not know', () => {
  it('is CMP-0702 and not a silently dropped rule', () => {
    const fixture = scaffold({
      rules: (ids) => [
        rule({
          id: ids.ids.next('rule'),
          kind: 'display',
          target: { type: 'question', id: ids.q5 },
          effect: { action: 'frobnicate' as RuleAction },
          condition: answered(ids.q1Variable),
        }),
      ],
    });
    const built = fixture.build();
    const result = buildRules(built.survey, built.graph, built.env);
    expect(result.rules).toEqual([]);
    expect(result.diagnostics[0]?.code).toBe('CMP-0702');
    expect(result.diagnostics[0]?.detail).toMatchObject({
      reason: 'unknown_action',
      action: 'frobnicate',
    });
  });
});

/* -------------------------------------------------------------------------- */
/* order_key                                                                   */
/* -------------------------------------------------------------------------- */

describe('order_key', () => {
  const fourRules = (ids: Ids): readonly LogicRule[] => [
    rule({
      id: ids.ids.next('rule'),
      kind: 'display',
      target: { type: 'question', id: ids.q5 },
      effect: { action: 'hide' },
      condition: answered(ids.q1Variable),
    }),
    rule({
      id: ids.ids.next('rule'),
      kind: 'display',
      target: { type: 'page', id: ids.page2 },
      effect: { action: 'hide' },
      condition: answered(ids.q1Variable),
    }),
    rule({
      id: ids.ids.next('rule'),
      kind: 'terminate',
      target: { type: 'survey' },
      effect: { action: 'terminate', disposition: 'SCREENOUT' },
      condition: answered(ids.q1Variable),
    }),
    rule({
      id: ids.ids.next('rule'),
      kind: 'set_variable',
      target: { type: 'variable', id: ids.hidden },
      effect: { action: 'set', value: toSchema(astBuilder().boolLit(true)) },
      condition: answered(ids.q1Variable),
    }),
  ];

  /**
   * The property the milestone rests on: the produced array is a function of the survey, not of
   * the order the rows arrived in. Asserted over all 24 permutations rather than over a random
   * sample, so a failure is reproducible. Only `rules` is compared — a diagnostic's *path* is an
   * array position by design (`/logic_rules/3`), so diagnostics are deliberately not invariant.
   */
  it('is identical under every permutation of survey.logic_rules', () => {
    const canonical = (() => {
      const fixture = scaffold({ rules: fourRules });
      const built = fixture.build();
      return buildRules(built.survey, built.graph, built.env).rules;
    })();
    expect(canonical).toHaveLength(4);

    for (const order of permutations([0, 1, 2, 3])) {
      const fixture = scaffold({
        rules: (ids) => {
          const declared = fourRules(ids);
          return order.map((index) => {
            const found = declared[index];
            if (found === undefined) throw new Error('bad permutation');
            return found;
          });
        },
      });
      const built = fixture.build();
      expect(buildRules(built.survey, built.graph, built.env).rules).toEqual(canonical);
    }
  });

  it('puts an unscoped rule before every rule the flow positions', () => {
    const fixture = scaffold({ rules: fourRules });
    const built = fixture.build();
    const produced = buildRules(built.survey, built.graph, built.env).rules;
    const survey = produced.filter((r) => r.target.type === 'survey');
    expect(survey).toHaveLength(1);
    expect(survey[0]?.order_key).toBeLessThan(0);
    for (const positioned of produced.filter((r) => r.target.type !== 'variable' && r.target.type !== 'survey')) {
      expect(positioned.order_key).toBeGreaterThanOrEqual(0);
    }
  });

  it('leaves a gap per flow site, so a mask can slot in behind the authored rules', () => {
    const fixture = scaffold({
      masks: [],
      rules: (ids) => [
        rule({
          id: ids.ids.next('rule'),
          kind: 'display',
          target: { type: 'question', id: ids.q5 },
          effect: { action: 'hide' },
          condition: answered(ids.q1Variable),
        }),
      ],
    });
    const built = fixture.build();
    const produced = only(buildRules(built.survey, built.graph, built.env).rules);
    expect(produced.order_key % ORDER_KEY_SITE_STRIDE).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* flow_node_id                                                                */
/* -------------------------------------------------------------------------- */

describe('a skip rule', () => {
  it('carries the flow node of its target, and writes exactly one flow cell', () => {
    const fixture = scaffold({
      rules: (ids) => [
        rule({
          id: ids.ids.next('rule'),
          kind: 'skip',
          target: { type: 'question', id: ids.q1 },
          effect: { action: 'skip_to', target_id: ids.page2 },
          condition: answered(ids.q1Variable),
        }),
      ],
    });
    const built = fixture.build();
    const produced = only(buildRules(built.survey, built.graph, built.env).rules);
    expect(produced.flow_node_id).toBe(fixture.sequenceId);
    expect(writesOf(produced)).toEqual([{ c: 'flow', node_id: fixture.sequenceId }]);
  });

  it('is CMP-0006 and is dropped when no flow node lays its target out', () => {
    const fixture = scaffold({
      rules: (ids) => [
        rule({
          id: ids.ids.next('rule'),
          kind: 'skip',
          target: { type: 'question', id: ids.q1 },
          effect: { action: 'skip_to', target_id: ids.page2 },
          condition: answered(ids.q1Variable),
        }),
      ],
    });
    const built = fixture.build({ laidOut: false });
    const result = buildRules(built.survey, built.graph, built.env);
    expect(result.rules).toEqual([]);
    expect(result.diagnostics.map((d) => d.code)).toEqual(['CMP-0006']);
    expect(result.diagnostics[0]?.detail).toMatchObject({ target_type: 'question' });
  });
});

/* -------------------------------------------------------------------------- */
/* ON UNKNOWN                                                                  */
/* -------------------------------------------------------------------------- */

describe('a rule carrying ON UNKNOWN', () => {
  it('is CMP-0700, and the produced rule leaves on_unknown absent', () => {
    const fixture = scaffold({
      rules: (ids) => [
        rule({
          id: ids.ids.next('rule'),
          kind: 'display',
          target: { type: 'question', id: ids.q5 },
          effect: { action: 'hide', params: { on_unknown: 'fire' } },
          condition: answered(ids.q1Variable),
        }),
      ],
    });
    const built = fixture.build();
    const result = buildRules(built.survey, built.graph, built.env);
    expect(result.diagnostics.map((d) => d.code)).toEqual(['CMP-0700']);
    expect(result.diagnostics[0]?.detail).toMatchObject({ on_unknown: 'fire' });
    const produced = only(result.rules);
    expect(produced.on_unknown).toBeUndefined();
    // No LGC-I002: the override was reported and refused, not carried into the engine.
    expect(codesOf(produced, built.env)).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Masks                                                                       */
/* -------------------------------------------------------------------------- */

function maskOf(ids: IdFactory, source: MaskSource, when: Mask['fallback']['when_empty']): Mask {
  return {
    id: ids.next('mask'),
    applies_to: 'options',
    mode: 'include',
    source,
    fallback: { when_empty: when },
  };
}

/**
 * The mask fixtures source a question from its own domain on purpose.
 *
 * CONTEXT decision 6: a domain id is synthesized as `dom_<emitting question id>`, so the only
 * variable whose domain agrees with a question's items is one the question itself emits. A
 * cross-question mask — the realistic case — reports `LGC-T021` today, and that false positive is
 * `CMP-0701`'s subject, not this file's. Sourcing from the same question keeps these tests about
 * the shape of the per-item expression.
 */
describe('a mask authored on a question', () => {
  it('becomes a mask rule carrying the authored fallback, mode and axis', () => {
    const ids = deterministicIds();
    const fixture = scaffold({
      masks: [maskOf(ids, { kind: 'explicit', item_ids: [] }, 'terminate')],
    });
    const built = fixture.build();
    const result = buildRules(built.survey, built.graph, built.env);
    const produced = only(result.rules);
    expect(result.diagnostics).toEqual([]);
    expect(produced.kind).toBe('mask');
    expect(produced.effect).toMatchObject({
      action: 'mask',
      applies_to: 'options',
      mode: 'include',
      fallback: { when_empty: 'terminate' },
    });
    expect(produced.target).toEqual({ type: 'question', id: fixture.q5.id });
  });

  it('takes its rule id from the mask id, so the trace can name it', () => {
    const ids = deterministicIds();
    const mask = maskOf(ids, { kind: 'explicit', item_ids: [] }, 'show_all');
    const fixture = scaffold({ masks: [mask] });
    const built = fixture.build();
    const produced = only(buildRules(built.survey, built.graph, built.env).rules);
    expect(produced.id).toBe(synthesizedMaskRuleId(mask.id));
    expect(produced.flow_node_id).toBe(fixture.sequenceId);
  });

  it('orders masks on one question by their document position, behind the authored rules', () => {
    const ids = deterministicIds();
    const masks = [
      maskOf(ids, { kind: 'explicit', item_ids: [] }, 'show_all'),
      maskOf(ids, { kind: 'explicit', item_ids: [] }, 'skip_question'),
    ];
    const fixture = scaffold({
      masks,
      rules: (rules) => [
        rule({
          id: rules.ids.next('rule'),
          kind: 'display',
          target: { type: 'question', id: rules.q5 },
          effect: { action: 'hide' },
          condition: answered(rules.q1Variable),
        }),
      ],
    });
    const built = fixture.build();
    const produced = buildRules(built.survey, built.graph, built.env).rules;
    expect(produced.map((r) => r.id)).toEqual([
      produced[0]?.id,
      synthesizedMaskRuleId(masks[0]?.id ?? ''),
      synthesizedMaskRuleId(masks[1]?.id ?? ''),
    ]);
    expect(produced[1]?.order_key).toBe((produced[0]?.order_key ?? 0) + 1);
    expect(produced[2]?.order_key).toBe((produced[0]?.order_key ?? 0) + 2);
  });
});

describe('each mask source', () => {
  /**
   * `LGC-W030` is the expected diagnostic and the only one: a `Mask` carries no condition, so
   * the synthesized rule's condition is the literal `TRUE`. Anything else in this list is a
   * per-item expression that does not type-check.
   */
  const check = (built: Built, produced: Rule): readonly string[] => codesOf(produced, built.env);

  it('selected_in over a set variable becomes CONTAINS(source, item)', () => {
    const staged = maskSourceFixture((ids) => ({
      kind: 'selected_in',
      variable_id: ids.q5Variable,
    }));
    expect(staged.produced.effect).toMatchObject({
      action: 'mask',
      per_item: { op: 'contains' },
    });
    expect(check(staged.built, staged.produced)).toEqual(['LGC-W030']);
  });

  it('not_selected_in negates the same membership test', () => {
    const staged = maskSourceFixture((ids) => ({
      kind: 'not_selected_in',
      variable_id: ids.q5Variable,
    }));
    expect(staged.produced.effect).toMatchObject({
      action: 'mask',
      per_item: { op: 'not', args: [{ op: 'contains' }] },
    });
    expect(check(staged.built, staged.produced)).toEqual(['LGC-W030']);
  });

  it('selected_in over an enum variable becomes an equality, not CONTAINS', () => {
    const staged = maskSourceFixture(
      (ids) => ({ kind: 'selected_in', variable_id: ids.q1Variable }),
      'q1',
    );
    expect(staged.produced.effect).toMatchObject({ per_item: { op: '==' } });
    expect(check(staged.built, staged.produced)).toEqual(['LGC-W030']);
  });

  it('explicit item ids become a set literal in the question domain', () => {
    const staged = maskSourceFixture((ids) => ({
      kind: 'explicit',
      item_ids: [ids.q5Option],
    }));
    expect(staged.produced.effect).toMatchObject({
      per_item: { op: 'contains', args: [{ op: 'lit', v: { k: 'set', v: [1] } }, { op: 'item' }] },
    });
    expect(check(staged.built, staged.produced)).toEqual(['LGC-W030']);
  });

  it('an explicit item id the question does not declare is CMP-0702', () => {
    const ids = deterministicIds();
    const stranger = ids.next('option');
    const fixture = scaffold({
      masks: [maskOf(ids, { kind: 'explicit', item_ids: [stranger] }, 'show_all')],
    });
    const built = fixture.build();
    const result = buildRules(built.survey, built.graph, built.env);
    expect(result.diagnostics.map((d) => d.code)).toEqual(['CMP-0702']);
    expect(result.diagnostics[0]?.detail).toMatchObject({
      reason: 'unresolved_mask_item',
      item_ids: [stranger],
    });
  });

  it('expression_per_item is carried through as the per-item condition', () => {
    const b = astBuilder();
    const staged = maskSourceFixture(() => ({
      kind: 'expression_per_item',
      condition: toSchema(b.cmp('>', b.itemAttr('code'), b.numLit(1))),
    }));
    expect(staged.produced.effect).toMatchObject({ per_item: { op: '>' } });
    expect(check(staged.built, staged.produced)).toEqual(['LGC-W030']);
  });
});

/**
 * A mask whose source names a variable or an option the registry only knows after it is built.
 *
 * Two passes: build the scaffold once to learn the ids, then rebuild it with the mask. The
 * scaffold is deterministic, so the second pass has the identical ids.
 */
function maskSourceFixture(
  source: (ids: Ids) => MaskSource,
  masksOn: 'q1' | 'q5' = 'q5',
): { readonly built: Built; readonly produced: Rule } {
  let captured: Ids | undefined;
  const probe = scaffold({
    rules: (ids) => {
      captured = ids;
      return [];
    },
  });
  probe.build();
  const ids = captured;
  if (ids === undefined) throw new Error('scaffold did not expose its ids');

  const maskIds = deterministicIds(999);
  const fixture = scaffold({ masks: [maskOf(maskIds, source(ids), 'skip_question')], masksOn });
  const built = fixture.build();
  const result = buildRules(built.survey, built.graph, built.env);
  expect(result.diagnostics).toEqual([]);
  return { built, produced: only(result.rules) };
}

/* -------------------------------------------------------------------------- */
/* A mask authored as a rule                                                   */
/* -------------------------------------------------------------------------- */

describe('a mask authored as a logic rule', () => {
  it('needs a when_empty in params, because RuleEffect has no field for it', () => {
    const fixture = scaffold({
      rules: (ids) => [
        rule({
          id: ids.ids.next('rule'),
          kind: 'mask',
          target: { type: 'question', id: ids.q5 },
          effect: {
            action: 'hide',
            value: toSchema(astBuilder().cmp('>', astBuilder().itemAttr('code'), astBuilder().numLit(1))),
          },
          condition: answered(ids.q1Variable),
        }),
      ],
    });
    const built = fixture.build();
    const result = buildRules(built.survey, built.graph, built.env);
    expect(result.rules).toEqual([]);
    expect(result.diagnostics.map((d) => d.code)).toEqual(['CMP-0702']);
    expect(result.diagnostics[0]?.detail).toMatchObject({ reason: 'mask_fallback_missing' });
  });

  it('becomes an exclude mask over the populated axis when params carry the fallback', () => {
    const b = astBuilder();
    const fixture = scaffold({
      rules: (ids) => [
        rule({
          id: ids.ids.next('rule'),
          kind: 'mask',
          target: { type: 'question', id: ids.q5 },
          effect: {
            action: 'hide',
            value: toSchema(b.cmp('>', b.itemAttr('code'), b.numLit(1))),
            params: { when_empty: 'skip_question' },
          },
          condition: answered(ids.q1Variable),
        }),
      ],
    });
    const built = fixture.build();
    const result = buildRules(built.survey, built.graph, built.env);
    expect(result.diagnostics).toEqual([]);
    const produced = only(result.rules);
    expect(produced.effect).toMatchObject({
      action: 'mask',
      mode: 'exclude',
      applies_to: 'options',
      fallback: { when_empty: 'skip_question' },
    });
    expect(codesOf(produced, built.env)).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Carried fields                                                              */
/* -------------------------------------------------------------------------- */

describe('the fields carried through unchanged', () => {
  it('defaults evaluation and authored_in, and uses notes as the trace label', () => {
    const fixture = scaffold({
      rules: (ids) => [
        rule({
          id: ids.ids.next('rule'),
          kind: 'display',
          target: { type: 'question', id: ids.q5 },
          effect: { action: 'hide' },
          condition: answered(ids.q1Variable),
          notes: 'client asked for this in the 3 March call',
        }),
      ],
    });
    const built = fixture.build();
    const produced = only(buildRules(built.survey, built.graph, built.env).rules);
    expect(produced.evaluation).toBe('on_change');
    expect(produced.authored_in).toBe('visual');
    expect(produced.label).toBe('client asked for this in the 3 March call');
    expect(produced.priority_group).toBeUndefined();
  });
});
