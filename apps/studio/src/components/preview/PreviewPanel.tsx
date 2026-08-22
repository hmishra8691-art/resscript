/**
 * The sandboxed preview iframe host (P1-11, security §3.2, UI §8).
 *
 * ## The sandbox, exactly
 *
 * `sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"` —
 * `allow-same-origin` is DELIBERATELY absent, so the frame runs with an opaque origin: even
 * though the preview host is already a separate origin, an opaque origin means the framed
 * document cannot use its own origin's storage or reach anything the studio's cookies protect
 * should a redirect ever land it somewhere unexpected. `referrerPolicy="no-referrer"` for the
 * same reason the runtime sends it on redirects: the preview URL carries a capability (`pt=`)
 * and must not leak in a Referer header. The runtime's side of the handshake is its CSP
 * `frame-ancestors <STUDIO_ORIGIN>`, so only this app can frame the page at all.
 *
 * ## The message gate
 *
 * Security §3.2's rule, both halves, always: `event.origin` must equal the preview origin AND
 * the payload must survive `parsePreviewToStudio` — the SAME validator the frame runs on our
 * messages, imported from `@resscript/runtime-core` so the contract cannot drift. Anything
 * that fails either check is silently ignored; a malformed message must never crash the studio
 * (that is a P1-11 acceptance test), and answering a hostile frame with an error would give it
 * an oracle.
 *
 * The `pt` token in the iframe src is minted server-side by `POST /versions/:id/preview-token`;
 * this component never sees `PREVIEW_SIGNING_SECRET`.
 */

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { parsePreviewToStudio, type DeviceClass } from '@resscript/runtime-core';
import { ApiError, apiFetch } from '@/lib/api-client';
import type { PreviewTokenView } from '@/lib/api-types';

/** Device presets are WIDTHS only — the artifact renders responsively, we just narrow the pane. */
const DEVICE_WIDTHS: Readonly<Record<DeviceClass, string>> = {
  desktop: '100%',
  tablet: '768px',
  mobile: '375px',
};

const DEVICES: readonly DeviceClass[] = ['desktop', 'tablet', 'mobile'];

/** E §14.1's seed shape. An input that fails this is simply not sent, never mangled. */
const SEED_SHAPE = /^[0-9a-f]{32}$/;

export interface PreviewPanelProps {
  readonly versionId: string;
  /** Offered as a <select> when the caller knows the version's languages; a free input otherwise. */
  readonly languages?: readonly string[];
  readonly defaultLanguage?: string;
}

interface Ended {
  readonly disposition: string;
  readonly redirectUrl: string | null;
}

