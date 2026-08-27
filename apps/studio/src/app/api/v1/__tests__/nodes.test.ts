/**
 * The content-node routes (API §2.5, roadmap P1-03): the tree, the writes, and the four
 * acceptance criteria the milestone is stated as.
 *
 * The suite's centre is what makes this model worth its complexity, and each one is asserted on the
 * STORE rather than on the response where the two could differ:
 *
 *  * a question save runs the plugin's `declareVariables` and the emitted names are the ones
 *    `deriveVariableName` produces — the export columns, by name;
 *  * a drag is ONE `UPDATE` on `content.nodes` (`MemoryDataset.writes`, which is the only way to
 *    tell a fractional index from a renumbering that happens to produce the same order);
 *  * renaming a `ref` changes exactly the derived variable NAMES and no id;
 *  * a delete is soft, an undelete restores the subtree, and both name the rules they touched.
 *
 * Assertions are on status codes, envelope CODES and stored rows. Never on message prose.
 */

import { describe, expect, it } from 'vitest';
import { POST as postNode } from '@/app/api/v1/versions/[id]/nodes/route';
import { GET as getTree } from '@/app/api/v1/versions/[id]/tree/route';
import {
  DELETE as deleteNode,
  GET as getNode,
  PATCH as patchNode,
} from '@/app/api/v1/nodes/[id]/route';
import { POST as moveNode } from '@/app/api/v1/nodes/[id]/move/route';
import { POST as undeleteNode } from '@/app/api/v1/nodes/[id]/undelete/route';
import { POST as duplicateNode } from '@/app/api/v1/nodes/[id]/duplicate/route';
import { POST as postItems } from '@/app/api/v1/nodes/[id]/items/route';
import { createHarness, params, readJson, req, type Harness } from '@/test/harness';

function envelopeCode(body: Record<string, unknown>): string {
  return (body['error'] as { code: string }).code;
}

function detailCodes(body: Record<string, unknown>): string[] {
  return (body['error'] as { details: { code: string }[] }).details.map((d) => d.code);
}

/**
 * The current `If-Match` for a version.
 *
 * Re-read per request, because every content write bumps `revision` (API §1.7) — a test that
 * cached the header would be asserting the lock works by accident on its second write.
 */
function ifMatch(h: Harness, versionId: string = h.ids.draftA): Record<string, string> {
  const version = h.data.versions.find((v) => v.id === versionId);
  return { 'If-Match': `W/"${String(version?.revision ?? 1)}.${String(h.nowMs)}"` };
}

function asProgrammer(h: Harness): void {
  h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
}

interface Result {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly headers: Headers;
}

async function createNode(
  h: Harness,
  body: Record<string, unknown>,
  versionId: string = h.ids.draftA,
): Promise<Result> {
  return readJson(
    await postNode(
      req(`/api/v1/versions/${versionId}/nodes`, { method: 'POST', body, headers: ifMatch(h, versionId) }),
      params({ id: versionId }),
    ),
  );
}

function id(result: Result, key = 'node'): string {
  return (result.body[key] as { id: string }).id;
}

function names(result: Result, key: string): string[] {
  return (result.body[key] as { name: string }[]).map((row) => row.name);
}

/** A block holding a page — the minimum legal shape for a question (C §5). */
async function skeleton(h: Harness): Promise<{ block: string; page: string }> {
  const block = await createNode(h, { node_kind: 'block', parent_id: null, ref: 'B1' });
  const page = await createNode(h, { node_kind: 'page', parent_id: id(block), ref: 'PG1' });
  return { block: id(block), page: id(page) };
}

/* ========================================================================== */
/* POST — create, and the variables the plugin declares                       */
/* ========================================================================== */

