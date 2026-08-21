/**
 * The lexer. Total: it never throws, and it never stops early — P8 (D §6.4) starts here, because
 * Monaco calls this on every keystroke, on input that is broken by construction.
 *
 * Every unlexable byte produces a diagnostic **and** a token stream that continues, so the parser
 * still sees the rest of the file. A lexer that bailed on the first stray character would make the
 * editor's diagnostics collapse to one message per typo, which is how a language server becomes
 * something users turn off.
 *
 * ## The comment-syntax contradiction
 *
 * The source documents disagree, and this is the one place it matters:
 *
 *  - **D §6.2** declares `comment = "--" { any_char_but_newline } | "/*" ... "*​/"`, and every
 *    example in D §6.3 and §9.2 uses `--`.
 *  - **09-ui §7.4** registers the Monaco language with `comments: { lineComment: '#' }`, which is
 *    what the editor's toggle-comment command (`⌘/`) inserts.
 *
 * If the lexer honoured only D, `⌘/` in the studio would insert a `#` the parser rejects: comment
 * a line out, get a syntax error. If it honoured only 09-ui, every example in the design docs
 * would fail to parse and the §6.3 corpus fixture would be unusable.
 *
 * So all three markers lex as comments, the author's marker is preserved verbatim in trivia
 * (T2 forbids changing a comment, and rewriting `--` to `#` would be changing it), and `#` is what
 * the printer emits for a comment it has to synthesize — which today is never, because comments
 * only ever arrive from source. Reported as a contradiction rather than settled quietly.
 */

import { rslDiagnostic, type DslDiagnostic, type Span } from './diagnostics.js';
import { PUNCTUATION, isKeyword, type CommentMarker, type CommentToken, type Token } from './tokens.js';

export interface LexResult {
  /** Comments excluded — they are trivia and the parser consumes them positionally. */
  readonly tokens: readonly Token[];
  readonly comments: readonly CommentToken[];
  readonly diagnostics: readonly DslDiagnostic[];
}

export function lex(source: string): LexResult {
  const tokens: Token[] = [];
  const comments: CommentToken[] = [];
  const diagnostics: DslDiagnostic[] = [];

  let i = 0;
  let line = 1;
  let lineStart = 0;
  /** Newlines seen since the last token or comment was emitted. */
  let nl = 0;

  const col = (offset: number): number => offset - lineStart + 1;
  const span = (start: number, end: number, atLine: number, atCol: number): Span => ({
    start,
    end,
    line: atLine,
    col: atCol,
  });

  while (i < source.length) {
    const ch = source.charAt(i);

    /* ---- whitespace ------------------------------------------------------ */
    if (ch === '\n') {
      i += 1;
      line += 1;
      lineStart = i;
      nl += 1;
      continue;
    }
    if (ch === '\r' || ch === ' ' || ch === '\t' || ch === '\f' || ch === '\v') {
      i += 1;
      continue;
    }

    const startLine = line;
    const startCol = col(i);

    /* ---- comments -------------------------------------------------------- */
    const marker = commentMarkerAt(source, i);
    if (marker !== undefined) {
      if (marker === '/*') {
        const close = source.indexOf('*/', i + 2);
        const end = close === -1 ? source.length : close + 2;
        const text = source.slice(i, end);
        if (close === -1) {
          diagnostics.push(
            rslDiagnostic(
              'RSL-0003',
              'Unterminated block comment: `/*` with no closing `*/`. Everything to the end of ' +
                'the file has been treated as comment text.',
              span(i, end, startLine, startCol),
            ),
          );
        }
        comments.push({ text, marker, start: i, end, line: startLine, col: startCol, nlBefore: nl });
        nl = 0;
        // Advance the line counter across the comment body so later positions stay correct.
        for (let k = i; k < end; k += 1) {
          if (source.charAt(k) === '\n') {
            line += 1;
            lineStart = k + 1;
          }
        }
        i = end;
        continue;
      }
      const nlAt = source.indexOf('\n', i);
      const end = nlAt === -1 ? source.length : nlAt;
      comments.push({
        text: source.slice(i, end),
        marker,
        start: i,
        end,
        line: startLine,
        col: startCol,
        nlBefore: nl,
      });
      nl = 0;
      i = end;
      continue;
    }

    /* ---- strings --------------------------------------------------------- */
    if (ch === '"') {
      const decoded = readString(source, i);
      const text = source.slice(i, decoded.end);
      if (!decoded.terminated) {
        diagnostics.push(
          rslDiagnostic(
            'RSL-0002',
            'Unterminated string literal: no closing `"` before the end of the line.',
            span(i, decoded.end, startLine, startCol),
          ),
        );
      }
      tokens.push({
        kind: 'string',
        text,
        upper: text.toUpperCase(),
        str: decoded.value,
        start: i,
        end: decoded.end,
        line: startLine,
        col: startCol,
        nlBefore: nl,
      });
      nl = 0;
      i = decoded.end;
      continue;
    }

    /* ---- numbers --------------------------------------------------------- */
    if (isDigit(ch)) {
      let j = i;
      while (j < source.length && isDigit(source.charAt(j))) j += 1;
      if (source.charAt(j) === '.' && isDigit(source.charAt(j + 1))) {
        j += 1;
        while (j < source.length && isDigit(source.charAt(j))) j += 1;
      }
      const text = source.slice(i, j);
      const value = Number(text);
      if (!Number.isFinite(value)) {
        // Unreachable for the shape above, but the value model forbids NaN/Infinity outright
        // (D §2.2), so the check is here rather than trusted.
        diagnostics.push(
          rslDiagnostic('RSL-0004', `Malformed number literal ${JSON.stringify(text)}.`, span(i, j, startLine, startCol)),
        );
      }
      tokens.push({
        kind: 'number',
        text,
        upper: text,
        num: Number.isFinite(value) ? value : 0,
        start: i,
        end: j,
        line: startLine,
        col: startCol,
        nlBefore: nl,
      });
      nl = 0;
      i = j;
      continue;
    }

    /* ---- identifiers and keywords ---------------------------------------- */
    if (isIdentStart(ch)) {
      let j = i;
      while (j < source.length && isIdentPart(source.charAt(j))) j += 1;
      const text = source.slice(i, j);
      const upper = text.toUpperCase();
      tokens.push({
        kind: isKeyword(upper) ? 'keyword' : 'ident',
        text,
        upper,
        start: i,
        end: j,
        line: startLine,
        col: startCol,
        nlBefore: nl,
      });
      nl = 0;
      i = j;
      continue;
    }

    /* ---- punctuation ----------------------------------------------------- */
    const punct = PUNCTUATION.find((p) => source.startsWith(p, i));
    if (punct !== undefined) {
      tokens.push({
        kind: 'punct',
        text: punct,
        upper: punct,
        start: i,
        end: i + punct.length,
        line: startLine,
        col: startCol,
        nlBefore: nl,
      });
      nl = 0;
      i += punct.length;
      continue;
    }

    /* ---- anything else --------------------------------------------------- */
    diagnostics.push(
      rslDiagnostic(
        'RSL-0015',
        `Stray character ${JSON.stringify(ch)}. It is not part of any ResScript token and has been skipped.`,
        span(i, i + 1, startLine, startCol),
        { character: ch },
      ),
    );
    i += 1;
  }

  tokens.push({
    kind: 'eof',
    text: '',
    upper: '',
    start: source.length,
    end: source.length,
    line,
    col: col(source.length),
    nlBefore: nl,
  });

  return { tokens, comments, diagnostics };
}

