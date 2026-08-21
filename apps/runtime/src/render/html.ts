/**
 * Server-side HTML for a resolved page — E §4 step 10, E §12.1's progressive-enhancement rule.
 *
 * The page is a FORM that submits and validates with JavaScript disabled; that is P1-09's own
 * acceptance line ("the same page completes and advances with JavaScript disabled") and it is
 * real, not aspirational — panel traffic includes enough locked-down and ancient browsers that
 * it pays for itself. The client bundle enhances this HTML in place (direct DOM patching, no
 * hydration); it never replaces it.
 *
 * What is inlined and what is not follows E §4 step 10's exclusion list exactly: the rendered
 * questions, the resolved orders (as DOM order — the client receives DERIVED orders, never the
 * seed), the session token for submit, and the client config. NOT inlined: the variable state,
 * other pages, the seed, quota state. A respondent's view source shows their page and nothing
 * about anyone else's.
 *
 * No template engine (E §1 — three things deliberately absent). Template literals with one
 * escape function whose call sites are the review surface.
 */

import type { RenderedPage, RenderedQuestion } from '@resscript/runtime-core';

/** HTML-escape for TEXT and ATTRIBUTE positions. Every interpolation below goes through it. */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface HtmlPageInput {
  readonly page: RenderedPage;
  readonly sessionId: string;
  readonly token: string;
  /** Prefilled values for a back-navigation render, keyed by variable id. */
  readonly prefill?: Record<string, unknown>;
  /** Validation messages from a failed submit, question id -> message keys. */
  readonly errors?: ReadonlyMap<string, readonly string[]>;
  /** The question id -> variable id mapping (from `emits`), for input names. */
  readonly variableOf: (questionId: string) => string | undefined;
  readonly progress?: { readonly visited: number };
  /** Serve the enhancement bundle? Absent in environments that have not built it. */
  readonly clientScriptUrl?: string;
  /**
   * Where the form posts. Defaults to the survey origin's `/s/<token>`; the preview surface
   * (P1-11) passes `/preview/<hash>?pt=…`-shaped bases because a preview session has no
   * survey token to build the default from.
   */
  readonly actionBase?: string;
  /** Set on the preview surface: the studio origin the frame may talk to, and the hash. */
  readonly preview?: { readonly studioOrigin: string; readonly artifactHash: string };
}

function inputFor(q: RenderedQuestion, input: HtmlPageInput): string {
  const name = input.variableOf(q.id) ?? q.id;
  const prefillValue = input.prefill?.[name];
  const err = input.errors?.get(q.id);

  const errorHtml = err?.length
    ? `<p class="error" role="alert">${err.map(esc).join(' ')}</p>`
    : '';

  // Radio for a single choice, checkboxes for a set — decided by question_type, with radios
  // as the fallback: over-permitting selections is a data defect, under-permitting is only UX.
  const multi = /multi|checkbox|set/.test(q.question_type);

  if (q.options) {
    const items = q.options.items
      .map(item => {
        const checked = Array.isArray(prefillValue)
          ? (prefillValue as unknown[]).includes(item.code)
          : prefillValue === item.code;
        const disabled = q.options!.disabled_codes.includes(item.code);
        return `<label class="opt${disabled ? ' disabled' : ''}">
  <input type="${multi ? 'checkbox' : 'radio'}" name="${esc(name)}" value="${item.code}"${
    checked ? ' checked' : ''
  }${disabled ? ' disabled' : ''}>
  <span>${esc(item.label ?? String(item.code))}</span>
</label>`;
      })
      .join('\n');
    return `${errorHtml}<fieldset id="${esc(q.id)}"${q.required ? ' data-required' : ''}>
<legend>${esc(q.label ?? '')}</legend>
${q.instruction ? `<p class="instruction">${esc(q.instruction)}</p>` : ''}
${items}
</fieldset>`;
  }

  // No options axis: a text control. Long-text types get a textarea.
  const long = /text_long|essay|open/.test(q.question_type);
  const value = typeof prefillValue === 'string' || typeof prefillValue === 'number'
    ? String(prefillValue)
    : '';
  const control = long
    ? `<textarea id="in_${esc(q.id)}" name="${esc(name)}" rows="4">${esc(value)}</textarea>`
    : `<input id="in_${esc(q.id)}" type="text" name="${esc(name)}" value="${esc(value)}">`;
  return `${errorHtml}<div class="q" id="${esc(q.id)}"${q.required ? ' data-required' : ''}>
<label for="in_${esc(q.id)}">${esc(q.label ?? '')}</label>
${q.instruction ? `<p class="instruction">${esc(q.instruction)}</p>` : ''}
${control}
</div>`;
}

