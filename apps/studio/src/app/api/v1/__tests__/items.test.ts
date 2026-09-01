/**
 * The item routes (API §2.5): options, matrix rows and columns — and the one distinction the whole
 * table exists to keep, `code` versus display order.
 *
 * C §5.1 calls conflating the two "a classic data disaster": randomizing or reordering the display
 * must never rewrite an exported value. 0007 makes the mistake unexpressible in the database (two
 * columns, two unique indexes); this suite asserts the API layer does not reintroduce it — a drag
 * changes `sort_key` and nothing else, a paste with a duplicated code is refused rather than
 * renumbered, and a recode is a different endpoint that says which columns it moved.
 *
 * The other half is that an option IS a column: every write here re-runs the plugin's
 * `declareVariables`, so the assertions are on `content.variables` as much as on the items.
 */

import { describe, expect, it } from 'vitest';
import { astBuilder } from '@resscript/logic';
import { POST as postNode } from '@/app/api/v1/versions/[id]/nodes/route';
import { GET as getItems, POST as postItem } from '@/app/api/v1/nodes/[id]/items/route';
import { POST as bulkItems } from '@/app/api/v1/nodes/[id]/items:bulk/route';
import { DELETE as deleteItem, PATCH as patchItem } from '@/app/api/v1/items/[id]/route';
import { POST as moveItem } from '@/app/api/v1/items/[id]/move/route';
import { createHarness, params, readJson, req, type Harness } from '@/test/harness';
import { IDS } from '@/test/registry-fixture';

function envelopeCode(body: Record<string, unknown>): string {
  return (body['error'] as { code: string }).code;
}

function detailCodes(body: Record<string, unknown>): string[] {
  return (body['error'] as { details: { code: string }[] }).details.map((d) => d.code);
}

function ifMatch(h: Harness, versionId: string = h.ids.draftA): Record<string, string> {
  const version = h.data.versions.find((v) => v.id === versionId);
  return { 'If-Match': `W/"${String(version?.revision ?? 1)}.${String(h.nowMs)}"` };
}

async function post(h: Harness, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { body: out } = await readJson(
    await postNode(
      req(`/api/v1/versions/${h.ids.draftA}/nodes`, {
        method: 'POST',
        body,
        headers: ifMatch(h),
      }),
      params({ id: h.ids.draftA }),
    ),
  );
  return out;
}

/** A multi-select on a page, which is the question type an option list is actually about. */
async function question(h: Harness, ref = 'Q1', questionType = 'multi_select'): Promise<string> {
  h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
  const block = await post(h, { node_kind: 'block', parent_id: null, ref: `${ref}_B` });
  const page = await post(h, {
    node_kind: 'page',
    parent_id: (block['node'] as { id: string }).id,
    ref: `${ref}_P`,
  });
  const node = await post(h, {
    node_kind: 'question',
    parent_id: (page['node'] as { id: string }).id,
    ref,
    question_type: questionType,
  });
  return (node['node'] as { id: string }).id;
}

