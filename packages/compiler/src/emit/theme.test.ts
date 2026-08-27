/**
 * The theme compiler (roadmap P2-12).
 *
 * Two things here are worth more than the rest.
 *
 * **The touch target actually exists.** `question-kit/contract/a11y.ts` asserts on every one of
 * 6,601 tests that `rs-target` is on every interactive element, and states that the real pixel value
 * lives in exactly one place. That place did not exist — no stylesheet in the repository defined the
 * class — so the contract was checked at the class level and unmet in every rendered survey. These
 * assertions are what make it real, and they read the floor from question-kit rather than from a
 * literal, because a floor with two values ships the wrong one.
 *
 * **A token value is an injection site.** It is interpolated into a stylesheet, so
 * `red;} body{display:none} .x{` would close the declaration and write arbitrary rules — and the CSS
 * sanitizer would never see it, because a token is not an author stylesheet. Every hostile spelling
 * below is a real attempt at that, and `resolveTokens` must drop each one rather than pass it
 * through.
 */

import { describe, expect, it } from 'vitest';
import { MIN_TOUCH_TARGET_PX, TOUCH_TARGET_CLASS } from '@resscript/question-kit';

// The sanitizer's own comment stripper, reused: asserting "the stylesheet does not contain
// outline:none" against the raw text failed on a COMMENT that explains why outline:none is
// forbidden. Checking the declarations rather than the prose is what the assertion meant, and this
// is the function that already knows how to tell them apart.
import { stripCssComments } from '../analyses/css.js';

import {
  TOKENS,
  compileTheme,
  defaultTheme,
  resolveTokens,
  validateTokens,
} from './theme.js';

/* ---------------------------------------------------------------- *
 * The accessibility contract
 * ---------------------------------------------------------------- */

describe('the touch-target contract', () => {
  it('defines the class question-kit asserts on', () => {
    // The defect this file closes. Before P2-12 this class was in no stylesheet anywhere, so the
    // contract was mechanically checked and never met.
    expect(defaultTheme().css).toContain(`.${TOUCH_TARGET_CLASS} {`);
  });

  it('emits the floor from question-kit, not a literal', () => {
    // a11y.ts calls MIN_TOUCH_TARGET_PX "a floor that a plugin cannot lower". A floor duplicated as
    // a literal in the file that emits the pixels is a floor with two values.
    const css = defaultTheme().css;
    expect(css).toContain(`min-height: ${String(MIN_TOUCH_TARGET_PX)}px`);
    expect(css).toContain(`min-width: ${String(MIN_TOUCH_TARGET_PX)}px`);
  });

  it('sets min-WIDTH as well as min-height', () => {
    // A 44px-tall target 12px wide is not a 44px target.
    const rule = defaultTheme().css.split(`.${TOUCH_TARGET_CLASS} {`)[1]?.split('}')[0] ?? '';
    expect(rule).toContain('min-width');
    expect(rule).toContain('min-height');
  });

  it('makes the element a flex box, so min-height is not inert', () => {
    // min-height on an inline element does nothing at all — which is how this rule gets written,
    // passes review, and changes no pixel.
    const rule = defaultTheme().css.split(`.${TOUCH_TARGET_CLASS} {`)[1]?.split('}')[0] ?? '';
    expect(rule).toMatch(/display:\s*inline-flex/);
    expect(rule).toContain('box-sizing: border-box');
  });

  it('keeps a visible focus ring and never sets outline:none', () => {
    // Its absence is the single most common WCAG failure in a themed survey.
    const css = defaultTheme().css;
    expect(css).toContain('focus-visible');
    expect(css).toContain('outline: 3px solid');

    const declarations = stripCssComments(css);
    expect(declarations).not.toContain('outline: none');
    expect(declarations).not.toContain('outline:none');
  });

  it('honours prefers-reduced-motion', () => {
    // A survey is not the place to override somebody's vestibular-disorder accommodation.
    expect(defaultTheme().css).toContain('@media (prefers-reduced-motion: reduce)');
  });
});

/* ---------------------------------------------------------------- *
 * Token validation — the injection surface
 * ---------------------------------------------------------------- */

