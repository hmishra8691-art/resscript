/**
 * The tree editor, wired — P1-03's acceptance criteria, one test each.
 *
 * The API routes these mount against are being implemented in parallel, so every request is
 * served by a stub keyed on method + path, and the assertions are about REQUESTS: how many, to
 * where, with what body. That is deliberate rather than convenient — the acceptance line is "the
 * database shows one `UPDATE` on `content.nodes` per drag", and the client-side half of it is
 * exactly "one `POST /nodes/{id}/move` per drop, with one anchor". A test that asserted on rendered
 * order would pass just as happily with sixty requests behind it.
 *
 * The fixture is the acceptance survey: 3 blocks, 12 pages, 40 questions.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SurveyTreePane } from '@/components/tree/SurveyTreePane';
import type { TreeRowWire } from '@/components/tree/wire';

/* -------------------------------------------------------------------------- */
/* The fixture                                                                */
/* -------------------------------------------------------------------------- */

const VERSION_ID = 'sv_01JC8KX9Q2M4V7ZB3F0T5N6R2W';
const ETAG = 'W/"41.1755680123456"';

/** 3 blocks × 4 pages, 40 questions spread over them (4,4,4,4 in block 1; 3s elsewhere). */
function buildTree(): readonly TreeRowWire[] {
  const rows: TreeRowWire[] = [];
  let questionNo = 0;
  for (let block = 0; block < 3; block += 1) {
    const blockId = 'blk_' + String(block);
    rows.push({
      id: blockId,
      kind: 'block',
      parent_id: null,
      sort_key: 'a' + String(block),
      ref: 'B' + String(block + 1),
      label_preview: 'Block ' + String(block + 1),
    });
    for (let page = 0; page < 4; page += 1) {
      const pageId = 'pg_' + String(block) + '_' + String(page);
      rows.push({
        id: pageId,
        kind: 'page',
        parent_id: blockId,
        sort_key: 'a' + String(page),
        ref: 'P' + String(block * 4 + page + 1),
        label_preview: '',
      });
      const perPage = block === 0 ? 4 : page < 2 ? 4 : 3;
      for (let question = 0; question < perPage && questionNo < 40; question += 1) {
        questionNo += 1;
        rows.push({
          id: 'qst_' + String(questionNo),
          kind: 'question',
          parent_id: pageId,
          sort_key: 'a' + String(question),
          ref: 'Q' + String(questionNo),
          label_preview: 'Question ' + String(questionNo),
          question_type: 'single_select',
          required: questionNo === 1,
          ...(questionNo === 1
            ? {
                // The shape the route serves: kind + the effect's action, no printed source yet.
                rule_summaries: [
                  { id: 'rul_1', kind: 'display', action: 'show', evaluation: 'on_change' },
                  { id: 'rul_2', kind: 'terminate', action: 'terminate', evaluation: 'on_submit' },
                ],
                diagnostic_counts: { errors: 1, warnings: 2 },
                flags: { pii: true, custom_js: false },
              }
            : {}),
        });
      }
    }
  }
  return rows;
}

const TREE = buildTree();

/* -------------------------------------------------------------------------- */
/* The stub API                                                               */
/* -------------------------------------------------------------------------- */

interface Recorded {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
  readonly ifMatch: string | null;
}

interface Stubbed {
  readonly status?: number;
  readonly body?: unknown;
  readonly etag?: string | null;
}

let calls: Recorded[] = [];
let route: (call: Recorded) => Stubbed | undefined = () => undefined;

function reply(body: unknown, status = 200, etag: string | null = ETAG): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      ...(etag === null ? {} : { etag }),
    },
  });
}

function apiError(status: number, code: string, extra: Record<string, unknown> = {}): Stubbed {
  return {
    status,
    body: { error: { code, message: code + ' from the stub', details: [], ...extra } },
    etag: null,
  };
}

