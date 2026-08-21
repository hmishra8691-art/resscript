/**
 * What the logic serialization must get right, and the one test that proves it.
 *
 * **The round trip is the specification.** `CompiledLogic` is not JSON — typed arrays, maps, and
 * five closures — and every index in it is positional, so a serializer that loses one entry does
 * not produce a broken artifact, it produces a *plausible* artifact in which rules evaluate in a
 * different order than the one that was reviewed. Nothing downstream can catch that: the runtime
 * is P1-09 and would happily evaluate the wrong order. So the test goes through
 * `stableStringify` → `JSON.parse` → `rehydrate` and compares `cells`, `topo`, `dependents`,
 * `writers` and `triggers` against the originals. The JSON hop is not ceremony — it is what makes
 * the assertion about *bytes* rather than about object identity, and it is where a `Map` that
 * serialized to `{}` or an `Int32Array` that serialized to `{"0":3}` would be caught.
 *
 * The sparse encodings are asserted in both directions for the same reason: an omitted default is
 * only correct if the read side restores it, so `rehydrate`'s `baseVisible` / `baseItems` /
 * `baseOption` are compared against `CompiledLogic`'s closures over the whole key space rather than
 * against the emitted records.
 *
 * `nodes[i].n === i` is asserted because every other index in the structure is stated relative to
 * it — `derived` maps a cell index to a *node* index, and a `nodes` array that had been filtered or
 * reordered would make that mapping silently point at another expression.
 */

import { describe, expect, it } from 'vitest';
// `rehydrate` and its helpers live in `packages/runtime-core` now: the deserializer belongs to the
// reader, and keeping it here would force runtime-core to import this package (and with it the
// solver and node:crypto) in order to evaluate logic. Imported as a dev dependency so losslessness
// stays asserted against the serializer it has to keep in step with.
import { cellsWrittenBy, rehydrate, toCompiledLogic } from '@resscript/runtime-core';
import { evaluate, varStateOf } from '@resscript/logic';
import {
  BASE_OPTION_DEFAULT,
  BASE_VISIBLE_DEFAULT,
  stableStringify,
  type ArtifactLogic,
} from '@resscript/schema';
import {
  asQuestionId,
  cellKey,
  itemsKey,
  optionKey,
  writesOf,
  type MaskAxis,
  type OptProp,
} from '@resscript/logic';

import { compileFixture, type Fixture } from './__fixtures__/artifact.js';
import {
  MASK_AXES,
  OPT_PROPS,
  buildArtifactLogic,
  compiledRuleOf,
} from './logic.js';

/** The artifact as it would come back off disk: canonical bytes, parsed. */
function throughJson(logic: ArtifactLogic): ArtifactLogic {
  return JSON.parse(stableStringify(logic)) as ArtifactLogic;
}

