/**
 * What the forward-reference analysis must get right, one test per claim the file makes.
 *
 * The two tests that carry the whole design are the mirror pair: a branched survey where
 * *document* order says "fine" and dominance says "forward reference", and one where document
 * order says "forward reference" and dominance says fine. If those two ever agree, the analysis
 * has quietly become a document-order comparison, and `packages/rescript-dsl` already does that
 * one. Each asserts the order it depends on, so a fixture edit that reorders the content cannot
 * silently turn the test into a tautology.
 *
 * `writeSetDominates` is checked against a brute-force oracle rather than against hand-written
 * expectations, the way `flow.test.ts` checks `dominates`: "every path from start to r is cut by
 * S" is a claim about paths, and a test that restates the algorithm's own answer proves nothing.
 * The oracle runs in the opposite direction (delete `S`, walk forward from `start`), so a shared
 * bug is unlikely.
 *
 * Variables are declared by hand rather than derived by `applyVariableRegistry`, which is what
 * lets a fixture name the variable a rule reads without a two-pass build. The registry adapter
 * (`buildTypeEnvFor`) still runs over them, because it is what produces the `TypeEnv` this
 * analysis reads; only schema's own name derivation is out of the picture, and it is not under
 * test here.
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
  QuestionNode,
  RuleTarget,
  Survey,
  Variable,
  VariableId as SchemaVariableId,
} from '@resscript/schema';
import {
  asFlowNodeId,
  asPageId,
  asRuleId,
  asVariableId,
  astBuilder,
  buildTypeEnv,
  type Expr,
  type Rule,
  type TypeEnv,
  type VariableId,
} from '@resscript/logic';

import { deterministicIds } from '../../../schema/src/__fixtures__/mini.js';
import type { CompileDiagnostic } from '../diagnostics.js';
import { buildFlowGraph } from '../flow.js';
import { buildRules } from '../rules.js';
import { buildTypeEnvFor } from '../registry.js';
import type { FlowGraph, VariableSites } from '../types.js';
import { analyzeForwardReferences, buildVariableSites, writeSetDominates } from './forward-ref.js';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

interface Scene {
  readonly survey: Survey;
  readonly graph: FlowGraph;
  readonly env: TypeEnv;
  readonly rules: readonly Rule[];
  readonly sites: VariableSites;
  readonly diagnostics: readonly CompileDiagnostic[];
}

interface SceneSpec {
  readonly content: readonly ContentNode[];
  readonly nodes: readonly FlowNode[];
  readonly variables?: readonly Variable[];
  readonly rules?: readonly LogicRule[];
}

/**
 * The whole pipeline this analysis sits in: registry, flow graph, lowered rules, site index.
 *
 * Deliberately not a mock. `Rule.flow_node_id` is what positions a read, and it is assigned by
 * `buildRules` from the flow graph — a fixture that set it by hand would be testing this file
 * against a claim `rules.ts` does not make.
 */
function scene(ids: IdFactory, spec: SceneSpec): Scene {
  const survey: Survey = {
    meta: { id: ids.next('survey'), ref: 'FWD', name: 'Forward reference fixture' },
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
    variables: spec.variables ?? [],
    content: spec.content,
    flow: { nodes: spec.nodes },
    logic_rules: spec.rules ?? [],
  };
  const env = buildTypeEnvFor(survey).env;
  const graph = buildFlowGraph(survey);
  const rules = buildRules(survey, graph, env).rules;
  const sites = buildVariableSites(survey, graph, rules, env);
  return {
    survey,
    graph,
    env,
    rules,
    sites,
    diagnostics: analyzeForwardReferences({ survey, graph, rules, env, sites }),
  };
}

/** A numeric question and the one scalar variable it emits, so both ids are in hand. */
interface Asked {
  readonly node: QuestionNode;
  readonly variable: Variable;
  readonly id: VariableId;
}

