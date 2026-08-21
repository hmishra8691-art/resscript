/**
 * What the never-visible check must get right.
 *
 * The load-bearing test is the negative one: a question with **no** `show` rule and a `hide` rule
 * that can never fire is *visible*, and reporting it would be a false positive on a survey whose
 * only defect is a dead hide rule. That is the difference between "every display rule targeting
 * it is provably false" (wrong) and "it is base-hidden and every `show` rule is provably false"
 * (right), and it is the one mistake in this analysis that would be noticed by an author rather
 * than by a reviewer.
 *
 * The second is the `U002`/`U003` split: a required question that can never be visible gets the
 * error and *only* the error. One defect, one diagnostic.
 *
 * Diagnostics are asserted by code and `detail`, never by message prose.
 */

import { describe, expect, it } from 'vitest';
import type {
  ContentNode,
  Expr as SchemaExpr,
  FlowNode,
  IdFactory,
  LogicRule,
  PageId,
  PageNode,
  QuestionItem,
  QuestionNode,
  RuleTarget,
  Survey,
  Variable,
} from '@resscript/schema';
import { asDomainId, astBuilder, asVariableId, type DomainId, type Expr, type TypeEnv, type VariableId } from '@resscript/logic';

import { deterministicIds } from '../../../schema/src/__fixtures__/mini.js';
import type { CompileDiagnostic } from '../diagnostics.js';
import { buildFlowGraph } from '../flow.js';
import { buildTypeEnvFor } from '../registry.js';
import { buildRules } from '../rules.js';
import type { FlowGraph } from '../types.js';
import { analyzeUnreachableContent } from './unreachable.js';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

interface Scene {
  readonly survey: Survey;
  readonly graph: FlowGraph;
  readonly env: TypeEnv;
  readonly diagnostics: readonly CompileDiagnostic[];
}

function scene(
  ids: IdFactory,
  spec: {
    readonly content: readonly ContentNode[];
    readonly nodes: readonly FlowNode[];
    readonly variables: readonly Variable[];
    readonly rules?: readonly LogicRule[];
  },
): Scene {
  const survey: Survey = {
    meta: { id: ids.next('survey'), ref: 'UNR', name: 'Unreachable fixture' },
    schema_version: 2,
    settings: {
      navigation: { back_allowed: true },
      resume: { enabled: false, window_s: 3600, position: 'last_page' },
      progress_bar: { mode: 'none' },
      screenout: { show_message: false },
    },
    languages: {
      base: 'en',
      available: [{ code: 'en' }],
      bundles: { en: {} },
      policy: { on_missing: 'fallback_to_base', block_publish_if_incomplete: false },
    },
    variables: spec.variables,
    content: spec.content,
    flow: { nodes: spec.nodes },
    logic_rules: spec.rules ?? [],
  };
  const env = buildTypeEnvFor(survey).env;
  const graph = buildFlowGraph(survey);
  const rules = buildRules(survey, graph, env).rules;
  return { survey, graph, env, diagnostics: analyzeUnreachableContent({ survey, graph, rules, env }) };
}

interface Selected {
  readonly node: QuestionNode;
  readonly variable: Variable;
  readonly id: VariableId;
  readonly domain: DomainId;
}

/** A single-select and the scalar enum variable it emits, so a condition can name a domain. */
function select(ids: IdFactory, ref: string, required = false): Selected {
  const options: QuestionItem[] = [1, 2].map((code) => ({
    id: ids.next('option'),
    ref: `o${String(code)}`,
    code,
    label: { key: `o.${String(code)}` },
    position: code,
  }));
  const node: QuestionNode = {
    id: ids.next('question'),
    type: 'question',
    ref,
    question_type: 'single_select',
    label: { key: `${ref}.label` },
    required,
    options,
  };
  const variable: Variable = {
    id: ids.next('variable'),
    name: ref,
    kind: 'response',
    type: 'enum',
    source: { question_id: node.id, part: { kind: 'scalar' } },
    enum_domain: options.map((option) => ({ code: option.code, label_key: `o.${option.ref}` })),
    export: { include: true, column: ref },
    pii: false,
    persist: true,
  };
  return { node, variable, id: asVariableId(variable.id), domain: asDomainId(`dom_${node.id}`) };
}