describe('buildArtifactLogic', () => {
  it('keeps cells in compileLogic order, with the key and the tagged union both', () => {
    const { artifactLogic, logic } = compileFixture();

    expect(artifactLogic.cells.map((cell) => cell.key)).toEqual([...logic.cellKeys]);
    expect(artifactLogic.cells.map((cell) => cell.kind)).toEqual(logic.cells.map((cell) => cell.c));
    artifactLogic.cells.forEach((entry, index) => {
      expect(entry.cell).toEqual(logic.cells[index]);
      // The key is recoverable from the union, which is what lets the runtime rehydrate without
      // parsing strings — and what makes the two fields checkable against each other.
      expect(cellKey(logic.cells[index] ?? { c: 'flow', node_id: '' as never })).toBe(entry.key);
    });
  });

  it('turns every typed array into a plain number array of the same length', () => {
    const { artifactLogic, logic } = compileFixture();

    expect(artifactLogic.topo).toEqual([...logic.topo]);
    expect(artifactLogic.topo_pos).toEqual([...logic.topoPos]);
    expect(artifactLogic.dependents).toHaveLength(logic.dependents.length);
    expect(artifactLogic.writers).toHaveLength(logic.writers.length);
    expect(artifactLogic.inputs).toHaveLength(logic.graph.inputs.length);
    expect(Array.isArray(artifactLogic.topo)).toBe(true);
  });

  it('keys by_trigger_variable by variable id and valid_by_target by target', () => {
    const { artifactLogic, logic, ids } = compileFixture();

    expect(Object.keys(artifactLogic.by_trigger_variable)).toEqual(
      [...logic.triggers.keys()].sort(),
    );
    expect(artifactLogic.by_trigger_variable[ids.q1Variable]).toEqual([
      ...(logic.triggers.get(ids.q1Variable as never) ?? []),
    ]);
    expect(Object.keys(artifactLogic.valid_by_target)).toEqual([...logic.validCells.keys()].sort());
  });

  it('emits nodes densely, with nodes[i].n === i', () => {
    const { artifactLogic } = compileFixture();

    expect(artifactLogic.nodes.length).toBeGreaterThan(0);
    artifactLogic.nodes.forEach((node, index) => {
      expect(node['n']).toBe(index);
    });
  });

  it('maps a derived cell index to an index into nodes, not to an inlined expression', () => {
    const { artifactLogic, logic } = compileFixture();

    const entries = Object.entries(artifactLogic.derived);
    expect(entries.length).toBeGreaterThan(0);
    for (const [cellIndex, nodeIndex] of entries) {
      expect(artifactLogic.nodes[nodeIndex]).toBeDefined();
      expect(artifactLogic.nodes[nodeIndex]).toEqual(logic.derived.get(Number(cellIndex)));
    }
  });

  it('inlines a rule condition, so a rule is readable without carrying nodes', () => {
    const { artifactLogic, logic } = compileFixture();

    expect(artifactLogic.rules).toEqual(logic.rules.map(compiledRuleOf));
    for (const rule of artifactLogic.rules) {
      expect(typeof rule.condition['op']).toBe('string');
    }
  });

  it('omits target_id for a survey-scoped rule rather than emitting null', () => {
    const rule = compiledRuleOf({
      id: 'rul_x' as never,
      kind: 'validate',
      target: { type: 'survey' },
      condition: { op: 'lit', n: 1, v: { k: 'bool', b: true } } as never,
      effect: { action: 'require_valid', message_key: '', scope: 'page' },
      evaluation: 'on_change',
      authored_in: 'visual',
      order_key: 0,
    });

    expect(Object.keys(rule)).not.toContain('target_id');
  });
});