describe('POST /api/v1/versions/:id/nodes', () => {
  it('creates a question and returns the variables its plugin declared, by derived name', async () => {
    const h = createHarness();
    asProgrammer(h);
    const { page } = await skeleton(h);
    const created = await createNode(h, {
      node_kind: 'question',
      parent_id: page,
      ref: 'Q100',
      question_type: 'text',
      label: 'q.q100.label',
      required: true,
    });
    expect(created.status).toBe(201);
    // schema §3's scalar rule: one variable, named for the question.
    expect(names(created, 'variables_created')).toEqual(['Q100']);
    const variable = (created.body['variables_created'] as { id: string; export_column: string; vtype: string }[])[0];
    expect(variable?.export_column).toBe('Q100');
    expect(variable?.vtype).toBe('text');
    // 0007's `emits`: stored on the node, so "which columns does Q100 produce" is a text search.
    expect((created.body['node'] as { emits: string[] }).emits).toEqual([variable?.id]);
    // And the row is really in content.variables, pointing back at the question.
    const stored = h.data.variables.find((row) => row.id === variable?.id);
    expect(stored?.source_question_id).toBe(id(created));
    expect(stored?.deleted_at).toBeNull();
  });

  it('fans a multi-select out into one boolean per option plus the derived set view', async () => {
    const h = createHarness();
    asProgrammer(h);
    const { page } = await skeleton(h);
    const question = await createNode(h, {
      node_kind: 'question',
      parent_id: page,
      ref: 'Q200',
      question_type: 'multi_select',
      required: false,
    });
    // A choice question with no options cannot declare a domain yet, so it emits nothing and says
    // so rather than refusing the creation — see `recomputeVariables`.
    expect(question.status).toBe(201);
    expect(names(question, 'variables_created')).toEqual([]);

    const nodeId = id(question);
    const added = await readJson(
      await postItems(
        req(`/api/v1/nodes/${nodeId}/items`, {
          method: 'POST',
          body: { item_kind: 'option', ref: 'o1', code: 1, label: 'o.1' },
          headers: ifMatch(h),
        }),
        params({ id: nodeId }),
      ),
    );
    expect(added.status).toBe(201);
    // `Q200r1` from the option's CODE, and `Q200` for the set view (F §10's catalogue).
    expect(names(added, 'variables_changed')).toEqual(['Q200r1', 'Q200']);
    const setView = (added.body['variables_changed'] as { name: string; export_include: boolean; persist: boolean }[])[1];
    // The set view is not an export column and is not stored: it is recomputed per page from the
    // booleans, which are the columns.
    expect(setView?.export_include).toBe(false);
    expect(setView?.persist).toBe(false);
  });

  it('refuses the shapes nodes_kind_shape and C §5 refuse, naming the field', async () => {
    const h = createHarness();
    asProgrammer(h);
    const { block, page } = await skeleton(h);

    const noPlugin = await createNode(h, { node_kind: 'question', parent_id: page, ref: 'Q1' });
    expect(noPlugin.status).toBe(422);
    expect(detailCodes(noPlugin.body)).toContain('required');

    const questionInBlock = await createNode(h, {
      node_kind: 'question',
      parent_id: block,
      ref: 'Q2',
      question_type: 'text',
    });
    expect(questionInBlock.status).toBe(422);
    expect(detailCodes(questionInBlock.body)).toContain('illegal_nesting');

    const rootPage = await createNode(h, { node_kind: 'page', parent_id: null, ref: 'P0' });
    expect(rootPage.status).toBe(422);
    expect(detailCodes(rootPage.body)).toContain('root_is_block');

    const unknownPlugin = await createNode(h, {
      node_kind: 'question',
      parent_id: page,
      ref: 'Q3',
      question_type: 'no_such_plugin',
    });
    expect(unknownPlugin.status).toBe(422);
    expect(detailCodes(unknownPlugin.body)).toContain('unknown_question_type');
  });

  it('refuses a duplicate ref with 409, because refs are unique per version', async () => {
    const h = createHarness();
    asProgrammer(h);
    await skeleton(h);
    const again = await createNode(h, { node_kind: 'block', parent_id: null, ref: 'b1' });
    expect(again.status).toBe(409);
    expect(envelopeCode(again.body)).toBe('already_exists');
  });

  it('computes sort_key server-side from after_id, and rejects an invented one', async () => {
    const h = createHarness();
    asProgrammer(h);
    const { block } = await skeleton(h);
    const second = await createNode(h, { node_kind: 'page', parent_id: block, ref: 'PG2' });
    const between = await createNode(h, {
      node_kind: 'page',
      parent_id: block,
      ref: 'PG15',
      after_id: (await pageIds(h, block))[0],
    });
    expect(between.status).toBe(201);
    const order = await pageIds(h, block);
    expect(order).toEqual([order[0], id(between), id(second)]);

    const invented = await createNode(h, {
      node_kind: 'page',
      parent_id: block,
      ref: 'PG9',
      sort_key: 'zzzz',
    });
    expect(invented.status).toBe(400);
    expect(envelopeCode(invented.body)).toBe('unknown_field');
  });
});

/** The page ids under one block, in document order, as the tree read serves them. */
async function pageIds(h: Harness, block: string): Promise<string[]> {
  const tree = await readJson(
    await getTree(req(`/api/v1/versions/${h.ids.draftA}/tree`), params({ id: h.ids.draftA })),
  );
  return (tree.body['data'] as { id: string; parent_id: string | null }[])
    .filter((row) => row.parent_id === block)
    .map((row) => row.id);
}

/* ========================================================================== */
/* The tree read                                                              */
/* ========================================================================== */

