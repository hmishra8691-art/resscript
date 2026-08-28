/**
 * What the compile gate promises, one test per promise the milestone is accepted against.
 *
 * The headline is the roadmap's own acceptance criterion, and it is asserted in the shape the
 * roadmap states it: a survey whose Q12 rule reads a Q20 asked later "fails with a diagnostic
 * naming Q12, Q20, the rule, and the flow positions of both, and no artifact is written". All four
 * halves of that sentence are separate expectations, including the last one — a gate that reported
 * the defect *and* handed back a bundle would let a caller that checks for a bundle publish it.
 *
 * The determinism block is the other load-bearing one. Two compiles of one survey must hash
 * identically, a compile a week later must hash identically (which is the whole reason
 * `compiled_at` is not in the hashed bytes), and a compile of a survey with one label changed must
 * not. The three together are what makes "republishing an unchanged survey writes no new object"
 * true rather than aspirational; asserting only the first two would pass for a hash that ignored
 * its input.
 *
 * Fixtures are built two ways on purpose. The §17 checks each break exactly one thing about a
 * minimal survey, so a failing assertion names one cause — the discipline
 * `packages/schema/src/__fixtures__/mini.ts` was written for. The determinism and mask tests reuse
 * `emit/__fixtures__/artifact.ts`, because those claims are about the whole pipeline and that
 * fixture is the one that exercises a fan-out, a mask, two languages and a hidden variable at once.
 * Both kinds add `redirects`: `COMPLETE` is redirect-required (`DISPOSITION_FACTS`), so a survey
 * with an `end` node and no redirect map is a legitimate `CMP-0300`, and a fixture that tripped it
 * would make every other assertion in the file conditional on that one.
 *
 * Diagnostics are asserted by code and `detail`, never by message prose.
 */

import { describe, expect, it } from 'vitest';
import type {
  BlockId,
  ContentNode,
  Expr as SchemaExpr,
  FlowNode,
  FlowNodeId,
  IdFactory,
  Iso8601,
  Languages,
  LogicRule,
  PageNode,
  QuestionItem,
  QuestionNode,
  Redirects,
  QuotaConfig,
  RuleTarget,
  StringBundle,
  Survey,
  Variable,
} from '@resscript/schema';
import { applyVariableRegistry } from '@resscript/schema';
import { asVariableId, astBuilder, type Expr } from '@resscript/logic';

import { deterministicIds } from '../../schema/src/__fixtures__/mini.js';
import {
  acknowledgementKey,
  acknowledgementKeyIsPortable,
  type CompileDiagnostic,
} from './diagnostics.js';
import { buildSurvey, type FixtureSpec } from './emit/__fixtures__/artifact.js';
import { largeSurvey } from './__fixtures__/large-survey.js';
import { compileSurvey } from './pipeline.js';
import type { CompileInput, CompileResult } from './types.js';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const SURVEY_VERSION_ID = 'sv_01JQZK8N0000000000000001';
const COMPILED_AT = '2026-03-01T12:00:00.000Z' as Iso8601;

/** Covers the one disposition every fixture's `end` node declares. */
const REDIRECTS: Redirects = { default: { COMPLETE: 'https://example.test/done' } };

interface SceneSpec {
  readonly content: readonly ContentNode[];
  readonly nodes: readonly FlowNode[];
  readonly variables?: readonly Variable[];
  readonly rules?: readonly LogicRule[];
  readonly languages?: Languages;
  readonly redirects?: Redirects | null;
  readonly quotas?: QuotaConfig;
  readonly entitlementReqs?: readonly string[];
}

const BASE_LANGUAGES: Languages = {
  base: 'en',
  available: [{ code: 'en' }],
  bundles: { en: {} },
  policy: { on_missing: 'fallback_to_base', block_publish_if_incomplete: false },
};

function makeSurvey(ids: IdFactory, spec: SceneSpec): Survey {
  return {
    meta: { id: ids.next('survey'), ref: 'GATE', name: 'Compile gate fixture' },
    schema_version: 2,
    settings: {
      navigation: { back_allowed: true },
      resume: { enabled: false, window_s: 3600, position: 'last_page' },
      progress_bar: { mode: 'none' },
      screenout: { show_message: false },
    },
    languages: spec.languages ?? BASE_LANGUAGES,
    variables: spec.variables ?? [],
    content: spec.content,
    flow: { nodes: spec.nodes },
    logic_rules: spec.rules ?? [],
    redirects: spec.redirects === undefined ? REDIRECTS : spec.redirects,
    ...(spec.quotas === undefined ? {} : { quotas: spec.quotas }),
    ...(spec.entitlementReqs === undefined ? {} : { entitlement_reqs: spec.entitlementReqs }),
  };
}

function compile(survey: Survey, overrides: Partial<CompileInput> = {}): CompileResult {
  return compileSurvey({
    survey,
    surveyVersionId: SURVEY_VERSION_ID,
    compiledAt: COMPILED_AT,
    ...overrides,
  });
}

/** A numeric question and the one scalar variable it emits, so both ids are in hand. */
interface Asked {
  readonly node: QuestionNode;
  readonly variable: Variable;
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
  return { node, variable };
}

function page(ids: IdFactory, ref: string, children: readonly QuestionNode[]): PageNode {
  return { id: ids.next('page'), type: 'page', ref, children };
}

function toSchema(expression: Expr): SchemaExpr {
  return expression as unknown as SchemaExpr;
}

/** `<var> > 3`: boolean, reads exactly one variable, never constant. */
function readsOf(variable: Variable): SchemaExpr {
  const b = astBuilder();
  return toSchema(b.cmp('>', b.variable(asVariableId(variable.id)), b.numLit(3)));
}

const TRUE = toSchema(astBuilder().boolLit(true));
const FALSE = toSchema(astBuilder().boolLit(false));

function displayRule(
  ids: IdFactory,
  action: 'show' | 'hide',
  target: RuleTarget,
  condition: SchemaExpr,
): LogicRule {
  return { id: ids.next('rule'), kind: 'display', target, condition, effect: { action } };
}

function codes(result: CompileResult): readonly string[] {
  return result.diagnostics.map((d) => d.code);
}

function only(result: CompileResult, code: string): CompileDiagnostic {
  const found = result.diagnostics.filter((d) => d.code === code);
  expect(found.length, `expected exactly one ${code}, got ${JSON.stringify(codes(result))}`).toBe(1);
  const first = found[0];
  if (first === undefined) throw new Error(`no ${code}`);
  return first;
}

function detailOf(diagnostic: CompileDiagnostic): { readonly [key: string]: unknown } {
  if (diagnostic.detail === undefined) throw new Error(`${diagnostic.code} carries no detail`);
  return diagnostic.detail;
}

/* -------------------------------------------------------------------------- */
/* The headline: Q12 reads Q20, which is asked later                          */
/* -------------------------------------------------------------------------- */

interface ForwardScene {
  readonly survey: Survey;
  readonly q12: Asked;
  readonly q20: Asked;
  readonly ruleId: string;
}