describe('validateTokens', () => {
  it('accepts every fallback in the vocabulary', () => {
    // The vocabulary must be internally consistent, or the default theme is invalid by its own
    // rules — which would be caught here and nowhere else.
    const all = Object.fromEntries(Object.entries(TOKENS).map(([k, v]) => [k, v.fallback]));
    expect(validateTokens(all)).toEqual([]);
  });

  it('accepts ordinary values', () => {
    expect(
      validateTokens({
        'color-brand': '#0057b8',
        'color-bg': 'rgba(255, 255, 255, 0.9)',
        'font-family': 'Inter, system-ui, sans-serif',
        'font-size': '18px',
        'line-height': '1.6',
        radius: '0',
        space: '1.25rem',
      }),
    ).toEqual([]);
  });

  it('reports an unknown token rather than ignoring it', () => {
    // A typo that silently does nothing is a theme editor where a change appears to save and has no
    // effect.
    expect(validateTokens({ 'colour-brand': '#fff' })).toEqual([
      { token: 'colour-brand', reason: 'unknown_token', value: '#fff' },
    ]);
  });

  it('REFUSES a value that would close the declaration and write new rules', () => {
    // The attack. `--rs-color-brand: red;} body{display:none} .x{` ends our declaration block and
    // then writes whatever it likes — and CMP-0503 never sees it, because a token is not an author
    // stylesheet.
    for (const hostile of [
      'red;} body{display:none} .x{',
      '#fff;}*{display:none}',
      'red}',
      'red;',
    ]) {
      expect(validateTokens({ 'color-brand': hostile })).toEqual([
        { token: 'color-brand', reason: 'invalid_value', value: hostile },
      ]);
    }
  });

  it('REFUSES a url() or an expression in a token', () => {
    for (const hostile of ['url(//evil/)', 'expression(alert(1))', '#fff url(//evil/)']) {
      expect(validateTokens({ 'color-bg': hostile })).toHaveLength(1);
    }
  });

  it('REFUSES a comment, which is how a pattern is smuggled past', () => {
    expect(validateTokens({ 'color-bg': '#fff/*x*/' })).toHaveLength(1);
  });

  it('REFUSES var(), because a token whose value is a token is a cycle', () => {
    expect(validateTokens({ 'color-bg': 'var(--rs-color-fg)' })).toHaveLength(1);
  });

  it('refuses a length with no unit, and a bare number where a length belongs', () => {
    expect(validateTokens({ radius: '6' })).toHaveLength(1);
    // ...but a bare 0 is legitimate CSS and is allowed.
    expect(validateTokens({ radius: '0' })).toEqual([]);
  });

  it('refuses a font stack containing a semicolon or brace', () => {
    expect(validateTokens({ 'font-family': 'Inter;} body{color:red' })).toHaveLength(1);
  });

  it('allows quotes in a font stack, which a family name legitimately needs', () => {
    expect(validateTokens({ 'font-family': '"Helvetica Neue", Arial, sans-serif' })).toEqual([]);
  });

  it('returns problems sorted, so a form does not reorder between saves', () => {
    const p = validateTokens({ zzz: 'x', aaa: 'y', mmm: 'z' });
    expect(p.map((x) => x.token)).toEqual(['aaa', 'mmm', 'zzz']);
  });
});

/* ---------------------------------------------------------------- *
 * Resolution
 * ---------------------------------------------------------------- */

describe('resolveTokens', () => {
  it('is TOTAL — every token has a value, so no rule needs a var() fallback', () => {
    // A stylesheet whose rules carry their own fallbacks has the default written twice, and the
    // copy in the CSS is the one that ships.
    const t = resolveTokens();
    for (const name of Object.keys(TOKENS)) {
      expect(t[name as keyof typeof t]).toBeTruthy();
    }
  });

  it('merges nearest-last, which is what theme inheritance means', () => {
    const parent = { 'color-brand': '#111111', radius: '2px' };
    const child = { 'color-brand': '#222222' };
    const t = resolveTokens(parent, child);

    expect(t['color-brand']).toBe('#222222'); // the child wins
    expect(t['radius']).toBe('2px'); // and inherits what it did not set
  });

  it('DROPS an invalid value rather than passing it to the emitter', () => {
    // The second layer. validateTokens reports so an author can fix it; this refuses so a caller
    // that skipped validation cannot ship an injection payload.
    const t = resolveTokens({ 'color-brand': 'red;}*{display:none}' });
    expect(t['color-brand']).toBe(TOKENS['color-brand']!.fallback);
  });

  it('drops an unknown token silently, since validateTokens is where it is reported', () => {
    // Set equality, not array equality: the resolved map's key ORDER is the vocabulary's insertion
    // order and is not a contract — the emitter sorts, which is where order actually matters.
    const t = resolveTokens({ nonsense: 'x' });
    expect(new Set(Object.keys(t))).toEqual(new Set(Object.keys(TOKENS)));
    expect('nonsense' in t).toBe(false);
  });

  it('trims whitespace, so a pasted value works', () => {
    expect(resolveTokens({ 'color-brand': '  #abcdef  ' })['color-brand']).toBe('#abcdef');
  });
});

/* ---------------------------------------------------------------- *
 * Emission
 * ---------------------------------------------------------------- */

describe('compileTheme', () => {
  it('emits every token as a custom property, including unchanged ones', () => {
    // An author stylesheet may read var(--rs-color-muted); a property that appeared only when a
    // client had customised it would work on one survey and not the next.
    const css = compileTheme().css;
    for (const name of Object.keys(TOKENS)) {
      expect(css).toContain(`--rs-${name}:`);
    }
  });

  it('emits the customised value', () => {
    const css = compileTheme({ layers: [{ 'color-brand': '#ff0000' }] }).css;
    expect(css).toContain('--rs-color-brand: #ff0000;');
  });

  it('is DETERMINISTIC — the same input gives byte-identical output', () => {
    // These bytes are inside the artifact's content hash (ADR-002). A hash that changes when nothing
    // changed makes every republish look like an edit.
    const a = compileTheme({ layers: [{ 'color-brand': '#123456' }] }).css;
    const b = compileTheme({ layers: [{ 'color-brand': '#123456' }] }).css;
    expect(a).toBe(b);
  });

  it('does not depend on token insertion order', () => {
    const a = compileTheme({ layers: [{ 'color-bg': '#eeeeee', radius: '4px' }] }).css;
    const b = compileTheme({ layers: [{ radius: '4px', 'color-bg': '#eeeeee' }] }).css;
    expect(a).toBe(b);
  });

  it('returns the resolved tokens alongside the CSS', () => {
    const out = compileTheme({ layers: [{ radius: '10px' }] });
    expect(out.tokens['radius']).toBe('10px');
    expect(out.tokens['color-bg']).toBe(TOKENS['color-bg']!.fallback);
  });

  it('emits CSS its own sanitizer accepts', () => {
    // The compiled theme must not itself contain a construct CMP-0503 refuses — apart from the
    // reserved selectors, which only WE are allowed to write. That is the point of the rule.
    const css = compileTheme().css;
    expect(css).not.toContain('@import');
    expect(css).not.toContain('url(');
    expect(css).not.toContain('expression(');
  });
});
