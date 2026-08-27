/**
 * The theme compiler: tokens → `theme.css` (C §15, roadmap P2-12).
 *
 * ## The defect this closes
 *
 * `question-kit/contract/a11y.ts` explains, at length and correctly, that "≥ 44 CSS px" cannot be
 * measured in jsdom, so the sizing is "pushed into one themed class that the design layer
 * guarantees, and the kit asserts the *class* is present on every interactive element." All 6,601
 * question-kit tests assert that `rs-target` is on every interactive element.
 *
 * `rs-target` was defined in **no stylesheet anywhere in this repository**. `apps/runtime/src/render/
 * html.ts` inlines nine literal CSS rules and none of them is it. So the accessibility contract the
 * whole kit is built around — the WCAG 2.2 AA touch-target floor — was mechanically checked at the
 * class level and unmet in every survey ever rendered. The class was present; the size was not.
 *
 * That is exactly the failure mode a11y.ts warned about in its own words ("leaves exactly one place
 * where the real px value is defined") and the one place was missing. `baseCss()` below is it.
 *
 * `MIN_TOUCH_TARGET_PX` is imported from question-kit rather than written as `44` here. The contract
 * calls itself a floor "that a plugin cannot lower"; a floor duplicated as a literal in the file
 * that actually emits the pixels is a floor with two values, and the second one is the one that
 * ships.
 *
 * ## Tokens, and why they are a closed vocabulary
 *
 * A theme is a flat `token → value` map over a fixed set of names, not arbitrary CSS. Three reasons,
 * and the third is the one that decides it:
 *
 *  * A closed set can be validated: a typo produces a diagnostic rather than a silently missing
 *    style.
 *  * A closed set can be inherited: `resolveTokens(parent, child)` is a merge, which is well-defined
 *    only when both sides speak the same vocabulary.
 *  * **A token value is interpolated into a stylesheet, so it is an injection site.** `--rs-bg:
 *    red;} body{display:none} .x{` would end the declaration and write arbitrary rules. Every value
 *    is therefore validated against a per-kind pattern (a colour is a colour, a length is a length)
 *    and a value that does not match is refused. Allowing free-form CSS in a token would make the
 *    theme editor a CSS injection vector with a friendly name, and the CSS sanitizer (`CMP-0503`)
 *    would never see it because a token is not an author stylesheet.
 *
 * ## Emitted as custom properties
 *
 * `:root{--rs-color-brand:#0057b8}` and rules that consume them, rather than tokens substituted
 * directly into each rule. Custom properties mean the cascade does the work: an author stylesheet
 * can legitimately override a token (`:root{--rs-radius:0}`) without touching our rules, while
 * `CMP-0503`'s reserved-selector rule still stops it from restyling `.rs-target` itself. The
 * distinction is deliberate — a client may change the brand colour; a client may not shrink the
 * touch target.
 */

import { MIN_TOUCH_TARGET_PX } from '@resscript/question-kit';

/** A token's value kind, which decides how its value is validated. */
export type TokenKind = 'color' | 'length' | 'font' | 'number';

export interface TokenSpec {
  readonly kind: TokenKind;
  /** Used when neither the theme nor its parent supplies one. Always valid for its kind. */
  readonly fallback: string;
}

/**
 * The vocabulary. Small on purpose: every entry here is a promise to keep emitting a CSS custom
 * property of that name, because an author stylesheet may reference it. Adding one is cheap;
 * removing one breaks somebody's CSS silently, so the list grows only when a real theme needs it.
 */
export const TOKENS: { readonly [name: string]: TokenSpec } = {
  'color-bg': { kind: 'color', fallback: '#ffffff' },
  'color-fg': { kind: 'color', fallback: '#1a1a1a' },
  'color-muted': { kind: 'color', fallback: '#555555' },
  'color-brand': { kind: 'color', fallback: '#0057b8' },
  'color-brand-fg': { kind: 'color', fallback: '#ffffff' },
  'color-error': { kind: 'color', fallback: '#b00020' },
  'color-border': { kind: 'color', fallback: '#c9c9c9' },
  'color-focus': { kind: 'color', fallback: '#0057b8' },
  'font-family': { kind: 'font', fallback: 'system-ui, sans-serif' },
  'font-size': { kind: 'length', fallback: '16px' },
  'line-height': { kind: 'number', fallback: '1.5' },
  'radius': { kind: 'length', fallback: '6px' },
  'space': { kind: 'length', fallback: '1rem' },
  'content-width': { kind: 'length', fallback: '640px' },
} as const;