/**
 * Two pages, one question each, and a display rule on the *first* page's question whose condition
 * reads the *second* page's answer.
 *
 * `order: 'q12-first'` is the defect and `'q20-first'` is the fix, and the only difference between
 * them is the order the flow visits the two pages — not the document order. That is the point: the
 * check is a dominance question (`types.ts`' `FlowGraph` comment), so the fixture has to be able to
 * change the flow while leaving the content tree alone.
 */
function forwardScene(order: 'q12-first' | 'q20-first'): ForwardScene {
  const ids = deterministicIds();
  const q12 = ask(ids, 'Q12');
  const q20 = ask(ids, 'Q20');
  const pageA = page(ids, 'PA', [q12.node]);
  const pageB = page(ids, 'PB', [q20.node]);
  const blockId = ids.next('block');
  const startId = ids.next('flow_node');
  const firstId = ids.next('flow_node');
  const secondId = ids.next('flow_node');
  const endId = ids.next('flow_node');

  const rule = displayRule(ids, 'hide', { type: 'question', id: q12.node.id }, readsOf(q20.variable));
  const first = order === 'q12-first' ? pageA : pageB;
  const second = order === 'q12-first' ? pageB : pageA;

  const survey = makeSurvey(ids, {
    // Document order is always PA then PB, so the two scenes differ only in the flow.
    content: [{ id: blockId, type: 'block', ref: 'B1', children: [pageA, pageB] }],
    nodes: [
      { id: startId, type: 'start', next: firstId },
      { id: firstId, type: 'sequence', target_id: first.id, next: secondId },
      { id: secondId, type: 'sequence', target_id: second.id, next: endId },
      { id: endId, type: 'end', disposition: 'COMPLETE' },
    ],
    variables: [q12.variable, q20.variable],
    rules: [rule],
    languages: bundleOf({ 'Q12.label': 'How many?', 'Q20.label': 'And how many?' }),
  });

  return { survey, q12, q20, ruleId: rule.id };
}

function bundleOf(en: StringBundle, extra: { readonly [code: string]: StringBundle } = {}): Languages {
  return {
    base: 'en',
    available: [{ code: 'en' }, ...Object.keys(extra).map((code) => ({ code }))],
    bundles: { en, ...extra },
    policy: { on_missing: 'fallback_to_base', block_publish_if_incomplete: false },
  };
}