function page(ids: IdFactory, ref: string, children: readonly QuestionNode[]): PageNode {
  return { id: ids.next('page'), type: 'page', ref, children };
}

function toSchema(expression: Expr): SchemaExpr {
  return expression as unknown as SchemaExpr;
}

/** `Q == 1 AND Q == 2`: satisfiable-looking, provably not. */
function unsatisfiable(q: Selected): SchemaExpr {
  const b = astBuilder();
  return toSchema(
    b.and(
      b.cmp('==', b.variable(q.id), b.enumLit(1, q.domain)),
      b.cmp('==', b.variable(q.id), b.enumLit(2, q.domain)),
    ),
  );
}

/** `Q == 1`: an ordinary condition that can go either way. */
function satisfiable(q: Selected): SchemaExpr {
  const b = astBuilder();
  return toSchema(b.cmp('==', b.variable(q.id), b.enumLit(1, q.domain)));
}

const ALWAYS = toSchema(astBuilder().boolLit(true));

function rule(
  id: string,
  kind: LogicRule['kind'],
  target: RuleTarget,
  action: LogicRule['effect']['action'],
  condition: SchemaExpr,
): LogicRule {
  return { id, kind, target, condition, effect: { action } } as LogicRule;
}

function codes(diagnostics: readonly CompileDiagnostic[]): readonly string[] {
  return diagnostics.map((d) => d.code);
}

/* -------------------------------------------------------------------------- */
/* One page laid out, one not                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Two pages; the flow lays out only the first. `orphanRequired` decides whether the question on
 * the second is `required`, which is the whole `U002`/`U003` split.
 */
function orphanPage(orphanRequired: boolean): Scene {
  const ids = deterministicIds();
  const q1 = select(ids, 'Q1');
  const q2 = select(ids, 'Q2', orphanRequired);
  const p1 = page(ids, 'P1', [q1.node]);
  const p2 = page(ids, 'P2', [q2.node]);
  const blockId = ids.next('block');
  const startId = ids.next('flow_node');
  const seqId = ids.next('flow_node');
  const endId = ids.next('flow_node');
  return scene(ids, {
    content: [{ id: blockId, type: 'block', ref: 'B1', children: [p1, p2] }],
    nodes: [
      { id: startId, type: 'start', next: seqId },
      // Only P1. P2 is in the document and in no flow node.
      { id: seqId, type: 'sequence', target_id: p1.id, next: endId },
      { id: endId, type: 'end', disposition: 'COMPLETE' },
    ],
    variables: [q1.variable, q2.variable],
  });
}

describe('a page no flow node lays out', () => {
  it('reports LGC-U002 as a warning for an optional question on it', () => {
    const built = orphanPage(false);
    expect(codes(built.diagnostics)).toEqual(['LGC-U002']);
    const found = built.diagnostics[0];
    expect(found?.severity).toBe('warning');
    expect(found?.detail?.['question_ref']).toBe('Q2');
    expect(found?.detail?.['reason']).toBe('page_not_laid_out');
    expect(found?.detail?.['required']).toBe(false);
    expect(found?.detail?.['page_laid_out']).toBe(false);
    expect(found?.detail?.['flow_node_id']).toBeNull();
    expect(found?.detail?.['rule_ids']).toEqual([]);
    expect(found?.path).toBe('/content/0/children/1/children/0');
  });

  it('reports LGC-U003 for a required question, and does not also report LGC-U002', () => {
    const built = orphanPage(true);
    expect(codes(built.diagnostics)).toEqual(['LGC-U003']);
    const found = built.diagnostics[0];
    expect(found?.severity).toBe('error');
    expect(found?.detail?.['question_ref']).toBe('Q2');
    expect(found?.detail?.['required']).toBe(true);
    expect(found?.detail?.['reason']).toBe('page_not_laid_out');
  });

  it('says nothing about the question on the page that is laid out', () => {
    expect(orphanPage(false).diagnostics.map((d) => d.detail?.['question_ref'])).toEqual(['Q2']);
  });
});