interface Result {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

async function addItem(h: Harness, nodeId: string, body: Record<string, unknown>): Promise<Result> {
  return readJson(
    await postItem(
      req(`/api/v1/nodes/${nodeId}/items`, { method: 'POST', body, headers: ifMatch(h) }),
      params({ id: nodeId }),
    ),
  );
}

async function paste(
  h: Harness,
  nodeId: string,
  body: Record<string, unknown>,
): Promise<Result> {
  return readJson(
    await bulkItems(
      req(`/api/v1/nodes/${nodeId}/items:bulk`, { method: 'POST', body, headers: ifMatch(h) }),
      params({ id: nodeId }),
    ),
  );
}

async function list(h: Harness, nodeId: string, query = ''): Promise<Result> {
  return readJson(
    await getItems(req(`/api/v1/nodes/${nodeId}/items${query}`), params({ id: nodeId })),
  );
}

function codes(result: Result): number[] {
  return (result.body['data'] as { code: number }[]).map((row) => row.code);
}

function refs(result: Result): string[] {
  return (result.body['data'] as { ref: string }[]).map((row) => row.ref);
}

/* ========================================================================== */
/* POST — one item, and the column it adds                                    */
/* ========================================================================== */

describe('POST /api/v1/nodes/:id/items', () => {
  it('adds an option, appends it, and recomputes the variables the question emits', async () => {
    const h = createHarness();
    const nodeId = await question(h, 'Q10');
    const first = await addItem(h, nodeId, { item_kind: 'option', ref: 'coffee', code: 1 });
    expect(first.status).toBe(201);
    const second = await addItem(h, nodeId, { item_kind: 'option', ref: 'tea', code: 2 });
    expect(second.status).toBe(201);

    // Absent position means APPEND: "add an option" puts it at the end of the list.
    expect(refs(await list(h, nodeId))).toEqual(['coffee', 'tea']);
    // Two booleans plus the set view, named from the option CODES.
    expect((second.body['variables_changed'] as { name: string }[]).map((row) => row.name)).toEqual([
      'Q10r1',
      'Q10r2',
      'Q10',
    ]);
  });

  it('requires a code, and never invents one from the position', async () => {
    const h = createHarness();
    const nodeId = await question(h, 'Q11');
    const missing = await addItem(h, nodeId, { item_kind: 'option', ref: 'coffee' });
    expect(missing.status).toBe(422);
    // The author says what the exported value is; the API does not guess it.
    expect(detailCodes(missing.body)).toContain('invalid_type');
  });

  it('refuses a duplicate code and a duplicate ref within the question', async () => {
    const h = createHarness();
    const nodeId = await question(h, 'Q12X');
    await addItem(h, nodeId, { item_kind: 'option', ref: 'coffee', code: 1 });

    const sameCode = await addItem(h, nodeId, { item_kind: 'option', ref: 'tea', code: 1 });
    expect(sameCode.status).toBe(409);
    expect(detailCodes(sameCode.body)).toContain('duplicate_code');

    const sameRef = await addItem(h, nodeId, { item_kind: 'option', ref: 'COFFEE', code: 2 });
    expect(sameRef.status).toBe(409);
    expect(envelopeCode(sameRef.body)).toBe('already_exists');

    // …but the SAME code on a different item kind is fine: the index is per (question, kind), so a
    // matrix may have a row 1 and a column 1.
    const asRow = await addItem(h, nodeId, { item_kind: 'row', ref: 'r1', code: 1 });
    expect(asRow.status).toBe(201);
    expect(codes(await list(h, nodeId, '?kind=option'))).toEqual([1]);
    expect(codes(await list(h, nodeId, '?kind=row'))).toEqual([1]);
  });

  it('type-checks a behaviour condition and rejects it with the LGC code', async () => {
    const h = createHarness();
    const nodeId = await question(h, 'Q13');
    const b = astBuilder(1);
    const wrongType = await addItem(h, nodeId, {
      item_kind: 'option',
      ref: 'coffee',
      code: 1,
      // S1 is an enum in the version's registry; comparing it to text is LGC-T003.
      behaviour: { visible: { condition: b.cmp('==', b.variable(IDS.varS1 as never), b.textLit('yes')) } },
    });
    expect(wrongType.status).toBe(422);
    expect(detailCodes(wrongType.body)).toContain('LGC-T003');
    expect(h.data.items).toHaveLength(0);

    const literal = await addItem(h, nodeId, {
      item_kind: 'option',
      ref: 'coffee',
      code: 1,
      behaviour: { visible: { literal: true } },
    });
    expect(literal.status).toBe(201);
    const both = await addItem(h, nodeId, {
      item_kind: 'option',
      ref: 'tea',
      code: 2,
      behaviour: { visible: { literal: true, condition: b.boolLit(true) } },
    });
    expect(both.status).toBe(422);
  });

  /**
   * The authorability check for the option-level features. An engine that computes `pin` and the
   * two ordering bands is worth nothing if the write path rejects them — `behaviour` is `.strict()`
   * on purpose, so every property has to be named to exist, and that is exactly the kind of gap
   * that goes unnoticed while every unit test in three packages passes.
   */
  it('accepts pin and the ordering bands, and round-trips them', async () => {
    const h = createHarness();
    const nodeId = await question(h, 'Q14');
    const b = astBuilder(1);

    const created = await addItem(h, nodeId, {
      item_kind: 'option',
      ref: 'none',
      code: 99,
      behaviour: {
        pin: true,
        prioritized: { literal: false },
        deprioritized: { condition: b.probe('answered', { kind: 'variable', id: IDS.varS1 as never }) },
      },
    });
    expect(created.status).toBe(201);

    const stored = h.data.items[0]?.behaviour as Record<string, unknown> | undefined;
    expect(stored?.['pin']).toBe(true);
    expect(stored?.['deprioritized']).toBeDefined();
  });

  it('still refuses a behaviour property that has no cell behind it', async () => {
    const h = createHarness();
    const nodeId = await question(h, 'Q15');
    const refused = await addItem(h, nodeId, {
      item_kind: 'option',
      ref: 'x',
      code: 1,
      behaviour: { promoted: true } as never,
    });
    // 400 and not 422: an unknown key fails body validation before any semantic check runs.
    expect(refused.status).toBe(400);
  });

  it('refuses items on a node that is not a question', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    const block = await post(h, { node_kind: 'block', parent_id: null, ref: 'BB' });
    const blockId = (block['node'] as { id: string }).id;
    const refused = await addItem(h, blockId, { item_kind: 'option', ref: 'x', code: 1 });
    expect(refused.status).toBe(422);
    expect(detailCodes(refused.body)).toContain('not_a_question');
  });
});