describe('the forward reference the milestone is accepted on', () => {
  it('fails, names both questions, the rule and both flow positions, and writes no artifact', () => {
    const scene = forwardScene('q12-first');
    const result = compile(scene.survey);

    expect(result.ok).toBe(false);
    expect(result.bundle).toBeUndefined();

    const diagnostic = only(result, 'LGC-F001');
    const detail = detailOf(diagnostic);
    expect(detail['rule_id']).toBe(scene.ruleId);
    // Q12 is the question the rule is scoped to; Q20 is the question whose answer it reads.
    expect(detail['rule_target_id']).toBe(scene.q12.node.id);
    expect(detail['write_question_id']).toBe(scene.q20.node.id);
    expect(detail['write_question_ref']).toBe('Q20');
    expect(detail['variable_id']).toBe(scene.q20.variable.id);

    const read = detail['read_flow_position'];
    const write = detail['write_flow_position'];
    expect(typeof read).toBe('number');
    expect(typeof write).toBe('number');
    // The direction is the defect: the write is downstream of the read.
    expect(Number(write)).toBeGreaterThan(Number(read));
  });

  it('compiles once Q20 is asked earlier in the flow, with the content tree untouched', () => {
    const broken = forwardScene('q12-first');
    const fixed = forwardScene('q20-first');
    // The fix is a flow edit and nothing else: same content, same rule.
    expect(fixed.survey.content).toEqual(broken.survey.content);
    expect(fixed.survey.logic_rules).toEqual(broken.survey.logic_rules);

    const result = compile(fixed.survey);
    expect(codes(result)).not.toContain('LGC-F001');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected a bundle');
    expect(result.bundle.hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

/* -------------------------------------------------------------------------- */
/* The two hard stops, and the two integrity claims the pipeline owns itself   */
/* -------------------------------------------------------------------------- */

describe('loading a stored document', () => {
  it('compiles a document at an older schema_version, migrating it on the way in', () => {
    const fixed = forwardScene('q20-first');
    // A v1 document: no `settings.min_time_action` on any page, which is what the v1 → v2
    // migration fills in. A compiler that skipped the migration would emit a page without it.
    const v1: Survey = { ...fixed.survey, schema_version: 1 };
    const result = compile(v1);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected a bundle');
    const pages = Object.values(result.bundle.artifact.pages);
    expect(pages.length).toBe(2);
    for (const compiled of pages) {
      expect(compiled.settings['min_time_action']).toBe('flag');
    }
  });

  it('stops at a dangling reference rather than reporting its consequences too', () => {
    const ids = deterministicIds();
    const base = oneQuestion(ids);
    const ghost = ids.next('question');
    const survey = makeSurvey(ids, {
      content: [{ id: base.blockId, type: 'block', ref: 'B1', children: [base.page] }],
      nodes: base.nodes,
      variables: [base.asked.variable],
      // A rule scoped to a question that does not exist. Every analysis downstream assumes ids
      // resolve, and each would have something misleading to say about this one.
      rules: [displayRule(ids, 'hide', { type: 'question', id: ghost }, readsOf(base.asked.variable))],
      languages: bundleOf(LABELS),
    });

    const result = compile(survey);
    expect(result.ok).toBe(false);
    expect(codes(result)).toEqual(['SCH-1004']);
  });
});

describe('the pipeline blocks what the runtime cannot execute', () => {
  it('refuses a rule cycle (CMP-0800), because the evaluator throws on a program with no order', () => {
    const ids = deterministicIds();
    const base = oneQuestion(ids);
    const left: Variable = {
      id: ids.next('variable'),
      name: 'LEFT',
      kind: 'hidden',
      type: 'number',
      export: { include: true, column: 'LEFT' },
      pii: false,
      persist: true,
    };
    const right: Variable = { ...left, id: ids.next('variable'), name: 'RIGHT', export: { include: true, column: 'RIGHT' } };
    const b = astBuilder();
    const survey = makeSurvey(ids, {
      content: [{ id: base.blockId, type: 'block', ref: 'B1', children: [base.page] }],
      nodes: base.nodes,
      variables: [base.asked.variable, left, right],
      rules: [
        // LEFT := RIGHT and RIGHT := LEFT: two cells, each the other's input.
        {
          id: ids.next('rule'),
          kind: 'set_variable',
          target: { type: 'variable', id: left.id },
          condition: TRUE,
          effect: { action: 'set', value: toSchema(b.variable(asVariableId(right.id))) },
        },
        {
          id: ids.next('rule'),
          kind: 'set_variable',
          target: { type: 'variable', id: right.id },
          condition: TRUE,
          effect: { action: 'set', value: toSchema(astBuilder().variable(asVariableId(left.id))) },
        },
      ],
      languages: bundleOf(LABELS),
    });

    const result = compile(survey);
    expect(result.ok).toBe(false);
    expect(result.bundle).toBeUndefined();
    expect(codes(result)).toContain('LGC-CYCLE');
    const detail = detailOf(only(result, 'CMP-0800'));
    // The condition the runtime's own guard tests: `topo` does not cover `cells`.
    expect(Number(detail['ordered_cell_count'])).toBeLessThan(Number(detail['cell_count']));
  });

  it('refuses a flow that lays out no page (CMP-0801)', () => {
    const ids = deterministicIds();
    const base = oneQuestion(ids);
    const startId = ids.next('flow_node');
    const endId = ids.next('flow_node');
    const survey = makeSurvey(ids, {
      content: [{ id: base.blockId, type: 'block', ref: 'B1', children: [base.page] }],
      // A start that goes straight to the end: legal as a graph, and a survey with no pages.
      nodes: [
        { id: startId, type: 'start', next: endId },
        { id: endId, type: 'end', disposition: 'COMPLETE' },
      ],
      variables: [base.asked.variable],
      languages: bundleOf(LABELS),
    });

    const result = compile(survey);
    expect(result.ok).toBe(false);
    expect(detailOf(only(result, 'CMP-0801'))['flow_node_count']).toBe(2);
  });
});

/* -------------------------------------------------------------------------- */
/* Determinism and republish                                                  */
/* -------------------------------------------------------------------------- */

/** The shared emit fixture, plus the redirect map its `end` node needs. */
function sharedSurvey(spec: FixtureSpec = {}): Survey {
  const { survey } = buildSurvey(spec);
  return { ...survey, redirects: REDIRECTS };
}

function compiledShared(spec: FixtureSpec = {}, compiledAt: Iso8601 = COMPILED_AT): CompileResult {
  return compile(sharedSurvey(spec), { compiledAt });
}

function bundleOfResult(result: CompileResult): {
  readonly hash: string;
  readonly files: readonly { readonly path: string; readonly bytes: string }[];
} {
  if (!result.ok) {
    throw new Error(`compile failed: ${JSON.stringify(result.diagnostics.map((d) => d.code))}`);
  }
  return result.bundle;
}

describe('the artifact hash is a function of the survey and nothing else', () => {
  it('hashes two compiles of one survey identically', () => {
    const first = bundleOfResult(compiledShared({ languages: ['de'] }));
    const second = bundleOfResult(compiledShared({ languages: ['de'] }));
    expect(second.hash).toBe(first.hash);
  });

  it('hashes identically when only compiledAt differs', () => {
    const march = bundleOfResult(compiledShared({}, '2026-03-01T12:00:00.000Z' as Iso8601));
    const july = bundleOfResult(compiledShared({}, '2026-07-14T09:31:07.221Z' as Iso8601));
    expect(july.hash).toBe(march.hash);
    // The in-memory artifact still carries the instant it was compiled at; only the stored bytes
    // omit it. Without this half, the test above would also pass for a compiler that dropped the
    // field entirely.
    const artifact = compiledShared({}, '2026-07-14T09:31:07.221Z' as Iso8601);
    if (!artifact.ok) throw new Error('expected a bundle');
    expect(artifact.bundle.artifact.manifest.compiled_at).toBe('2026-07-14T09:31:07.221Z');
    expect(artifact.bundle.artifact.manifest.artifact_hash).toBe(artifact.bundle.hash);
  });

  it('hashes differently when one option label changes', () => {
    const before = bundleOfResult(compiledShared());
    const after = bundleOfResult(compiledShared({ q1Label: 'Pick exactly one' }));
    expect(after.hash).not.toBe(before.hash);
  });
});

describe('republishing an unchanged survey writes no new object', () => {
  it('produces byte-identical files, so a publisher comparing hashes stores nothing', () => {
    const first = bundleOfResult(compiledShared({ languages: ['de'] }));
    const second = bundleOfResult(
      compiledShared({ languages: ['de'] }, '2027-01-01T00:00:00.000Z' as Iso8601),
    );
    expect(second.files).toEqual(first.files);
    // `toEqual` compares structurally; this compares the bytes a storage client would upload.
    expect(JSON.stringify(second.files)).toBe(JSON.stringify(first.files));
    expect(second.hash).toBe(first.hash);
  });
});

/* -------------------------------------------------------------------------- */
/* One fixture per remaining §17 check                                        */
/* -------------------------------------------------------------------------- */

/**
 * A one-page survey with one numeric question, as the base every §17 fixture breaks.
 *
 * The three flow node ids come back with it so a fixture can rebuild the flow — the termination
 * case has to redirect the sequence's `next` — rather than patching an element of `nodes` by index,
 * which is how a fixture edit silently stops testing what its name says.
 */
interface Base {
  readonly asked: Asked;
  readonly page: PageNode;
  readonly blockId: BlockId;
  readonly startId: FlowNodeId;
  readonly sequenceId: FlowNodeId;
  readonly endId: FlowNodeId;
  readonly nodes: readonly FlowNode[];
}

function oneQuestion(ids: IdFactory): Base {
  const asked = ask(ids, 'Q1');
  const only1 = page(ids, 'P1', [asked.node]);
  const blockId = ids.next('block');
  const startId = ids.next('flow_node');
  const sequenceId = ids.next('flow_node');
  const endId = ids.next('flow_node');
  return {
    asked,
    page: only1,
    blockId,
    startId,
    sequenceId,
    endId,
    nodes: [
      { id: startId, type: 'start', next: sequenceId },
      { id: sequenceId, type: 'sequence', target_id: blockId, next: endId },
      { id: endId, type: 'end', disposition: 'COMPLETE' },
    ],
  };
}

const LABELS: StringBundle = { 'Q1.label': 'How many?' };

describe('schema §17, one check at a time', () => {
  it('reports an unreachable page as both a dead flow node and a question nobody sees', () => {
    const ids = deterministicIds();
    const base = oneQuestion(ids);
    const orphanId = ids.next('flow_node');
    const stranded = ask(ids, 'Q2');
    const secondPage = page(ids, 'P2', [stranded.node]);
    const secondBlockId = ids.next('block');
    const survey = makeSurvey(ids, {
      // P2 is in a *second* block. Putting it in B1 would leave it reachable, because the
      // reachable sequence node targets the block and a block lays out every page beneath it.
      content: [
        { id: base.blockId, type: 'block', ref: 'B1', children: [base.page] },
        { id: secondBlockId, type: 'block', ref: 'B2', children: [secondPage] },
      ],
      // The orphan lays out B2 and nothing points at it, so P2 is in no respondent's path.
      nodes: [...base.nodes, { id: orphanId, type: 'sequence', target_id: secondBlockId, next: null }],
      variables: [base.asked.variable, stranded.variable],
      languages: bundleOf({ ...LABELS, 'Q2.label': 'And?' }),
    });

    const result = compile(survey);
    expect(result.ok).toBe(false);
    expect(detailOf(only(result, 'LGC-U001'))['flow_node_id']).toBe(orphanId);
    // The page's own consequence, from the other pass: two facts, one defect, no third diagnostic.
    const stranded2 = detailOf(only(result, 'LGC-U002'));
    expect(stranded2['question_ref']).toBe('Q2');
    expect(stranded2['reason']).toBe('page_not_laid_out');
    expect(stranded2['page_id']).toBe(secondPage.id);
  });

  /**
   * A mask with no `fallback` fails at the *shape* gate, as `SCH-0100`, not as `validateStructural`'s
   * `SCH-1005`.
   *
   * That is the correct answer and worth pinning as such rather than reaching for the structural
   * code: schema's shape descriptor declares `Mask.fallback` required, so an absent one never
   * reaches the structural pass — `SCH-1005` is reachable only for a `when_empty` present and
   * outside `MASK_FALLBACKS`, and even that is `SCH-0103` from the descriptor first. What §17 asks
   * for is that a mask with no fallback cannot be published and that the diagnostic points at the
   * mask, and both hold at the earliest gate. Asserting `SCH-1005` here would pin a code the
   * pipeline cannot produce for this document.
   */
  it('refuses a mask with no fallback, pointing at the mask (SCH-0100)', () => {
    const ids = deterministicIds();
    const asked = ask(ids, 'Q1');
    const optionId = ids.next('option');
    const item: QuestionItem = {
      id: optionId,
      ref: 'o1',
      code: 1,
      label: { key: 'Q1.o1' },
      position: 1,
    };
    // The cast is the fixture's whole point: `Mask.fallback` is required in the type, and the
    // check exists because a stored document can still arrive without it.
    const question = {
      ...asked.node,
      question_type: 'single_select',
      options: [item],
      masks: [
        {
          id: ids.next('mask'),
          applies_to: 'options',
          mode: 'include',
          source: { kind: 'explicit', item_ids: [optionId] },
        },
      ],
    } as unknown as QuestionNode;

    const only1 = page(ids, 'P1', [question]);
    const blockId = ids.next('block');
    const startId = ids.next('flow_node');
    const sequenceId = ids.next('flow_node');
    const endId = ids.next('flow_node');
    const survey = makeSurvey(ids, {
      content: [{ id: blockId, type: 'block', ref: 'B1', children: [only1] }],
      nodes: [
        { id: startId, type: 'start', next: sequenceId },
        { id: sequenceId, type: 'sequence', target_id: blockId, next: endId },
        { id: endId, type: 'end', disposition: 'COMPLETE' },
      ],
      variables: [
        {
          ...asked.variable,
          type: 'enum',
          enum_domain: [{ code: 1, label_key: 'Q1.o1' }],
        },
      ],
      languages: bundleOf({ ...LABELS, 'Q1.o1': 'Yes' }),
    });

    const result = compile(survey);
    expect(result.ok).toBe(false);
    const diagnostic = only(result, 'SCH-0100');
    expect(diagnostic.path).toBe(`/content/0/children/0/children/0/masks/0/fallback`);
  });

  it('reports a required question no respondent can see (LGC-U003)', () => {
    const ids = deterministicIds();
    const base = oneQuestion(ids);
    const required: QuestionNode = { ...base.asked.node, required: true };
    const survey = makeSurvey(ids, {
      content: [
        { id: base.blockId, type: 'block', ref: 'B1', children: [page(ids, 'P1', [required])] },
      ],
      nodes: base.nodes,
      variables: [base.asked.variable],
      // A hide rule that always fires: the question is required and never shown.
      rules: [displayRule(ids, 'hide', { type: 'question', id: required.id }, TRUE)],
      languages: bundleOf(LABELS),
    });

    const result = compile(survey);
    expect(result.ok).toBe(false);
    const detail = detailOf(only(result, 'LGC-U003'));
    expect(detail['question_ref']).toBe('Q1');
    expect(detail['reason']).toBe('hide_rule_always_fires');
  });

  it('reports a duplicated ref (SCH-1001, through the pipeline)', () => {
    const ids = deterministicIds();
    const base = oneQuestion(ids);
    const twin: QuestionNode = { ...ask(ids, 'Q1').node };
    const survey = makeSurvey(ids, {
      content: [
        {
          id: base.blockId,
          type: 'block',
          ref: 'B1',
          children: [page(ids, 'P1', [base.asked.node, twin])],
        },
      ],
      nodes: base.nodes,
      variables: [base.asked.variable],
      languages: bundleOf(LABELS),
    });

    const result = compile(survey);
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('SCH-1001');
  });

  it('reports a variable shadowing a reserved system name (SCH-1003, through the pipeline)', () => {
    const ids = deterministicIds();
    const base = oneQuestion(ids);
    const shadow: Variable = {
      id: ids.next('variable'),
      // `language` is in `RESERVED_VARIABLE_NAMES`: a system variable cannot be shadowed.
      name: 'language',
      kind: 'hidden',
      type: 'text',
      export: { include: true, column: 'language_' },
      pii: false,
      persist: true,
    };
    const survey = makeSurvey(ids, {
      content: [{ id: base.blockId, type: 'block', ref: 'B1', children: [base.page] }],
      nodes: base.nodes,
      variables: [base.asked.variable, shadow],
      languages: bundleOf(LABELS),
    });

    const result = compile(survey);
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('SCH-1003');
  });

  it('blocks publish on an incomplete bundle when the policy says so (CMP-0200)', () => {
    const ids = deterministicIds();
    const base = oneQuestion(ids);
    const survey = makeSurvey(ids, {
      content: [{ id: base.blockId, type: 'block', ref: 'B1', children: [base.page] }],
      nodes: base.nodes,
      variables: [base.asked.variable],
      languages: {
        base: 'en',
        available: [{ code: 'en' }, { code: 'de' }],
        bundles: { en: LABELS, de: {} },
        policy: { on_missing: 'fallback_to_base', block_publish_if_incomplete: true },
      },
    });

    const result = compile(survey);
    expect(result.ok).toBe(false);
    const detail = detailOf(only(result, 'CMP-0200'));
    expect(detail['language']).toBe('de');
    expect(detail['reason']).toBe('publish_blocked_by_policy');
  });

  it('reports a reachable termination with no redirect (CMP-0300)', () => {
    const ids = deterministicIds();
    const base = oneQuestion(ids);
    const screenoutId = ids.next('flow_node');
    const survey = makeSurvey(ids, {
      content: [{ id: base.blockId, type: 'block', ref: 'B1', children: [base.page] }],
      nodes: [
        { id: base.startId, type: 'start', next: base.sequenceId },
        // The page now leads to a SCREENOUT termination, which `REDIRECTS` does not cover.
        { id: base.sequenceId, type: 'sequence', target_id: base.blockId, next: screenoutId },
        { id: screenoutId, type: 'termination', disposition: 'SCREENOUT' },
      ],
      variables: [base.asked.variable],
      languages: bundleOf(LABELS),
    });

    const result = compile(survey);
    expect(result.ok).toBe(false);
    const detail = detailOf(only(result, 'CMP-0300'));
    expect(detail['disposition']).toBe('SCREENOUT');
    expect(detail['reason']).toBe('no_redirect_configured');
  });

  it('reports a quota cell nobody can fall into (LGC-Q001)', () => {
    const ids = deterministicIds();
    const base = oneQuestion(ids);
    const dimensionId = ids.next('quota_dimension');
    const survey = makeSurvey(ids, {
      content: [{ id: base.blockId, type: 'block', ref: 'B1', children: [base.page] }],
      nodes: base.nodes,
      variables: [base.asked.variable],
      languages: bundleOf(LABELS),
      quotas: {
        policy: {
          count_at: 'completion',
          reservation_ttl_s: 900,
          on_store_unavailable: 'fail_closed',
          counter_scope: 'survey',
        },
        dimensions: [
          {
            id: dimensionId,
            ref: 'age',
            variable_id: base.asked.variable.id,
            // A bucket no respondent can be in: the cell keyed on it can never be filled.
            buckets: [{ ref: 'none', match: FALSE }],
          },
        ],
        plans: [
          {
            id: ids.next('quota_plan'),
            ref: 'main',
            type: 'marginal',
            dimension_ids: [dimensionId],
            target_mode: 'count',
            cells: [{ key: ['none'], target: 100, mode: 'hard' }],
          },
        ],
      },
    });

    const result = compile(survey);
    expect(result.ok).toBe(false);
    const detail = detailOf(only(result, 'LGC-Q001'));
    expect(detail['reason']).toBe('unsatisfiable_bucket');
    expect(detail['bucket_ref']).toBe('none');
  });

  it('reports a requirement the plan does not grant (CMP-0600)', () => {
    const ids = deterministicIds();
    const base = oneQuestion(ids);
    const survey = makeSurvey(ids, {
      content: [{ id: base.blockId, type: 'block', ref: 'B1', children: [base.page] }],
      nodes: base.nodes,
      variables: [base.asked.variable],
      languages: bundleOf(LABELS),
      entitlementReqs: ['conjoint'],
    });

    // An empty set is a plan that grants nothing, which is not the same as no plan at all.
    const result = compile(survey, { entitlements: new Set<string>() });
    expect(result.ok).toBe(false);
    expect(detailOf(only(result, 'CMP-0600'))['entitlement_key']).toBe('conjoint');
  });

  it('says nothing about entitlements when there is no plan in scope', () => {
    const ids = deterministicIds();
    const base = oneQuestion(ids);
    const survey = makeSurvey(ids, {
      content: [{ id: base.blockId, type: 'block', ref: 'B1', children: [base.page] }],
      nodes: base.nodes,
      variables: [base.asked.variable],
      languages: bundleOf(LABELS),
      entitlementReqs: ['conjoint'],
    });

    expect(codes(compile(survey))).not.toContain('CMP-0600');
  });

  it('reports author HTML that does not survive sanitization (CMP-0500)', () => {
    const ids = deterministicIds();
    const base = oneQuestion(ids);
    const survey = makeSurvey(ids, {
      content: [{ id: base.blockId, type: 'block', ref: 'B1', children: [base.page] }],
      nodes: base.nodes,
      variables: [base.asked.variable],
      languages: bundleOf({ ...LABELS, 'Q1.label': 'How many? <script>steal()</script>' }),
    });

    const result = compile(survey);
    expect(result.ok).toBe(false);
    const detail = detailOf(only(result, 'CMP-0500'));
    expect(detail['origin']).toBe('i18n_string');
    expect(detail['reasons']).toContain('disallowed_tag');
  });
});

/* -------------------------------------------------------------------------- */
/* Warnings and acknowledgement                                               */
/* -------------------------------------------------------------------------- */

describe('a warning blocks publish until the author accepts it, and not after', () => {
  /** One page, one question, one untranslated bundle under a non-blocking policy: one warning. */
  function warnScene(): Survey {
    const ids = deterministicIds();
    const base = oneQuestion(ids);
    return makeSurvey(ids, {
      content: [{ id: base.blockId, type: 'block', ref: 'B1', children: [base.page] }],
      nodes: base.nodes,
      variables: [base.asked.variable],
      languages: {
        base: 'en',
        available: [{ code: 'en' }, { code: 'de' }],
        bundles: { en: LABELS, de: {} },
        policy: { on_missing: 'fallback_to_base', block_publish_if_incomplete: false },
      },
    });
  }

  it('compiles with the warning unacknowledged', () => {
    const result = compile(warnScene());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected a bundle');
    expect(result.unacknowledged.map((d) => d.code)).toEqual(['CMP-0201']);
  });

  it('drops it from unacknowledged once its key is passed, and still reports it', () => {
    const survey = warnScene();
    const first = compile(survey);
    if (!first.ok) throw new Error('expected a bundle');
    const warning = first.unacknowledged[0];
    if (warning === undefined) throw new Error('expected a warning');

    const key = acknowledgementKey(warning);

    /*
     * The key has to survive the transport it is actually carried on, and this test used to
     * prove only that it survives being handed back to a function in the same process.
     *
     * Both legs of the real round trip are Postgres `jsonb`: the worker writes the key into
     * `ops.jobs.result` when a compile is blocked, and the studio sends it back in
     * `ops.jobs.payload` for `app.publish_version`'s `p_acknowledged_warnings`. jsonb is stored
     * as `text`, and Postgres text cannot hold a NUL, so ` ` is rejected with 22P05 —
     * meaning the in-memory round trip below passed while the deployed path could not report a
     * warning OR accept an acknowledgement, and killed the worker process trying.
     *
     * `JSON.parse(JSON.stringify(...))` is the cheap half of the proof (the key must survive
     * JSON at all); `acknowledgementKeyIsPortable` is the half that names the actual constraint.
     * Neither needs a database, which is the point — the property is checkable here, where the
     * key is minted.
     */
    expect(acknowledgementKeyIsPortable(key)).toBe(true);
    expect(JSON.parse(JSON.stringify({ k: key })) as { k: string }).toEqual({ k: key });

    const second = compile(survey, { acknowledgedWarnings: [key] });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('expected a bundle');
    expect(second.unacknowledged).toEqual([]);
    // Still in the record: `compile_diagnostics` has to show what was accepted.
    expect(codes(second)).toContain('CMP-0201');
    expect(second.bundle.hash).toBe(first.bundle.hash);
  });
});

/* -------------------------------------------------------------------------- */
/* The compiler does not report to the author about its own desugaring        */
/* -------------------------------------------------------------------------- */

describe('a question-level mask draws no diagnostic about its synthesized condition', () => {
  it('reports no LGC-W030 for the rule rules.ts synthesizes from QuestionNode.masks', () => {
    const result = compiledShared();
    expect(codes(result)).not.toContain('LGC-W030');
  });

  it('still reports LGC-W030 for an authored rule whose condition is constant', () => {
    const ids = deterministicIds();
    const base = oneQuestion(ids);
    const survey = makeSurvey(ids, {
      content: [{ id: base.blockId, type: 'block', ref: 'B1', children: [base.page] }],
      nodes: base.nodes,
      variables: [base.asked.variable],
      // `show` and not `hide`, so the question does not become never-visible (LGC-U002) as well.
      rules: [displayRule(ids, 'show', { type: 'question', id: base.asked.node.id }, TRUE)],
      languages: bundleOf(LABELS),
    });

    const result = compile(survey);
    const diagnostic = only(result, 'LGC-W030');
    // The path is the rule's row in the document, not `compileLogic`'s internal rule index.
    expect(diagnostic.path).toBe('/logic_rules/0/condition');
  });

  /**
   * The other half of the path repair.
   *
   * `compileLogic` checks a derived variable's own expression and reports against
   * `/variables/<variable id>/expression`, which is not a location in the document. An
   * acknowledgement or a UI link keyed on that path points at nothing; the array index is what
   * `validateStructural` uses for the same row.
   */
  it('reports a derived expression against its row in the document, not its variable id', () => {
    const ids = deterministicIds();
    const base = oneQuestion(ids);
    const b = astBuilder();
    const derived: Variable = {
      id: ids.next('variable'),
      name: 'DOUBLED',
      kind: 'derived',
      type: 'number',
      // A well-formed `var_` id that no variable in this survey has: `validateStructural` does not
      // walk expression ASTs, so this reaches `checkExpr` as `LGC-T001`.
      expression: toSchema(
        b.binArith('+', b.variable(asVariableId('var_01HF7YAT00M9MZNN5WPTQAS6ZZ')), b.numLit(1)),
      ),
      export: { include: true, column: 'DOUBLED' },
      pii: false,
      persist: true,
    };
    const survey = makeSurvey(ids, {
      content: [{ id: base.blockId, type: 'block', ref: 'B1', children: [base.page] }],
      nodes: base.nodes,
      variables: [base.asked.variable, derived],
      languages: bundleOf(LABELS),
    });

    const result = compile(survey);
    expect(result.ok).toBe(false);
    // `/variables/1`, the derived variable's index — not `/variables/var_…`.
    expect(only(result, 'LGC-T001').path).toBe('/variables/1/expression');
  });
});

/* -------------------------------------------------------------------------- */
/* Performance                                                                */
/* -------------------------------------------------------------------------- */

/**
 * 500 questions over 50 pages, in five fully translated languages — the roadmap's budget case.
 *
 * Generated rather than checked in, because the shape that matters is the size and a 500-question
 * fixture file would be unreviewable. Variables come from `applyVariableRegistry` rather than being
 * declared here, so the 500 names and the 500 `emits` lists are schema's own derivation and not a
 * loop in a test that could agree with itself.
 */
describe('the compile budget', () => {
  /**
   * One cold run, not `perf.test.ts`' warmed median.
   *
   * `packages/logic/src/perf.test.ts` warms the JIT and takes a median because it measures a 5 ms
   * budget, where a cold first call is all overhead. This budget is 5 s and the thing being held to
   * it is a publish job: a worker compiles a survey once, in a process that has never compiled that
   * survey before, so the cold number is the number that matters and warming would measure a case
   * that never happens in production.
   */
  it('compiles 500 questions in 5 languages within the roadmap budget of 5 s', () => {
    const survey = largeSurvey(500, ['en', 'de', 'fr', 'es', 'ja']);
    const started = performance.now();
    const result = compile(survey);
    const elapsed = performance.now() - started;

    if (!result.ok) {
      throw new Error(`compile failed: ${JSON.stringify(codes(result))}`);
    }
    // 50 pages in 5 languages: 250 page files, plus the manifest, graph, logic, redirects, five
    // bundles — and theme.css.
    //
    // This count was 259 and went to 260 when P2-12 made the compiler always emit a theme. The
    // change is the point rather than an accident: `themeCss` had been an optional input that
    // nothing supplied, so NO artifact carried a stylesheet, and `.rs-target` — the class
    // question-kit asserts on 6,601 times to satisfy the WCAG touch-target floor — was defined in
    // no stylesheet in the repository. An exact file count is what noticed.
    expect(Object.keys(result.bundle.artifact.pages).length).toBe(50);
    expect(result.bundle.files.length).toBe(260);
    expect(result.bundle.files.some((f) => f.path.endsWith('theme.css'))).toBe(true);
    expect(result.bundle.artifact.manifest.variable_manifest.length).toBe(500);
    // Printed rather than silently passed: a regression should show the number it regressed to,
    // since a test that only says "over 5000 ms" hides whether it was 5.1 s or 40 s.
    // eslint-disable-next-line no-console -- the measured number is the point of the test
    console.log(`500 questions x 5 languages: ${elapsed.toFixed(0)} ms`);
    expect(elapsed).toBeLessThan(5000);
  });
});


/* -------------------------------------------------------------------------- */
/* Loop unrolling, end to end (P2-02)                                         */
/* -------------------------------------------------------------------------- */

describe('a loop block compiles to one page per iteration', () => {
  /**
   * A block with `settings.loop` over two questions on two pages, plus one page outside the loop.
   *
   * The variables are written by hand at the two iterations rather than through
   * `buildVariableRegistry`, so this fixture asserts what the EMITTER does with an unrolled
   * registry rather than re-testing the unrolling `schema/variables.ts` already covers.
   */
  function loopedScene(iterations: number) {
    const ids = deterministicIds(9090);
    const q1 = ask(ids, 'Q1');
    const outsideQ = ask(ids, 'Q0');

    const loopPage = page(ids, 'LP', [q1.node]);
    const plainPage = page(ids, 'PP', [outsideQ.node]);
    const loopBlock = {
      id: ids.next('block'),
      type: 'block' as const,
      ref: 'LB',
      children: [loopPage],
      settings: {
        loop: {
          source: { kind: 'numeric_range' as const, from: 1, to: iterations },
          max_iterations: iterations,
          iteration_variable_ref: 'BRAND',
          variable_naming: '{ref}_{iteration}',
        },
      },
    };
    const plainBlock = {
      id: ids.next('block'),
      type: 'block' as const,
      ref: 'PB',
      children: [plainPage],
    };

    // One variable per iteration for the looped question, named the way applyLoopNaming would.
    const loopVars: Variable[] = Array.from({ length: iterations }, (_, i) => ({
      id: ids.next('variable'),
      name: `Q1_${String(i + 1)}`,
      kind: 'response' as const,
      type: 'number' as const,
      source: { question_id: q1.node.id, part: { kind: 'scalar' as const }, iteration: i + 1 },
      export: { include: true, column: `Q1_${String(i + 1)}` },
      pii: false,
      persist: true,
    }));

    const start = ids.next('flow_node');
    const loopNode = ids.next('flow_node');
    const plainNode = ids.next('flow_node');
    const end = ids.next('flow_node');

    const survey = makeSurvey(ids, {
      content: [loopBlock, plainBlock] as never,
      // Both label keys, or SCH-1008 refuses the compile before any of this is exercised.
      languages: bundleOf({ 'Q1.label': 'How many?', 'Q0.label': 'And overall?' }),
      variables: [...loopVars, outsideQ.variable],
      nodes: [
        { id: start, type: 'start', next: loopNode },
        { id: loopNode, type: 'loop', target_id: loopBlock.id, next: plainNode },
        { id: plainNode, type: 'sequence', target_id: plainBlock.id, next: end },
        { id: end, type: 'end', disposition: 'COMPLETE' },
      ] as never,
    });

    return { survey, loopPage, plainPage, loopNode, q1, loopVars };
  }

  it('emits N page files for one looped page, plus the unlooped one', () => {
    // The whole point. Before P2-02 a `loop` flow node ran its target ONCE: flow.ts treated it as a
    // `sequence` and nothing unrolled the pages, so a loop over four brands asked about one.
    const { survey } = loopedScene(3);
    const result = compile(survey);
    if (!result.ok) throw new Error(`compile failed: ${JSON.stringify(codes(result))}`);

    const pages = Object.keys(result.bundle.artifact.pages);
    expect(pages).toHaveLength(4); // 3 iterations + 1 page outside the loop
  });

  it('puts every iteration in page_order, in iteration order, before the unlooped page', () => {
    const { survey, plainPage } = loopedScene(3);
    const result = compile(survey);
    if (!result.ok) throw new Error('compile failed');

    const order = result.bundle.artifact.graph.page_order;
    expect(order).toHaveLength(4);
    // The unlooped page is last, because its flow node follows the loop's.
    expect(order[3]).toBe(plainPage.id);
    // And the three iterations are distinct ids.
    expect(new Set(order.slice(0, 3)).size).toBe(3);
  });

  it('maps every derived id back to the authored page, on the GRAPH', () => {
    // On the graph and not only on each CompiledPage, because the consumer is the flow machine: it
    // asks "is this page visible" while walking page_order, before any page file is fetched. A
    // derived id the logic program has never seen would fall through to baseVisible (true), and a
    // rule hiding a looped page would hide none of its iterations.
    const { survey, loopPage } = loopedScene(2);
    const result = compile(survey);
    if (!result.ok) throw new Error('compile failed');

    const map = result.bundle.artifact.graph.page_authored ?? {};
    expect(Object.keys(map)).toHaveLength(2);
    for (const authored of Object.values(map)) expect(authored).toBe(loopPage.id);
  });

  it('gives every iteration the SAME flow-node entry, so the machine walks them as one sequence', () => {
    // This is why the runtime needed no change: `pagesForNode` filters page_order by page_entry, so
    // a loop node owning N x the pages is walked correctly by the `case 'sequence': case 'loop':`
    // arm that already existed.
    const { survey, loopNode } = loopedScene(3);
    const result = compile(survey);
    if (!result.ok) throw new Error('compile failed');

    const entry = result.bundle.artifact.graph.page_entry;
    const owned = Object.entries(entry).filter(([, node]) => node === loopNode);
    expect(owned).toHaveLength(3);
  });

  it('binds each iteration page to THAT iteration variables only', () => {
    // The bug this prevents: `emitsOf` collects every variable whose source.question_id matches,
    // which for a looped question is all N iterations. One rendered question carrying N iterations'
    // variables writes an answer at iteration 2 into iteration 1's export column, or into all.
    const { survey, loopVars } = loopedScene(3);
    const result = compile(survey);
    if (!result.ok) throw new Error('compile failed');

    const pages = Object.values(result.bundle.artifact.pages);
    const looped = pages.filter((p) => p.iteration !== undefined);
    expect(looped).toHaveLength(3);

    for (const p of looped) {
      const emits = p.questions[0]?.emits ?? [];
      expect(emits).toHaveLength(1);
      const expected = loopVars[(p.iteration ?? 0) - 1];
      expect(emits[0]).toBe(expected?.id);
    }
  });

  it('records the iteration and the authored id on each looped page', () => {
    const { survey, loopPage } = loopedScene(2);
    const result = compile(survey);
    if (!result.ok) throw new Error('compile failed');

    const looped = Object.values(result.bundle.artifact.pages)
      .filter((p) => p.iteration !== undefined)
      .sort((a, b) => (a.iteration ?? 0) - (b.iteration ?? 0));

    expect(looped.map((p) => p.iteration)).toEqual([1, 2]);
    for (const p of looped) expect(p.authored_id).toBe(loopPage.id);
  });

  it('keeps the questions AUTHORED id, so the logic cells are shared', () => {
    // Deliberate, and exact rather than approximate: no expression in the logic AST reads the
    // current iteration, so a rule's verdict is provably iteration-invariant. loops.test.ts asserts
    // that invariant against the real Expr union so adding such a node breaks a test rather than
    // silently invalidating this.
    const { survey, q1 } = loopedScene(2);
    const result = compile(survey);
    if (!result.ok) throw new Error('compile failed');

    for (const p of Object.values(result.bundle.artifact.pages)) {
      if (p.iteration === undefined) continue;
      expect(p.questions[0]?.id).toBe(q1.node.id);
    }
  });

  it('adds NOTHING to a survey with no loops', () => {
    // These bytes are in the artifact hash, so a survey without loops must compile identically to
    // before this feature: no page_authored key, no iteration field.
    const ids = deterministicIds(7);
    const asked = ask(ids, 'Q1');
    const blockId = ids.next('block');
    const start = ids.next('flow_node');
    const seq = ids.next('flow_node');
    const end = ids.next('flow_node');
    const survey = makeSurvey(ids, {
      content: [{ id: blockId, type: 'block', ref: 'B1', children: [page(ids, 'P1', [asked.node])] }],
      languages: bundleOf(LABELS),
      variables: [asked.variable],
      nodes: [
        { id: start, type: 'start', next: seq },
        { id: seq, type: 'sequence', target_id: blockId, next: end },
        { id: end, type: 'end', disposition: 'COMPLETE' },
      ] as never,
    });
    const result = compile(survey);
    if (!result.ok) throw new Error('compile failed');

    expect(result.bundle.artifact.graph.page_authored).toBeUndefined();
    for (const p of Object.values(result.bundle.artifact.pages)) {
      expect(p.iteration).toBeUndefined();
      expect(p.authored_id).toBeUndefined();
    }
  });

  it('is deterministic: two compiles of the same looped survey agree byte for byte', () => {
    // Per-iteration ids are DERIVED, never minted — a fresh ULID per compile would change
    // graph.json, change the artifact hash, and destroy the property this codebase is judged on.
    const a = compile(loopedScene(3).survey);
    const b = compile(loopedScene(3).survey);
    if (!a.ok || !b.ok) throw new Error('compile failed');
    expect(a.bundle.hash).toBe(b.bundle.hash);
  });

  it('changes the artifact when the iteration count changes', () => {
    const a = compile(loopedScene(2).survey);
    const b = compile(loopedScene(3).survey);
    if (!a.ok || !b.ok) throw new Error('compile failed');
    expect(a.bundle.hash).not.toBe(b.bundle.hash);
  });
});


/* -------------------------------------------------------------------------- */
/* A randomizer's pages carry their target (P2-03)                            */
/* -------------------------------------------------------------------------- */

describe('page_group connects the compiler to the machine randomizer', () => {
  it('maps every page a randomizer owns to the target it came from', () => {
    // Without this the machine cannot permute at block granularity: `page_entry` says a randomizer
    // owns a page and nothing says WHICH target it came from, so the only available permutation
    // would shuffle pages across blocks. Emitted here and consumed by `randomizerPages`.
    const ids = deterministicIds(3131);
    const qa = ask(ids, 'QA');
    const qb = ask(ids, 'QB');

    const pageA1 = page(ids, 'A1', [qa.node]);
    const pageA2 = page(ids, 'A2', []);
    const pageB1 = page(ids, 'B1', [qb.node]);
    const blockA = { id: ids.next('block'), type: 'block' as const, ref: 'BA', children: [pageA1, pageA2] };
    const blockB = { id: ids.next('block'), type: 'block' as const, ref: 'BB', children: [pageB1] };

    const start = ids.next('flow_node');
    const rand = ids.next('flow_node');
    const end = ids.next('flow_node');

    const survey = makeSurvey(ids, {
      content: [blockA, blockB] as never,
      languages: bundleOf({ 'QA.label': 'a?', 'QB.label': 'b?' }),
      variables: [qa.variable, qb.variable],
      nodes: [
        { id: start, type: 'start', next: rand },
        {
          id: rand,
          type: 'randomizer',
          targets: [blockA.id, blockB.id],
          mode: 'shuffle',
          next: end,
        },
        { id: end, type: 'end', disposition: 'COMPLETE' },
      ] as never,
    });

    const result = compile(survey);
    if (!result.ok) throw new Error(`compile failed: ${JSON.stringify(codes(result))}`);

    const group = result.bundle.artifact.graph.page_group ?? {};
    expect(group[pageA1.id]).toBe(blockA.id);
    expect(group[pageA2.id]).toBe(blockA.id);
    expect(group[pageB1.id]).toBe(blockB.id);
    // And all three pages belong to the randomizer, which is what made them unreachable before.
    const entry = result.bundle.artifact.graph.page_entry;
    expect(entry[pageA1.id]).toBe(rand);
    expect(entry[pageB1.id]).toBe(rand);
  });

  it('adds nothing for a survey with no randomizer', () => {
    // The field is in the artifact hash, so a survey without one must compile identically.
    const ids = deterministicIds(11);
    const asked = ask(ids, 'Q1');
    const blockId = ids.next('block');
    const start = ids.next('flow_node');
    const seq = ids.next('flow_node');
    const end = ids.next('flow_node');
    const survey = makeSurvey(ids, {
      content: [{ id: blockId, type: 'block', ref: 'B1', children: [page(ids, 'P1', [asked.node])] }],
      languages: bundleOf(LABELS),
      variables: [asked.variable],
      nodes: [
        { id: start, type: 'start', next: seq },
        { id: seq, type: 'sequence', target_id: blockId, next: end },
        { id: end, type: 'end', disposition: 'COMPLETE' },
      ] as never,
    });
    const result = compile(survey);
    if (!result.ok) throw new Error('compile failed');
    expect(result.bundle.artifact.graph.page_group).toBeUndefined();
  });
});


/* -------------------------------------------------------------------------- */
/* Author CSS reaches the artifact, and only if it passes (P2-12)             */
/* -------------------------------------------------------------------------- */

describe('author stylesheets', () => {
  function withCss(sheets: { ref: string; source: string }[]) {
    const ids = deterministicIds(5150);
    const asked = ask(ids, 'Q1');
    const blockId = ids.next('block');
    const start = ids.next('flow_node');
    const seq = ids.next('flow_node');
    const end = ids.next('flow_node');
    const base = makeSurvey(ids, {
      content: [{ id: blockId, type: 'block', ref: 'B1', children: [page(ids, 'P1', [asked.node])] }],
      languages: bundleOf(LABELS),
      variables: [asked.variable],
      nodes: [
        { id: start, type: 'start', next: seq },
        { id: seq, type: 'sequence', target_id: blockId, next: end },
        { id: end, type: 'end', disposition: 'COMPLETE' },
      ] as never,
    });
    return {
      ...base,
      assets: {
        css: sheets.map((sheet, i) => ({
          id: `ast_0C${String(i)}${'0'.repeat(23)}`,
          ref: sheet.ref,
          source: sheet.source,
          scope: 'survey',
        })),
      },
    } as unknown as Survey;
  }

  it('emits author.css as its OWN file, not appended to theme.css', () => {
    // Separate on purpose: the two have different provenance and different trust, the served <link>
    // order states the cascade explicitly, and the theme's own rules — the .rs-target contract —
    // stay identifiable as ours.
    const result = compile(withCss([{ ref: 'MAIN', source: 'body{color:#111}' }]));
    if (!result.ok) throw new Error(`compile failed: ${JSON.stringify(codes(result))}`);

    const paths = result.bundle.files.map((f) => f.path);
    expect(paths).toContain('author.css');
    expect(paths).toContain('theme.css');
    const theme = result.bundle.files.find((f) => f.path === 'theme.css');
    expect(theme?.bytes).not.toContain('#111');
  });

  it('concatenates sheets in REF order, labelled', () => {
    // Ref order and not row order, so the cascade does not depend on how the database returned them.
    // Labelled so a browser's dev tools name the file an author has to open.
    const result = compile(
      withCss([
        { ref: 'ZED', source: '.z{color:red}' },
        { ref: 'ALPHA', source: '.a{color:blue}' },
      ]),
    );
    if (!result.ok) throw new Error('compile failed');

    const css = result.bundle.files.find((f) => f.path === 'author.css')?.bytes ?? '';
    expect(css.indexOf('/* ALPHA */')).toBeLessThan(css.indexOf('/* ZED */'));
  });

  it('emits NO author.css for a survey with none', () => {
    const result = compile(withCss([]));
    if (!result.ok) throw new Error('compile failed');
    expect(result.bundle.files.map((f) => f.path)).not.toContain('author.css');
  });

  it('REFUSES to publish CSS the sanitizer rejects, so nothing unsafe is emitted', () => {
    // The gate that makes emitting author CSS safe at all. A remote url() is an HTTP request, and
    // with attribute selectors it reads values out of the page one character at a time — so this is
    // a publish error rather than a file that ships.
    const result = compile(withCss([{ ref: 'EVIL', source: 'a{background:url(//evil.example/)}' }]));
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('CMP-0503');
  });

  it('refuses a stylesheet that targets the reserved rs- prefix', () => {
    // Author CSS loads AFTER the theme, so this rule is what stops it shrinking the 44px touch
    // target the theme defines. The cascade lets an author override colours; it does not let them
    // override the accessibility floor.
    const result = compile(withCss([{ ref: 'SHRINK', source: '.rs-target{min-height:1px}' }]));
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('CMP-0503');
  });

  it('changes the artifact hash when author CSS changes', () => {
    const a = compile(withCss([{ ref: 'M', source: 'body{color:#111}' }]));
    const b = compile(withCss([{ ref: 'M', source: 'body{color:#222}' }]));
    if (!a.ok || !b.ok) throw new Error('compile failed');
    expect(a.bundle.hash).not.toBe(b.bundle.hash);
  });
});
