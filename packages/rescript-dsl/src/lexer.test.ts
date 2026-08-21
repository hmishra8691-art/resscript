/**
 * Lexer tests. Three claims matter here and the rest is bookkeeping:
 *
 *  1. **Positions are exact.** Monaco underlines from these offsets, and the roadmap is explicit
 *     that "error messages can be terse; error *positions* cannot".
 *  2. **Keywords are case-insensitive, refs are not** (D §6.2).
 *  3. **All three comment markers lex**, because D §6.2 and 09-ui §7.4 disagree about which one the
 *     language has (see lexer.ts's header).
 */

import { describe, expect, it } from 'vitest';
import { lex, lineColAt, quote } from './lexer.js';
import { KEYWORDS, isKeyword } from './tokens.js';

const kinds = (source: string): readonly string[] =>
  lex(source)
    .tokens.filter((t) => t.kind !== 'eof')
    .map((t) => `${t.kind}:${t.text}`);

describe('the lexer', () => {
  it('records offsets, lines and columns', () => {
    const source = 'IF S1 = 1\n  THEN SHOW Q12';
    const tokens = lex(source).tokens;
    const then = tokens.find((t) => t.upper === 'THEN');
    expect(then).toBeDefined();
    expect(then?.start).toBe(source.indexOf('THEN'));
    expect(then?.end).toBe(source.indexOf('THEN') + 4);
    expect(then?.line).toBe(2);
    expect(then?.col).toBe(3);
    expect(source.slice(then?.start ?? 0, then?.end ?? 0)).toBe('THEN');
  });

  it('counts UTF-16 code units, not bytes, so a non-ASCII label does not shift later spans', () => {
    // Recorded as a deviation from the milestone brief's "byte offsets": every consumer named in the
    // design (Monaco, the API's `source_span`, `String.prototype.slice`) counts code units, and a
    // diagnostic offset that disagrees with the editor's is worse than useless.
    const source = 'IF OE = "Ωmega" THEN SHOW Q12';
    const then = lex(source).tokens.find((t) => t.upper === 'THEN');
    expect(then?.start).toBe(source.indexOf('THEN'));
  });

  it('treats keywords case-insensitively and refs case-sensitively', () => {
    expect(lex('if').tokens[0]?.kind).toBe('keyword');
    expect(lex('If').tokens[0]?.kind).toBe('keyword');
    expect(lex('IF').tokens[0]?.kind).toBe('keyword');
    const [q1, q1lower] = [lex('Q1').tokens[0], lex('q1').tokens[0]];
    expect(q1?.kind).toBe('ident');
    expect(q1lower?.kind).toBe('ident');
    expect(q1?.text).not.toBe(q1lower?.text);
  });

  it('lexes all three comment markers and keeps them verbatim', () => {
    const source = '# hash\n-- dash\n/* block */\nIF S1 = 1 THEN SHOW Q12';
    const { comments, tokens } = lex(source);
    expect(comments.map((c) => c.marker)).toEqual(['#', '--', '/*']);
    expect(comments.map((c) => c.text)).toEqual(['# hash', '-- dash', '/* block */']);
    expect(tokens[0]?.upper).toBe('IF');
    expect(tokens[0]?.line).toBe(4);
  });

  it('does not mistake a negation for a comment when they are separated', () => {
    expect(kinds('- -Q6')).toEqual(['punct:-', 'punct:-', 'ident:Q6']);
    // `--Q6` is a comment, which is why the printer never emits it (see printer.ts's `neg`).
    expect(kinds('--Q6')).toEqual([]);
  });

  it('reports an unterminated block comment and still terminates', () => {
    const { diagnostics, comments } = lex('/* never closed\nIF S1 = 1');
    expect(diagnostics.map((d) => d.code)).toEqual(['RSL-0003']);
    expect(comments).toHaveLength(1);
  });

  it('stops an unterminated string at the newline rather than swallowing the file', () => {
    const source = 'LABEL "oops\nIF S1 = 1 THEN SHOW Q12';
    const { diagnostics, tokens } = lex(source);
    expect(diagnostics.map((d) => d.code)).toEqual(['RSL-0002']);
    // The next line is still lexed, which is what keeps the diagnostics below a typo real.
    expect(tokens.some((t) => t.upper === 'THEN')).toBe(true);
  });

  it('reports a stray character and keeps going', () => {
    const { diagnostics, tokens } = lex('IF S1 @ 1 THEN SHOW Q12');
    expect(diagnostics.map((d) => d.code)).toEqual(['RSL-0015']);
    expect(tokens.filter((t) => t.kind !== 'eof')).toHaveLength(6);
  });

  it('decodes and re-encodes string escapes so printing is idempotent', () => {
    const token = lex('"a\\"b\\\\c\\nd\\u0041"').tokens[0];
    expect(token?.str).toBe('a"b\\c\nd A'.replace(' A', 'A'));
    expect(quote(token?.str ?? '')).toBe('"a\\"b\\\\c\\ndA"');
  });

  it('lexes decimals but not exponent notation, which is why the printer avoids emitting it', () => {
    expect(lex('1.5').tokens[0]?.num).toBe(1.5);
    expect(kinds('1e3')).toEqual(['number:1', 'ident:e3']);
  });

  it('counts newlines between tokens, which is what drives blank-line trivia', () => {
    const tokens = lex('SHOW Q12\n\n\nHIDE Q12').tokens;
    expect(tokens[2]?.nlBefore).toBe(3);
  });

  it('has a keyword table Monaco can be pinned against (09-ui §7.4)', () => {
    expect(KEYWORDS.length).toBeGreaterThan(50);
    expect(new Set(KEYWORDS).size).toBe(KEYWORDS.length);
    for (const keyword of KEYWORDS) {
      expect(keyword).toBe(keyword.toUpperCase());
      expect(isKeyword(keyword)).toBe(true);
    }
    expect(isKeyword('COUNT')).toBe(false); // function names are contextual, never reserved
  });

  it('reports line and column for an arbitrary offset', () => {
    expect(lineColAt('a\nbc\nd', 4)).toEqual({ line: 2, col: 3 });
    expect(lineColAt('a', 99)).toEqual({ line: 1, col: 2 });
  });
});
