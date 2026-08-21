/**
 * What `buildRegistryInput` must get right, one test per property another pass depends on.
 *
 * Everything here is asserted against a survey built by `applyVariableRegistry` rather than
 * against hand-written `Variable` rows. That is the point of the fixtures: the adapter's job is
 * to translate whatever `buildVariableRegistry` produced, so a fixture that hand-wrote the
 * variables would test the adapter against this file's idea of the model instead of against
 * schema's. Diagnostics are asserted by code and `detail`, never by message prose.
 *
 * The `groupItems` exercises are here and not in `packages/logic` for a specific reason: what
 * `buildTypeEnv` needs from a registry is stated only in its own implementation (`set_view` is
 * filtered out of a `question_emits` group, an `options` group's items must carry a domain), and
 * an adapter that satisfies the *types* while breaking those invariants compiles clean and
 * miscounts every multi-select.
 */

import { describe, expect, it } from 'vitest';
import {
  applyVariableRegistry,
  mapContent,
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
  asQuestionId,
  asVariableId,
  buildTypeEnv,
  type Group,
  type QuestionId,
  type VarDecl,
} from '@resscript/logic';
import {
  createRegistry,
  FIRST_PARTY_CORES,
  type AnyPluginCore,
  type PluginRegistry,
} from '@resscript/question-kit';
import { deterministicIds, makeMiniSurvey } from '../../schema/src/__fixtures__/mini.js';

import { buildRegistryInput, buildTypeEnvFor, ORDERED_SCALE_QUESTION_TYPES } from './registry.js';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A survey whose content is exactly the given questions.
 *
 * `makeMiniSurvey` supplies the parts this module never reads — settings, languages, the
 * disposition shape — and everything it *does* read is replaced: one block, one page, the
 * questions, and a registry rebuilt by `applyVariableRegistry` so the variables are the ones
 * schema would have written. The flow is rewritten to point at the new block so the fixture stays
 * a coherent survey rather than one with a dangling `target_id`; no assertion here reads it.
 */
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
  // `position` is written 1-based on purpose: it is what `packages/schema`'s own fixtures do
  // (`mini.ts`), and the 0-vs-1 disagreement with `ItemDecl.position` is asserted below.
  return { id: ids.next('option'), ref, code, label: { key: labelKey }, position: code };
}

const MULTI_SELECT_CONFIG: JsonObject = {
  display: 'vertical',
  columns: 1,
  minSelected: 0,
  maxSelected: 0,
  other: { enabled: false, maxLen: 200, required: true },
};

function multiSelect(ids: IdFactory, ref = 'Q5'): QuestionNode {
  return {
    id: ids.next('question'),
    type: 'question',
    ref,
    question_type: 'multi_select',
    label: { key: `${ref}.label` },
    required: false,
    config: MULTI_SELECT_CONFIG,
    options: [
      item(ids, 'o1', 1, `${ref}.o1`),
      item(ids, 'o2', 2, `${ref}.o2`),
      item(ids, 'o3', 3, `${ref}.o3`),
    ],
  };
}