describe('GET /api/v1/versions/:id/tree', () => {
  it('returns one row per live node in document order, with the counts the tree renders', async () => {
    const h = createHarness();
    asProgrammer(h);
    const { block, page } = await skeleton(h);
    const question = await createNode(h, {
      node_kind: 'question',
      parent_id: page,
      ref: 'Q300',
      question_type: 'text',
      label: 'q.q300.label',
    });

    const tree = await readJson(
      await getTree(
        req(`/api/v1/versions/${h.ids.draftA}/tree?fields=summary&include=rules,badges`),
        params({ id: h.ids.draftA }),
      ),
    );
    expect(tree.status).toBe(200);
    const rows = tree.body['data'] as {
      id: string;
      kind: string;
      parent_id: string | null;
      child_count: number;
      depth: number;
      label_preview: string | null;
      rule_summaries: unknown[];
      diagnostic_counts: { errors: number };
    }[];
    const mine = rows.filter((row) => [block, page, id(question)].includes(row.id));
    expect(mine.map((row) => row.kind)).toEqual(['block', 'page', 'question']);
    expect(mine.map((row) => row.depth)).toEqual([1, 2, 3]);
    expect(mine[0]?.child_count).toBe(1);
    // Not asked for: `fields=summary` leaves the preview null rather than reading the strings.
    expect(mine[2]?.label_preview).toBeNull();
    expect(mine[2]?.rule_summaries).toEqual([]);
    expect(mine[2]?.diagnostic_counts.errors).toBe(0);
  });

  it('fields=full resolves label previews from the base language', async () => {
    const h = createHarness();
    asProgrammer(h);
    const { page } = await skeleton(h);
    await createNode(h, {
      node_kind: 'question',
      parent_id: page,
      ref: 'Q400',
      question_type: 'text',
      label: 'q.q400.label',
    });
    h.data.seedLanguage({ versionId: h.ids.draftA, orgId: h.ids.orgA, lang: 'en', isBase: true });
    h.data.seedString({
      versionId: h.ids.draftA,
      orgId: h.ids.orgA,
      lang: 'en',
      key: 'q.q400.label',
      value: 'How often do you buy coffee?',
    });

    const tree = await readJson(
      await getTree(
        req(`/api/v1/versions/${h.ids.draftA}/tree?fields=full`),
        params({ id: h.ids.draftA }),
      ),
    );
    const row = (tree.body['data'] as { ref: string; label_preview: string | null }[]).find(
      (entry) => entry.ref === 'Q400',
    );
    expect(row?.label_preview).toBe('How often do you buy coffee?');
  });

  it('include=rules attaches the rules targeting each node', async () => {
    const h = createHarness();
    asProgrammer(h);
    const { page } = await skeleton(h);
    const question = await createNode(h, {
      node_kind: 'question',
      parent_id: page,
      ref: 'Q500',
      question_type: 'text',
    });
    h.data.seedRule({
      org_id: h.ids.orgA,
      survey_version_id: h.ids.draftA,
      kind: 'display',
      target_kind: 'node',
      target_node_id: id(question),
      condition: {},
      effect: { action: 'hide' },
    });

    const tree = await readJson(
      await getTree(
        req(`/api/v1/versions/${h.ids.draftA}/tree?include=rules`),
        params({ id: h.ids.draftA }),
      ),
    );
    const row = (tree.body['data'] as { ref: string; rule_summaries: { kind: string; action: string }[] }[]).find(
      (entry) => entry.ref === 'Q500',
    );
    expect(row?.rule_summaries).toEqual([
      expect.objectContaining({ kind: 'display', action: 'hide' }),
    ]);
  });

  it('rejects an unknown fields or include value rather than ignoring it', async () => {
    const h = createHarness();
    asProgrammer(h);
    const bad = await readJson(
      await getTree(
        req(`/api/v1/versions/${h.ids.draftA}/tree?fields=everything`),
        params({ id: h.ids.draftA }),
      ),
    );
    expect(bad.status).toBe(422);
    expect(detailCodes(bad.body)).toContain('invalid_value');
  });
});

/* ========================================================================== */
/* The move: ONE row write                                                    */
/* ========================================================================== */

