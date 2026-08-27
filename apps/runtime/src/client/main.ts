/**
 * The respondent client — E §12.1's page controller, enhancement-only.
 *
 * This script runs against the server-rendered form and NEVER replaces it: no framework, no
 * virtual DOM, no hydration (E §12.1 — React here would be 40 KB of the budget buying nothing
 * that direct DOM work does not give). If this file fails to load, the survey still completes:
 * the form posts, the server validates, the 303 navigates. Everything here is a refinement of
 * that path, and everything here degrades TO that path on any error.
 *
 * What it does today: timing capture (first render, focus loss — speeder detection's inputs),
 * fetch-based submit with an idempotency key (so a double-click is one event even before the
 * server's guard), and inline validation-message rendering without a page load.
 *
 * What it deliberately does not do (E §12.2): decide which page is next, evaluate quota or
 * termination, or hold the flow graph. The client receives one page and a submit endpoint.
 * Client-side logic evaluation (show/hide within the page) joins when the engine bundle does —
 * the budget line for it is reserved in E §12.1's table.
 */

import {
  parseStudioToPreview,
  type PreviewToStudio,
} from '@resscript/runtime-core';

interface SubmitResponse {
  page?: { page_id: string };
  disposition?: string;
  validation_failed?: Array<{ question_id: string; message_key: string }>;
  replayed?: boolean;
  page_id?: string;
}

