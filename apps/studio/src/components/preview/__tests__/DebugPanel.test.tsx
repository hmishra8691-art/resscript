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

/* ---------------------------------------------------------------- *
 * Replay — P1-11's acceptance line
 * ---------------------------------------------------------------- */

const SESSION = 'ses_01HQ8ZG7VYABCDEFGHJKMNPQRS';

/** What `GET /preview/:hash/replay/:session_id` answers, as the proxy passes it through. */
const replayBody = {
  session_id: SESSION,
  artifact_hash: 'a'.repeat(64),
  seed: 'a3f9c1d2e4b6a8f0c2d4e6b8a0f2c4d6',
  disposition: 'COMPLETE',
  steps: [
    {
      seq: 2,
      page_id: 'pg_1',
      outcome: 'submitted',
      questions: [{ question_id: 'qst_1', ref: 'Q1', order: { options: [5, 3, 2, 4, 1] } }],
    },
    { seq: 3, page_id: 'pg_2', outcome: 'final', questions: [] },
  ],
};

describe('DebugPanel replay', () => {
  function renderPanel(): void {
    render(<DebugPanel versionId="sv_01JC8KX9Q2M4V7ZB3F0T5N6R2W" />);
  }

  it('the button is refused until the id is a real session id', () => {
    stubApi([replayBody]);
    renderPanel();
    const field = screen.getByTestId('debug-replay-id');
    const button = screen.getByTestId('debug-replay-start') as HTMLButtonElement;

    expect(button.disabled).toBe(true);
    fireEvent.change(field, { target: { value: 'not-a-session' } });
    expect(button.disabled).toBe(true);
    // A shape check in the UI as well as in the schema and the endpoint: the id becomes a URL
    // path segment two hops away, and refusing it here costs the operator nothing.
    fireEvent.change(field, { target: { value: SESSION } });
    expect(button.disabled).toBe(false);
  });

  it('renders the replayed pages and their orders AS RENDERED', async () => {
    stubApi([replayBody]);
    renderPanel();
    fireEvent.change(screen.getByTestId('debug-replay-id'), { target: { value: SESSION } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('debug-replay-start'));
    });

    expect(screen.getByTestId('debug-replay')).toBeTruthy();
    expect(screen.getByTestId('replay-seed').textContent).toBe('a3f9c1d2e4b6a8f0c2d4e6b8a0f2c4d6');
    expect(screen.getByTestId('replay-disposition').textContent).toBe('COMPLETE');
    // The orders are the point: "the exact pages, option orders and rule verdicts that
    // respondent saw" is the acceptance sentence, and an order rendered as codes is the half a
    // programmer actually compares against a client's complaint.
    const step = screen.getByTestId('replay-step-2');
    expect(step.textContent).toContain('pg_1');
    expect(step.textContent).toContain('[5,3,2,4,1]');
  });

  it('a runtime refusal is shown as data, not a crash', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (): Promise<Response> =>
          new Response(JSON.stringify({ error: { code: 'not_found', message: 'no', details: [] } }), {
            status: 404,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    renderPanel();
    fireEvent.change(screen.getByTestId('debug-replay-id'), { target: { value: SESSION } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('debug-replay-start'));
    });

    expect(screen.getByRole('alert').textContent).toContain('not_found');
    expect(screen.queryByTestId('debug-replay')).toBeNull();
  });
});
