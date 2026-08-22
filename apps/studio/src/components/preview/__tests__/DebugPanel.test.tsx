/**
 * DebugPanel — the trace tables and the PII mask (P1-11).
 *
 * The mask is the assertion with teeth: a value the operator drove into a PII variable renders
 * as ●●●● and the clear text appears NOWHERE in the document, because the panel is
 * screen-shared in every QA call and "masked in the table, printed in the tooltip" is how PII
 * leaks anyway.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DebugPanel, maskedValue } from '@/components/preview/DebugPanel';

const startBody = {
  session_id: 'ses_dbg1',
  page: { page_id: 'pg_1', questions: [], skipped: [] },
  progress: { visited: 1, revision: 1 },
  debug: {
    seed: 'f'.repeat(32),
    artifact_hash: 'a'.repeat(64),
    orders: { 'qst_1.option': [2, 0, 1] },
    digest: 'd1',
    cells_evaluated: 3,
    trace: [
      {
        cell: 'show(qst_2)',
        topo_pos: 4,
        writers: [{ rule_id: 'R7', verdict: 'T' }],
        result: true,
        changed: true,
      },
      {
        cell: 'terminate(QUOTA_FULL)',
        topo_pos: 9,
        writers: [
          { rule_id: 'R9', verdict: 'U', collapsed: { from: 'U', to: false, reason: 'strict' } },
        ],
        result: false,
        changed: false,
      },
    ],
    validations: [],
    termination: null,
  },
  variables: [
    { name: 'S1', kind: 'response', vtype: 'enum', pii: false },
    { name: 'EMAIL', kind: 'response', vtype: 'text', pii: true },
  ],
};

const setvarsBody = { ok: true, set: 2, rejected: [], page_id: 'pg_1' };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubApi(bodies: readonly unknown[]): void {
  const queue = [...bodies];
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async (): Promise<Response> =>
        new Response(JSON.stringify(queue.length > 1 ? queue.shift() : queue[0]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ),
  );
}

async function startSession(): Promise<void> {
  render(<DebugPanel versionId="sv_01JC8KX9Q2M4V7ZB3F0T5N6R2W" />);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Start debug session' }));
  });
}

describe('maskedValue', () => {
  it('masks by the registry pii flag and only by it', () => {
    const variables = startBody.variables;
    expect(maskedValue('EMAIL', 'qa@example.test', variables)).toBe('●●●●');
    expect(maskedValue('S1', 2, variables)).toBe('2');
  });
});

describe('DebugPanel', () => {
  it('renders seed, per-cell verdicts with collapse annotations, and randomization orders', async () => {
    stubApi([startBody]);
    await startSession();

    expect(screen.getByTestId('debug-seed')).toHaveTextContent('f'.repeat(32));
    expect(screen.getByTestId('debug-current-page')).toHaveTextContent('pg_1');

    const trace = screen.getByTestId('debug-trace');
    expect(trace).toHaveTextContent('show(qst_2)');
    expect(trace).toHaveTextContent('R7 = T');
    // D §2.5's collapse annotation: a U that collapsed is a smell the panel must surface.
    expect(trace).toHaveTextContent('R9 = U');
    expect(trace).toHaveTextContent('(U→false: strict)');
    expect(trace).toHaveTextContent('pruned');

    const orders = screen.getByTestId('debug-orders');
    expect(orders).toHaveTextContent('qst_1.option');
    expect(orders).toHaveTextContent('2 → 0 → 1');
  });

  it('masks PII values as ●●●● and never prints the clear text', async () => {
    stubApi([startBody, setvarsBody]);
    await startSession();

    fireEvent.change(screen.getByLabelText('Step payload (JSON)'), {
      target: { value: '{"EMAIL":"qa@example.test","S1":2}' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Set vars' }));
    });

    const table = screen.getByTestId('debug-vars');
    expect(table).toHaveTextContent('EMAIL');
    expect(table).toHaveTextContent('●●●●');
    expect(table).toHaveTextContent('S1');
    // Nowhere in the RENDERED state — the payload textarea still holds what the operator is
    // typing (that is their own editor, not a render of session state).
    expect(table.textContent).not.toContain('qa@example.test');
    expect(screen.getByTestId('debug-trace').textContent).not.toContain('qa@example.test');
  });

  it("shows the runtime's refusal as debug information, not as a panel failure", async () => {
    stubApi([startBody]);
    await startSession();

    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (): Promise<Response> =>
          new Response(
            JSON.stringify({ error: { code: 'stale_page', message: 'stale', details: [] } }),
            { status: 409, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );
    fireEvent.change(screen.getByLabelText('Step payload (JSON)'), {
      target: { value: '{}' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Submit page' }));
    });
    expect(screen.getByRole('alert')).toHaveTextContent('stale_page');
    // The session view survives the refusal.
    expect(screen.getByTestId('debug-current-page')).toHaveTextContent('pg_1');
  });
});