describe('POST /api/v1/nodes/:id/move', () => {
  it('writes exactly one row on content.nodes per drag', async () => {
    const h = createHarness();
    asProgrammer(h);
    const { block } = await skeleton(h);
    // Four sibling pages, so "move the last one to the front" is a real reorder.
    for (const ref of ['PG2', 'PG3', 'PG4']) {
      await createNode(h, { node_kind: 'page', parent_id: block, ref });
    }
    const order = await pageIds(h, block);
    const last = order[3] as string;

    const before = h.data.countWrites('content.nodes', 'update');
    const moved = await readJson(
      await moveNode(
        req(`/api/v1/nodes/${last}/move`, {
          method: 'POST',
          body: { parent_id: block, after_id: null },
          headers: ifMatch(h),
        }),
        params({ id: last }),
      ),
    );
    expect(moved.status).toBe(200);
    // THE acceptance criterion. With integer positions this is four writes, four audit rows and a
    // write-write conflict with anybody editing a sibling.
    expect(h.data.countWrites('content.nodes', 'update') - before).toBe(1);
    expect(await pageIds(h, block)).toEqual([last, ...order.slice(0, 3)]);
  });

  it('refuses to move a node into its own subtree', async () => {
    const h = createHarness();
    asProgrammer(h);
    const { block, page } = await skeleton(h);
    const inner = await createNode(h, { node_kind: 'block', parent_id: block, ref: 'B2' });
    const conflicted = await readJson(
      await moveNode(
        req(`/api/v1/nodes/${block}/move`, {
          method: 'POST',
          body: { parent_id: id(inner) },
          headers: ifMatch(h),
        }),
        params({ id: block }),
      ),
    );
    expect(conflicted.status).toBe(422);
    expect(detailCodes(conflicted.body)).toContain('move_into_own_subtree');

    // And C §5's nesting, which is the same function's second refusal.
    const intoPage = await readJson(
      await moveNode(
        req(`/api/v1/nodes/${block}/move`, {
          method: 'POST',
          body: { parent_id: page },
          headers: ifMatch(h),
        }),
        params({ id: block }),
      ),
    );
    expect(intoPage.status).toBe(422);
    expect(detailCodes(intoPage.body)).toContain('illegal_nesting');
  });

  it('accepts before_id and resolves it to the predecessor', async () => {
    const h = createHarness();
    asProgrammer(h);
    const { block } = await skeleton(h);
    await createNode(h, { node_kind: 'page', parent_id: block, ref: 'PG2' });
    const order = await pageIds(h, block);
    const first = order[0] as string;
    const second = order[1] as string;

    const moved = await readJson(
      await moveNode(
        req(`/api/v1/nodes/${second}/move`, {
          method: 'POST',
          body: { parent_id: block, before_id: first },
          headers: ifMatch(h),
        }),
        params({ id: second }),
      ),
    );
    expect(moved.status).toBe(200);
    expect(await pageIds(h, block)).toEqual([second, first]);
  });
});

/* ========================================================================== */
/* PATCH: the rename, and the one field that cannot change                    */
/* ========================================================================== */

describe('PATCH /api/v1/nodes/:id', () => {
  it('renames exactly the derived variable names, changing no id', async () => {
    const h = createHarness();
    asProgrammer(h);
    const { page } = await skeleton(h);
    const created = await createNode(h, {
      node_kind: 'question',
      parent_id: page,
      ref: 'Q600',
      question_type: 'text',
    });
    const nodeId = id(created);
    const before = (created.body['variables_created'] as { id: string; name: string }[])[0];

    const renamed = await readJson(
      await patchNode(
        req(`/api/v1/nodes/${nodeId}`, { method: 'PATCH', body: { ref: 'S600' }, headers: ifMatch(h) }),
        params({ id: nodeId }),
      ),
    );
    expect(renamed.status).toBe(200);
    const after = (renamed.body['variables_changed'] as { id: string; name: string; export_column: string }[])[0];
    expect(after?.name).toBe('S600');
    expect(after?.export_column).toBe('S600');
    // The whole point: the name moved, the id did not, so every AST, quota and mask that points
    // at it keeps working untouched.
    expect(after?.id).toBe(before?.id);
    expect((renamed.body['node'] as { emits: string[] }).emits).toEqual([before?.id]);
    expect(h.data.variables.filter((row) => row.deleted_at === null && row.source_question_id === nodeId)).toHaveLength(1);
  });

  it('leaves a deliberately overridden export column alone across a rename', async () => {
    const h = createHarness();
    asProgrammer(h);
    const { page } = await skeleton(h);
    const created = await createNode(h, {
      node_kind: 'question',
      parent_id: page,
      ref: 'Q700',
      question_type: 'text',
    });
    const nodeId = id(created);
    // What `PATCH /variables/{id}` (API §2.6) will do: pin the column to a client's existing
    // tracker layout. Written directly here because that route is §2.6's, not this milestone's.
    const index = h.data.variables.findIndex((row) => row.source_question_id === nodeId);
    const row = h.data.variables[index];
    if (row !== undefined) h.data.variables[index] = { ...row, export_column: 'LEGACY_Q7' };

    const renamed = await readJson(
      await patchNode(
        req(`/api/v1/nodes/${nodeId}`, { method: 'PATCH', body: { ref: 'S700' }, headers: ifMatch(h) }),
        params({ id: nodeId }),
      ),
    );
    const after = (renamed.body['variables_changed'] as { name: string; export_column: string }[])[0];
    expect(after?.name).toBe('S700');
    // A rename must not silently break a client's column mapping.
    expect(after?.export_column).toBe('LEGACY_Q7');
  });

  it('refuses a question_type change with an explanation, not as an unknown field', async () => {
    const h = createHarness();
    asProgrammer(h);
    const { page } = await skeleton(h);
    const created = await createNode(h, {
      node_kind: 'question',
      parent_id: page,
      ref: 'Q800',
      question_type: 'text',
    });
    const nodeId = id(created);
    const refused = await readJson(
      await patchNode(
        req(`/api/v1/nodes/${nodeId}`, {
          method: 'PATCH',
          body: { question_type: 'numeric' },
          headers: ifMatch(h),
        }),
        params({ id: nodeId }),
      ),
    );
    expect(refused.status).toBe(422);
    expect(detailCodes(refused.body)).toContain('question_type_immutable');
  });

  it('refuses a rename that would collide, and stores nothing', async () => {
    const h = createHarness();
    asProgrammer(h);
    const { page } = await skeleton(h);
    const first = await createNode(h, {
      node_kind: 'question',
      parent_id: page,
      ref: 'Q900',
      question_type: 'text',
    });
    await createNode(h, {
      node_kind: 'question',
      parent_id: page,
      ref: 'Q901',
      question_type: 'text',
    });
    const nodeId = id(first);
    const collided = await readJson(
      await patchNode(
        req(`/api/v1/nodes/${nodeId}`, { method: 'PATCH', body: { ref: 'Q901' }, headers: ifMatch(h) }),
        params({ id: nodeId }),
      ),
    );
    expect(collided.status).toBe(409);
    expect(h.data.nodes.find((row) => row.id === nodeId)?.ref).toBe('Q900');
  });
});

