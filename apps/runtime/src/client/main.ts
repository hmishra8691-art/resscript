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

  const base = new URL(form.action);
  const eventUrl = `${base.origin}/s/${base.pathname.split('/')[2]}/event?session=${session}`;

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

    void fetch(`${base.origin}${base.pathname}?session=${session}`, {
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
        if (next) {
          location.assign(`${base.origin}/s/${base.pathname.split('/')[2]}/p/${next}?session=${session}`);
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