/* ========================================================================== */
/* The drag: ONE row write, and `code` untouched                              */
/* ========================================================================== */

describe('POST /api/v1/items/:id/move', () => {
  it('reorders without renumbering, in one write per drag', async () => {
    const h = createHarness();
    const nodeId = await question(h, 'Q20');
    // Codes that are deliberately NOT 1..n, because a client's tracker layout rarely is.
    const pasted = await paste(h, nodeId, {
      item_kind: 'option',
      mode: 'append',
      items: [10, 20, 30, 40, 50].map((code) => ({ ref: `o${String(code)}`, code })),
    });
    expect(pasted.status).toBe(201);
    expect(codes(await list(h, nodeId))).toEqual([10, 20, 30, 40, 50]);

    const items = (await list(h, nodeId)).body['data'] as { id: string; ref: string }[];
    const last = items[4] as { id: string };
    const before = h.data.countWrites('content.question_items', 'update');
    const moved = await readJson(
      await moveItem(
        req(`/api/v1/items/${last.id}/move`, {
          method: 'POST',
          body: { after_id: null },
          headers: ifMatch(h),
        }),
        params({ id: last.id }),
      ),
    );
    expect(moved.status).toBe(200);
    // THE acceptance criterion, at the option list: one UPDATE per drag, whatever the list length.
    expect(h.data.countWrites('content.question_items', 'update') - before).toBe(1);
    // The order moved and NOT ONE CODE CHANGED. `Q20r50` still means "the option whose code is 50".
    expect(refs(await list(h, nodeId))).toEqual(['o50', 'o10', 'o20', 'o30', 'o40']);
    expect(codes(await list(h, nodeId))).toEqual([50, 10, 20, 30, 40]);
    const names = h.data.variables
      .filter((row) => row.deleted_at === null && row.source_question_id === nodeId)
      .map((row) => row.name)
      .sort();
    expect(names).toEqual(['Q20', 'Q20r10', 'Q20r20', 'Q20r30', 'Q20r40', 'Q20r50']);
  });
});

