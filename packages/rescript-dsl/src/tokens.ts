/**
 * The token set and the reserved-word table — D §6.2's lexical layer.
 *
 * Two rules from D §6.2, restated because they pull in opposite directions and every decision in
 * this file follows from them:
 *
 *  - **Keywords are case-insensitive** and pretty-print uppercase.
 *  - **Refs are case-sensitive**, because `Q1` and `q1` being the same variable is a trap in an
 *    export column name.
 *
 * So `if`, `If` and `IF` are one keyword, while `Q1` and `q1` are two different refs — which
 * means the *reserved* set has to stay small, or a legitimate variable name becomes unspellable.
 * The set below is exactly the words the grammar needs to make a decision on, and no more.
 * Function names (`COUNT`, `ANSWERED`, `LABEL_OF`, …) are deliberately **not** reserved: they are
 * recognized contextually by the following `(`, so a survey may declare a variable named `COUNT`
 * without the parser noticing. That is the difference between a small language and an annoying
 * one.
 */

export type TokenKind = 'ident' | 'keyword' | 'number' | 'string' | 'punct' | 'eof';

export interface Token {
  readonly kind: TokenKind;
  /** The raw slice, verbatim. Refs keep their case; keywords keep the author's case. */
  readonly text: string;
  /** `text.toUpperCase()`, precomputed because keyword comparison is the hot path. */
  readonly upper: string;
  /** Decoded value for a number token. */
  readonly num?: number;
  /** Decoded value for a string token (escapes applied). */
  readonly str?: string;
  readonly start: number;
  readonly end: number;
  readonly line: number;
  readonly col: number;
  /** Newlines between the previous token (or comment) and this one. Drives blank-line trivia. */
  readonly nlBefore: number;
}

export type CommentMarker = '#' | '--' | '/*';

export interface CommentToken {
  /** Verbatim, including the marker and any closing block-comment delimiter. Byte-for-byte. */
  readonly text: string;
  readonly marker: CommentMarker;
  readonly start: number;
  readonly end: number;
  readonly line: number;
  readonly col: number;
  readonly nlBefore: number;
}

/**
 * The reserved words.
 *
 * Grouped by the production that needs them, so that "why is this word reserved" is answerable
 * from the file. A word reserved for no production is a variable name someone cannot use.
 */
export const KEYWORDS = [
  // statements and definitions
  'QUESTION', 'BLOCK', 'PAGE', 'END', 'QUOTA', 'PRIORITY', 'GROUP',
  // question clauses
  'TYPE', 'LABEL', 'INSTRUCTION', 'REQUIRED', 'OPTIONAL', 'OPTIONS', 'ROWS', 'COLUMNS',
  'VALIDATE', 'RANDOMIZE', 'MASK', 'PIPE',
  // option flags
  'EXCLUSIVE', 'ANCHOR', 'SPECIFY', 'META', 'VISIBLE', 'ENABLED', 'PRESELECT', 'AUTOSELECT',
  // validate rules
  'SELECT', 'AT', 'LEAST', 'MOST', 'EXACTLY', 'SUM', 'RANGE', 'MATCHES', 'MESSAGE', 'REQUIRE',
  // rules and actions
  'IF', 'THEN', 'ELSE', 'ON', 'UNKNOWN', 'SHOW', 'HIDE', 'SKIP', 'TO', 'TERMINATE', 'AS',
  'CUSTOM', 'SET', 'DISABLE', 'ENABLE', 'UNREQUIRE', 'FLAG',
  // targets
  'OPTION', 'ROW', 'COLUMN', 'WHERE',
  // randomization
  'KEEP', 'FIRST', 'LAST', 'PLACE', 'SUBSET', 'SUBBLOCKS', 'EVENLY', 'ROTATE', 'CHILDREN',
  // masking and piping
  'EXCEPT', 'SELECTED', 'WHEN', 'EMPTY', 'FROM', 'ALL', 'CODE', 'LIST',
  // expressions
  'AND', 'OR', 'NOT', 'MOD', 'BETWEEN', 'CONTAINS', 'ANY', 'NONE', 'OF', 'IN', 'CASE',
  'NULLS', 'ITERATIONS', 'FAIL', 'ERROR',
  // literals
  'TRUE', 'FALSE', 'NULL', 'TEXT', 'DATE',
] as const;

export type Keyword = (typeof KEYWORDS)[number];

const KEYWORD_SET: ReadonlySet<string> = new Set<string>(KEYWORDS);

export function isKeyword(upper: string): upper is Keyword {
  return KEYWORD_SET.has(upper);
}

/**
 * Punctuation, longest match first.
 *
 * `=` and `==` both parse as equality and pretty-print as `=` (D §6.2); `<>` and `!=` likewise
 * for inequality. The synonyms exist because survey programmers arrive from SQL, from JavaScript
 * and from Decipher, and rejecting the spelling they already type teaches them nothing.
 */
export const PUNCTUATION = ['==', '<=', '>=', '<>', '!=', '=', '<', '>', '+', '-', '*', '/', '(', ')', '[', ']', '{', '}', ',', '.', '%'] as const;

export type Punct = (typeof PUNCTUATION)[number];

/** The keyword list Monaco's Monarch tokenizer must match (09-ui §7.4 pins this in a CI test). */
export function keywordList(): readonly string[] {
  return KEYWORDS;
}
