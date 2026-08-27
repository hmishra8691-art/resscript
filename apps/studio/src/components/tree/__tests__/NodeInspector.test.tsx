/**
 * The inspector, the plugin editor shell, and the option list.
 *
 * The load-bearing assertions:
 *
 *  - the type picker is REGISTRY data — the test names `consent`, a plugin no file in
 *    `apps/studio` mentions, and asserts the picker offers it. That is P1-04's "adding a fourth
 *    plugin requires touching no file in apps/studio", asserted from the studio side;
 *  - a plugin editor's config change becomes ONE `PATCH /nodes/{id}` carrying the whole folded
 *    config, not a JSON-Patch document the API does not accept;
 *  - a 60-brand paste is ONE `items:bulk`;
 *  - reordering options is one `POST /items/{id}/move` that carries no code, and the codes on
 *    screen do not move with the rows (schema §5.1).
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FIRST_PARTY_PLUGINS } from '@resscript/question-kit/react';
import { apiFetch } from '@/lib/api-client';
import { NodeInspector } from '@/components/tree/NodeInspector';
import { TypePicker } from '@/components/tree/TypePicker';
import type { VersionWriter, WriteOptions } from '@/components/tree/useVersionWriter';

const ETAG = 'W/"41.1755680123456"';

/**
 * The envelope `GET /nodes/{id}` answers with: the node ROW (so `label_key`, not `label` — a node
 * names a translation), with the includes as siblings rather than as fields on it.
 */
const NODE_BODY = {
  node: {
    id: 'qst_1',
    node_kind: 'question',
    parent_id: 'pg_1',
    sort_key: 'a0',
    ref: 'Q1',
    label_key: 'Which of these brands have you bought?',
    required: true,
    question_type: 'single_select',
    config: { display: 'vertical', columns: 1 },
    flags: { pii: false, has_custom_js: false },
  },
  items: [
    { id: 'opt_1', item_kind: 'option', code: 10, label: 'Alpha' },
    { id: 'opt_2', item_kind: 'option', code: 20, label: 'Beta' },
    { id: 'opt_3', item_kind: 'option', code: 30, label: 'Gamma' },
  ],
  variables: [
    { name: 'Q1', kind: 'response', vtype: 'enum', export_column: 'Q1', pii: false },
    { name: 'Q1_other', kind: 'response', vtype: 'text', export_column: 'Q1_other', pii: true },
  ],
};