/* ========================================================================== */
/* DELETE and undelete: the undo buffer                                       */
/* ========================================================================== */

describe('DELETE and POST /undelete /api/v1/nodes/:id', () => {
  it('soft-deletes the subtree, names the affected rules, and restores on undelete', async () => {
    const h = createHarness();
    asProgrammer(h);
    const { page } = await skeleton(h);
    const question = await createNode(h, {
      node_kind: 'question',
      parent_id: page,
      ref: 'Q1000',
      question_type: 'text',
    });
    const nodeId = id(question);
    const rule = h.data.seedRule({
      org_id: h.ids.orgA,
      survey_version_id: h.ids.draftA,
      kind: 'display',
      target_kind: 'node',
      target_node_id: nodeId,
      condition: {},
      effect: { action: 'hide' },
    });

    const removed = await readJson(
      await deleteNode(
        req(`/api/v1/nodes/${page}`, { method: 'DELETE', headers: ifMatch(h) }),
        params({ id: page }),
      ),
    );
    expect(removed.status).toBe(200);
    // The page AND its question: a deleted page takes its children with it.
    expect((removed.body['deleted'] as { id: string }[]).map((row) => row.id)).toEqual([page, nodeId]);
    expect(removed.body['rules_affected']).toEqual([
      expect.objectContaining({ id: rule.id, outcome: 'orphaned' }),
    ]);
    // Soft: the rows are still there, which is what lets undo restore the logic too.
    expect(h.data.nodes.find((row) => row.id === nodeId)?.deleted_at).not.toBeNull();
    expect(h.data.rules.find((row) => row.id === rule.id)?.deleted_at).toBeNull();
    // And gone from the tree, because `content.tree_rows` excludes soft-deleted nodes.
    const tree = await readJson(
      await getTree(req(`/api/v1/versions/${h.ids.draftA}/tree`), params({ id: h.ids.draftA })),
    );
    expect((tree.body['data'] as { id: string }[]).map((row) => row.id)).not.toContain(nodeId);

    const restored = await readJson(
      await undeleteNode(
        req(`/api/v1/nodes/${page}/undelete`, { method: 'POST', headers: ifMatch(h) }),
        params({ id: page }),
      ),
    );
    expect(restored.status).toBe(200);
    expect((restored.body['restored'] as { id: string }[]).map((row) => row.id)).toEqual([page, nodeId]);
    const back = await readJson(await getNode(req(`/api/v1/nodes/${nodeId}`), params({ id: nodeId })));
    expect(back.status).toBe(200);
    // The variable came back with the row, with the same id: an undelete does not recreate columns.
    expect((back.body['variables'] as { name: string }[]).map((row) => row.name)).toEqual(['Q1000']);
  });

  it('?cascade_rules=delete soft-deletes the rules too, and says so', async () => {
    const h = createHarness();
    asProgrammer(h);
    const { page } = await skeleton(h);
    const question = await createNode(h, {
      node_kind: 'question',
      parent_id: page,
      ref: 'Q1100',
      question_type: 'text',
    });
    const rule = h.data.seedRule({
      org_id: h.ids.orgA,
      survey_version_id: h.ids.draftA,
      kind: 'display',
      target_kind: 'node',
      target_node_id: id(question),
      condition: {},
      effect: { action: 'hide' },
    });

    const removed = await readJson(
      await deleteNode(
        req(`/api/v1/nodes/${id(question)}?cascade_rules=delete`, {
          method: 'DELETE',
          headers: ifMatch(h),
        }),
        params({ id: id(question) }),
      ),
    );
    expect(removed.status).toBe(200);
    expect(removed.body['rules_affected']).toEqual([
      expect.objectContaining({ id: rule.id, outcome: 'deleted' }),
    ]);
    expect(h.data.rules.find((row) => row.id === rule.id)?.deleted_at).not.toBeNull();
  });

  it('restores only what the cascade removed, not a child deleted earlier', async () => {
    const h = createHarness();
    asProgrammer(h);
    const { page } = await skeleton(h);
    const kept = await createNode(h, {
      node_kind: 'question',
      parent_id: page,
      ref: 'Q_KEPT',
      question_type: 'text',
    });
    const earlier = await createNode(h, {
      node_kind: 'question',
      parent_id: page,
      ref: 'Q_EARLIER',
      question_type: 'text',
    });
    // Deleted on its own, a day before somebody deletes the page.
    await deleteNode(
      req(`/api/v1/nodes/${id(earlier)}`, { method: 'DELETE', headers: ifMatch(h) }),
      params({ id: id(earlier) }),
    );
    h.nowMs += 86_400_000;
    await deleteNode(
      req(`/api/v1/nodes/${page}`, { method: 'DELETE', headers: ifMatch(h) }),
      params({ id: page }),
    );

    const restored = await readJson(
      await undeleteNode(
        req(`/api/v1/nodes/${page}/undelete`, { method: 'POST', headers: ifMatch(h) }),
        params({ id: page }),
      ),
    );
    expect(restored.status).toBe(200);
    expect((restored.body['restored'] as { id: string }[]).map((row) => row.id)).toEqual([
      page,
      id(kept),
    ]);
    // Undo that restored more than the delete removed would be worse than undo that restores less.
    expect(h.data.nodes.find((row) => row.id === id(earlier))?.deleted_at).not.toBeNull();
  });

  it('rejects an unknown cascade_rules value', async () => {
    const h = createHarness();
    asProgrammer(h);
    const { page } = await skeleton(h);
    const bad = await readJson(
      await deleteNode(
        req(`/api/v1/nodes/${page}?cascade_rules=burn`, { method: 'DELETE', headers: ifMatch(h) }),
        params({ id: page }),
      ),
    );
    expect(bad.status).toBe(422);
    expect(detailCodes(bad.body)).toContain('invalid_value');
  });

  it('refuses to undelete a live node', async () => {
    const h = createHarness();
    asProgrammer(h);
    const { page } = await skeleton(h);
    const live = await readJson(
      await undeleteNode(
        req(`/api/v1/nodes/${page}/undelete`, { method: 'POST', headers: ifMatch(h) }),
        params({ id: page }),
      ),
    );
    expect(live.status).toBe(409);
    expect(envelopeCode(live.body)).toBe('illegal_transition');
  });
});