function commentMarkerAt(source: string, i: number): CommentMarker | undefined {
  if (source.startsWith('/*', i)) return '/*';
  if (source.startsWith('--', i)) return '--';
  if (source.charAt(i) === '#') return '#';
  return undefined;
}

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

function isIdentStart(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_';
}

function isIdentPart(ch: string): boolean {
  return isIdentStart(ch) || isDigit(ch);
}

interface StringRead {
  readonly value: string;
  readonly end: number;
  readonly terminated: boolean;
}

/**
 * A double-quoted string with C-style escapes.
 *
 * It deliberately stops at a newline rather than scanning to the next quote somewhere further
 * down the file: an unterminated string in a live editor is the normal state halfway through
 * typing one, and swallowing the next forty lines makes every diagnostic below it wrong.
 */
function readString(source: string, at: number): StringRead {
  let i = at + 1;
  let out = '';
  while (i < source.length) {
    const ch = source.charAt(i);
    if (ch === '"') return { value: out, end: i + 1, terminated: true };
    if (ch === '\n') return { value: out, end: i, terminated: false };
    if (ch === '\\') {
      const next = source.charAt(i + 1);
      switch (next) {
        case 'n':
          out += '\n';
          i += 2;
          continue;
        case 't':
          out += '\t';
          i += 2;
          continue;
        case 'r':
          out += '\r';
          i += 2;
          continue;
        case '"':
        case '\\':
        case '/':
          out += next;
          i += 2;
          continue;
        case 'u': {
          const hex = source.slice(i + 2, i + 6);
          if (/^[0-9a-fA-F]{4}$/.test(hex)) {
            out += String.fromCharCode(Number.parseInt(hex, 16));
            i += 6;
            continue;
          }
          out += next;
          i += 2;
          continue;
        }
        default:
          // An unknown escape keeps the character verbatim rather than failing: the author most
          // likely meant a literal backslash, and refusing to lex helps nobody.
          out += next === '' ? '\\' : next;
          i += next === '' ? 1 : 2;
          continue;
      }
    }
    out += ch;
    i += 1;
  }
  return { value: out, end: i, terminated: false };
}

/** Re-escape a string for printing. Canonical, so `print` is idempotent over string literals. */
export function quote(value: string): string {
  let out = '"';
  for (const ch of value) {
    switch (ch) {
      case '"':
        out += '\\"';
        break;
      case '\\':
        out += '\\\\';
        break;
      case '\n':
        out += '\\n';
        break;
      case '\r':
        out += '\\r';
        break;
      case '\t':
        out += '\\t';
        break;
      default: {
        const code = ch.codePointAt(0) ?? 0;
        out += code < 0x20 ? `\\u${code.toString(16).padStart(4, '0')}` : ch;
      }
    }
  }
  return `${out}"`;
}

/** 1-based line/column of an offset. Used by `contextAt` and by callers holding only an offset. */
export function lineColAt(source: string, offset: number): { readonly line: number; readonly col: number } {
  const clamped = Math.max(0, Math.min(offset, source.length));
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < clamped; i += 1) {
    if (source.charAt(i) === '\n') {
      line += 1;
      lineStart = i + 1;
    }
  }
  return { line, col: clamped - lineStart + 1 };
}