interface Recorded {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

let calls: Recorded[] = [];
let route: (call: Recorded) => { readonly status?: number; readonly body?: unknown } | undefined =
  () => undefined;

beforeEach(() => {
  calls = [];
  route = () => undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
      const path = String(input).replace('/api/v1', '');
      const call: Recorded = {
        method: init?.method ?? 'GET',
        path,
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      };
      calls.push(call);
      const stubbed = route(call);
      const body =
        stubbed?.body ??
        (call.method === 'GET' && path.startsWith('/nodes/qst_1?') ? NODE_BODY : {});
      return new Response(JSON.stringify(body), {
        status: stubbed?.status ?? 200,
        headers: { 'content-type': 'application/json', etag: ETAG },
      });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/**
 * A writer that really talks to the stubbed routes — the refusal paths are
 * `SurveyTreePane.test.tsx`'s subject, so what matters here is the request each control produces.
 */
function stubWriter(overrides: Partial<VersionWriter> = {}): VersionWriter {
  return {
    readOnly: false,
    conflict: null,
    error: null,
    busy: false,
    async write<T>(path: string, options: WriteOptions): Promise<T | null> {
      const response = await apiFetch<T>(path, {
        method: options.method,
        ifMatch: ETAG,
        ...(options.body === undefined ? {} : { body: options.body }),
      });
      return response.data;
    },
    dismissConflict: () => undefined,
    clearError: () => undefined,
    ...overrides,
  };
}

async function mountInspector(writer: VersionWriter = stubWriter()): Promise<void> {
  render(
    <NodeInspector
      nodeId="qst_1"
      writer={writer}
      lang="en"
      announce={() => undefined}
      onRefuse={() => undefined}
      onRowPatch={() => undefined}
      reloadToken={0}
    />,
  );
  await screen.findByTestId('node-inspector');
}

function patchesTo(path: string): readonly Recorded[] {
  return calls.filter((call) => call.method === 'PATCH' && call.path === path);
}

/* -------------------------------------------------------------------------- */

describe('TypePicker', () => {
  it('offers every registered plugin, including ones no studio file names', () => {
    render(<TypePicker value={null} onChange={() => undefined} />);
    const picker = screen.getByTestId('type-picker');
    // One option per registered plugin, plus the "choose…" placeholder.
    expect(within(picker).getAllByRole('option')).toHaveLength(FIRST_PARTY_PLUGINS.length + 1);
    const offered = within(picker)
      .getAllByRole('option')
      .map((option) => (option as HTMLOptionElement).value)
      .filter((value) => value !== '');
    expect(new Set(offered)).toEqual(new Set(FIRST_PARTY_PLUGINS.map((plugin) => plugin.meta.id)));
    // The proof of "driven by registry metadata": `consent` appears in no studio source file.
    const consent = within(picker).getByRole('option', { name: /consent/i });
    expect(consent).toHaveAttribute('value', 'consent');
    // Grouped by the plugin's own category, not by a list kept here.
    const categories = new Set(FIRST_PARTY_PLUGINS.map((plugin) => plugin.meta.category));
    for (const category of categories) {
      expect(picker.querySelector(`optgroup[label="${category}"]`)).not.toBeNull();
    }
  });

  it('reports the selected type back by plugin id', () => {
    const seen: string[] = [];
    render(<TypePicker value={null} onChange={(id) => seen.push(id)} />);
    fireEvent.change(screen.getByTestId('type-picker'), { target: { value: 'consent' } });
    expect(seen).toEqual(['consent']);
  });
});

describe('NodeInspector', () => {
  it('fetches the body lazily and renders the studio-owned fields', async () => {
    await mountInspector();
    expect(calls[0]?.path).toBe('/nodes/qst_1?include=items,cells,validation,masks,scripts,rules');
    expect(screen.getByTestId('inspector-ref')).toHaveValue('Q1');
    expect(screen.getByTestId('inspector-label')).toHaveValue(
      'Which of these brands have you bought?',
    );
    expect(screen.getByTestId('inspector-required')).toBeChecked();
  });

  it('shows the question type as read-only and says why', async () => {
    await mountInspector();
    expect(screen.getByTestId('inspector-type')).toBeDisabled();
    expect(screen.getByTestId('inspector-type-locked')).toHaveTextContent(
      'a different type emits different variables',
    );
  });

  it('commits a ref rename on blur, as one PATCH', async () => {
    await mountInspector();
    fireEvent.change(screen.getByTestId('inspector-ref'), { target: { value: 'S1' } });
    expect(patchesTo('/nodes/qst_1')).toHaveLength(0);
    fireEvent.blur(screen.getByTestId('inspector-ref'));
    await waitFor(() => {
      expect(patchesTo('/nodes/qst_1')).toHaveLength(1);
    });
    expect(patchesTo('/nodes/qst_1')[0]?.body).toEqual({ ref: 'S1' });
  });

  it('hosts the plugin’s own editor and turns its patch into ONE node PATCH', async () => {
    await mountInspector();
    const shell = screen.getByTestId('question-editor-shell');
    expect(shell).toHaveAttribute('data-question-type', 'single_select');
    // The plugin's control, rendered by the plugin — studio does not know this field exists.
    fireEvent.change(within(shell).getByLabelText(/display/i, { selector: 'select' }), {
      target: { value: 'dropdown' },
    });
    await waitFor(() => {
      expect(patchesTo('/nodes/qst_1')).toHaveLength(1);
    });
    const body = patchesTo('/nodes/qst_1')[0]?.body as { config: Record<string, unknown> };
    // The whole config, folded — and the plugin's defaults are present, so a node stored before
    // a plugin gained a field does not lose it.
    expect(body.config['display']).toBe('dropdown');
    expect(body.config['columns']).toBe(1);
    expect(Object.keys(body)).toEqual(['config']);
  });

  it('lists the variables the question emits, with their export columns', async () => {
    await mountInspector();
    const panel = screen.getByTestId('emits-panel');
    expect(panel).toHaveTextContent('Variables this question emits (2)');
    expect(within(screen.getByTestId('emits-row-Q1')).getByText('enum')).toBeInTheDocument();
    const other = screen.getByTestId('emits-row-Q1_other');
    expect(other).toHaveTextContent('Q1_other');
    expect(other).toHaveTextContent('text');
    expect(within(other).getByText('PII')).toBeInTheDocument();
  });
});

describe('the option list', () => {
  it('shows display order and code as two different columns', async () => {
    await mountInspector();
    expect(screen.getByTestId('item-position-opt_1')).toHaveTextContent('1');
    expect(screen.getByTestId('item-code-opt_1')).toHaveValue(10);
    expect(screen.getByTestId('item-position-opt_3')).toHaveTextContent('3');
    expect(screen.getByTestId('item-code-opt_3')).toHaveValue(30);
  });

  it('reorders in one request, and the codes do not move with the rows', async () => {
    await mountInspector();
    fireEvent.click(screen.getByTestId('item-down-opt_1'));

    await waitFor(() => {
      expect(calls.filter((call) => call.path.endsWith('/move'))).toHaveLength(1);
    });
    const move = calls.find((call) => call.path.endsWith('/move'));
    expect(move?.path).toBe('/items/opt_1/move');
    expect(move?.body).toEqual({ after_id: 'opt_2' });
    expect(Object.keys(move?.body as object)).not.toContain('code');

    // Alpha is now second — and still code 10.
    expect(screen.getByTestId('item-position-opt_1')).toHaveTextContent('2');
    expect(screen.getByTestId('item-code-opt_1')).toHaveValue(10);
    expect(screen.getByTestId('item-code-opt_2')).toHaveValue(20);
    expect(screen.getByTestId('item-position-opt_2')).toHaveTextContent('1');
  });

  it('reorders from the keyboard too', async () => {
    await mountInspector();
    fireEvent.keyDown(screen.getByTestId('item-code-opt_3'), { key: 'ArrowUp', altKey: true });
    await waitFor(() => {
      expect(calls.filter((call) => call.path.endsWith('/move'))).toHaveLength(1);
    });
    expect(calls.find((call) => call.path.endsWith('/move'))?.body).toEqual({ before_id: 'opt_2' });
  });

  it('edits a code without touching the order', async () => {
    await mountInspector();
    fireEvent.change(screen.getByTestId('item-code-opt_2'), { target: { value: '25' } });
    fireEvent.blur(screen.getByTestId('item-code-opt_2'));
    await waitFor(() => {
      expect(patchesTo('/items/opt_2')).toHaveLength(1);
    });
    expect(patchesTo('/items/opt_2')[0]?.body).toEqual({ code: 25 });
    expect(calls.filter((call) => call.path.endsWith('/move'))).toHaveLength(0);
  });

  it('sends a 60-brand paste as ONE items:bulk request', async () => {
    await mountInspector();
    const text = Array.from({ length: 60 }, (_, at) => 'Brand ' + String(at + 1)).join('\n');
    fireEvent.change(screen.getByTestId('items-paste-text'), { target: { value: text } });
    expect(screen.getByTestId('items-paste-summary')).toHaveTextContent(
      '60 parsed, 60 with codes assigned by position',
    );

    fireEvent.change(screen.getByTestId('items-paste-mode'), { target: { value: 'replace' } });
    fireEvent.click(screen.getByTestId('items-paste-apply'));

    await waitFor(() => {
      expect(calls.filter((call) => call.path.includes('items:bulk'))).toHaveLength(1);
    });
    const bulk = calls.find((call) => call.path.includes('items:bulk'));
    expect(bulk?.path).toBe('/nodes/qst_1/items:bulk');
    const body = bulk?.body as { mode: string; item_kind: string; items: readonly unknown[] };
    expect(body.mode).toBe('replace');
    expect(body.item_kind).toBe('option');
    expect(body.items).toHaveLength(60);
    expect(body.items[0]).toEqual({ ref: 'o31', code: 31, label: 'Brand 1' });
    // One request for sixty options, not sixty creates.
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  });
});

describe('a frozen version', () => {
  it('disables every control and says what to do instead', async () => {
    await mountInspector(stubWriter({ readOnly: true }));
    expect(screen.getByTestId('inspector-read-only')).toHaveTextContent(
      'clone a new draft to edit',
    );
    expect(screen.getByTestId('inspector-ref')).toBeDisabled();
    expect(screen.getByTestId('inspector-required')).toBeDisabled();
    expect(screen.getByTestId('item-code-opt_1')).toBeDisabled();
    expect(screen.getByTestId('items-paste-apply')).toBeDisabled();
    expect(screen.getByTestId('item-add')).toBeDisabled();
  });
});
