/**
 * `PUT /api/v1/nodes/:id/cells` — mixed matrices (API §2.5, C §5.2).
 *
 * The acceptance line this suite exists for is P1-05's, reached through P1-03's API: a matrix with
 * rows `[numeric, text, single_select over columns]` emits exactly `Mr1 : number`, `Mr2 : text`,
 * `Mr3 : enum` — three plugins' worth of typed variables, none of which the matrix plugin knows how
 * to produce. So the assertions are on the emitted VARIABLE TYPES, not on the cell rows: the cells
 * are the input, the manifest is the output, and the output is the export contract.
 */

import { describe, expect, it } from 'vitest';
import { POST as postNode } from '@/app/api/v1/versions/[id]/nodes/route';
import { POST as postItem } from '@/app/api/v1/nodes/[id]/items/route';
import { GET as getCells, PUT as putCells } from '@/app/api/v1/nodes/[id]/cells/route';
import { createHarness, params, readJson, req, type Harness } from '@/test/harness';

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

async function node(h: Harness, body: Record<string, unknown>): Promise<string> {
  const { body: out } = await readJson(
    await postNode(
      req(`/api/v1/versions/${h.ids.draftA}/nodes`, { method: 'POST', body, headers: ifMatch(h) }),
      params({ id: h.ids.draftA }),
    ),
  );
  return (out['node'] as { id: string }).id;
}

/** A 3x2 matrix: three rows to give each of the mixed controls one, two shared columns. */
async function matrix(h: Harness): Promise<string> {
  h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
  const block = await node(h, { node_kind: 'block', parent_id: null, ref: 'MB' });
  const page = await node(h, { node_kind: 'page', parent_id: block, ref: 'MP' });
  const question = await node(h, {
    node_kind: 'question',
    parent_id: page,
    ref: 'M1',
    question_type: 'matrix',
    required: true,
  });
  for (const [index, ref] of ['r1', 'r2', 'r3'].entries()) {
    await readJson(
      await postItem(
        req(`/api/v1/nodes/${question}/items`, {
          method: 'POST',
          body: { item_kind: 'row', ref, code: index + 1, label: `m1.${ref}` },
          headers: ifMatch(h),
        }),
        params({ id: question }),
      ),
    );
  }
  for (const [index, ref] of ['c1', 'c2'].entries()) {
    await readJson(
      await postItem(
        req(`/api/v1/nodes/${question}/items`, {
          method: 'POST',
          body: { item_kind: 'column', ref, code: index + 1, label: `m1.${ref}` },
          headers: ifMatch(h),
        }),
        params({ id: question }),
      ),
    );
  }
  return question;
}

function typesOf(h: Harness, nodeId: string): { name: string; vtype: string }[] {
  return h.data.variables
    .filter((row) => row.deleted_at === null && row.source_question_id === nodeId)
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .map((row) => ({ name: row.name, vtype: row.vtype }));
}

async function put(h: Harness, nodeId: string, body: Record<string, unknown>) {
  return readJson(
    await putCells(
      req(`/api/v1/nodes/${nodeId}/cells`, { method: 'PUT', body, headers: ifMatch(h) }),
      params({ id: nodeId }),
    ),
  );
}