beforeEach(() => {
  calls = [];
  route = () => undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
      const path = String(input).replace('/api/v1', '');
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const call: Recorded = {
        method: init?.method ?? 'GET',
        path,
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
        ifMatch: headers['If-Match'] ?? null,
      };
      calls.push(call);

      const stubbed = route(call);
      if (stubbed !== undefined) {
        return reply(stubbed.body ?? {}, stubbed.status ?? 200, stubbed.etag ?? ETAG);
      }
      // The ETag's issuer (API §1.7) and the outline. Everything else answers 200 with a fresh
      // revision, which is the "nothing went wrong" path.
      if (call.method === 'GET' && path === '/versions/' + VERSION_ID) {
        return reply({ id: VERSION_ID, status: 'draft', revision: 41 });
      }
      if (call.method === 'GET' && path.startsWith('/versions/' + VERSION_ID + '/tree')) {
        return reply({ survey_version_id: VERSION_ID, revision: 41, fields: 'summary', data: TREE });
      }
      if (call.method === 'GET' && path.startsWith('/nodes/')) {
        // The envelope `GET /nodes/{id}` really answers with: the row, plus each include as a
        // sibling of it.
        const id = path.split('/')[2]?.split('?')[0] ?? '';
        return reply({
          node: { id, node_kind: 'question', ref: 'Q?', question_type: 'single_select', config: {} },
          items: [],
          variables: [],
        });
      }
      return reply({}, 200, 'W/"42.1755680199999"');
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function movesFor(nodeId: string): readonly Recorded[] {
  return calls.filter((call) => call.method === 'POST' && call.path === '/nodes/' + nodeId + '/move');
}

function visibleRowIds(): readonly string[] {
  return screen
    .getAllByRole('treeitem')
    .map((element) => element.getAttribute('data-testid')?.replace('tree-row-', '') ?? '');
}

async function mount(status = 'draft'): Promise<void> {
  render(
    <SurveyTreePane
      versions={[{ id: VERSION_ID, version_no: 1, status, revision: 41 }]}
      defaultLanguage="en"
    />,
  );
  await screen.findByTestId('survey-tree');
}

/** Open B1 → P1 so Q1…Q4 are on screen. */
async function openFirstPage(): Promise<void> {
  fireEvent.click(screen.getByLabelText('Expand P1'));
  await screen.findByTestId('tree-row-qst_1');
}

/* -------------------------------------------------------------------------- */

describe('SurveyTreePane — the outline', () => {
  it('renders the 3-block / 12-page / 40-question survey with its badges', async () => {
    await mount();

    // Root blocks expanded, pages collapsed — §3.3's opening outline.
    expect(visibleRowIds()).toHaveLength(15);
    expect(screen.getByTestId('tree-counts')).toHaveTextContent(
      '3 blocks · 12 pages · 40 questions',
    );

    await openFirstPage();
    const row = screen.getByTestId('tree-row-qst_1');
    expect(within(row).getByTestId('tree-type-qst_1')).toHaveTextContent('single_select');
    expect(within(row).getByTestId('tree-required-qst_1')).toBeInTheDocument();
    expect(within(row).getByTestId('tree-rulecount-qst_1')).toHaveTextContent('2');
    expect(within(row).getByTestId('tree-errors-qst_1')).toHaveTextContent('1');
    expect(within(row).getByTestId('tree-warnings-qst_1')).toHaveTextContent('2');
    // The printed rule, under the node it governs (§3.1) — not on hover.
    expect(within(row).getByTestId('tree-rules-qst_1')).toHaveTextContent('show');
    // A question row carries the ARIA the keyboard and a screen reader both navigate by.
    expect(row).toHaveAttribute('aria-level', '3');
  });

  it('collapses and expands a container', async () => {
    await mount();
    fireEvent.click(screen.getByLabelText('Collapse B1'));
    expect(screen.queryByTestId('tree-row-pg_0_0')).toBeNull();
    fireEvent.click(screen.getByLabelText('Expand B1'));
    expect(screen.getByTestId('tree-row-pg_0_0')).toBeInTheDocument();
  });
});

describe('SurveyTreePane — one drag, one write', () => {
  it('sends exactly ONE move request, with the computed anchor', async () => {
    await mount();
    await openFirstPage();

    fireEvent.dragStart(screen.getByTestId('tree-row-qst_1'));
    fireEvent.drop(screen.getByTestId('tree-row-qst_3'));

    await waitFor(() => {
      expect(movesFor('qst_1')).toHaveLength(1);
    });
    const move = movesFor('qst_1')[0];
    expect(move?.body).toEqual({ parent_id: 'pg_0_0', after_id: 'qst_3' });
    expect(move?.ifMatch).toBe(ETAG);
    // No re-sequence of the siblings: the whole point of the fractional sort_key.
    expect(calls.filter((call) => call.path.endsWith('/move'))).toHaveLength(1);
    // And the row moved on screen before any refetch — optimistic, one frame.
    expect(visibleRowIds().slice(1, 6)).toEqual(['pg_0_0', 'qst_2', 'qst_3', 'qst_1', 'qst_4']);
  });

  it('produces the SAME request from the keyboard as from the drag', async () => {
    await mount();
    await openFirstPage();

    // Selection follows focus; ⌥↓ then moves the selected row (UI §1.3).
    fireEvent.click(screen.getByTestId('tree-row-qst_1'));
    fireEvent.keyDown(screen.getByTestId('tree-row-qst_1'), { key: 'ArrowDown', altKey: true });

    await waitFor(() => {
      expect(movesFor('qst_1')).toHaveLength(1);
    });
    expect(movesFor('qst_1')[0]?.body).toEqual({ parent_id: 'pg_0_0', after_id: 'qst_2' });

    // The visible button is the same path, not a second implementation.
    fireEvent.click(screen.getByTestId('tree-up-qst_1'));
    await waitFor(() => {
      expect(movesFor('qst_1')).toHaveLength(2);
    });
    expect(movesFor('qst_1')[1]?.body).toEqual({ parent_id: 'pg_0_0', before_id: 'qst_2' });
  });

  it('nests a question into a page in one request', async () => {
    await mount();
    await openFirstPage();
    fireEvent.dragStart(screen.getByTestId('tree-row-qst_1'));
    fireEvent.drop(screen.getByTestId('tree-row-pg_0_1'));
    await waitFor(() => {
      expect(movesFor('qst_1')).toHaveLength(1);
    });
    expect(movesFor('qst_1')[0]?.body).toEqual({ parent_id: 'pg_0_1', after_id: 'qst_8' });
  });

  it('refuses a drop into the dragged node’s own subtree WITHOUT a request', async () => {
    await mount();
    fireEvent.dragStart(screen.getByTestId('tree-row-blk_0'));
    fireEvent.drop(screen.getByTestId('tree-row-pg_0_0'));

    await waitFor(() => {
      expect(screen.getByTestId('tree-announcement')).toHaveTextContent('inside itself');
    });
    expect(calls.filter((call) => call.path.includes('/move'))).toHaveLength(0);
  });

  it('surfaces the server’s refusal and rolls the tree back', async () => {
    await mount();
    await openFirstPage();
    const before = visibleRowIds();
    route = (call) =>
      call.path === '/nodes/qst_1/move'
        ? apiError(422, 'validation_failed')
        : undefined;

    fireEvent.dragStart(screen.getByTestId('tree-row-qst_1'));
    fireEvent.drop(screen.getByTestId('tree-row-qst_3'));

    await waitFor(() => {
      expect(screen.getByTestId('tree-error')).toHaveTextContent('validation_failed');
    });
    expect(visibleRowIds()).toEqual(before);
    expect(movesFor('qst_1')).toHaveLength(1);
  });
});

describe('SurveyTreePane — soft delete is the undo buffer', () => {
  it('hides the node, offers Undo, and restores it', async () => {
    await mount();
    await openFirstPage();
    fireEvent.click(screen.getByTestId('tree-row-qst_2'));
    fireEvent.click(screen.getByTestId('tree-delete-qst_2'));

    await waitFor(() => {
      expect(screen.getByTestId('undo-toast')).toBeInTheDocument();
    });
    // `cascade_rules=orphan` keeps the rules that target it, so undo restores their target.
    const del = calls.find((call) => call.method === 'DELETE');
    expect(del?.path).toBe('/nodes/qst_2?cascade_rules=orphan');
    expect(screen.queryByTestId('tree-row-qst_2')).toBeNull();

    // Hidden, not gone: the toggle reveals it dimmed, with its own Undo.
    fireEvent.click(screen.getByTestId('tree-show-deleted'));
    expect(screen.getByTestId('tree-row-qst_2')).toHaveAttribute('data-deleted', 'true');
    expect(screen.getByTestId('tree-deleted-qst_2')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('undo-delete'));
    await waitFor(() => {
      expect(calls.some((call) => call.path === '/nodes/qst_2/undelete')).toBe(true);
    });
    fireEvent.click(screen.getByTestId('tree-show-deleted'));
    expect(screen.getByTestId('tree-row-qst_2')).not.toHaveAttribute('data-deleted');
  });
});

describe('SurveyTreePane — the two refusals', () => {
  it('goes read-only with "clone a new draft to edit" on 409 frozen_version', async () => {
    await mount();
    await openFirstPage();
    route = (call) =>
      call.method === 'POST' && call.path.endsWith('/move')
        ? apiError(409, 'frozen_version')
        : undefined;

    fireEvent.dragStart(screen.getByTestId('tree-row-qst_1'));
    fireEvent.drop(screen.getByTestId('tree-row-qst_3'));

    await waitFor(() => {
      expect(screen.getByTestId('tree-frozen')).toHaveTextContent('clone a new draft to edit');
    });
    // Read-only means read-only: the rows are no longer draggable and the controls are disabled.
    expect(screen.getByTestId('tree-row-qst_1')).toHaveAttribute('draggable', 'false');
    fireEvent.click(screen.getByTestId('tree-row-qst_1'));
    expect(screen.getByTestId('tree-up-qst_1')).toBeDisabled();
    expect(screen.queryByTestId('conflict-dialog')).toBeNull();
  });

  it('starts read-only when the selected version is already published', async () => {
    await mount('published');
    expect(screen.getByTestId('tree-frozen')).toHaveTextContent('clone a new draft to edit');
    expect(screen.getByTestId('add-node').closest('fieldset')).toBeDisabled();
  });

  it('opens the conflict dialog on 412 and does NOT retry', async () => {
    await mount();
    await openFirstPage();
    const before = visibleRowIds();
    route = (call) =>
      call.method === 'POST' && call.path.endsWith('/move')
        ? apiError(412, 'revision_conflict', {
            current_revision: 47,
            details: [
              { path: null, code: 'expected_revision', message: '41' },
              { path: null, code: 'current_revision', message: '47' },
            ],
            changed_since: [{ node_id: 'qst_9', action: 'node.updated', actor: 'usr_2' }],
          })
        : undefined;

    fireEvent.dragStart(screen.getByTestId('tree-row-qst_1'));
    fireEvent.drop(screen.getByTestId('tree-row-qst_3'));

    const dialog = await screen.findByTestId('conflict-dialog');
    expect(dialog).toHaveTextContent('Someone else changed this survey');
    expect(screen.getByTestId('conflict-mine')).toHaveTextContent('Q1 moved after Q3');
    expect(screen.getByTestId('conflict-my-revision')).toHaveTextContent('r41');
    expect(screen.getByTestId('conflict-their-revision')).toHaveTextContent('r47');

    // The assertion this test exists for: ONE attempt. No silent retry, no overwrite.
    expect(movesFor('qst_1')).toHaveLength(1);
    expect(visibleRowIds()).toEqual(before);
    // …and no "keep mine" escape hatch.
    expect(screen.queryByText(/keep mine/i)).toBeNull();

    const treeReads = calls.filter((call) => call.path.startsWith('/versions/' + VERSION_ID + '/tree'));
    fireEvent.click(screen.getByTestId('conflict-reload'));
    await waitFor(() => {
      expect(
        calls.filter((call) => call.path.startsWith('/versions/' + VERSION_ID + '/tree')).length,
      ).toBe(treeReads.length + 1);
    });
    expect(screen.queryByTestId('conflict-dialog')).toBeNull();
  });
});

describe('SurveyTreePane — building the survey', () => {
  it('adds a question next to the selection, in one request', async () => {
    await mount();
    await openFirstPage();
    fireEvent.click(screen.getByTestId('tree-row-qst_1'));

    fireEvent.change(screen.getByTestId('add-kind'), { target: { value: 'question' } });
    fireEvent.change(screen.getByTestId('add-type'), { target: { value: 'nps' } });
    fireEvent.change(screen.getByTestId('add-ref'), { target: { value: 'Q41' } });

    route = (call) =>
      call.path === '/versions/' + VERSION_ID + '/nodes'
        ? {
            status: 201,
            body: {
              // The node ROW, as the route returns it: `node_kind`, not `kind`.
              node: {
                id: 'qst_41',
                node_kind: 'question',
                parent_id: 'pg_0_0',
                sort_key: 'a0V',
                ref: 'Q41',
                question_type: 'nps',
                label_key: null,
              },
              variables_created: [
                { name: 'Q41', kind: 'response', vtype: 'number', export_column: 'Q41', pii: false },
              ],
            },
          }
        : undefined;

    fireEvent.click(screen.getByTestId('add-node'));
    await waitFor(() => {
      expect(calls.some((call) => call.path === '/versions/' + VERSION_ID + '/nodes')).toBe(true);
    });
    const created = calls.find((call) => call.path === '/versions/' + VERSION_ID + '/nodes');
    expect(created?.body).toEqual({
      node_kind: 'question',
      parent_id: 'pg_0_0',
      after_id: 'qst_1',
      ref: 'Q41',
      question_type: 'nps',
    });
    expect(created?.ifMatch).toBe(ETAG);
    // The created node joins the outline from the response, without a second tree read.
    expect(screen.getByTestId('tree-ref-qst_41')).toHaveTextContent('Q41');
    expect(
      calls.filter((call) => call.path.startsWith('/versions/' + VERSION_ID + '/tree')),
    ).toHaveLength(1);
  });

  it('refuses a node with no ref rather than creating an unnamed one', async () => {
    await mount();
    fireEvent.click(screen.getByTestId('add-node'));
    await waitFor(() => {
      expect(screen.getByTestId('tree-announcement')).toHaveTextContent('a ref is required');
    });
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  });
});