function nps(ids: IdFactory, ref = 'Q7'): QuestionNode {
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

/** A mixed matrix: row 1 uses the shared column list, row 2 is numeric, row 3 is text. */
function mixedMatrix(ids: IdFactory, ref = 'Q9'): QuestionNode {
  return {
    id: ids.next('question'),
    type: 'question',
    ref,
    question_type: 'matrix_mixed',
    label: { key: `${ref}.label` },
    required: false,
    rows: [
      item(ids, 'r1', 1, `${ref}.r1`),
      item(ids, 'r2', 2, `${ref}.r2`),
      item(ids, 'r3', 3, `${ref}.r3`),
    ],
    columns: [
      item(ids, 'c1', 1, `${ref}.c1`),
      item(ids, 'c2', 2, `${ref}.c2`),
    ],
    cells: [
      { row_ref: 'r2', control: { question_type: 'numeric' } },
      { row_ref: 'r3', control: { question_type: 'open_text' } },
    ],
  };
}

/** Two single selects built from the same option template — the `CMP-0701` case. */
function brandList(ids: IdFactory, ref: string): QuestionNode {
  return {
    id: ids.next('question'),
    type: 'question',
    ref,
    question_type: 'single_select',
    label: { key: `${ref}.label` },
    required: false,
    options: [
      { id: ids.next('option'), ref: 'o1', code: 1, label: { key: 'brand.a' }, position: 1 },
      { id: ids.next('option'), ref: 'o2', code: 2, label: { key: 'brand.b' }, position: 2 },
    ],
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

const domainOf = (question: QuestionNode): string => `dom_${question.id}`;

/* -------------------------------------------------------------------------- */
/* Variables                                                                   */
/* -------------------------------------------------------------------------- */

describe('a multi-select fan-out', () => {
  const ids = deterministicIds();
  const q = multiSelect(ids);
  const survey = surveyWith([q], { ids });
  const { input, diagnostics } = buildRegistryInput(survey);

  it('declares one boolean per option, carrying the item code and id', () => {
    for (const code of [1, 2, 3]) {
      const decl = byName(input.variables, `Q5r${code}`);
      expect(decl.kind).toBe('response');
      expect(decl.type).toBe('boolean');
      expect(decl.part).toBe('option');
      expect(decl.code).toBe(code);
      expect(decl.option_id).toBe(q.options?.[code - 1]?.id);
      expect(decl.question_id).toBe(q.id);
      // A boolean is not domained; a domain on it would make `Q5r1 == Q5r2` an enum comparison.
      expect(decl.domain).toBeUndefined();
    }
  });

  it('declares the set view as a derived set over the question\'s synthesized domain', () => {
    const view = byName(input.variables, 'Q5');
    expect(view.kind).toBe('derived');
    expect(view.type).toBe('set');
    expect(view.part).toBe('set_view');
    expect(view.domain).toBe(domainOf(q));
    expect(view.persist).toBe(false);
    // The property the whole of derive.ts exists for.
    expect(view.expression).toBeDefined();
  });

  it('carries an expression on exactly the derived variables', () => {
    for (const decl of input.variables) {
      expect(decl.expression !== undefined).toBe(decl.kind === 'derived');
    }
  });

  it('preserves registry order, which is the export column order', () => {
    expect(input.variables.map((v) => v.name)).toEqual(['Q5r1', 'Q5r2', 'Q5r3', 'Q5']);
  });

  it('builds one domain from the option list, nominal by default', () => {
    expect(input.domains).toHaveLength(1);
    expect(input.domains[0]).toEqual({
      id: asDomainId(domainOf(q)),
      entries: [
        { code: 1, label_key: 'Q5.o1' },
        { code: 2, label_key: 'Q5.o2' },
        { code: 3, label_key: 'Q5.o3' },
      ],
      // A brand list is not a scale: `Q5 > 2` must stay LGC-T009.
      ordinal: false,
    });
  });

  it('reports nothing', () => {
    expect(diagnostics).toEqual([]);
  });

  it('links each item declaration to the variable it emits, at a 0-based position', () => {
    const decl = input.questions?.[0];
    expect(decl?.id).toBe(q.id);
    expect(decl?.emits).toHaveLength(4);
    expect(decl?.domain).toBe(domainOf(q));
    expect(decl?.options.map((o) => o.position)).toEqual([0, 1, 2]);
    // The finding, pinned: schema's `QuestionItem.position` on these items is 1, 2, 3 — it is the
    // dense *display* position — while `ItemDecl.position` is documented 0-based and is passed
    // straight through to `item_attr position` by `groupItems`' `options` case. Reading the field
    // would make `item.position == 0` unsatisfiable for the first option of every survey.
    expect(q.options?.map((o) => o.position)).toEqual([1, 2, 3]);
    expect(decl?.options.map((o) => o.code)).toEqual([1, 2, 3]);
    expect(decl?.options.map((o) => o.ref)).toEqual(['o1', 'o2', 'o3']);
    expect(decl?.options.map((o) => o.variable_id)).toEqual([
      byName(input.variables, 'Q5r1').id,
      byName(input.variables, 'Q5r2').id,
      byName(input.variables, 'Q5r3').id,
    ]);
  });
});

describe('an NPS question', () => {
  const ids = deterministicIds();
  const q = nps(ids);
  const survey = surveyWith([q], { ids });
  const { input } = buildRegistryInput(survey);

  it('declares the score as a plain number with no domain', () => {
    const score = byName(input.variables, 'Q7');
    expect(score.kind).toBe('response');
    expect(score.type).toBe('number');
    expect(score.part).toBe('scalar');
    expect(score.domain).toBeUndefined();
  });

  it('declares the band as a derived enum over the canonical band domain', () => {
    const band = byName(input.variables, 'Q7_band');
    expect(band.kind).toBe('derived');
    expect(band.type).toBe('enum');
    expect(band.part).toBe('suffix');
    expect(band.domain).toBe(domainOf(q));
    expect(band.expression).toBeDefined();
    expect(input.domains[0]?.entries).toEqual(NPS_BAND_DOMAIN);
  });

  it('marks the domain ordinal from the allowlist when no registry is supplied', () => {
    expect(ORDERED_SCALE_QUESTION_TYPES).toContain('nps');
    expect(input.domains[0]?.ordinal).toBe(true);
  });

  it('marks the domain ordinal from the plugin category when one is', () => {
    const withPlugins = buildRegistryInput(survey, { plugins: firstPartyRegistry() });
    expect(withPlugins.input.domains[0]?.ordinal).toBe(true);
  });

  it('lets the plugin override the allowlist rather than the other way round', () => {
    // `multi_select` is `category: 'choice'`, and it is not in the allowlist either — the point
    // is that a resolved plugin answers, so adding a type to the allowlist cannot make a
    // plugin-declared brand list ordinal behind the plugin's back.
    const other = surveyWith([multiSelect(deterministicIds(7))]);
    const resolved = buildRegistryInput(other, { plugins: firstPartyRegistry() });
    expect(resolved.input.domains[0]?.ordinal).toBe(false);
  });
});

describe('a mixed matrix', () => {
  const ids = deterministicIds();
  const q = mixedMatrix(ids);
  const survey = surveyWith([q], { ids });
  const { input } = buildRegistryInput(survey);

  it('gives each row the type its own cell control implies', () => {
    expect(byName(input.variables, 'Q9r1').type).toBe('enum');
    expect(byName(input.variables, 'Q9r2').type).toBe('number');
    expect(byName(input.variables, 'Q9r3').type).toBe('text');
  });

  it('domains only the rows that are enums, from the shared column list', () => {
    expect(byName(input.variables, 'Q9r1').domain).toBe(domainOf(q));
    expect(byName(input.variables, 'Q9r2').domain).toBeUndefined();
    expect(byName(input.variables, 'Q9r3').domain).toBeUndefined();
    expect(input.domains[0]?.entries).toEqual([
      { code: 1, label_key: 'Q9.c1' },
      { code: 2, label_key: 'Q9.c2' },
    ]);
  });

  it('carries rows and columns as separate 0-based axes', () => {
    const decl = input.questions?.[0];
    expect(decl?.rows.map((r) => [r.ref, r.position, r.code])).toEqual([
      ['r1', 0, 1],
      ['r2', 1, 2],
      ['r3', 2, 3],
    ]);
    expect(decl?.columns.map((c) => [c.ref, c.position, c.code])).toEqual([
      ['c1', 0, 1],
      ['c2', 1, 2],
    ]);
    expect(decl?.options).toEqual([]);
    // A column emits no variable of its own in a row-oriented matrix.
    expect(decl?.columns.every((c) => c.variable_id === undefined)).toBe(true);
    expect(decl?.rows.map((r) => r.variable_id)).toEqual([
      byName(input.variables, 'Q9r1').id,
      byName(input.variables, 'Q9r2').id,
      byName(input.variables, 'Q9r3').id,
    ]);
  });

  it('marks a matrix domain nominal, because a column list is not declared ordered', () => {
    expect(input.domains[0]?.ordinal).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* The domain identity gap                                                     */
/* -------------------------------------------------------------------------- */

describe('two questions sharing an option list', () => {
  const ids = deterministicIds();
  const a = brandList(ids, 'Q1x');
  const b = brandList(ids, 'Q2x');
  const survey = surveyWith([a, b], { ids });
  const { input, diagnostics } = buildRegistryInput(survey);

  it('produces two domains and never merges them', () => {
    expect(input.domains.map((d) => d.id).sort()).toEqual(
      [domainOf(a), domainOf(b)].sort(),
    );
    // Merging would make `Q1x == Q2x` legal, which is exactly the copy-pasted-rule bug D §2.2's
    // nominal domains exist to catch. The false positive is the cheaper of the two errors.
    expect(input.domains[0]?.entries).toEqual(input.domains[1]?.entries);
  });

  it('reports CMP-0701 once, naming both domains and both questions', () => {
    const reported = diagnostics.filter((d) => d.code === 'CMP-0701');
    expect(reported).toHaveLength(1);
    expect(reported[0]?.severity).toBe('warning');
    expect(reported[0]?.detail?.['domain_ids']).toEqual(
      [domainOf(a), domainOf(b)].sort((x, y) => x.localeCompare(y)),
    );
    expect(reported[0]?.detail?.['question_ids']).toEqual(
      [domainOf(a), domainOf(b)]
        .sort((x, y) => x.localeCompare(y))
        .map((d) => d.slice('dom_'.length)),
    );
    expect(reported[0]?.detail?.['entries']).toEqual([
      { code: 1, label_key: 'brand.a' },
      { code: 2, label_key: 'brand.b' },
    ]);
  });

  it('says nothing when the two lists differ by one label key', () => {
    const ids2 = deterministicIds(99);
    const c = brandList(ids2, 'Q3x');
    const d: QuestionNode = {
      ...brandList(ids2, 'Q4x'),
      options: [
        { id: ids2.next('option'), ref: 'o1', code: 1, label: { key: 'brand.a' }, position: 1 },
        { id: ids2.next('option'), ref: 'o2', code: 2, label: { key: 'brand.z' }, position: 2 },
      ],
    };
    const built = buildRegistryInput(surveyWith([c, d], { ids: ids2 }));
    expect(built.diagnostics.filter((x) => x.code === 'CMP-0701')).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* The unusable derived variable                                               */
/* -------------------------------------------------------------------------- */

describe('a derived variable with nothing to compute it from', () => {
  it('is CMP-0103, an error, and leaves no expression behind', () => {
    const ids = deterministicIds();
    const base = surveyWith([multiSelect(ids)], { ids });
    const orphan: Variable = {
      id: ids.next('variable'),
      name: 'ORPHAN',
      kind: 'derived',
      type: 'number',
      export: { include: true, column: 'ORPHAN' },
      pii: false,
      persist: true,
    };
    const survey: Survey = { ...base, variables: [...base.variables, orphan] };
    const { input, diagnostics } = buildRegistryInput(survey);

    const reported = diagnostics.filter((d) => d.code === 'CMP-0103');
    expect(reported).toHaveLength(1);
    expect(reported[0]?.severity).toBe('error');
    expect(reported[0]?.detail?.['name']).toBe('ORPHAN');
    expect(reported[0]?.detail?.['part']).toBeNull();
    expect(byName(input.variables, 'ORPHAN').expression).toBeUndefined();
  });

  it('passes an authored expression through untouched', () => {
    const ids = deterministicIds();
    const base = surveyWith([multiSelect(ids)], { ids });
    const authored: Variable = {
      id: ids.next('variable'),
      name: 'SCORE',
      kind: 'derived',
      type: 'number',
      expression: { op: 'lit', v: { k: 'num', v: 3 }, n: 1 },
      export: { include: true, column: 'SCORE' },
      pii: false,
      persist: true,
    };
    const { input, diagnostics } = buildRegistryInput({
      ...base,
      variables: [...base.variables, authored],
    });
    expect(diagnostics).toEqual([]);
    expect(byName(input.variables, 'SCORE').expression).toEqual(authored.expression);
  });
});

/* -------------------------------------------------------------------------- */
/* Content                                                                     */
/* -------------------------------------------------------------------------- */

describe('the content projection', () => {
  it('carries page and block parenthood from the tree, not from a flat scan', () => {
    const ids = deterministicIds();
    const q = multiSelect(ids);
    const survey = surveyWith([q], { ids });
    const { input } = buildRegistryInput(survey);

    expect(input.blocks).toHaveLength(1);
    expect(input.pages).toHaveLength(1);
    const page = input.pages?.[0];
    const block = input.blocks?.[0];
    expect(page?.question_ids).toEqual([asQuestionId(q.id)]);
    expect(page?.block_id).toBe(block?.id);
    expect(block?.page_ids).toEqual([page?.id]);
    expect(input.questions?.[0]?.page_id).toBe(page?.id);
    expect(input.questions?.[0]?.required).toBe(false);
  });

  it('keeps questions in document order', () => {
    const ids = deterministicIds();
    const a = nps(ids, 'A1');
    const b = multiSelect(ids, 'B1');
    const survey = surveyWith([a, b], { ids });
    const { input } = buildRegistryInput(survey);
    expect(input.questions?.map((q) => q.ref)).toEqual(['A1', 'B1']);
  });

  it('rebuilds emits when the document does not carry them', () => {
    const ids = deterministicIds();
    const q = multiSelect(ids);
    const survey = surveyWith([q], { ids });
    // The key is *deleted*, not set to `undefined`: `exactOptionalPropertyTypes` makes those two
    // different documents, and only the deleted form is what a migrated older survey looks like.
    const stripped: Survey = {
      ...survey,
      content: mapContent(survey.content, (node) => {
        if (node.type !== 'question') return node;
        const { emits, ...withoutEmits } = node;
        void emits;
        return withoutEmits;
      }),
    };
    const { input } = buildRegistryInput(stripped);
    expect(input.questions?.[0]?.emits).toHaveLength(4);
  });
});

/* -------------------------------------------------------------------------- */
/* What buildTypeEnv expects of us                                             */
/* -------------------------------------------------------------------------- */

describe('the type environment built from this adapter', () => {
  const ids = deterministicIds();
  const ms = multiSelect(ids);
  const matrix = mixedMatrix(ids);
  const survey = surveyWith([ms, matrix], { ids });
  const { env, input } = buildTypeEnvFor(survey);
  const msId = asQuestionId(ms.id);
  const matrixId = asQuestionId(matrix.id);

  it('resolves every declaration by id, by name and by owner question', () => {
    for (const decl of input.variables) {
      expect(env.byId(decl.id)).toBe(decl);
      expect(env.byRef(decl.name)?.id).toBe(decl.id);
    }
    expect(env.ownerQuestion(byName(input.variables, 'Q5r1').id)?.id).toBe(msId);
  });

  it('types the set view as set<domain> and a fan-out member as bool', () => {
    expect(env.typeOf(byName(input.variables, 'Q5'))).toEqual({
      k: 'set',
      d: asDomainId(domainOf(ms)),
    });
    expect(env.typeOf(byName(input.variables, 'Q5r1'))).toEqual({ k: 'bool' });
  });

  it('excludes the set view from a question_emits group', () => {
    const group: Group = { kind: 'question_emits', question_id: msId };
    const items = env.groupItems(group);
    expect(items).toHaveLength(3);
    expect(items.map((i) => i.code)).toEqual([1, 2, 3]);
    expect(items.map((i) => i.position)).toEqual([0, 1, 2]);
    // The set view's own variable must not be a member: it would be a fourth item and every
    // COUNT over a multi-select would be off by one.
    expect(items.map((i) => i.variable_id)).not.toContain(byName(input.variables, 'Q5').id);
  });

  it('gives an options group properly domained items with labels', () => {
    const items = env.groupItems({ kind: 'options', question_id: msId });
    expect(items).toHaveLength(3);
    for (const item_ of items) {
      expect(item_.domain).toBe(domainOf(ms));
    }
    expect(items.map((i) => i.label_key)).toEqual(['Q5.o1', 'Q5.o2', 'Q5.o3']);
    expect(items.map((i) => i.position)).toEqual([0, 1, 2]);
  });

  it('resolves matrix_rows and matrix_cols over the row and column axes', () => {
    const rows = env.groupItems({ kind: 'matrix_rows', question_id: matrixId });
    expect(rows.map((r) => r.code)).toEqual([1, 2, 3]);
    expect(rows.map((r) => r.label_key)).toEqual(['Q9.r1', 'Q9.r2', 'Q9.r3']);
    // A row-oriented matrix emits no `column` parts, so the column axis has no members. Asserted
    // rather than assumed: `groupItems` returns `[]` here and an `agg` over it is LGC-T018.
    expect(env.groupItems({ kind: 'matrix_cols', question_id: matrixId })).toEqual([]);
  });

  it('resolves an explicit group in the order it was given', () => {
    const ordered = ['Q5r3', 'Q5r1'].map((name) => byName(input.variables, name).id);
    const items = env.groupItems({ kind: 'explicit', variable_ids: ordered });
    expect(items.map((i) => i.code)).toEqual([3, 1]);
  });

  it('unrolls a looped question into per-iteration members', () => {
    const loopIds = deterministicIds(4242);
    const looped = multiSelect(loopIds, 'L1');
    const loopSurvey = surveyWith([looped], { ids: loopIds, loop: true });
    const built = buildTypeEnvFor(loopSurvey);
    const questionId: QuestionId = asQuestionId(looped.id);
    const items = built.env.groupItems({
      kind: 'loop_iterations',
      question_id: questionId,
      loop_id: questionId,
    });
    // Two iterations x (three options + one set view); the set view is not filtered out of a
    // loop_iterations group, which is `packages/logic`'s choice and is asserted so a change there
    // shows up here rather than in a client's tab.
    expect(items).toHaveLength(8);
    expect(built.input.variables.map((v) => v.name)).toContain('L1r1_2');
    expect(byName(built.input.variables, 'L1r1_2').iteration).toBe(2);
  });
});

describe('the mini survey', () => {
  it('translates the fixture every schema diagnostic test is built on, cleanly', () => {
    const { input, diagnostics } = buildRegistryInput(makeMiniSurvey());
    expect(diagnostics).toEqual([]);
    // `Q1` single select -> enum with a domain; `Q2` numeric -> number with none.
    expect(byName(input.variables, 'Q1').type).toBe('enum');
    expect(byName(input.variables, 'Q1').domain).toBeDefined();
    expect(byName(input.variables, 'Q2').type).toBe('number');
    expect(byName(input.variables, 'Q2').domain).toBeUndefined();
    // Ids survive the brand round trip unchanged; the brand is a type-level fiction.
    for (const decl of input.variables) {
      expect(decl.id).toBe(asVariableId(decl.id));
    }
    expect(buildTypeEnv(input).variables()).toHaveLength(input.variables.length);
  });
});