function ask(ids: IdFactory, ref: string): Asked {
  const node: QuestionNode = {
    id: ids.next('question'),
    type: 'question',
    ref,
    question_type: 'numeric',
    label: { key: `${ref}.label` },
    required: false,
  };
  const variable: Variable = {
    id: ids.next('variable'),
    name: ref,
    kind: 'response',
    type: 'number',
    source: { question_id: node.id, part: { kind: 'scalar' } },
    export: { include: true, column: ref },
    pii: false,
    persist: true,
  };
  return { node, variable, id: asVariableId(variable.id) };
}

function page(ids: IdFactory, ref: string, children: readonly QuestionNode[]): PageNode {
  return { id: ids.next('page'), type: 'page', ref, children };
}

/** `<var> > 3`: boolean, reads exactly one variable, never constant. */
function reads(id: VariableId): SchemaExpr {
  const b = astBuilder();
  return toSchema(b.cmp('>', b.variable(id), b.numLit(3)));
}

function toSchema(expression: Expr): SchemaExpr {
  return expression as unknown as SchemaExpr;
}

const TRUE = toSchema(astBuilder().boolLit(true));

/** A display rule. `hide` rather than `show`, so the fixture does not flip base visibility. */
function hideRule(id: string, target: RuleTarget, condition: SchemaExpr): LogicRule {
  return { id, kind: 'display', target, condition, effect: { action: 'hide' } } as LogicRule;
}

function codes(diagnostics: readonly CompileDiagnostic[]): readonly string[] {
  return diagnostics.map((d) => d.code);
}

function detailOf(
  diagnostics: readonly CompileDiagnostic[],
  code: string,
): { readonly [key: string]: unknown } {
  const found = diagnostics.find((d) => d.code === code);
  if (found?.detail === undefined) throw new Error(`no ${code} with detail`);
  return found.detail;
}

/* -------------------------------------------------------------------------- */
/* The diamond                                                                */
/* -------------------------------------------------------------------------- */

interface Diamond {
  readonly scene: Scene;
  readonly qa: Asked;
  readonly qb: Asked;
  readonly qj: Asked;
  readonly pageA: PageId;
  readonly pageB: PageId;
  readonly pageJoin: PageId;
  readonly armA: string;
  readonly armB: string;
  readonly join: string;
}

/**
 * `PB` is declared FIRST in the document and `PA` second, but the flow puts them on the two arms
 * of one branch, so neither precedes the other for any respondent. That gap is the fixture's
 * whole reason for existing.
 */
function diamond(
  rules?: (q: {
    readonly qa: Asked;
    readonly qb: Asked;
    readonly qj: Asked;
    readonly pageJoin: PageId;
  }) => readonly LogicRule[],
  extra: { readonly variables?: readonly Variable[] } = {},
): Diamond {
  const ids = deterministicIds();
  const qb = ask(ids, 'QB');
  const qa = ask(ids, 'QA');
  const qj = ask(ids, 'QJ');
  const pageB = page(ids, 'PB', [qb.node]);
  const pageA = page(ids, 'PA', [qa.node]);
  const pageJoin = page(ids, 'PJ', [qj.node]);
  const blockId = ids.next('block');
  const startId = ids.next('flow_node');
  const branchId = ids.next('flow_node');
  const armAId = ids.next('flow_node');
  const armBId = ids.next('flow_node');
  const joinId = ids.next('flow_node');
  const endId = ids.next('flow_node');

  const built = scene(ids, {
    // Document order: PB, then PA, then PJ.
    content: [{ id: blockId, type: 'block', ref: 'B1', children: [pageB, pageA, pageJoin] }],
    nodes: [
      { id: startId, type: 'start', next: branchId },
      {
        id: branchId,
        type: 'branch',
        branches: [
          { condition: TRUE, next: armAId },
          { condition: null, next: armBId },
        ],
      },
      { id: armAId, type: 'sequence', target_id: pageA.id, next: joinId },
      { id: armBId, type: 'sequence', target_id: pageB.id, next: joinId },
      { id: joinId, type: 'sequence', target_id: pageJoin.id, next: endId },
      { id: endId, type: 'end', disposition: 'COMPLETE' },
    ],
    variables: [qb.variable, qa.variable, qj.variable, ...(extra.variables ?? [])],
    ...(rules === undefined ? {} : { rules: rules({ qa, qb, qj, pageJoin: pageJoin.id }) }),
  });

  return {
    scene: built,
    qa,
    qb,
    qj,
    pageA: pageA.id,
    pageB: pageB.id,
    pageJoin: pageJoin.id,
    armA: armAId,
    armB: armBId,
    join: joinId,
  };
}