(() => {
  const script = document.currentScript as HTMLScriptElement | null;
  const session = script?.dataset['session'];
  const pageId = script?.dataset['page'];
  const form = document.querySelector('form');
  if (!script || !session || !pageId || !form) return;

  // ---- timing capture ---------------------------------------------------
  const t0 = performance.now();
  let focusLostAt: number | null = null;
  let focusLossMs = 0;
  addEventListener('blur', () => (focusLostAt = performance.now()));
  addEventListener('focus', () => {
    if (focusLostAt !== null) focusLossMs += performance.now() - focusLostAt;
    focusLostAt = null;
  });

  // The surface prefix, derived from the form action so ONE client serves both the survey
  // origin (`/s/<token>/…`) and the preview surface (`/preview/<hash>/…?pt=…`, P1-11). The
  // signed preview token rides in the query and must survive into every URL built here.
  const base = new URL(form.action);
  const prefixPath = base.pathname.replace(/\/submit$/, '');
  const pt = base.searchParams.get('pt');
  // `rest` is optional so a sub-route that needs no query (replay, whose session id is in the
  // path) does not end up with a dangling separator.
  const q = (rest: string) =>
    pt ? `pt=${encodeURIComponent(pt)}${rest ? `&${rest}` : ''}` : rest;
  const urlFor = (sub: string, rest: string) => `${base.origin}${prefixPath}${sub}?${q(rest)}`;
  const eventUrl = urlFor('/event', `session=${session}`);

  // First-render timing, once, fire-and-forget. sendBeacon when available so an immediate
  // navigation cannot cancel it; the endpoint answers 204 whatever happens.
  const firstRender = Math.round(performance.now() - t0);
  const beacon = JSON.stringify({ page_id: pageId, first_render_ms: firstRender });
  if (navigator.sendBeacon) navigator.sendBeacon(eventUrl, beacon);
  else void fetch(eventUrl, { method: 'POST', body: beacon, keepalive: true });

  // ---- enhanced submit ----------------------------------------------------
  let attempt = 1;
  let inFlight = false;

  form.addEventListener('submit', ev => {
    if (!window.fetch) return; // ancient browser: the form's own POST is the path
    ev.preventDefault();
    if (inFlight) return; // double-click: one request, even before the server's guard
    inFlight = true;

    const data = new FormData(form);
    const values: Record<string, unknown> = {};
    for (const key of new Set(data.keys())) {
      if (key === '__page_id') continue;
      const all = data.getAll(key).map(String);
      values[key] = all.length > 1 ? all : all[0];
    }

    const body = {
      page_id: pageId,
      values,
      // Stable per (page, attempt, values): a network retry replays, a corrected answer does
      // not. The server derives the same shape when the key is absent.
      idempotency_key: `c:${pageId}:${attempt}:${simpleHash(JSON.stringify(values))}`,
      timings: {
        total_ms: Math.round(performance.now() - t0),
        focus_loss_ms: Math.round(focusLossMs),
      },
    };

    void fetch(urlFor('/submit', `session=${session}`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then(res => res.json() as Promise<SubmitResponse>)
      .then(json => {
        if (json.validation_failed?.length) {
          attempt += 1;
          inFlight = false;
          renderErrors(json.validation_failed);
          return;
        }
        // Navigation is the server's answer, always: next page or terminal. The client never
        // computes a destination (E §12.2).
        const next = json.page?.page_id ?? json.page_id;
        if (json.disposition) postToStudio({
          t: 'preview:disposition', disposition: json.disposition,
          redirect_url: (json as { redirect_url?: string | null }).redirect_url ?? null,
        });
        if (next) {
          location.assign(urlFor(`/p/${encodeURIComponent(next)}`, `session=${session}`));
        } else {
          location.reload(); // terminal renders server-side
        }
      })
      .catch(() => {
        // Any transport failure: fall back to the no-JS path. The idempotency key makes the
        // double-send safe.
        inFlight = false;
        form.submit();
      });
  });

  function renderErrors(failures: Array<{ question_id: string; message_key: string }>): void {
    for (const el of Array.from(document.querySelectorAll('.error'))) el.remove();
    for (const f of failures) {
      const target = document.getElementById(f.question_id);
      if (!target) continue;
      const p = document.createElement('p');
      p.className = 'error';
      p.setAttribute('role', 'alert');
      p.textContent = f.message_key;
      target.before(p);
    }
    document.querySelector('.error')?.scrollIntoView({ block: 'center' });
  }

  // ---- the preview channel (P1-11, security §3.2) --------------------------
  // Active only when the server marked this page as preview-framed. Origin checked on every
  // message AND every message validated before dispatch — both, always: origin alone trusts a
  // compromised studio tab's structure; validation alone answers any frame that can postMessage.
  const previewOrigin = script.dataset['previewOrigin'];
  const artifactHash = script.dataset['artifact'];
  function postToStudio(msg: PreviewToStudio): void {
    if (previewOrigin && window.parent !== window) window.parent.postMessage(msg, previewOrigin);
  }
  if (previewOrigin && artifactHash && window.parent !== window) {
    postToStudio({ t: 'preview:ready', artifact_hash: artifactHash, session_id: session });
    postToStudio({
      t: 'preview:page', page_id: pageId, height: document.documentElement.scrollHeight,
    });
    addEventListener('message', ev => {
      if (ev.origin !== previewOrigin) return;
      const msg = parseStudioToPreview(ev.data);
      if (!msg) return; // malformed: ignored, never crashed on (security §3.2)
      switch (msg.t) {
        case 'preview:goto':
          location.assign(urlFor(`/p/${encodeURIComponent(msg.page_id)}`, `session=${session}`));
          return;
        case 'preview:replay':
          // A navigation, not a fetch: the replay response is a whole recorded interview, and the
          // panel reads it from the frame's own document rather than through this script. The
          // signed token rides along in `q()`, and the server refuses any session not pinned to
          // this artifact — so a forged session id here reaches a 404, never another survey.
          location.assign(urlFor(`/replay/${encodeURIComponent(msg.session_id)}`, ''));
          return;
        case 'preview:setVars':
          void fetch(urlFor('/setvars', `session=${session}`), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ vars: msg.vars }),
          }).then(() => location.reload())
            .catch(() => postToStudio({ t: 'preview:error', code: 'setvars_failed', message: '' }));
          return;
        case 'preview:init':
        case 'preview:reload':
          // A (re)init targets a possibly different artifact, whose signed token this frame
          // does not hold: the studio performs it by setting the iframe src, not by message.
          postToStudio({ t: 'preview:error', code: 'reinit_by_src', message: 'set the iframe src' });
          return;
        case 'preview:setDevice':
          return; // a viewport concern; the studio resizes the iframe, nothing to do in-frame
      }
    });
  }

  /** FNV-1a, enough for an idempotency discriminator — not the shared PRNG, no seed here. */
  function simpleHash(s: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16);
  }
})();