describe('PUT /api/v1/nodes/:id/cells', () => {
  it('gives each row the type its own control declares', async () => {
    const h = createHarness();
    const nodeId = await matrix(h);
    // With no overrides every row is a single-select over the shared columns, which is what an
    // un-mixed matrix is.
    expect(typesOf(h, nodeId)).toEqual([
      { name: 'M1r1', vtype: 'enum' },
      { name: 'M1r2', vtype: 'enum' },
      { name: 'M1r3', vtype: 'enum' },
    ]);

    const mixed = await put(h, nodeId, {
      cells: [
        { row_ref: 'r1', control: { question_type: 'numeric', config: { display: 'input', decimals: 0 } } },
        { row_ref: 'r2', control: { question_type: 'text' } },
      ],
    });
    expect(mixed.status).toBe(200);
    // Row 1 numeric, row 2 text, row 3 still the matrix default. The matrix plugin produced none
    // of these types; it composed three other plugins and rescoped their names.
    expect(typesOf(h, nodeId)).toEqual([
      { name: 'M1r1', vtype: 'number' },
      { name: 'M1r2', vtype: 'text' },
      { name: 'M1r3', vtype: 'enum' },
    ]);
    expect((mixed.body['variables_changed'] as { name: string }[]).map((row) => row.name)).toEqual([
      'M1r1',
      'M1r2',
      'M1r3',
    ]);
    // The ids did not move: the cell's variable is sourced from the ROW, and the row is the same.
    const ids = h.data.variables
      .filter((row) => row.deleted_at === null && row.source_question_id === nodeId)
      .map((row) => row.id);
    expect(new Set(ids).size).toBe(3);
  });

  it('is a whole-set replace, and reading it back speaks refs', async () => {
    const h = createHarness();
    const nodeId = await matrix(h);
    await put(h, nodeId, {
      cells: [
        { row_ref: 'r1', control: { question_type: 'numeric' } },
        { row_ref: 'r2', control: { question_type: 'text' } },
      ],
    });
    const read = await readJson(
      await getCells(req(`/api/v1/nodes/${nodeId}/cells`), params({ id: nodeId })),
    );
    expect(read.status).toBe(200);
    expect(
      (read.body['cells'] as { row_ref: string; control: { question_type: string } }[]).map(
        (cell) => [cell.row_ref, cell.control.question_type],
      ),
    ).toEqual([
      ['r1', 'numeric'],
      ['r2', 'text'],
    ]);

    // PUT replaces: dropping r2 from the body drops its override, and its row goes back to the
    // matrix default.
    const narrowed = await put(h, nodeId, {
      cells: [{ row_ref: 'r1', control: { question_type: 'numeric' } }],
    });
    expect(narrowed.status).toBe(200);
    expect((narrowed.body['cells'] as unknown[]).length).toBe(1);
    expect(typesOf(h, nodeId)).toEqual([
      { name: 'M1r1', vtype: 'number' },
      { name: 'M1r2', vtype: 'enum' },
      { name: 'M1r3', vtype: 'enum' },
    ]);

    // …and an empty set clears them all.
    const cleared = await put(h, nodeId, { cells: [] });
    expect(cleared.status).toBe(200);
    expect(cleared.body['cells']).toEqual([]);
    expect(h.data.cells.filter((row) => row.question_id === nodeId)).toHaveLength(0);
  });

  it('validates the whole set before writing anything, naming each offending index', async () => {
    const h = createHarness();
    const nodeId = await matrix(h);
    const bad = await put(h, nodeId, {
      cells: [
        { row_ref: 'r1', control: { question_type: 'numeric' } },
        { row_ref: 'nope', control: { question_type: 'numeric' } },
        { row_ref: 'r2', control: { question_type: 'matrix' } },
        { row_ref: 'r3', control: { question_type: 'no_such_plugin' } },
      ],
    });
    expect(bad.status).toBe(422);
    expect(detailCodes(bad.body)).toEqual([
      'unknown_item',
      'not_composable',
      'unknown_question_type',
    ]);
    const paths = (bad.body['error'] as { details: { path: string }[] }).details.map((d) => d.path);
    expect(paths[0]).toBe('cells.1.row_ref');
    // Nothing stored: the first cell was valid and is not there either.
    expect(h.data.cells).toHaveLength(0);
  });

  it('refuses use_columns on a per-cell override', async () => {
    const h = createHarness();
    const nodeId = await matrix(h);
    const bad = await put(h, nodeId, {
      cells: [
        {
          row_ref: 'r1',
          column_ref: 'c1',
          control: { question_type: 'single_select', use_columns: true },
        },
      ],
    });
    expect(bad.status).toBe(422);
    expect(detailCodes(bad.body)).toContain('use_columns_is_row_level');
  });

  it('refuses cells on a non-question, on a frozen version, and to a viewer', async () => {
    const h = createHarness();
    const nodeId = await matrix(h);

    const block = await node(h, { node_kind: 'block', parent_id: null, ref: 'MB2' });
    const notAQuestion = await put(h, block, { cells: [] });
    expect(notAQuestion.status).toBe(422);
    expect(detailCodes(notAQuestion.body)).toContain('not_a_question');

    h.as({ userId: h.ids.viewerA, activeOrgId: h.ids.orgA });
    const asViewer = await put(h, nodeId, { cells: [] });
    expect(asViewer.status).toBe(403);

    h.as({ userId: h.ids.ownerB, activeOrgId: h.ids.orgB });
    const crossOrg = await put(h, nodeId, { cells: [] });
    expect(crossOrg.status).toBe(404);

    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    const frozen = h.data.seedVersionAt({
      orgId: h.ids.orgA,
      surveyId: h.ids.surveyA,
      versionNo: 11,
      status: 'production',
      createdBy: h.ids.ownerA,
    });
    const frozenQuestion = h.data.seedNode({
      org_id: h.ids.orgA,
      survey_version_id: frozen.id,
      node_kind: 'question',
      ref: 'FM',
      question_type: 'matrix',
      required: true,
    });
    const onFrozen = await put(h, frozenQuestion.id, { cells: [] });
    expect(onFrozen.status).toBe(409);
    expect(envelopeCode(onFrozen.body)).toBe('frozen_version');
  });
});