/* -------------------------------------------------------------------------- */
/* Display rules                                                              */
/* -------------------------------------------------------------------------- */

interface Scoped extends Scene {
  readonly pageId: PageId;
}

/** One laid-out page with two questions, plus whatever rules the case needs. */
function withRules(
  build: (q1: Selected, q2: Selected, pageId: PageId) => readonly LogicRule[],
): Scoped {
  const ids = deterministicIds();
  const q1 = select(ids, 'Q1');
  const q2 = select(ids, 'Q2');
  const p1 = page(ids, 'P1', [q1.node, q2.node]);
  const blockId = ids.next('block');
  const startId = ids.next('flow_node');
  const seqId = ids.next('flow_node');
  const endId = ids.next('flow_node');
  return {
    ...scene(ids, {
      content: [{ id: blockId, type: 'block', ref: 'B1', children: [p1] }],
      nodes: [
        { id: startId, type: 'start', next: seqId },
        { id: seqId, type: 'sequence', target_id: p1.id, next: endId },
        { id: endId, type: 'end', disposition: 'COMPLETE' },
      ],
      variables: [q1.variable, q2.variable],
      rules: build(q1, q2, p1.id),
    }),
    pageId: p1.id,
  };
}

describe('base visibility decides what a dead display rule means', () => {
  it('reports LGC-U002 when the only show rule can never fire', () => {
    const built = withRules((q1, q2) => [
      rule('rul_SHOW', 'display', { type: 'question', id: q2.node.id }, 'show', unsatisfiable(q1)),
    ]);
    expect(codes(built.diagnostics)).toEqual(['LGC-U002']);
    expect(built.diagnostics[0]?.detail?.['question_ref']).toBe('Q2');
    expect(built.diagnostics[0]?.detail?.['reason']).toBe('show_rules_never_fire');
    expect(built.diagnostics[0]?.detail?.['rule_ids']).toEqual(['rul_SHOW']);
    expect(built.diagnostics[0]?.detail?.['rule_paths']).toEqual(['/logic_rules/0']);
  });

  it('stays silent when a HIDE rule can never fire, because the question is base-visible', () => {
    const built = withRules((q1, q2) => [
      rule('rul_HIDE', 'display', { type: 'question', id: q2.node.id }, 'hide', unsatisfiable(q1)),
    ]);
    expect(built.diagnostics).toEqual([]);
  });

  it('stays silent when the show rule is satisfiable', () => {
    const built = withRules((q1, q2) => [
      rule('rul_SHOW', 'display', { type: 'question', id: q2.node.id }, 'show', satisfiable(q1)),
    ]);
    expect(built.diagnostics).toEqual([]);
  });

  it('needs every show rule to be dead, not just one', () => {
    const built = withRules((q1, q2) => [
      rule('rul_S1', 'display', { type: 'question', id: q2.node.id }, 'show', unsatisfiable(q1)),
      rule('rul_S2', 'display', { type: 'question', id: q2.node.id }, 'show', satisfiable(q1)),
    ]);
    expect(built.diagnostics).toEqual([]);
  });

  it('reports LGC-U002 for a hide rule that always fires', () => {
    const built = withRules((_q1, q2) => [
      rule('rul_HIDE', 'display', { type: 'question', id: q2.node.id }, 'hide', ALWAYS),
    ]);
    expect(codes(built.diagnostics)).toEqual(['LGC-U002']);
    expect(built.diagnostics[0]?.detail?.['reason']).toBe('hide_rule_always_fires');
    expect(built.diagnostics[0]?.detail?.['rule_ids']).toEqual(['rul_HIDE']);
  });

  it('reports LGC-U002 for a skip rule that always fires', () => {
    const built = withRules((_q1, q2) => [
      rule('rul_SKIP', 'skip', { type: 'question', id: q2.node.id }, 'skip_to', ALWAYS),
    ]);
    expect(codes(built.diagnostics)).toEqual(['LGC-U002']);
    expect(built.diagnostics[0]?.detail?.['reason']).toBe('skip_rule_always_fires');
  });
});