/* ========================================================================== */
/* Duplicate                                                                  */
/* ========================================================================== */

describe('POST /api/v1/nodes/:id/duplicate', () => {
  it('copies the subtree with new ids and refs, remaps rules inside it, and copies none pointing in', async () => {
    const h = createHarness();
    asProgrammer(h);
    const { block, page } = await skeleton(h);
    const first = await createNode(h, {
      node_kind: 'question',
      parent_id: page,
      ref: 'QA',
      question_type: 'text',
    });
    const second = await createNode(h, {
      node_kind: 'question',
      parent_id: page,
      ref: 'QB',
      question_type: 'text',
    });
    const qa = id(first);
    const qb = id(second);
    const qaVariable = (first.body['variables_created'] as { id: string }[])[0]?.id as string;

    // INSIDE the subtree: QA gates QB. Both are copied, so the copy's QA must gate the copy's QB.
    const inside = h.data.seedRule({
      org_id: h.ids.orgA,
      survey_version_id: h.ids.draftA,
      kind: 'display',
      target_kind: 'node',
      target_node_id: qb,
      condition: { op: 'var', id: qaVariable },
      effect: { action: 'hide' },
      depends_on_node_ids: [qa],
      depends_on_variable_ids: [qaVariable],
    });
    // POINTING IN: a page OUTSIDE the subtree reads QA. Copying it would double an effect on a
    // page the author did not touch.
    const outside = await createNode(h, { node_kind: 'page', parent_id: block, ref: 'PG_OUT' });
    const pointingIn = h.data.seedRule({
      org_id: h.ids.orgA,
      survey_version_id: h.ids.draftA,
      kind: 'display',
      target_kind: 'node',
      target_node_id: id(outside),
      condition: {},
      effect: { action: 'hide' },
      depends_on_node_ids: [qa],
    });

    const copy = await readJson(
      await duplicateNode(
        req(`/api/v1/nodes/${page}/duplicate`, {
          method: 'POST',
          body: { ref: 'PG1_COPY', into_parent_id: block },
          headers: ifMatch(h),
        }),
        params({ id: page }),
      ),
    );
    expect(copy.status).toBe(201);
    const nodes = copy.body['nodes'] as { id: string; ref: string | null; node_kind: string }[];
    expect(nodes.map((row) => row.ref)).toEqual(['PG1_COPY', 'QA_2', 'QB_2']);
    // New ids, always: two questions in one version cannot share an id or an export column.
    expect(nodes.map((row) => row.id)).not.toContain(page);
    expect(nodes.map((row) => row.id)).not.toContain(qa);

    // The copy's variables are its own, named for its own refs.
    expect(names(copy, 'variables_created')).toEqual(['QA_2', 'QB_2']);

    const rules = copy.body['rules_created'] as {
      id: string;
      target_node_id: string;
      depends_on_node_ids: string[];
      depends_on_variable_ids: string[];
      condition: { id?: string };
    }[];
    expect(rules).toHaveLength(1);
    expect(rules[0]?.id).not.toBe(inside.id);
    const copiedQa = nodes.find((row) => row.ref === 'QA_2')?.id;
    const copiedQb = nodes.find((row) => row.ref === 'QB_2')?.id;
    expect(rules[0]?.target_node_id).toBe(copiedQb);
    expect(rules[0]?.depends_on_node_ids).toEqual([copiedQa]);
    // The AST's variable id is remapped too, so the copy reads the COPY's column.
    const copiedVariable = (copy.body['variables_created'] as { id: string; name: string }[]).find(
      (row) => row.name === 'QA_2',
    )?.id;
    expect(rules[0]?.condition.id).toBe(copiedVariable);
    expect(rules[0]?.depends_on_variable_ids).toEqual([copiedVariable]);
    // And the inbound rule was not copied.
    expect(h.data.rules.filter((row) => row.deleted_at === null)).toHaveLength(3);
    expect(h.data.rules.some((row) => row.id === pointingIn.id)).toBe(true);
  });

  it('refuses a ref that is already taken', async () => {
    const h = createHarness();
    asProgrammer(h);
    const { page } = await skeleton(h);
    const taken = await readJson(
      await duplicateNode(
        req(`/api/v1/nodes/${page}/duplicate`, {
          method: 'POST',
          body: { ref: 'PG1' },
          headers: ifMatch(h),
        }),
        params({ id: page }),
      ),
    );
    expect(taken.status).toBe(409);
    expect(envelopeCode(taken.body)).toBe('already_exists');
  });
});

