/**
 * The container, and the one claim that matters: the editor is REACHABLE and its output reaches the
 * route.
 *
 * `RedirectEditor` has been complete and tested since P2-10 and was rendered nowhere, while
 * `CMP-0300` refuses to publish any survey whose flow can reach `COMPLETE` with no redirect — and
 * the synthesized flow always can. So every survey hit a gate that the UI offered no way to answer,
 * and the only remedy was an INSERT into `content.redirects` by hand.
 *
 * `RedirectEditor.test.tsx` covers the editing behaviour and needs no network. These tests cover
 * exactly the seam that was missing: four fetches in, a PUT out, and what happens when either end
 * misbehaves.
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RedirectsPane } from '../RedirectsPane';

const VERSION = 'ver_01JQZK8N0000000000000001';

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

const calls: Call[] = [];

/** One fetch stub for all four endpoints, keyed on the path. */
function stubFetch(over: { redirectsStatus?: number; putStatus?: number; putBody?: unknown } = {}) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({
      url,
      method,
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });

    const reply = (status: number, body: unknown): Response =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });

    if (url.includes('/redirects') && method === 'PUT') {
      return reply(over.putStatus ?? 200, over.putBody ?? { redirects: [] });
    }
    if (url.includes('/redirects')) {
      if (over.redirectsStatus !== undefined && over.redirectsStatus !== 200) {
        return reply(over.redirectsStatus, {
          error: { code: 'forbidden', message: 'programmer role required' },
        });
      }
      return reply(200, {
        survey_version_id: VERSION,
        redirects: [
          {
            scope: 'default',
            scope_key: '',
            disposition: 'COMPLETE',
            custom_key: '',
            url_template: 'https://panel.example/done',
          },
        ],
      });
    }
    if (url.includes('/variables')) {
      return reply(200, {
        data: [
          { name: 'RID', vtype: 'text', pii: false },
          { name: 'EMAIL', vtype: 'text', pii: true },
        ],
      });
    }
    if (url.includes('/vendors')) return reply(200, { vendors: [{ ref: 'PANEL_A' }] });
    if (url.includes('/translations')) {
      return reply(200, { languages: [{ lang: 'en' }, { lang: 'fr-CA' }] });
    }
    return reply(404, { error: { code: 'not_found', message: 'no' } });
  });
}

beforeEach(() => {
  calls.length = 0;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('RedirectsPane', () => {
  it('loads the four inputs the editor needs and renders the existing rows', async () => {
    vi.stubGlobal('fetch', stubFetch());
    render(<RedirectsPane versionId={VERSION} role="programmer" />);

    // The row from the server, not a blank editor.
    await waitFor(() => {
      expect(screen.getByLabelText('Redirect 1 url template')).toHaveValue(
        'https://panel.example/done',
      );
    });

    const fetched = calls.filter((c) => c.method === 'GET').map((c) => c.url);
    expect(fetched.some((u) => u.includes('/redirects'))).toBe(true);
    // Variables carry `pii`, which `CMP-0301` refuses in a template — the editor's preview needs
    // it to avoid offering an author a URL the compiler will reject.
    expect(fetched.some((u) => u.includes('/variables'))).toBe(true);
    expect(fetched.some((u) => u.includes('/vendors'))).toBe(true);
    // Languages come from the translations summary: there is no /languages route.
    expect(fetched.some((u) => u.includes('/translations'))).toBe(true);
  });

  it('PUTs the whole set on save', async () => {
    vi.stubGlobal('fetch', stubFetch());
    render(<RedirectsPane versionId={VERSION} role="programmer" />);
    await screen.findByLabelText('Redirect 1 url template');

    await userEvent.click(screen.getByRole('button', { name: 'Save redirects' }));

    await waitFor(() => {
      const put = calls.find((c) => c.method === 'PUT');
      expect(put).toBeDefined();
      // The route REPLACES the set, so the editor's output goes verbatim — a diff here would be a
      // second definition of what a redirect set is.
      expect((put?.body as { redirects: unknown[] }).redirects).toHaveLength(1);
    });
    expect(screen.getByTestId('redirects-saved')).toBeDefined();
  });

  it('renders a 422 detail against the row it names', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch({
        putStatus: 422,
        putBody: {
          error: {
            code: 'validation_failed',
            message: 'redirect set is invalid',
            details: [
              {
                path: 'redirects.0.url_template',
                code: 'invalid_value',
                message: 'must be an absolute https URL',
              },
            ],
          },
        },
      }),
    );
    render(<RedirectsPane versionId={VERSION} role="programmer" />);
    await screen.findByLabelText('Redirect 1 url template');

    await userEvent.click(screen.getByRole('button', { name: 'Save redirects' }));

    // Addressed by index because the rows are not stored — the submitted index is the only address
    // the client has. Passed through so the editor can render it against that row rather than as a
    // form-level banner that says nothing about which of twelve rows is wrong.
    await waitFor(() => {
      expect(screen.getByText('must be an absolute https URL')).toBeDefined();
    });
  });

  it('shows the load failure instead of an empty editor', async () => {
    // Failing open here would offer a Save button over an empty set — one click from replacing a
    // real redirect table with nothing. The read is the one fetch that is not best-effort.
    vi.stubGlobal('fetch', stubFetch({ redirectsStatus: 403 }));
    render(<RedirectsPane versionId={VERSION} role="programmer" />);

    await waitFor(() => {
      expect(screen.getByTestId('redirects-load-error')).toBeDefined();
    });
    expect(screen.queryByRole('button', { name: 'Save redirects' })).toBeNull();
  });

  it('is read-only below the programmer floor', async () => {
    vi.stubGlobal('fetch', stubFetch());
    render(<RedirectsPane versionId={VERSION} role="reviewer" />);
    await screen.findByLabelText('Redirect 1 url template');

    // A redirect row is a vendor relationship — which panel, which callback host — and the route
    // puts even the READ at the programmer floor for that reason.
    expect(screen.getByRole('button', { name: 'Save redirects' })).toBeDisabled();
  });
});
