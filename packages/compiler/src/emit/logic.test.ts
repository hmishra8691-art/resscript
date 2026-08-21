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
import { stableStringify, type ArtifactLogic } from '@resscript/schema';
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
  BASE_OPTION_DEFAULT,
  BASE_VISIBLE_DEFAULT,
  MASK_AXES,
  OPT_PROPS,
  buildArtifactLogic,
  cellsWrittenBy,
  compiledRuleOf,
  rehydrate,
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