export function renderHtmlPage(input: HtmlPageInput): string {
  const { page } = input;
  const base = input.actionBase ?? `/s/${input.token}`;
  // The base may carry its own query (`/preview/<hash>?pt=…`); fold it into the action's.
  const [basePath, baseQuery] = base.split('?');
  const action = esc(
    `${basePath}/submit?${baseQuery ? `${baseQuery}&` : ''}session=${input.sessionId}&html=1`,
  );

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Survey</title>
<style>
  body{font:16px/1.5 system-ui,sans-serif;margin:0 auto;max-width:640px;padding:1rem}
  fieldset{border:none;padding:0;margin:0 0 1.5rem}
  legend,label.q{font-weight:600}
  .opt{display:block;padding:.4rem 0}
  .opt.disabled{opacity:.5}
  .instruction{color:#555;font-size:.9em}
  .error{color:#b00020;font-weight:600}
  button{font-size:1rem;padding:.6rem 2rem}
</style>
</head>
<body>
<main>
<form method="post" action="${action}">
${page.questions.map(q => inputFor(q, input)).join('\n')}
<input type="hidden" name="__page_id" value="${esc(page.page_id)}">
<button type="submit">Next</button>
</form>
</main>
${
  input.clientScriptUrl
    ? `<script src="${esc(input.clientScriptUrl)}" defer data-session="${esc(
        input.sessionId,
      )}" data-page="${esc(page.page_id)}"${
        input.preview
          ? ` data-preview-origin="${esc(input.preview.studioOrigin)}" data-artifact="${esc(
              input.preview.artifactHash,
            )}"`
          : ''
      }></script>`
    : ''
}
</body>
</html>`;
}

/**
 * The test-mode redirect interstitial (E §14.1): the resolved URL, the disposition, and every
 * interpolated parameter, with a "follow it anyway" link and deliberately NO auto-redirect —
 * QA's job is to look at what would have been sent, and an auto-follow would take the page
 * away before they can.
 */
export function renderRedirectInterstitial(input: {
  readonly url: string;
  readonly disposition: string;
  readonly params: Record<string, string>;
}): string {
  const rows = Object.entries(input.params)
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`)
    .join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Test redirect</title>
<style>
  body{font:15px/1.5 system-ui,sans-serif;margin:0 auto;max-width:720px;padding:2rem 1rem}
  .badge{display:inline-block;background:#fde68a;padding:.2rem .6rem;border-radius:4px;font-weight:600}
  code{word-break:break-all;background:#f3f4f6;padding:.2rem .4rem;border-radius:3px}
  table{border-collapse:collapse;margin:1rem 0}
  td{border:1px solid #ddd;padding:.3rem .6rem}
  a.follow{display:inline-block;margin-top:1rem;padding:.6rem 1.5rem;background:#111;color:#fff;text-decoration:none;border-radius:4px}
</style>
</head><body><main>
<p><span class="badge">TEST MODE</span></p>
<p>Disposition: <strong>${esc(input.disposition)}</strong></p>
<p>A production respondent would be redirected to:</p>
<p><code>${esc(input.url)}</code></p>
${rows ? `<table><thead><tr><td><strong>parameter</strong></td><td><strong>value</strong></td></tr></thead><tbody>${rows}</tbody></table>` : ''}
<a class="follow" href="${esc(input.url)}" rel="noreferrer">Follow it anyway</a>
</main></body></html>`;
}

/** The terminal page: a disposition with no redirect configured yet (E §11 step 6). */
export function renderTerminalPage(disposition: string): string {
  const messages: Record<string, string> = {
    COMPLETE: 'Thank you — your responses have been recorded.',
    SCREENOUT: 'Thank you for your interest. You do not qualify for this survey.',
    QUOTA_FULL: 'Thank you — this survey has already reached its target for your group.',
  };
  const msg = messages[disposition] ?? 'This survey has ended.';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Survey</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:0 auto;max-width:640px;padding:3rem 1rem;text-align:center}</style>
</head><body><main><p>${esc(msg)}</p></main></body></html>`;
}