describe('a branch is where document order and dominance come apart', () => {
  it('reports LGC-F001 for a read on one arm of a variable written on the other', () => {
    const d = diamond((q) => [hideRule('rul_R1', { type: 'question', id: q.qa.node.id }, reads(q.qb.id))]);

    // The premise: QB's page is declared BEFORE QA's, so a document-order check says "fine".
    const block = d.scene.survey.content[0];
    if (block === undefined || block.type !== 'block') throw new Error('bad fixture');
    expect(block.children.map((child) => child.id)).toEqual([d.pageB, d.pageA, d.pageJoin]);

    expect(codes(d.scene.diagnostics)).toEqual(['LGC-F001']);
    const detail = detailOf(d.scene.diagnostics, 'LGC-F001');
    expect(detail['rule_id']).toBe('rul_R1');
    expect(detail['variable_id']).toBe(d.qb.variable.id);
    expect(detail['variable_name']).toBe('QB');
    expect(detail['blocking_variable_name']).toBe('QB');
    expect(detail['availability']).toBe('none');
    expect(detail['read_flow_node_id']).toBe(d.armA);
    expect(detail['read_page_id']).toBe(d.pageA);
    expect(detail['write_flow_node_id']).toBe(d.armB);
    expect(detail['write_page_id']).toBe(d.pageB);
    expect(detail['write_question_id']).toBe(d.qb.node.id);
    expect(detail['write_question_ref']).toBe('QB');
    // The flow positions the acceptance criterion asks the diagnostic to name.
    expect(detail['read_flow_position']).toBe(d.scene.graph.position.get(d.armA));
    expect(detail['write_flow_position']).toBe(d.scene.graph.position.get(d.armB));
    expect(detail['read_page_index']).toBe(0);
    expect(detail['write_page_index']).toBe(1);
    expect(d.scene.diagnostics[0]?.severity).toBe('error');
    expect(d.scene.diagnostics[0]?.path).toBe('/logic_rules/0/condition');
  });

  it('stays silent when document order says forward reference and the flow does not', () => {
    const ids = deterministicIds();
    const early = ask(ids, 'QEARLY');
    const late = ask(ids, 'QLATE');
    const pageEarly = page(ids, 'PE', [early.node]);
    const pageLate = page(ids, 'PL', [late.node]);
    const blockId = ids.next('block');
    const startId = ids.next('flow_node');
    const lateId = ids.next('flow_node');
    const earlyId = ids.next('flow_node');
    const endId = ids.next('flow_node');

    const built = scene(ids, {
      // Document order: PE first. Flow order: PL first.
      content: [{ id: blockId, type: 'block', ref: 'B1', children: [pageEarly, pageLate] }],
      nodes: [
        { id: startId, type: 'start', next: lateId },
        { id: lateId, type: 'sequence', target_id: pageLate.id, next: earlyId },
        { id: earlyId, type: 'sequence', target_id: pageEarly.id, next: endId },
        { id: endId, type: 'end', disposition: 'COMPLETE' },
      ],
      variables: [early.variable, late.variable],
      rules: [hideRule('rul_R1', { type: 'question', id: early.node.id }, reads(late.id))],
    });

    expect(built.graph.pageOrder).toEqual([pageLate.id, pageEarly.id]);
    expect(built.diagnostics).toEqual([]);
  });

  it('splits F001 from F002 on one fixture', () => {
    const d = diamond((q) => [
      // Read at the join of a variable written on one arm only: some paths have it.
      hideRule('rul_JOIN', { type: 'question', id: q.qj.node.id }, reads(q.qa.id)),
      // Read on arm A of a variable written on arm B: no path has it.
      hideRule('rul_ARM', { type: 'question', id: q.qa.node.id }, reads(q.qb.id)),
    ]);
    expect(codes(d.scene.diagnostics)).toEqual(['LGC-F001', 'LGC-F002']);
    expect(detailOf(d.scene.diagnostics, 'LGC-F001')['rule_id']).toBe('rul_ARM');
    expect(detailOf(d.scene.diagnostics, 'LGC-F002')['rule_id']).toBe('rul_JOIN');
    expect(detailOf(d.scene.diagnostics, 'LGC-F002')['availability']).toBe('some');
    expect(detailOf(d.scene.diagnostics, 'LGC-F002')['read_flow_node_id']).toBe(d.join);
    expect(d.scene.diagnostics.find((diag) => diag.code === 'LGC-F002')?.severity).toBe('warning');
  });

  it('stays silent for an in-page read, which the cell graph recomputes on change', () => {
    const d = diamond((q) => [
      hideRule('rul_SELF', { type: 'page', id: q.pageJoin }, reads(q.qj.id)),
    ]);
    expect(d.scene.diagnostics).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* The three shapes that must not be false positives                          */
/* -------------------------------------------------------------------------- */

describe('shapes that must stay silent', () => {
  it('treats a hidden variable read on the first page as available at entry', () => {
    const ids = deterministicIds();
    const q1 = ask(ids, 'Q1');
    const p1 = page(ids, 'P1', [q1.node]);
    const blockId = ids.next('block');
    const startId = ids.next('flow_node');
    const seqId = ids.next('flow_node');
    const endId = ids.next('flow_node');
    const flag: Variable = {
      id: ids.next('variable'),
      name: 'SOURCE',
      kind: 'hidden',
      type: 'number',
      export: { include: true, column: 'SOURCE' },
      pii: false,
      persist: true,
    };

    const built = scene(ids, {
      content: [{ id: blockId, type: 'block', ref: 'B1', children: [p1] }],
      nodes: [
        { id: startId, type: 'start', next: seqId },
        { id: seqId, type: 'sequence', target_id: p1.id, next: endId },
        { id: endId, type: 'end', disposition: 'COMPLETE' },
      ],
      variables: [q1.variable, flag],
      rules: [hideRule('rul_R1', { type: 'question', id: q1.node.id }, reads(asVariableId(flag.id)))],
    });

    expect(built.diagnostics).toEqual([]);
    expect(built.sites.preEntry.has(flag.id)).toBe(true);
    expect(built.sites.writes.get(flag.id)).toEqual([startId]);
    // And the read was recorded, so the index is not silent by being empty.
    expect(built.sites.reads.get(flag.id)).toEqual([seqId]);
  });

  it('accepts a write set that collectively dominates the read, arm by arm', () => {
    const written = twoArmWrites(['A', 'B']);
    expect(written.diagnostics).toEqual([]);
    expect(new Set(written.sites.writes.get(written.variableId))).toEqual(
      new Set([written.armA, written.armB]),
    );
  });

  it('reports LGC-F002 when only one arm writes it', () => {
    const written = twoArmWrites(['A']);
    expect(codes(written.diagnostics)).toEqual(['LGC-F002']);
    expect(detailOf(written.diagnostics, 'LGC-F002')['availability']).toBe('some');
  });

  it('reports LGC-F001 when neither arm writes it', () => {
    const written = twoArmWrites([]);
    expect(codes(written.diagnostics)).toEqual(['LGC-F001']);
    expect(detailOf(written.diagnostics, 'LGC-F001')['write_flow_node_id']).toBeNull();
  });
});

/**
 * A variable written by a `set_variable` rule on each arm of the diamond, read at the join.
 *
 * The two rules are hand-built rather than lowered by `buildRules`, and that is not a shortcut:
 * `rules.ts` resolves a rule's `flow_node_id` from its *target*, and a `set_variable` rule's
 * target is the variable, so the authoring model cannot yet say "this assignment happens on arm
 * A". Two writes of one variable at two different flow nodes is exactly the shape set dominance
 * exists for, so it is constructed directly; the query under test is the same one either way.
 */
function twoArmWrites(arms: readonly ('A' | 'B')[]): {
  readonly diagnostics: readonly CompileDiagnostic[];
  readonly sites: VariableSites;
  readonly variableId: SchemaVariableId;
  readonly armA: string;
  readonly armB: string;
} {
  const d = diamond();
  const segId = asVariableId('var_01HSEGSEGSEGSEGSEGSEGSEG');
  // `response`, so the answer is decided by the write sites alone: `hidden` would be pre-entry
  // and `derived` would defer to its expression's inputs, and neither exercises the query.
  const env = buildTypeEnv({
    variables: [
      { id: segId, name: 'SEG', kind: 'response', type: 'number', persist: true, pii: false },
    ],
    domains: [],
  });

  const write = (label: 'A' | 'B'): Rule => {
    const b = astBuilder();
    return {
      id: asRuleId(`rul_SET${label}`),
      kind: 'set_variable',
      target: { type: 'variable', id: segId },
      condition: b.boolLit(true),
      effect: { action: 'set', variable_id: segId, value: b.numLit(1) },
      evaluation: 'on_change',
      authored_in: 'visual',
      order_key: 0,
      flow_node_id: asFlowNodeId(label === 'A' ? d.armA : d.armB),
    };
  };

  const readRule = (): Rule => {
    const b = astBuilder();
    return {
      id: asRuleId('rul_READ'),
      kind: 'display',
      target: { type: 'page', id: asPageId(d.pageJoin) },
      condition: b.cmp('>', b.variable(segId), b.numLit(0)),
      effect: { action: 'hide' },
      evaluation: 'on_change',
      authored_in: 'visual',
      order_key: 1,
      flow_node_id: asFlowNodeId(d.join),
    };
  };

  const rules: readonly Rule[] = [...arms.map(write), readRule()];
  const sites = buildVariableSites(d.scene.survey, d.scene.graph, rules, env);
  return {
    diagnostics: analyzeForwardReferences({
      survey: d.scene.survey,
      graph: d.scene.graph,
      rules,
      env,
      sites,
    }),
    sites,
    variableId: segId as unknown as SchemaVariableId,
    armA: d.armA,
    armB: d.armB,
  };
}

/* -------------------------------------------------------------------------- */
/* Derived variables                                                          */
/* -------------------------------------------------------------------------- */

function derivedVar(id: string, name: string, expression: SchemaExpr): Variable {
  return {
    id: id as Variable['id'],
    name,
    kind: 'derived',
    type: 'number',
    expression,
    export: { include: true, column: name },
    pii: false,
    persist: false,
  };
}

describe('derived variables resolve to their inputs', () => {
  it('names the input, not the derived variable, when the input is the forward reference', () => {
    const segId = 'var_01HSEGSEGSEGSEGSEGSEGSEG';
    const d = diamondWithDerived(segId);
    expect(codes(d.scene.diagnostics)).toEqual(['LGC-F001']);
    const detail = detailOf(d.scene.diagnostics, 'LGC-F001');
    expect(detail['variable_name']).toBe('SEG');
    expect(detail['blocking_variable_name']).toBe('QB');
    expect(detail['write_question_ref']).toBe('QB');
    expect(detail['write_flow_node_id']).toBe(d.armB);
    // The derived variable itself has no write site: "wherever its inputs are complete" is a
    // conjunction, and the index deliberately does not flatten it into a set of nodes.
    expect(d.scene.sites.writes.has(segId as unknown as SchemaVariableId)).toBe(false);
  });

  it('reports LGC-F002 when the derived variable is read where one input is available', () => {
    const segId = 'var_01HSEGSEGSEGSEGSEGSEGSEG';
    const d = diamondWithDerived(segId, 'join');
    expect(codes(d.scene.diagnostics)).toEqual(['LGC-F002']);
    expect(detailOf(d.scene.diagnostics, 'LGC-F002')['blocking_variable_name']).toBe('QB');
  });

  it('bails on a cycle rather than looping, leaving LGC-CYCLE to say what is wrong', () => {
    const ids = deterministicIds();
    const q1 = ask(ids, 'Q1');
    const p1 = page(ids, 'P1', [q1.node]);
    const blockId = ids.next('block');
    const startId = ids.next('flow_node');
    const seqId = ids.next('flow_node');
    const d1Id = 'var_01HD1D1D1D1D1D1D1D1D1D1D1';
    const d2Id = 'var_01HD2D2D2D2D2D2D2D2D2D2D2';
    const b1 = astBuilder();
    const b2 = astBuilder();

    const built = scene(ids, {
      content: [{ id: blockId, type: 'block', ref: 'B1', children: [p1] }],
      nodes: [
        { id: startId, type: 'start', next: seqId },
        { id: seqId, type: 'sequence', target_id: p1.id, next: null },
      ],
      variables: [
        q1.variable,
        derivedVar(d1Id, 'D1', toSchema(b1.binArith('+', b1.variable(asVariableId(d2Id)), b1.numLit(1)))),
        derivedVar(d2Id, 'D2', toSchema(b2.binArith('+', b2.variable(asVariableId(d1Id)), b2.numLit(1)))),
      ],
      rules: [hideRule('rul_R1', { type: 'question', id: q1.node.id }, reads(asVariableId(d1Id)))],
    });

    expect(built.diagnostics).toEqual([]);
  });
});

/** The diamond plus `SEG = QB + 1`, read on arm A (no path) or at the join (some paths). */
function diamondWithDerived(segId: string, readAt: 'armA' | 'join' = 'armA'): Diamond {
  const b = astBuilder();
  // The expression is built against the *known* variable id of QB, which the fixture hands out
  // rather than derives — see the header on why variables are declared by hand here.
  const probe = diamond();
  const expression = toSchema(b.binArith('+', b.variable(probe.qb.id), b.numLit(1)));
  return diamond(
    (q) => [
      hideRule(
        'rul_R1',
        readAt === 'armA'
          ? { type: 'question', id: q.qa.node.id }
          : { type: 'question', id: q.qj.node.id },
        reads(asVariableId(segId)),
      ),
    ],
    { variables: [derivedVar(segId, 'SEG', expression)] },
  );
}

/* -------------------------------------------------------------------------- */
/* Set dominance against an oracle                                            */
/* -------------------------------------------------------------------------- */

/**
 * `S` cuts every `start → r` path iff deleting `S` makes `r` unreachable. Forward from `start`,
 * where `writeSetDominates` walks backward from `r`, so the two share no traversal.
 */
function dominatesByDeletion(
  graph: FlowGraph,
  sites: ReadonlySet<string>,
  read: string,
): boolean {
  if (sites.has(read)) return true;
  if (sites.has(graph.start)) return true;
  const seen = new Set<string>([graph.start]);
  const stack = [graph.start];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) break;
    for (const next of graph.successors.get(node) ?? []) {
      if (sites.has(next) || seen.has(next)) continue;
      seen.add(next);
      stack.push(next);
    }
  }
  return !seen.has(read);
}

describe('writeSetDominates', () => {
  it('agrees with path deletion on every set of size 0, 1 and 2', () => {
    const mismatches: string[] = [];
    for (const graph of [diamond().scene.graph, loopGraph()]) {
      const nodes = [...graph.reachable];
      const subsets: ReadonlySet<string>[] = [new Set()];
      for (const a of nodes) {
        subsets.push(new Set([a]));
        for (const b of nodes) subsets.push(new Set([a, b]));
      }
      for (const sites of subsets) {
        for (const read of nodes) {
          const claimed = writeSetDominates(graph, sites, read);
          const actual = dominatesByDeletion(graph, sites, read);
          if (claimed !== actual) {
            mismatches.push(`{${[...sites].join(',')}} cut ${read}: ours=${claimed} paths=${actual}`);
          }
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('is reflexive, and the empty set cuts nothing', () => {
    const graph = diamond().scene.graph;
    for (const node of graph.reachable) {
      expect(writeSetDominates(graph, new Set([node]), node)).toBe(true);
      expect(writeSetDominates(graph, new Set(), node)).toBe(false);
    }
  });
});

/** A back edge, so the oracle comparison covers a graph the backward walk can revisit. */
function loopGraph(): FlowGraph {
  const ids = deterministicIds();
  const q1 = ask(ids, 'Q1');
  const q2 = ask(ids, 'Q2');
  const p1 = page(ids, 'P1', [q1.node]);
  const p2 = page(ids, 'P2', [q2.node]);
  const blockId = ids.next('block');
  const startId = ids.next('flow_node');
  const headId = ids.next('flow_node');
  const bodyId = ids.next('flow_node');
  const againId = ids.next('flow_node');
  const endId = ids.next('flow_node');
  return scene(ids, {
    content: [{ id: blockId, type: 'block', ref: 'B1', children: [p1, p2] }],
    nodes: [
      { id: startId, type: 'start', next: headId },
      { id: headId, type: 'sequence', target_id: p1.id, next: bodyId },
      { id: bodyId, type: 'sequence', target_id: p2.id, next: againId },
      {
        id: againId,
        type: 'branch',
        branches: [
          { condition: TRUE, next: headId },
          { condition: null, next: endId },
        ],
      },
      { id: endId, type: 'end', disposition: 'COMPLETE' },
    ],
    variables: [q1.variable, q2.variable],
  }).graph;
}

/* -------------------------------------------------------------------------- */
/* Refusals                                                                   */
/* -------------------------------------------------------------------------- */

describe('what the analysis declines to report', () => {
  it('says nothing at all when the flow has no start node', () => {
    const ids = deterministicIds();
    const qb = ask(ids, 'QB');
    const qa = ask(ids, 'QA');
    const p1 = page(ids, 'P1', [qb.node, qa.node]);
    const blockId = ids.next('block');
    const built = scene(ids, {
      content: [{ id: blockId, type: 'block', ref: 'B1', children: [p1] }],
      nodes: [],
      variables: [qb.variable, qa.variable],
      rules: [hideRule('rul_R1', { type: 'question', id: qa.node.id }, reads(qb.id))],
    });
    expect(built.graph.start).toBe('');
    expect(built.diagnostics).toEqual([]);
  });

  it('reports one diagnostic per rule and variable, not one per read of it', () => {
    const d = diamond((q) => {
      const b = astBuilder();
      const twice = toSchema(
        b.and(
          b.cmp('>', b.variable(q.qb.id), b.numLit(1)),
          b.cmp('<', b.variable(q.qb.id), b.numLit(9)),
        ),
      );
      return [hideRule('rul_R1', { type: 'question', id: q.qa.node.id }, twice)];
    });
    expect(codes(d.scene.diagnostics)).toEqual(['LGC-F001']);
  });

  it('says nothing about a survey-scoped rule, which has no flow position', () => {
    const d = diamond((q) => [
      { id: 'rul_R1', kind: 'skip', target: { type: 'survey' }, condition: reads(q.qb.id), effect: { action: 'skip_to' } } as LogicRule,
    ]);
    expect(d.scene.diagnostics).toEqual([]);
  });
});
