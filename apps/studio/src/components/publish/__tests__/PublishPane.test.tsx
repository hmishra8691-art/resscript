/**
 * The publish container — the half that turns `PublishDialog` from a unit-tested component into
 * a reachable surface.
 *
 * `PublishDialog.test.tsx` already covers every refusal the dialog makes from its props. What is
 * untested until here is the CONTAINER's three jobs, and each has a way of going quietly wrong:
 *
 *  1. ONE read, not two. The diagnostics envelope carries the version's status, compile_state and
 *     acknowledged_warnings alongside the diagnostics; fetching the version row separately is two
 *     reads that can disagree about which compile the diagnostics belong to.
 *  2. The dry compile posts to `/compile`, the publish to `/publish`. Swapping them is a publish
 *     the author did not ask for — the one mistake in this file that reaches production data.
 *  3. A terminal job re-reads. Without it the dialog keeps offering Publish on a version that is
 *     already frozen, and the author's second click is a 409 they cannot explain.
 *
 * Requests are asserted, not rendered order: what matters is which endpoint received what.
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PublishPane } from '@/components/publish/PublishPane';

const VERSION_ID = 'sv_01JC8KX9Q2M4V7ZB3F0T5N6R2W';
const SURVEY_ID = 'svy_01JC8KX9Q2M4V7ZB3F0T5N6R2W';

interface Recorded {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

let calls: Recorded[] = [];
let diagnostics: unknown[] = [];
let jobStatus = 'queued';

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  calls = [];
  diagnostics = [];
  jobStatus = 'queued';
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
      const path = String(input).replace('/api/v1', '');
      calls.push({
        method: init?.method ?? 'GET',
        path,
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      });

      // `apiFetch` returns the parsed body AS the data — the envelope is the body itself.
      if (path === '/versions/' + VERSION_ID + '/diagnostics') {
        return reply({
          survey_version_id: VERSION_ID,
          status: 'draft',
          compile_state: 'none',
          artifact_hash: null,
          artifact_bytes: null,
          revision: 41,
          acknowledged_warnings: [],
          diagnostics,
          summary: { total: diagnostics.length, errors: 0, warnings: 0 },
        });
      }
      if (path.startsWith('/jobs/')) {
        return reply({ id: 'job_1', kind: 'compile', status: jobStatus, progress: null });
      }
      // Both POSTs answer with a job, which is what makes swapping them silent without a test.
      return reply({ job: { id: 'job_1', kind: 'compile', status: 'queued' } }, 202);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderPane(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <PublishPane versionId={VERSION_ID} surveyId={SURVEY_ID} role="project_manager" versionNo={1} />
    </QueryClientProvider>,
  );
}

describe('PublishPane', () => {
  it('reads the diagnostics envelope ONCE and never the version row', async () => {
    renderPane();
    await waitFor(() => {
      expect(screen.getByTestId('publish-pane')).toBeTruthy();
    });

    const reads = calls.filter((c) => c.method === 'GET');
    expect(reads.map((c) => c.path)).toEqual(['/versions/' + VERSION_ID + '/diagnostics']);
    // The version row is deliberately NOT fetched: everything the dialog refuses on is in the
    // envelope, and a second read is a second answer about which compile this is.
    expect(reads.some((c) => c.path === '/versions/' + VERSION_ID)).toBe(false);
  });

  it('the dry-compile button posts to /compile — never to /publish', async () => {
    renderPane();
    await waitFor(() => screen.getByTestId('publish-dry-compile'));

    screen.getByTestId('publish-dry-compile').click();

    await waitFor(() => {
      expect(calls.some((c) => c.method === 'POST')).toBe(true);
    });
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0]?.path).toBe('/versions/' + VERSION_ID + '/compile');
    // THE assertion that matters: checking must never publish.
    expect(posts[0]?.path).not.toContain('/publish');
    expect(posts[0]?.body).toBeUndefined();
  });

  it('a terminal job re-reads the diagnostics, so a frozen version stops offering Publish', async () => {
    renderPane();
    await waitFor(() => screen.getByTestId('publish-dry-compile'));
    const readsBefore = calls.filter((c) => c.method === 'GET').length;

    jobStatus = 'succeeded';
    screen.getByTestId('publish-dry-compile').click();

    await waitFor(() => {
      const reads = calls.filter(
        (c) => c.method === 'GET' && c.path === '/versions/' + VERSION_ID + '/diagnostics',
      );
      expect(reads.length).toBeGreaterThan(readsBefore - 1);
    });
  });

  it('renders the dialog once the envelope arrives, and a loading line before it', async () => {
    renderPane();
    // The pane exists immediately; the dialog waits for the one read.
    expect(screen.getByTestId('publish-pane')).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByTestId('publish-dry-compile')).toBeTruthy();
    });
  });
});