describe('rules survive the trip in executable form', () => {
  /**
   * WHY THIS EXISTS. `compiledRuleOf` used to emit only `id`, `kind`, `condition`, `effect` and
   * `target_id`, dropping `target.type`, `evaluation`, `authored_in`, `order_key`, `on_unknown`,
   * `priority_group`, `flow_node_id` and `label`. Every existing round-trip assertion passed,
   * because they compared `cells`, `topo`, `dependents`, `writers` and `triggers` — the cell graph —
   * and never the rules.
   *
   * The consequence was that `evaluate()` could not be called on a rehydrated artifact at all:
   * `packages/logic`'s `Rule` needs those four required fields and `CompiledRule` had none of them.
   * C §17 claims "the artifact is self-contained: given it and a session's variable state, the next
   * page is computable with no database read except the session itself", and it was not.
   *
   * So the assertion here is per-field equality over every rule, not a spot check: a field added to
   * `Rule` and forgotten in `compiledRuleOf` fails this test rather than shipping a rule the runtime
   * evaluates differently from the one that was reviewed.
   */
  it('every field of every rule survives, per field', () => {
    const { artifactLogic, logic } = compileFixture();
    const back = rehydrate(throughJson(artifactLogic));

    expect(back.rules).toHaveLength(logic.rules.length);
    expect(back.rules).toEqual(logic.rules);
  });

  it('carries the four fields whose absence made rules unevaluable', () => {
    // Named individually so a regression says which one went missing.
    const { artifactLogic, logic } = compileFixture();
    const emitted = artifactLogic.rules;

    expect(emitted.length).toBeGreaterThan(0);
    emitted.forEach((rule, i) => {
      const original = logic.rules[i];
      expect(rule.target_type).toBe(original?.target.type);
      expect(rule.evaluation).toBe(original?.evaluation);
      expect(rule.authored_in).toBe(original?.authored_in);
      expect(rule.order_key).toBe(original?.order_key);
    });
  });

  it('reconstructs the Target arm, which writesOf switches on', () => {
    // `target_id` alone cannot say whether a target is a question, a page or a variable, and
    // `writesOf` picks the cell a rule writes from exactly that.
    const { artifactLogic, logic } = compileFixture();
    const back = rehydrate(throughJson(artifactLogic));

    back.rules.forEach((rule, i) => {
      expect(rule.target).toEqual(logic.rules[i]?.target);
    });
  });

  it('omits an absent optional rather than writing null', () => {
    // An absent optional and one set to `undefined` are different types under
    // `exactOptionalPropertyTypes`, and only the absent form round-trips through JSON unchanged.
    const { artifactLogic } = compileFixture();
    const bytes = stableStringify(artifactLogic);

    for (const rule of artifactLogic.rules) {
      if (rule.on_unknown === undefined) expect('on_unknown' in rule).toBe(false);
      if (rule.priority_group === undefined) expect('priority_group' in rule).toBe(false);
      if (rule.label === undefined) expect('label' in rule).toBe(false);
    }
    expect(bytes).not.toContain('"on_unknown":null');
    expect(bytes).not.toContain('"label":null');
  });

  it('a survey-scoped rule carries no target_id', () => {
    const surveyScoped = compiledRuleOf({
      id: 'rul_x' as never,
      kind: 'display' as never,
      target: { type: 'survey' },
      condition: { n: 0, k: 'lit', t: 'bool', v: true } as never,
      effect: { action: 'show' } as never,
      evaluation: 'on_entry' as never,
      authored_in: 'dsl',
      order_key: 7,
    });

    expect(surveyScoped.target_type).toBe('survey');
    expect('target_id' in surveyScoped).toBe(false);
  });

  it('the emitted rules stay in canonical order', () => {
    // Every index in the structure is positional and fixed by this order (ArtifactLogic's header).
    const { artifactLogic } = compileFixture();
    const keys = artifactLogic.rules.map((r) => r.order_key);

    expect([...keys].sort((a, b) => a - b)).toEqual(keys);
  });
});