/* ========================================================================== */
/* The lock, the freeze, and who may write                                    */
/* ========================================================================== */

describe('the guards every §2.5 write shares', () => {
  it('a missing If-Match is 428 and a stale one is 412 with the current revision', async () => {
    const h = createHarness();
    asProgrammer(h);
    const missing = await readJson(
      await postNode(
        req(`/api/v1/versions/${h.ids.draftA}/nodes`, {
          method: 'POST',
          body: { node_kind: 'block', parent_id: null, ref: 'B9' },
        }),
        params({ id: h.ids.draftA }),
      ),
    );
    expect(missing.status).toBe(428);
    expect(envelopeCode(missing.body)).toBe('precondition_required');

    const stale = await readJson(
      await postNode(
        req(`/api/v1/versions/${h.ids.draftA}/nodes`, {
          method: 'POST',
          body: { node_kind: 'block', parent_id: null, ref: 'B9' },
          headers: { 'If-Match': `W/"999.${String(h.nowMs)}"` },
        }),
        params({ id: h.ids.draftA }),
      ),
    );
    expect(stale.status).toBe(412);
    expect(envelopeCode(stale.body)).toBe('revision_conflict');
    expect(stale.body['error']).toEqual(
      expect.objectContaining({ current_revision: expect.any(Number) }),
    );
    expect(h.data.nodes.filter((row) => row.ref === 'B9')).toHaveLength(0);
  });

  it('every write bumps the version revision, and hands back the new ETag', async () => {
    const h = createHarness();
    asProgrammer(h);
    const before = h.data.versions.find((v) => v.id === h.ids.draftA)?.revision ?? 0;
    const created = await createNode(h, { node_kind: 'block', parent_id: null, ref: 'B10' });
    const after = h.data.versions.find((v) => v.id === h.ids.draftA)?.revision ?? 0;
    expect(after).toBe(before + 1);
    expect(created.headers.get('ETag')).toBe(`W/"${String(after)}.${String(h.nowMs)}"`);
  });

  it('answers 409 frozen_version on every write to a non-draft, before the lock', async () => {
    const h = createHarness();
    asProgrammer(h);
    const frozen = h.data.seedVersionAt({
      orgId: h.ids.orgA,
      surveyId: h.ids.surveyA,
      versionNo: 7,
      status: 'production',
      createdBy: h.ids.ownerA,
    });
    const seeded = h.data.seedNode({
      org_id: h.ids.orgA,
      survey_version_id: frozen.id,
      node_kind: 'block',
      ref: 'FROZEN',
    });

    // No `If-Match` at all: the frozen answer must not depend on the lock.
    const created = await readJson(
      await postNode(
        req(`/api/v1/versions/${frozen.id}/nodes`, {
          method: 'POST',
          body: { node_kind: 'page', parent_id: seeded.id, ref: 'PGF' },
        }),
        params({ id: frozen.id }),
      ),
    );
    expect(created.status).toBe(409);
    expect(envelopeCode(created.body)).toBe('frozen_version');

    for (const attempt of [
      patchNode(
        req(`/api/v1/nodes/${seeded.id}`, { method: 'PATCH', body: { ref: 'NEW' } }),
        params({ id: seeded.id }),
      ),
      moveNode(
        req(`/api/v1/nodes/${seeded.id}/move`, { method: 'POST', body: { parent_id: null } }),
        params({ id: seeded.id }),
      ),
      deleteNode(req(`/api/v1/nodes/${seeded.id}`, { method: 'DELETE' }), params({ id: seeded.id })),
      duplicateNode(
        req(`/api/v1/nodes/${seeded.id}/duplicate`, { method: 'POST', body: { ref: 'COPY' } }),
        params({ id: seeded.id }),
      ),
    ]) {
      const { status, body } = await readJson(await attempt);
      expect(status).toBe(409);
      expect(envelopeCode(body)).toBe('frozen_version');
    }
  });

  it('a viewer cannot write, a reviewer can read, another org sees 404', async () => {
    const h = createHarness();
    asProgrammer(h);
    const { page } = await skeleton(h);

    h.as({ userId: h.ids.viewerA, activeOrgId: h.ids.orgA });
    const asViewer = await readJson(
      await postNode(
        req(`/api/v1/versions/${h.ids.draftA}/nodes`, {
          method: 'POST',
          body: { node_kind: 'page', parent_id: page, ref: 'PGV' },
          headers: ifMatch(h),
        }),
        params({ id: h.ids.draftA }),
      ),
    );
    expect(asViewer.status).toBe(403);
    expect(detailCodes(asViewer.body)).toContain('role_required');

    h.as({ userId: h.ids.reviewerA, activeOrgId: h.ids.orgA });
    const read = await readJson(await getNode(req(`/api/v1/nodes/${page}`), params({ id: page })));
    expect(read.status).toBe(200);
    // The read issues the version's ETag, so a reviewer's client can hand it to a programmer's.
    expect(read.headers.get('ETag')).toMatch(/^W\/"\d+\.\d+"$/);

    h.as({ userId: h.ids.ownerB, activeOrgId: h.ids.orgB });
    const crossOrgRead = await readJson(
      await getNode(req(`/api/v1/nodes/${page}`), params({ id: page })),
    );
    expect(crossOrgRead.status).toBe(404);
    const crossOrgWrite = await readJson(
      await postNode(
        req(`/api/v1/versions/${h.ids.draftA}/nodes`, {
          method: 'POST',
          body: { node_kind: 'page', parent_id: page, ref: 'PGX' },
          headers: { 'If-Match': `W/"1.${String(h.nowMs)}"` },
        }),
        params({ id: h.ids.draftA }),
      ),
    );
    expect(crossOrgWrite.status).toBe(404);
    expect(envelopeCode(crossOrgWrite.body)).toBe('not_found');
  });

  it('GET /nodes/:id serves the body lazily, and only what was asked for', async () => {
    const h = createHarness();
    asProgrammer(h);
    const { page } = await skeleton(h);
    const question = await createNode(h, {
      node_kind: 'question',
      parent_id: page,
      ref: 'Q1200',
      question_type: 'multi_select',
    });
    const nodeId = id(question);
    await readJson(
      await postItems(
        req(`/api/v1/nodes/${nodeId}/items`, {
          method: 'POST',
          body: { item_kind: 'option', ref: 'o1', code: 1 },
          headers: ifMatch(h),
        }),
        params({ id: nodeId }),
      ),
    );

    const bare = await readJson(await getNode(req(`/api/v1/nodes/${nodeId}`), params({ id: nodeId })));
    expect(bare.body['items']).toBeUndefined();
    const full = await readJson(
      await getNode(req(`/api/v1/nodes/${nodeId}?include=items,rules`), params({ id: nodeId })),
    );
    expect((full.body['items'] as { ref: string }[]).map((row) => row.ref)).toEqual(['o1']);
    expect(full.body['rules']).toEqual([]);

    const bad = await readJson(
      await getNode(req(`/api/v1/nodes/${nodeId}?include=everything`), params({ id: nodeId })),
    );
    expect(bad.status).toBe(422);
    expect(detailCodes(bad.body)).toContain('invalid_value');
  });
});
