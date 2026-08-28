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
   * The compiled stylesheet's content-addressed URL (`/theme/<hash>.css`).
   *
   * Absent means the inline fallback below is used, which is the pre-P2-12 behaviour and is kept for
   * exactly one case: an artifact compiled before the theme existed. It is NOT the normal path —
   * the fallback cannot define `.rs-target`, because that class's pixel value lives in one place
   * (the theme compiler) and duplicating it here would give the accessibility floor two values.
   */
  readonly themeCssUrl?: string;
  /**
   * The author stylesheet's content-addressed URL, when the survey has one.
   *
   * Linked AFTER the theme, which is the cascade an author expects — their rules override the
   * platform's defaults. Safe to put second because `CMP-0503` refuses selectors on the reserved
   * `rs-` prefix, so author CSS cannot restyle the touch-target contract the theme defines however
   * late it loads.
   */
  readonly authorCssUrl?: string;
  /**
   * The author's page-shell HTML, already fetched by the caller.
   *
   * A resolved STRING, not a ref or a fetcher: this function is synchronous and pure, which is what
   * lets the whole render be unit-tested and replayed. `handler.ts` resolves
   * `page.settings.html_template_ref` through the artifact loader before calling.
   *
   * The template has already passed `CMP-0500`'s allowlist at compile time, so it carries no
   * script, no event handlers and no disallowed URL schemes. `CMP-0504` has already refused one
   * without a `{{questions}}` slot, so the substitution below cannot silently drop the form.
   */
  readonly pageTemplate?: string;
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

/**
 * The questions slot a page template must contain.
 *
 * Duplicated from `compiler/src/analyses/templates.ts` rather than imported: `apps/runtime` does
 * not depend on `@resscript/compiler` and must not start — the runtime loading the compiler would
 * put the whole publish pipeline in the respondent's request path. The token is asserted equal in
 * both places by a test, which is the mechanism that keeps two literals in step where an import
 * would.
 */
const QUESTIONS_SLOT = '{{questions}}';

/**
 * Put the form into the author's shell.
 *
 * EVERY occurrence, not the first. A template with two slots is an authoring mistake, and
 * substituting once would leave a literal `{{questions}}` visible on the page — a respondent
 * reading their own survey's template syntax is worse than a duplicated form, and `CMP-0504`
 * cannot tell one slot from two without deciding that two is illegal, which it is not obviously.
 *
 * `replaceAll` with a STRING needle, never a RegExp: the form's HTML contains `$` in
 * nothing today and could tomorrow, and `$&` in a regex replacement is a substitution nobody
 * intends. A string needle takes no pattern.
 */
function applyPageTemplate(template: string, form: string): string {
  if (!template.includes(QUESTIONS_SLOT)) {
    // CMP-0504 refuses this at publish, so reaching it means a hand-edited artifact. The form wins:
    // a respondent who cannot answer is a lost interview, and a template that renders without its
    // shell is merely ugly.
    return form;
  }
  return template.split(QUESTIONS_SLOT).join(form);
}

/**
 * The stylesheet element, or the legacy inline block.
 *
 * The linked theme is the normal path and the inline block is a fallback for an artifact compiled
 * before P2-12. Keeping the fallback matters — an old artifact must still render — but it is
 * deliberately NOT a copy of the theme: it cannot define `.rs-target`, because that class's pixel
 * value lives in exactly one place (`compiler/emit/theme.ts`) and a second copy here would be a
 * WCAG floor with two values, of which the stale one ships.
 *
 * `<link>` rather than an inline `<style>` for the compiled theme, even though inlining saves a
 * request: the URL is content-addressed, so the browser caches it across every page of every session
 * and across surveys sharing an artifact, while inlining pays for the bytes on every page render.
 */
function themeLink(input: HtmlPageInput): string {
  if (input.themeCssUrl !== undefined) {
    const theme = `<link rel="stylesheet" href="${esc(input.themeCssUrl)}">`;
    // Author CSS second — see `authorCssUrl`. A 404 for a survey with no author stylesheet costs
    // one request and renders identically, which is a better trade than threading "does this
    // artifact have author CSS" through every render path.
    return input.authorCssUrl === undefined
      ? theme
      : `${theme}\n<link rel="stylesheet" href="${esc(input.authorCssUrl)}">`;
  }
  return `<style>
  /* Fallback for an artifact compiled before the theme compiler existed (P2-12). Deliberately does
     NOT define .rs-target — see themeLink(). */
  body{font:16px/1.5 system-ui,sans-serif;margin:0 auto;max-width:640px;padding:1rem}
  fieldset{border:none;padding:0;margin:0 0 1.5rem}
  legend,label.q{font-weight:600}
  .opt{display:block;padding:.4rem 0}
  .opt.disabled{opacity:.5}
  .instruction{color:#555;font-size:.9em}
  .error{color:#b00020;font-weight:600}
  button{font-size:1rem;padding:.6rem 2rem}
</style>`;
}

export function renderHtmlPage(input: HtmlPageInput): string {
  const { page } = input;
  const base = input.actionBase ?? `/s/${input.token}`;
  // The base may carry its own query (`/preview/<hash>?pt=…`); fold it into the action's.
  const [basePath, baseQuery] = base.split('?');
  const action = esc(
    `${basePath}/submit?${baseQuery ? `${baseQuery}&` : ''}session=${input.sessionId}&html=1`,
  );

  const form = `<form method="post" action="${action}">
${page.questions.map(q => inputFor(q, input)).join('\n')}
<input type="hidden" name="__page_id" value="${esc(page.page_id)}">
<button type="submit">Next</button>
</form>`;

  // The author's shell, or ours. The template is substituted INSIDE `<main>` rather than replacing
  // the document: a page template overrides the page shell (schema §11), not the head, the charset,
  // the viewport or `robots: noindex`. Letting it replace the document would let a template drop
  // `noindex` and put a live survey in a search index — which is not a styling decision.
  const body =
    input.pageTemplate === undefined
      ? `<main>\n${form}\n</main>`
      : `<main>\n${applyPageTemplate(input.pageTemplate, form)}\n</main>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Survey</title>
${themeLink(input)}
</head>
<body>
${body}
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