describe('the logic schema section', () => {
  /**
   * WHY THIS EXISTS. `packages/logic`'s `EvalSchema` is a set of closures over the authoring type
   * environment, and ADR-001 forbids the runtime from reading authoring tables. Without this section
   * the runtime could not build one, so `evaluate()` could not be called — the second half of the
   * same gap that made the serialized rules unevaluable.
   *
   * Every map is cross-page on purpose: a rule on page 5 can ask `SHOWN(Q2r3)` or `ASKED(Q2)`, so
   * the answer is not in the page being rendered. Deriving them from compiled pages would mean
   * reading all of them, which is the per-page cost C §17 forbids.
   */
  it('maps each question to the variables it emits', () => {
    const { artifactLogic, ids } = compileFixture();
    const schema = artifactLogic.schema;

    expect(schema).toBeDefined();
    // Q5 is the multi-select, so it fans out to one variable per option plus the parent.
    expect(schema?.question_variables[ids.q5]?.length).toBeGreaterThan(1);
    expect(schema?.question_variables[ids.q1]).toBeDefined();
  });

  it('maps each page to its questions in document order', () => {
    const { artifactLogic, ids } = compileFixture();

    expect(artifactLogic.schema?.page_questions[ids.page1]).toEqual([ids.q1, ids.q5]);
  });

  it('maps a question to its page', () => {
    const { artifactLogic, ids } = compileFixture();
    const pageOf = artifactLogic.schema?.page_of;

    expect(pageOf?.[ids.q1]).toBe(ids.page1);
    expect(pageOf?.[ids.q5]).toBe(ids.page1);
    expect(pageOf?.[ids.q7]).toBe(ids.page2);
  });

  it('maps a domain code to its label key, for label_of', () => {
    const { artifactLogic, ids } = compileFixture();
    const keys = artifactLogic.schema?.label_keys[`dom_${ids.q1}`];

    expect(keys?.['1']).toBe('q1.o1');
    expect(keys?.['2']).toBe('q1.o2');
  });

  it('emits keys in code-point order, so bytes and memory agree', () => {
    // The same argument as `sortedRecord`: this record is also the in-memory `artifact.logic`, and
    // an insertion-ordered object there would make an in-memory comparison disagree with a byte one.
    const { artifactLogic } = compileFixture();
    const schema = artifactLogic.schema;

    for (const map of [schema?.question_variables, schema?.page_questions, schema?.page_of]) {
      const keys = Object.keys(map ?? {});
      expect([...keys].sort()).toEqual(keys);
    }
  });

  it('survives the JSON round trip as a usable EvalSchema', () => {
    const { artifactLogic, ids } = compileFixture();
    const back = rehydrate(throughJson(artifactLogic));

    expect(back.schema.pageOf(ids.q1)).toBe(ids.page1);
    expect(back.schema.pageQuestions(ids.page1 as never)).toEqual([ids.q1, ids.q5]);
    expect(back.schema.questionVariables(ids.q1 as never).length).toBeGreaterThan(0);
    expect(back.schema.labelKey(`dom_${ids.q1}` as never, 1)).toBe('q1.o1');
  });

  it('inverts question_variables to answer ownerQuestion', () => {
    // Inverted rather than emitted as a second map, so the two cannot disagree: a variable listed
    // under two questions would be a contradiction the artifact could otherwise carry.
    const { artifactLogic, ids } = compileFixture();
    const back = rehydrate(throughJson(artifactLogic));
    const emitted = artifactLogic.schema?.question_variables[ids.q5] ?? [];

    expect(emitted.length).toBeGreaterThan(0);
    for (const variableId of emitted) {
      expect(back.schema.ownerQuestion(variableId as never)).toBe(ids.q5);
    }
  });

  it('declaredVisible agrees with baseVisible, from the one record', () => {
    // Two closures over `base_visible` rather than two records: a disagreement between "visible by
    // default" and "declared visible" is not a distinction the model has.
    const { artifactLogic, ids } = compileFixture();
    const back = rehydrate(throughJson(artifactLogic));

    expect(back.schema.declaredVisible(ids.q7)).toBe(back.baseVisible(ids.q7));
    expect(back.schema.declaredVisible(ids.q1)).toBe(back.baseVisible(ids.q1));
  });

  it('falls back to EMPTY_SCHEMA when the section is absent', () => {
    // An artifact compiled before the section existed. Every probe answers "nothing", which makes a
    // page-scoped condition evaluate as if the survey had no structure — so this is a republish
    // path, not a supported mode. Asserted so the behaviour is deliberate rather than a crash.
    const { artifactLogic } = compileFixture();
    const { schema: _dropped, ...withoutSchema } = throughJson(artifactLogic);
    const back = rehydrate(withoutSchema as typeof artifactLogic);

    expect(back.schema.pageQuestions('pg_whatever' as never)).toEqual([]);
    expect(back.schema.ownerQuestion('var_whatever' as never)).toBeUndefined();
  });

  it('omits a block that spans more than one page', () => {
    // `pageOf` returning the wrong page would make `ASKED(block)` answer about a page the respondent
    // may not have reached, so a multi-page block is absent rather than pointing at one of them.
    const { artifactLogic, ids } = compileFixture();
    const schema = artifactLogic.schema;

    // Established rather than assumed: the fixture's block really does contain both pages, so the
    // absence below is the rule firing and not an empty map.
    expect(Object.keys(schema?.page_questions ?? {}).sort()).toEqual([ids.page1, ids.page2].sort());
    expect(schema?.page_of[ids.block]).toBeUndefined();
    // And the questions inside it are still mapped, so nothing was dropped wholesale.
    expect(schema?.page_of[ids.q1]).toBe(ids.page1);
    expect(schema?.page_of[ids.q7]).toBe(ids.page2);
  });
});