describe('the amortized rebalance', () => {
  it('rewrites the set once the keys outgrow their budget, and only after a move is durable', async () => {
    const h = createHarness();
    const nodeId = await question(h, 'Q21');
    // Keys long enough to be over budget, SEEDED rather than reached by 200 API calls.
    // `frac-key.test.ts` already proves the growth — B §4.6's pathological drag sequence needs
    // ~200 adjacent inserts to reach 42 characters, and 200 requests would make this suite's
    // runtime the reason somebody deletes it. What is under test here is the TRIGGER: that a move
    // notices `max(length(sort_key)) > 16` and rewrites the set, and does it after the move.
    for (let index = 0; index < 20; index += 1) {
      h.data.seedItem({
        org_id: h.ids.orgA,
        survey_version_id: h.ids.draftA,
        question_id: nodeId,
        item_kind: 'option',
        ref: `o${String(index)}`,
        code: index + 10,
        sort_key: `V${'1'.repeat(index)}z`,
      });
    }
    const grown = Math.max(
      ...h.data.items.filter((row) => row.question_id === nodeId).map((row) => row.sort_key.length),
    );
    expect(grown).toBeGreaterThan(16);

    const items = (await list(h, nodeId)).body['data'] as { id: string; ref: string }[];
    const order = items.map((row) => row.ref);
    const last = items[items.length - 1] as { id: string };
    const moved = await readJson(
      await moveItem(
        req(`/api/v1/items/${last.id}/move`, {
          method: 'POST',
          body: { after_id: null },
          headers: ifMatch(h),
        }),
        params({ id: last.id }),
      ),
    );
    expect(moved.status).toBe(200);
    // The move happened FIRST and the rebalance after it, so the drag is still one row write plus
    // the maintenance — never a renumber the author has to wait for before their key exists.
    const after = Math.max(
      ...h.data.items.filter((row) => row.question_id === nodeId).map((row) => row.sort_key.length),
    );
    expect(after).toBeLessThanOrEqual(4);
    // And the reorder is exactly the one the author asked for, with every code untouched.
    expect(refs(await list(h, nodeId))).toEqual([
      order[order.length - 1],
      ...order.slice(0, order.length - 1),
    ]);
    // Twenty distinct codes before and twenty after: a rebalance rewrites `sort_key` and nothing
    // else, which is the only reason it is safe to run behind the author's back.
    expect(new Set(codes(await list(h, nodeId))).size).toBe(20);
  });
});

/* ========================================================================== */
/* The paste                                                                   */
/* ========================================================================== */

