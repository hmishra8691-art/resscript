/**
 * PreviewPanel — the sandbox attributes and the postMessage gate (P1-11 acceptance).
 *
 * The acceptance test this file exists for: "a malformed-postMessage test asserting the studio
 * does not crash". Hostile messages — foreign origins, near-miss shapes, non-objects — are
 * dispatched at the mounted panel and the assertions are that NOTHING moved: no crash, no
 * connected flag, no page indicator, no disposition banner. Then the same shapes from the
 * right origin with valid structure DO move state, which is what proves the gate is the pair
 * (origin AND validator) rather than an accident of nothing listening.
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PreviewPanel } from '@/components/preview/PreviewPanel';

const HASH = 'a'.repeat(64);
const PREVIEW_ORIGIN = 'http://prv-dev.run.local:8081';
const PREVIEW_URL = `${PREVIEW_ORIGIN}/preview/${HASH}?pt=v1.9999999999999.${'0'.repeat(64)}`;

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async (): Promise<Response> =>
        new Response(
          JSON.stringify({
            artifact_hash: HASH,
            preview_token: 'v1.9999999999999.' + '0'.repeat(64),
            expires_at: '2026-08-20T12:10:00.000Z',
            preview_url: PREVIEW_URL,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    ),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function mountConnectedPanel(): Promise<HTMLElement> {
  render(<PreviewPanel versionId="sv_01JC8KX9Q2M4V7ZB3F0T5N6R2W" />);
  return await screen.findByTitle('Survey preview');
}

function post(origin: string, data: unknown): void {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { origin, data }));
  });
}

describe('PreviewPanel', () => {
  it('renders the exact sandbox — allow-same-origin deliberately absent — and no-referrer', async () => {
    const frame = await mountConnectedPanel();
    expect(frame).toHaveAttribute(
      'sandbox',
      'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox',
    );
    expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin');
    expect(frame).toHaveAttribute('referrerpolicy', 'no-referrer');
    expect(frame).toHaveAttribute('src', PREVIEW_URL);
  });

  it('ignores malformed and foreign messages without crashing or moving state', async () => {
    await mountConnectedPanel();

    // A perfectly-shaped message from the WRONG origin: the first half of the gate.
    post('https://evil.example', { t: 'preview:ready', artifact_hash: HASH, session_id: 'ses_1' });
    // Structural hostility from the RIGHT origin: the second half.
    post(PREVIEW_ORIGIN, { t: 'preview:evil', payload: 'boo' });
    post(PREVIEW_ORIGIN, 'just a string');
    post(PREVIEW_ORIGIN, null);
    post(PREVIEW_ORIGIN, 42);
    post(PREVIEW_ORIGIN, ['preview:ready']);
    // Near-misses: right tag, wrong fields — the validator, not the tag, is the gate.
    post(PREVIEW_ORIGIN, { t: 'preview:page', page_id: 'pg_1' }); // height missing
    post(PREVIEW_ORIGIN, { t: 'preview:page', page_id: 42, height: 100 });
    post(PREVIEW_ORIGIN, { t: 'preview:disposition', disposition: 'COMPLETE', redirect_url: 42 });
    post(PREVIEW_ORIGIN, { t: 'preview:error', code: 'x' }); // message missing

    // Nothing moved: not connected, no page, no banner, no error surface — and no crash,
    // which these queries would not survive.
    expect(screen.getByTestId('preview-status')).toHaveTextContent('waiting for the preview frame…');
    expect(screen.queryByTestId('preview-current-page')).toBeNull();
    expect(screen.queryByTestId('preview-disposition')).toBeNull();
    expect(screen.queryByTestId('preview-frame-error')).toBeNull();
  });

  it('accepts the same messages when both halves of the gate pass', async () => {
    await mountConnectedPanel();

    post(PREVIEW_ORIGIN, { t: 'preview:ready', artifact_hash: HASH, session_id: 'ses_1' });
    expect(screen.getByTestId('preview-status')).toHaveTextContent('connected');

    post(PREVIEW_ORIGIN, { t: 'preview:page', page_id: 'pg_2', height: 640 });
    expect(screen.getByTestId('preview-current-page')).toHaveTextContent('page: pg_2');
    expect(screen.getByTitle('Survey preview')).toHaveStyle({ height: '640px' });

    // preview:error surfaces NON-fatally: the frame stays mounted.
    post(PREVIEW_ORIGIN, { t: 'preview:error', code: 'artifact_gone', message: 'gone' });
    expect(screen.getByTestId('preview-frame-error')).toHaveTextContent('artifact_gone: gone');
    expect(screen.getByTitle('Survey preview')).toBeDefined();

    post(PREVIEW_ORIGIN, {
      t: 'preview:disposition',
      disposition: 'COMPLETE',
      redirect_url: 'https://panel.example/return?st=1',
    });
    expect(screen.getByTestId('preview-disposition')).toHaveTextContent('COMPLETE');
    expect(screen.getByTestId('preview-disposition')).toHaveTextContent(
      'https://panel.example/return?st=1',
    );
  });

  it('bounds a hostile height claim instead of laying out ten million pixels', async () => {
    await mountConnectedPanel();
    post(PREVIEW_ORIGIN, { t: 'preview:page', page_id: 'pg_1', height: 10_000_000 });
    expect(screen.getByTitle('Survey preview')).toHaveStyle({ height: '4000px' });
  });

  it('surfaces the 409 "compile first" refusal instead of an iframe', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (): Promise<Response> =>
          new Response(
            JSON.stringify({
              error: { code: 'illegal_transition', message: 'no artifact', details: [] },
            }),
            { status: 409, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );
    render(<PreviewPanel versionId="sv_01JC8KX9Q2M4V7ZB3F0T5N6R2W" />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This version has no compiled artifact yet',
    );
    expect(screen.queryByTitle('Survey preview')).toBeNull();
  });
});