describe('a rehydrated artifact is runnable', () => {
  /**
   * THE ASSERTION THE ROUND-TRIP TESTS COULD NOT MAKE.
   *
   * Everything above compares an artifact against the `CompiledLogic` it came from, field by field.
   * That is necessary and it is not sufficient: every one of those assertions passed while the
   * serialized rules were missing `target`, `evaluation`, `authored_in` and `order_key`, and while
   * there was no type environment at all — because the comparisons were against the *artifact* side
   * of each field, not against what the evaluator needs.
   *
   * C §17 claims the artifact is self-contained: "given it and a session's variable state, the next
   * page is computable with no database read except the session itself." This is that claim, run.
   * The only way it can pass is if the bytes really do carry an executable program.
   */
  function runFromArtifact() {
    const { artifactLogic } = compileFixture();
    const back = rehydrate(throughJson(artifactLogic));
    // `maskItems` is the one view the artifact cannot carry — it is scoped to the question being
    // rendered — so the caller supplies it. Empty here because this fixture has no per-item mask
    // condition; a real render passes the compiled page's items.
    const program = toCompiledLogic(back, () => []);
    return evaluate(program, varStateOf({}), {
      now: new Date('2026-01-01T00:00:00.000Z').toISOString(),
    } as never);
  }

  it('evaluate() runs on bytes that made the whole round trip', () => {
    const verdict = runFromArtifact();

    // One entry per cell: the program was walked, not skipped.
    expect(verdict.cells.length).toBeGreaterThan(0);
    expect(verdict.trace).toHaveLength(verdict.cells.length);
  });

  it('produces a verdict the renderer can read', () => {
    // These four are exactly the hooks `renderPage` takes, so this is the shape of the seam.
    const verdict = runFromArtifact();

    expect(typeof verdict.visible).toBe('function');
    expect(typeof verdict.items).toBe('function');
    expect(typeof verdict.option).toBe('function');
    expect(typeof verdict.value).toBe('function');
  });

  it('answers a visibility probe consistently with base_visible', () => {
    const { artifactLogic, ids } = compileFixture();
    const back = rehydrate(throughJson(artifactLogic));
    const verdict = evaluate(toCompiledLogic(back, () => []), varStateOf({}), {
      now: new Date('2026-01-01T00:00:00.000Z').toISOString(),
    } as never);

    // Q7 is declared hidden in the fixture (`declaredVisible: { [ids.q7]: false }`), and with no
    // answers no rule fires to reveal it. A verdict disagreeing with `base_visible` here would mean
    // the sparse default was lost on the read side.
    expect(verdict.visible(ids.q7)).toBe(back.baseVisible(ids.q7));
  });

  it('is deterministic across two independent rehydrations', () => {
    // Two respondents on one artifact must evaluate rules in the same order — the property
    // ArtifactLogic's positional indices exist to pin.
    const a = runFromArtifact();
    const b = runFromArtifact();

    expect(a.cells).toEqual(b.cells);
    expect(a.trace.map((t) => t.cell)).toEqual(b.trace.map((t) => t.cell));
  });

  it('derives nodeCount from the dense nodes array rather than trusting a copy', () => {
    const { artifactLogic, logic } = compileFixture();
    const program = toCompiledLogic(rehydrate(throughJson(artifactLogic)), () => []);

    expect(program.nodeCount).toBe(logic.nodeCount);
  });

  it('inverts the four cell-index maps from `cells`', () => {
    // Shipped nowhere: `cells` already carries the tagged union, and a second copy could disagree.
    const { artifactLogic, logic } = compileFixture();
    const program = toCompiledLogic(rehydrate(throughJson(artifactLogic)), () => []);

    expect([...program.valueCell.entries()].sort()).toEqual([...logic.valueCell.entries()].sort());
    expect([...program.visibleCell.entries()].sort()).toEqual(
      [...logic.visibleCell.entries()].sort(),
    );
    expect([...program.itemsCell.entries()].sort()).toEqual([...logic.itemsCell.entries()].sort());
    expect([...program.optCell.entries()].sort()).toEqual([...logic.optCell.entries()].sort());
  });
});