describe('POST /api/v1/nodes/:id/items:bulk', () => {
  it('pastes 60 brands in one atomic write and declares 60 columns plus the set view', async () => {
    const h = createHarness();
    const nodeId = await question(h, 'Q30');
    const sixty = Array.from({ length: 60 }, (_, index) => ({
      ref: `brand${String(index + 1)}`,
      code: index + 1,
      label: `q30.brand.${String(index + 1)}`,
    }));
    const pasted = await paste(h, nodeId, { item_kind: 'option', mode: 'append', items: sixty });
    expect(pasted.status).toBe(201);
    expect((pasted.body['data'] as unknown[]).length).toBe(60);
    expect((pasted.body['variables_changed'] as unknown[]).length).toBe(61);
    // Dense keys for the whole block: 60 pasted options do not start life with 60 characters of
    // key, which is what would happen if each one interpolated after the last.
    const keys = h.data.items.filter((row) => row.question_id === nodeId).map((row) => row.sort_key);
    expect(Math.max(...keys.map((key) => key.length))).toBeLessThanOrEqual(8);
  });

  it('is atomic: a duplicated code rejects the whole paste and writes nothing', async () => {
    const h = createHarness();
    const nodeId = await question(h, 'Q40');
    await paste(h, nodeId, {
      item_kind: 'option',
      mode: 'append',
      items: [
        { ref: 'a', code: 1 },
        { ref: 'b', code: 2 },
      ],
    });

    const clash = await paste(h, nodeId, {
      item_kind: 'option',
      mode: 'replace',
      items: [
        { ref: 'x', code: 7 },
        { ref: 'y', code: 8 },
        { ref: 'z', code: 7 },
      ],
    });
    expect(clash.status).toBe(422);
    expect(detailCodes(clash.body)).toContain('duplicate_code');
    // `replace` would have deleted the old list first. It did not: nothing was written at all,
    // which is what "atomic" has to mean for a paste that clears what is already there.
    expect(refs(await list(h, nodeId))).toEqual(['a', 'b']);
    expect(
      h.data.variables.filter((row) => row.deleted_at === null && row.source_question_id === nodeId),
    ).toHaveLength(3);
  });

  it('refuses an append whose codes collide with the existing list', async () => {
    const h = createHarness();
    const nodeId = await question(h, 'Q50');
    await paste(h, nodeId, { item_kind: 'option', mode: 'append', items: [{ ref: 'a', code: 1 }] });
    const clash = await paste(h, nodeId, {
      item_kind: 'option',
      mode: 'append',
      items: [{ ref: 'b', code: 1 }],
    });
    expect(clash.status).toBe(409);
    expect(detailCodes(clash.body)).toContain('duplicate_code');
    expect(refs(await list(h, nodeId))).toEqual(['a']);
  });

  it('replace soft-deletes the old list and its columns, and keeps the new one ordered', async () => {
    const h = createHarness();
    const nodeId = await question(h, 'Q60');
    await paste(h, nodeId, {
      item_kind: 'option',
      mode: 'append',
      items: [
        { ref: 'old1', code: 1 },
        { ref: 'old2', code: 2 },
      ],
    });
    const replaced = await paste(h, nodeId, {
      item_kind: 'option',
      mode: 'replace',
      items: [
        { ref: 'new1', code: 11 },
        { ref: 'new2', code: 12 },
      ],
    });
    expect(replaced.status).toBe(201);
    expect(refs(await list(h, nodeId))).toEqual(['new1', 'new2']);
    // Soft: the old rows are still there for undo, and so are their variable rows — deleted, not
    // removed, because a rule can target an option.
    expect(h.data.items.filter((row) => row.deleted_at !== null)).toHaveLength(2);
    const dead = h.data.variables.filter((row) => row.deleted_at !== null).map((row) => row.name);
    expect(dead.sort()).toEqual(['Q60r1', 'Q60r2']);
    const live = h.data.variables
      .filter((row) => row.deleted_at === null && row.source_question_id === nodeId)
      .map((row) => row.name)
      .sort();
    expect(live).toEqual(['Q60', 'Q60r11', 'Q60r12']);
  });
});

/* ========================================================================== */
/* PATCH and DELETE                                                            */
/* ========================================================================== */