export function PreviewPanel({
  versionId,
  languages,
  defaultLanguage,
}: PreviewPanelProps): React.JSX.Element {
  const [src, setSrc] = useState<string | null>(null);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [device, setDevice] = useState<DeviceClass>('desktop');
  const [seed, setSeed] = useState('');
  const [language, setLanguage] = useState(defaultLanguage ?? '');
  const [connected, setConnected] = useState(false);
  const [currentPage, setCurrentPage] = useState<string | null>(null);
  const [frameHeight, setFrameHeight] = useState(480);
  const [ended, setEnded] = useState<Ended | null>(null);
  const [frameError, setFrameError] = useState<string | null>(null);

  const restart = useCallback(async (): Promise<void> => {
    setTokenError(null);
    setConnected(false);
    setCurrentPage(null);
    setEnded(null);
    setFrameError(null);
    try {
      const { data } = await apiFetch<PreviewTokenView>(
        '/versions/' + versionId + '/preview-token',
        { method: 'POST' },
      );
      // Seed and language ride the entry URL (`&seed=`, `&lang=`) — the runtime validates
      // both and falls back to fresh-seed/base-language on anything it does not recognise.
      let url = data.preview_url;
      if (SEED_SHAPE.test(seed)) url += '&seed=' + seed;
      if (language !== '') url += '&lang=' + encodeURIComponent(language);
      setSrc(url);
    } catch (err: unknown) {
      setSrc(null);
      setTokenError(
        err instanceof ApiError && err.code === 'illegal_transition'
          ? 'This version has no compiled artifact yet — publish it to staging to compile first.'
          : err instanceof ApiError
            ? err.message
            : 'could not reach the studio API',
      );
    }
  }, [versionId, seed, language]);

  // Mount (and version change) fetches a token; seed/language edits apply on the NEXT restart
  // rather than reloading the frame under the user mid-keystroke — hence the ref indirection.
  const restartRef = useRef(restart);
  restartRef.current = restart;
  useEffect(() => {
    void restartRef.current();
  }, [versionId]);

  // The postMessage gate needs the EXACT origin the token endpoint pointed us at — derived
  // from the src we actually loaded, so the two can never disagree.
  const previewOrigin = useMemo(() => {
    if (src === null) return null;
    try {
      return new URL(src).origin;
    } catch {
      return null;
    }
  }, [src]);

  useEffect(() => {
    if (previewOrigin === null) return undefined;
    const onMessage = (event: MessageEvent): void => {
      // Security §3.2: origin AND structure, both, always. Origin alone is insufficient (a
      // compromised preview origin can send structural hostility); validation alone is
      // insufficient (any frame can postMessage). Failures fall through in silence.
      if (event.origin !== previewOrigin) return;
      const message = parsePreviewToStudio(event.data);
      if (message === null) return;
      switch (message.t) {
        case 'preview:ready':
          setConnected(true);
          return;
        case 'preview:page':
          setCurrentPage(message.page_id);
          // Height is frame-supplied and therefore hostile until bounded: a frame that claims
          // ten million pixels gets the cap, not the layout.
          if (Number.isFinite(message.height) && message.height > 0) {
            setFrameHeight(Math.min(4000, Math.max(160, Math.ceil(message.height))));
          }
          return;
        case 'preview:disposition':
          setEnded({ disposition: message.disposition, redirectUrl: message.redirect_url });
          return;
        case 'preview:error':
          // Non-fatal on purpose: the frame keeps rendering whatever it can, and the operator
          // reads the code alongside it.
          setFrameError(message.code + ': ' + message.message);
          return;
        case 'preview:trace':
        case 'preview:validation':
          // The client bundle does not send these yet (P1-11 scope: the trace travels in the
          // debug session's JSON instead — see DebugPanel). Accepted and dropped, so a bundle
          // that starts sending them is not treated as hostile.
          return;
      }
    };
    window.addEventListener('message', onMessage);
    return (): void => {
      window.removeEventListener('message', onMessage);
    };
  }, [previewOrigin]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <div role="group" aria-label="Device width" style={{ display: 'flex', gap: 4 }}>
          {DEVICES.map((preset) => (
            <button
              key={preset}
              type="button"
              className="rs-button"
              aria-pressed={device === preset}
              onClick={() => {
                setDevice(preset);
              }}
            >
              {preset}
            </button>
          ))}
        </div>
        <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <span className="rs-muted">Seed</span>
          <input
            className="rs-input"
            value={seed}
            placeholder="32 hex chars to reproduce"
            size={34}
            onChange={(event) => {
              setSeed(event.target.value.trim().toLowerCase());
            }}
          />
        </label>
        <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <span className="rs-muted">Language</span>
          {languages !== undefined && languages.length > 0 ? (
            <select
              className="rs-input"
              value={language}
              onChange={(event) => {
                setLanguage(event.target.value);
              }}
            >
              {languages.map((lang) => (
                <option key={lang} value={lang}>
                  {lang}
                </option>
              ))}
            </select>
          ) : (
            <input
              className="rs-input"
              value={language}
              size={6}
              onChange={(event) => {
                setLanguage(event.target.value.trim());
              }}
            />
          )}
        </label>
        <button
          type="button"
          className="rs-button"
          onClick={() => {
            void restart();
          }}
        >
          Restart
        </button>
        <span className="rs-muted" data-testid="preview-status">
          {connected ? 'connected' : 'waiting for the preview frame…'}
        </span>
        {currentPage === null ? null : (
          <span data-testid="preview-current-page">page: {currentPage}</span>
        )}
      </div>

      {tokenError === null ? null : <p role="alert">{tokenError}</p>}
      {frameError === null ? null : (
        <p role="alert" data-testid="preview-frame-error">
          Preview reported: {frameError}
        </p>
      )}
      {ended === null ? null : (
        <div className="rs-card" data-testid="preview-disposition">
          <strong>{ended.disposition}</strong>{' '}
          {ended.redirectUrl === null ? (
            <span className="rs-muted">no redirect configured</span>
          ) : (
            // A link and never an auto-follow, matching the runtime's own test-mode
            // interstitial (E §14.1): QA's job is to look at the resolved URL.
            <span>
              would redirect to <code>{ended.redirectUrl}</code>
            </span>
          )}
        </div>
      )}

      {src === null ? null : (
        <iframe
          title="Survey preview"
          src={src}
          // The exact attribute set from the spec. `allow-same-origin` is absent ON PURPOSE —
          // see the file header before adding anything here.
          sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"
          referrerPolicy="no-referrer"
          style={{
            width: DEVICE_WIDTHS[device],
            maxWidth: '100%',
            height: frameHeight,
            border: '1px solid var(--rs-border)',
            borderRadius: 4,
            background: 'var(--rs-surface)',
          }}
        />
      )}
    </div>
  );
}