describe('the sparse base_* encodings', () => {
  it('emits base_visible only for nodes that are not visible by default', () => {
    const { artifactLogic, ids } = compileFixture();

    expect(Object.values(artifactLogic.base_visible)).not.toContain(BASE_VISIBLE_DEFAULT);
    expect(artifactLogic.base_visible[ids.q7]).toBe(false);
    expect(artifactLogic.base_visible[ids.q1]).toBeUndefined();
  });

  it('emits base_option only where the authored default differs from schema §5.1', () => {
    const { artifactLogic, ids } = compileFixture();

    expect(artifactLogic.base_option[optionKey(ids.q5Option1, 'preselected')]).toBe(true);
    expect(artifactLogic.base_option[optionKey(ids.q5Option1, 'visible')]).toBeUndefined();
    expect(BASE_OPTION_DEFAULT.visible).toBe(true);
    expect(BASE_OPTION_DEFAULT.preselected).toBe(false);
  });

  it('materializes base_items for every axis a question declares items on, and no others', () => {
    const { artifactLogic, ids } = compileFixture();

    expect(artifactLogic.base_items[itemsKey(asQuestionId(ids.q5), 'options')]).toEqual([1, 2, 3]);
    expect(artifactLogic.base_items[itemsKey(asQuestionId(ids.q1), 'options')]).toEqual([1, 2]);
    expect(artifactLogic.base_items[itemsKey(asQuestionId(ids.q1), 'rows')]).toBeUndefined();
    // A question with no items at all contributes no key.
    expect(artifactLogic.base_items[itemsKey(asQuestionId(ids.q7), 'options')]).toBeUndefined();
    expect(MASK_AXES).toEqual(['options', 'rows', 'columns']);
  });
});