describe('PATCH and DELETE /api/v1/items/:id', () => {
  it('recoding an option renames its column and keeps its id', async () => {
    const h = createHarness();
    const nodeId = await question(h, 'Q70');
    const created = await addItem(h, nodeId, { item_kind: 'option', ref: 'coffee', code: 1 });
    const itemId = (created.body['item'] as { id: string }).id;
    const variableId = h.data.variables.find((row) => row.name === 'Q70r1')?.id;

    const recoded = await readJson(
      await patchItem(
        req(`/api/v1/items/${itemId}`, { method: 'PATCH', body: { code: 7 }, headers: ifMatch(h) }),
        params({ id: itemId }),
      ),
    );
    expect(recoded.status).toBe(200);
    expect((recoded.body['item'] as { code: number }).code).toBe(7);
    const changed = recoded.body['variables_changed'] as { id: string; name: string }[];
    // The column is named from the code, so it moves — and the id does not, because the variable's
    // SOURCE (this option) has not changed.
    expect(changed.map((row) => row.name)).toEqual(['Q70r7', 'Q70']);
    expect(changed[0]?.id).toBe(variableId);
  });

  it('a label edit moves no column', async () => {
    const h = createHarness();
    const nodeId = await question(h, 'Q80');
    const created = await addItem(h, nodeId, { item_kind: 'option', ref: 'coffee', code: 1 });
    const itemId = (created.body['item'] as { id: string }).id;
    const relabelled = await readJson(
      await patchItem(
        req(`/api/v1/items/${itemId}`, {
          method: 'PATCH',
          body: { label: 'q80.coffee' },
          headers: ifMatch(h),
        }),
        params({ id: itemId }),
      ),
    );
    expect(relabelled.status).toBe(200);
    expect(relabelled.body['variables_changed']).toEqual([]);
  });

  it('DELETE is 204, soft, and takes the option-s column with it', async () => {
    const h = createHarness();
    const nodeId = await question(h, 'Q90');
    const created = await addItem(h, nodeId, { item_kind: 'option', ref: 'coffee', code: 1 });
    await addItem(h, nodeId, { item_kind: 'option', ref: 'tea', code: 2 });
    const itemId = (created.body['item'] as { id: string }).id;

    const removed = await deleteItem(
      req(`/api/v1/items/${itemId}`, { method: 'DELETE', headers: ifMatch(h) }),
      params({ id: itemId }),
    );
    expect(removed.status).toBe(204);
    expect(refs(await list(h, nodeId))).toEqual(['tea']);
    expect(h.data.items.find((row) => row.id === itemId)?.deleted_at).not.toBeNull();
    expect(h.data.variables.find((row) => row.name === 'Q90r1')?.deleted_at).not.toBeNull();
    expect(h.data.variables.find((row) => row.name === 'Q90r2')?.deleted_at).toBeNull();
  });
});

/* ========================================================================== */
/* The guards                                                                  */
/* ========================================================================== */

describe('the guards the item writes share', () => {
  it('409 on a frozen version, 403 for a viewer, 404 across orgs, 428 without If-Match', async () => {
    const h = createHarness();
    const nodeId = await question(h, 'Q99');

    const noLock = await readJson(
      await postItem(
        req(`/api/v1/nodes/${nodeId}/items`, {
          method: 'POST',
          body: { item_kind: 'option', ref: 'x', code: 1 },
        }),
        params({ id: nodeId }),
      ),
    );
    expect(noLock.status).toBe(428);

    h.as({ userId: h.ids.viewerA, activeOrgId: h.ids.orgA });
    const asViewer = await addItem(h, nodeId, { item_kind: 'option', ref: 'x', code: 1 });
    expect(asViewer.status).toBe(403);

    h.as({ userId: h.ids.ownerB, activeOrgId: h.ids.orgB });
    const crossOrg = await addItem(h, nodeId, { item_kind: 'option', ref: 'x', code: 1 });
    expect(crossOrg.status).toBe(404);
    const crossOrgRead = await list(h, nodeId);
    expect(crossOrgRead.status).toBe(404);

    // Frozen: the same node, on a version that has been published.
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    const frozen = h.data.seedVersionAt({
      orgId: h.ids.orgA,
      surveyId: h.ids.surveyA,
      versionNo: 9,
      status: 'production',
      createdBy: h.ids.ownerA,
    });
    const frozenQuestion = h.data.seedNode({
      org_id: h.ids.orgA,
      survey_version_id: frozen.id,
      node_kind: 'question',
      ref: 'FQ',
      question_type: 'multi_select',
      required: false,
    });
    const onFrozen = await addItem(h, frozenQuestion.id, {
      item_kind: 'option',
      ref: 'x',
      code: 1,
    });
    expect(onFrozen.status).toBe(409);
    expect(envelopeCode(onFrozen.body)).toBe('frozen_version');
    const pastedOnFrozen = await paste(h, frozenQuestion.id, {
      item_kind: 'option',
      mode: 'replace',
      items: [{ ref: 'x', code: 1 }],
    });
    expect(pastedOnFrozen.status).toBe(409);
  });
});