export type TokenName = keyof typeof TOKENS;

/**
 * Value patterns, per kind.
 *
 * Deliberately narrow rather than "any valid CSS value for this property". A wider pattern is a
 * wider injection surface, and the cost of narrowness is that an exotic-but-legitimate value is
 * refused with a message the author can act on — which is the failure direction that gets fixed
 * rather than exploited. Note what every pattern excludes: `;`, `}`, `{`, `(`, `/*`, and quotes.
 */
const PATTERNS: { readonly [K in TokenKind]: RegExp } = {
  // Hex, or one of the functional forms with numeric arguments only. No `var()` — a token whose
  // value is another token is a cycle waiting to happen and a resolution order nobody can read.
  color:
    /^(?:#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|(?:rgb|rgba|hsl|hsla)\(\s*[0-9.,%\s/]+\s*\)|transparent|currentColor)$/,
  length: /^-?(?:\d+|\d*\.\d+)(?:px|rem|em|%|vh|vw|ch)$|^0$/,
  number: /^-?(?:\d+|\d*\.\d+)$/,
  // A font STACK: names, quoted or bare, comma-separated. Quotes are allowed here because a family
  // name legitimately needs them, and the pattern pins what may appear between them.
  font: /^[A-Za-z0-9 -￿ "'\-_,.]+$/,
};

export interface TokenProblem {
  readonly token: string;
  /** `unknown_token` | `invalid_value`. */
  readonly reason: string;
  readonly value: string;
}

/**
 * Validate a token map. Returns the problems; the caller decides whether they are a diagnostic or a
 * 422.
 *
 * Exported and returning data rather than throwing, so the studio's theme editor and the compiler
 * can share one definition of "is this theme valid" — two implementations would let the editor
 * accept what the compiler refuses, which is a save button that produces an unpublishable survey.
 */
export function validateTokens(tokens: { readonly [k: string]: string }): readonly TokenProblem[] {
  const problems: TokenProblem[] = [];
  // Sorted so the list is stable: a caller rendering these into a form should not see them reorder
  // between saves.
  for (const name of Object.keys(tokens).sort()) {
    const value = tokens[name] ?? '';
    const spec = TOKENS[name];
    if (spec === undefined) {
      problems.push({ token: name, reason: 'unknown_token', value });
      continue;
    }
    if (!PATTERNS[spec.kind].test(value.trim())) {
      problems.push({ token: name, reason: 'invalid_value', value });
    }
  }
  return problems;
}

/**
 * Merge a chain of token maps, nearest-last, and fill every gap from the vocabulary's fallbacks.
 *
 * The result is TOTAL — every token in `TOKENS` has a value — which is what lets `baseCss()` be
 * written without a single `var(--x, fallback)`. A stylesheet whose rules carry their own fallbacks
 * has the default value written twice, and the copy in the CSS is the one that ships.
 *
 * INVALID VALUES ARE DROPPED, not passed through. A caller that skipped validation must not be able
 * to reach the emitter with an injection payload, so this is the second layer: `validateTokens`
 * reports so the author can fix it, and this refuses so a bug in the caller cannot ship it.
 */
export function resolveTokens(
  ...chain: readonly { readonly [k: string]: string }[]
): { readonly [K in TokenName]: string } {
  const out: { [k: string]: string } = {};
  for (const name of Object.keys(TOKENS)) out[name] = (TOKENS[name] as TokenSpec).fallback;
  for (const layer of chain) {
    for (const [name, value] of Object.entries(layer)) {
      const spec = TOKENS[name];
      if (spec === undefined) continue;
      const trimmed = value.trim();
      if (!PATTERNS[spec.kind].test(trimmed)) continue;
      out[name] = trimmed;
    }
  }
  return out as { readonly [K in TokenName]: string };
}

/* -------------------------------------------------------------------------- */
/* Emission                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The custom-property block.
 *
 * Every token is emitted, including ones equal to their fallback. That is deliberate: an author
 * stylesheet may read `var(--rs-color-muted)`, and a property that appears only when a client
 * happens to have customised it would work on one survey and not the next.
 */
function rootBlock(tokens: { readonly [K in TokenName]: string }): string {
  const lines = Object.keys(TOKENS)
    .sort()
    .map((name) => `  --rs-${name}: ${tokens[name as TokenName]};`);
  return `:root {\n${lines.join('\n')}\n}`;
}

/**
 * The base stylesheet. THIS is the one place the touch-target pixels are defined.
 *
 * `min-height` AND `min-width`, because a 44px-tall target 12px wide is not a 44px target; and
 * `display:inline-flex` with centring, because a min-height on an inline element does nothing at
 * all — which is the way this rule would be written, look correct in review, and change no pixel.
 */
function baseCss(): string {
  const px = `${String(MIN_TOUCH_TARGET_PX)}px`;
  return `/* The touch-target contract. question-kit/contract/a11y.ts asserts the CLASS is present on
   every interactive element and states that the real px value lives in exactly one place; this is
   that place. min-width as well as min-height, because a tall sliver is not a target, and
   inline-flex because min-height on an inline element does nothing. */
.rs-target {
  min-height: ${px};
  min-width: ${px};
  display: inline-flex;
  align-items: center;
  box-sizing: border-box;
}

/* A visible focus ring, never removed. Its absence is the single most common WCAG failure in a
   themed survey, and a theme that could set outline:none would take the keyboard away from
   everybody who needs it. Not overridable by an author stylesheet: CMP-0503 refuses selectors on
   the rs- prefix. */
.rs-target:focus-visible,
:where(input, select, textarea, button, [tabindex]):focus-visible {
  outline: 3px solid var(--rs-color-focus);
  outline-offset: 2px;
}

body {
  background: var(--rs-color-bg);
  color: var(--rs-color-fg);
  font-family: var(--rs-font-family);
  font-size: var(--rs-font-size);
  line-height: var(--rs-line-height);
  margin: 0 auto;
  max-width: var(--rs-content-width);
  padding: var(--rs-space);
}

fieldset { border: none; padding: 0; margin: 0 0 calc(var(--rs-space) * 1.5); }
legend, label.q { font-weight: 600; }
.opt { display: block; padding: calc(var(--rs-space) * 0.4) 0; }
.opt.disabled { opacity: .5; }
.instruction { color: var(--rs-color-muted); font-size: .9em; }
.error { color: var(--rs-color-error); font-weight: 600; }

input[type="text"], input[type="number"], select, textarea {
  font: inherit;
  color: inherit;
  background: var(--rs-color-bg);
  border: 1px solid var(--rs-color-border);
  border-radius: var(--rs-radius);
  padding: calc(var(--rs-space) * 0.4);
}

button {
  font: inherit;
  background: var(--rs-color-brand);
  color: var(--rs-color-brand-fg);
  border: none;
  border-radius: var(--rs-radius);
  padding: calc(var(--rs-space) * 0.6) calc(var(--rs-space) * 2);
  cursor: pointer;
}

/* Respect the OS setting rather than animating regardless. A survey is not the place to override
   somebody's vestibular-disorder accommodation. */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: .01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: .01ms !important;
  }
}`;
}

export interface CompileThemeInput {
  /**
   * Nearest-last token layers: the platform default is already the vocabulary's fallbacks, so this
   * is typically `[parentTheme, theme]` or just `[theme]`.
   */
  readonly layers?: readonly { readonly [k: string]: string }[];
}

export interface CompiledTheme {
  readonly css: string;
  /** The fully resolved tokens, for `ArtifactManifest` and for a theme editor's preview. */
  readonly tokens: { readonly [K in TokenName]: string };
}

/**
 * Compile a theme to the bytes that ship.
 *
 * Deterministic: token order is sorted and nothing consults a clock or a random source, because
 * these bytes go into the artifact's content hash (ADR-002) and a hash that changes when nothing
 * changed makes every republish look like an edit.
 */
export function compileTheme(input: CompileThemeInput = {}): CompiledTheme {
  const tokens = resolveTokens(...(input.layers ?? []));
  return {
    tokens,
    css: `${rootBlock(tokens)}\n\n${baseCss()}\n`,
  };
}

/** The default theme, for a survey that pins none. Exported so tests and previews share it. */
export function defaultTheme(): CompiledTheme {
  return compileTheme();
}