describe('the round trip', () => {
  it('reproduces cells, topo, dependents, writers and triggers through canonical JSON', () => {
    const fixture = compileFixture({ languages: ['de'] });
    const rehydrated = rehydrate(throughJson(fixture.artifactLogic));
    const original = fixture.logic;

    expect(rehydrated.cells).toEqual(original.cells);
    expect(rehydrated.cellKeys).toEqual([...original.cellKeys]);
    expect([...rehydrated.topo]).toEqual([...original.topo]);
    expect([...rehydrated.topoPos]).toEqual([...original.topoPos]);
    expect(rehydrated.dependents.map((edges) => [...edges])).toEqual(
      original.dependents.map((edges) => [...edges]),
    );
    expect(rehydrated.writers.map((rules) => [...rules])).toEqual(
      original.writers.map((rules) => [...rules]),
    );
    expect([...rehydrated.triggers.keys()].sort()).toEqual([...original.triggers.keys()].sort());
    for (const [variableId, indices] of original.triggers) {
      expect([...(rehydrated.triggers.get(variableId) ?? [])]).toEqual([...indices]);
    }
  });

  it('restores the typed arrays as typed arrays, not as objects', () => {
    const fixture = compileFixture();
    const rehydrated = rehydrate(throughJson(fixture.artifactLogic));

    expect(rehydrated.topo).toBeInstanceOf(Int32Array);
    expect(rehydrated.dependents[0]).toBeInstanceOf(Int32Array);
    expect(rehydrated.triggers.values().next().value).toBeInstanceOf(Int32Array);
  });

  it('restores valid_by_target and the reverse edges', () => {
    const fixture = compileFixture();
    const rehydrated = rehydrate(throughJson(fixture.artifactLogic));

    expect([...rehydrated.validCells.keys()].sort()).toEqual([...fixture.logic.validCells.keys()].sort());
    expect(rehydrated.inputs.map((edges) => [...edges])).toEqual(
      fixture.logic.graph.inputs.map((edges) => [...edges]),
    );
  });

  it('restores the three base closures over their whole key space, defaults included', () => {
    const fixture = compileFixture();
    const rehydrated = rehydrate(throughJson(fixture.artifactLogic));

    for (const nodeId of visibleNodeIds(fixture)) {
      expect(rehydrated.baseVisible(nodeId)).toBe(fixture.logic.baseVisible(nodeId));
    }
    for (const questionId of [fixture.ids.q1, fixture.ids.q5, fixture.ids.q7]) {
      for (const axis of MASK_AXES) {
        const expected = fixture.logic.baseItems(asQuestionId(questionId), axis as MaskAxis);
        // The fallback for an axis with no items is `[]` on both sides — an absent key means "this
        // question has no such axis", which is the same answer the closure gives.
        expect([...rehydrated.baseItems(asQuestionId(questionId), axis as MaskAxis)]).toEqual([
          ...expected,
        ]);
      }
    }
    for (const optionId of [fixture.ids.q1Option1, fixture.ids.q5Option1]) {
      for (const prop of OPT_PROPS) {
        expect(rehydrated.baseOption(optionId, prop as OptProp)).toBe(
          fixture.logic.baseOption(optionId, prop as OptProp),
        );
      }
    }
  });

  it('restores the cell index of every key, so the runtime needs one string lookup and no parse', () => {
    const fixture = compileFixture();
    const rehydrated = rehydrate(throughJson(fixture.artifactLogic));

    fixture.logic.cellKeys.forEach((key, index) => {
      expect(rehydrated.indexOf(key)).toBe(index);
    });
    expect(rehydrated.indexOf('value(var_does_not_exist)')).toBeUndefined();
  });

  it('restores derived expressions as the node objects they point at', () => {
    const fixture = compileFixture();
    const rehydrated = rehydrate(throughJson(fixture.artifactLogic));

    expect([...rehydrated.derived.keys()].sort()).toEqual([...fixture.logic.derived.keys()].sort());
    for (const [cellIndex, expr] of fixture.logic.derived) {
      expect(rehydrated.derived.get(cellIndex)).toEqual(expr);
    }
  });

  it('recovers which cells a rule writes from the writers index', () => {
    const fixture = compileFixture();
    const rehydrated = rehydrate(throughJson(fixture.artifactLogic));

    fixture.logic.rules.forEach((rule, ruleIndex) => {
      const recovered = cellsWrittenBy(rehydrated, ruleIndex).map((index) => rehydrated.cellKeys[index]);
      // Not `writesOf(rule)` verbatim: a rule whose effect writes no cell (a skip with no flow
      // site) is absent from `writers` entirely, which is the graph's answer and the right one.
      const expected = writesOf(rule)
        .map(cellKey)
        .filter((key) => rehydrated.indexOf(key) !== undefined);
      expect([...recovered].sort()).toEqual([...expected].sort());
    });
  });

  it('is stable: serializing a rehydrated artifact reproduces the same bytes', () => {
    const fixture = compileFixture();
    const once = stableStringify(fixture.artifactLogic);
    const twice = stableStringify(buildArtifactLogic({ survey: fixture.survey, logic: fixture.logic }));

    expect(twice).toBe(once);
  });
});

/** Every content node whose visibility is a cell, plus one that is not — for the default arm. */
function visibleNodeIds(fixture: Fixture): readonly string[] {
  return [
    fixture.ids.q1,
    fixture.ids.q5,
    fixture.ids.q7,
    fixture.ids.page1,
    fixture.ids.page2,
    fixture.ids.block,
    'qst_not_in_this_survey',
  ];
}