describe('an ancestor that can never be visible takes its questions with it', () => {
  it('reports every question on a page whose only show rule is dead, naming the page', () => {
    const built = withRules((q1, _q2, pageId) => [
      rule('rul_SHOW', 'display', { type: 'page', id: pageId }, 'show', unsatisfiable(q1)),
    ]);
    expect(codes(built.diagnostics)).toEqual(['LGC-U002', 'LGC-U002']);
    expect(built.diagnostics.map((d) => d.detail?.['question_ref'])).toEqual(['Q1', 'Q2']);
    // `node_id` is the page, not the question: that is where the defective rule is.
    expect(built.diagnostics.map((d) => d.detail?.['node_id'])).toEqual([
      built.pageId,
      built.pageId,
    ]);
    expect(built.diagnostics.map((d) => d.detail?.['reason'])).toEqual([
      'show_rules_never_fire',
      'show_rules_never_fire',
    ]);
  });

  it('reports a whole block nobody can see, once per question inside it', () => {
    const ids = deterministicIds();
    const q1 = select(ids, 'Q1');
    const q2 = select(ids, 'Q2');
    const p1 = page(ids, 'P1', [q1.node]);
    const p2 = page(ids, 'P2', [q2.node]);
    const innerId = ids.next('block');
    const outerId = ids.next('block');
    const startId = ids.next('flow_node');
    const seqId = ids.next('flow_node');
    const built = scene(ids, {
      content: [
        {
          id: outerId,
          type: 'block',
          ref: 'OUT',
          children: [{ id: innerId, type: 'block', ref: 'IN', children: [p1, p2] }],
        },
      ],
      nodes: [
        { id: startId, type: 'start', next: seqId },
        { id: seqId, type: 'sequence', target_id: outerId, next: null },
      ],
      variables: [q1.variable, q2.variable],
      rules: [rule('rul_SHOW', 'display', { type: 'block', id: innerId }, 'show', unsatisfiable(q1))],
    });
    expect(codes(built.diagnostics)).toEqual(['LGC-U002', 'LGC-U002']);
    expect(built.diagnostics.map((d) => d.detail?.['node_id'])).toEqual([innerId, innerId]);
  });
});

/* -------------------------------------------------------------------------- */
/* Refusals                                                                   */
/* -------------------------------------------------------------------------- */

describe('what the analysis declines to report', () => {
  it('says nothing when the flow has no start node', () => {
    const ids = deterministicIds();
    const q1 = select(ids, 'Q1', true);
    const p1 = page(ids, 'P1', [q1.node]);
    const blockId = ids.next('block');
    const built = scene(ids, {
      content: [{ id: blockId, type: 'block', ref: 'B1', children: [p1] }],
      nodes: [],
      variables: [q1.variable],
    });
    expect(built.graph.start).toBe('');
    expect(built.diagnostics).toEqual([]);
  });

  it('says nothing when the flow lays out no pages at all', () => {
    const ids = deterministicIds();
    const q1 = select(ids, 'Q1', true);
    const p1 = page(ids, 'P1', [q1.node]);
    const blockId = ids.next('block');
    const startId = ids.next('flow_node');
    const built = scene(ids, {
      content: [{ id: blockId, type: 'block', ref: 'B1', children: [p1] }],
      nodes: [{ id: startId, type: 'start', next: null }],
      variables: [q1.variable],
    });
    expect(built.graph.pageOrder).toEqual([]);
    expect(built.diagnostics).toEqual([]);
  });

  it('says nothing about an option-targeted rule, which is LGC-W040 territory', () => {
    const built = withRules((_q1, q2) => {
      const option = (q2.node.options ?? [])[0];
      if (option === undefined) throw new Error('bad fixture');
      return [rule('rul_OPT', 'option_state', { type: 'option', id: option.id }, 'hide', ALWAYS)];
    });
    expect(built.diagnostics).toEqual([]);
  });
});
