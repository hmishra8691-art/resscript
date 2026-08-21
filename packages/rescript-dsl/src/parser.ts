/**
 * The recovering parser — D §6.2's grammar, and P8 (D §6.4) as a hard requirement.
 *
 * ## The recovery contract
 *
 * `parseProgram` never throws, on any input, ever. It always returns a program and, for any input
 * it could not fully read, at least one diagnostic whose span lies inside the offending region.
 * That is not a quality-of-implementation nicety: Monaco calls this on every keystroke, forever,
 * on input that is broken by construction (D §6.4 P8), and a parser that throws is a broken
 * editor.
 *
 * Three mechanisms hold it up:
 *
 *  1. **Every loop consumes a token.** Every `while` in this file either advances the cursor or
 *     breaks; `recover()` is the one place allowed to skip, and it always skips at least one token.
 *     A parser that can stand still is a parser that can hang the editor's main thread.
 *  2. **Unreadable regions become statements, not exceptions.** A region the parser cannot read is
 *     an `ErrorStmt` carrying its source text verbatim, so `print(parse(s))` does not delete the
 *     user's work while they are halfway through typing it.
 *  3. **`SExpr` has an `error` member.** A failed sub-expression is a node, so the enclosing
 *     statement still parses and the diagnostics below the error are still real.
 *
 * ## Grammar deviations, all deliberate
 *
 * Every one is reported in the milestone's contradictions list rather than settled quietly:
 *
 *  - `statement` gains a **bare action** (`HIDE Q3 OPTION 4`), which D §6.3 uses three times and
 *    D §6.2's production does not admit.
 *  - `statement` gains **`PIPE`**, which D §6.3 uses at statement level and D §6.2 lists only as a
 *    `question_clause`.
 *  - `block_def` and `page_def` are named but never defined by D §6.2; the shape here mirrors
 *    `question_def`.
 *  - `IN` is accepted as a synonym for `ANY OF`, and `BETWEEN a AND b` desugars to
 *    `x >= a AND x <= b`, on the same grounds D §6.2 gives for accepting both `=` and `==`.
 *  - `QUOTA` parses to an `UnsupportedStmt` with an `RSL-0007` diagnostic (P2-06).
 */

import type { Disposition } from '@resscript/logic';
import { DISPOSITIONS } from '@resscript/logic';
import { lex } from './lexer.js';
import { rslDiagnostic, type DslDiagnostic, type Span } from './diagnostics.js';
import type { CommentToken, Token } from './tokens.js';
import type {
  Action,
  ActionTarget,
  ContainerDef,
  DslLiteral,
  MaskSource,
  MaskSpec,
  NodeRef,
  OptionDef,
  OptionFlag,
  PipeSpec,
  RandModifier,
  RandTarget,
  RandomizeSpec,
  Statement,
  Trivia,
  ValidateRule,
  VarName,
} from './ast.js';
import type { SExpr, SGroup, SPathSegment } from './surface.js';

export interface ParsedProgram {
  readonly statements: readonly Statement<SExpr>[];
  readonly diagnostics: readonly DslDiagnostic[];
}

/** Aggregation call names. `MIN_OF`/`MAX_OF` — see the note on `AGG_CALLS` below. */
const AGG_CALLS: { readonly [name: string]: string } = {
  COUNT: 'count',
  SUM: 'sum',
  MEAN: 'mean',
  STDEV: 'stdev',
  DISTINCT_COUNT: 'distinct_count',
  ANY: 'any',
  ALL: 'all',
  FIRST_ANSWERED: 'first_answered',
  LAST_ANSWERED: 'last_answered',
  // D §2.3 has `min`/`max` as *both* an `Arith` kind (`min(a, b, …)` over expressions) and an
  // `Agg.fn` (the smallest member of a group). One spelling cannot mean both — `MIN(Q3)` would be
  // ambiguous the moment `Q3` is a question with a fan-out — so the aggregation forms get their
  // own names. D §6.2 does not enumerate call names, so this is a completion, not a change.
  MIN_OF: 'min',
  MAX_OF: 'max',
};

/** D §2.3's four probe kinds, one call name each. */
const PROBE_CALLS: { readonly [name: string]: 'answered' | 'shown' | 'valid' | 'asked' } = {
  ANSWERED: 'answered',
  SHOWN: 'shown',
  VALID: 'valid',
  ASKED: 'asked',
};

const STATEMENT_STARTERS: ReadonlySet<string> = new Set([
  'QUESTION', 'BLOCK', 'PAGE', 'IF', 'SET', 'TERMINATE', 'RANDOMIZE', 'MASK', 'PIPE',
  'PRIORITY', 'QUOTA', 'SHOW', 'HIDE', 'DISABLE', 'ENABLE', 'PRESELECT', 'SKIP', 'REQUIRE',
  'UNREQUIRE', 'FLAG',
]);

const QUESTION_CLAUSES: ReadonlySet<string> = new Set([
  'TYPE', 'LABEL', 'INSTRUCTION', 'REQUIRED', 'OPTIONAL', 'OPTIONS', 'ROWS', 'COLUMNS',
  'VALIDATE', 'RANDOMIZE', 'MASK', 'PIPE', 'END',
]);

const ACTION_STARTERS: ReadonlySet<string> = new Set([
  'SHOW', 'HIDE', 'SKIP', 'TERMINATE', 'SET', 'DISABLE', 'ENABLE', 'PRESELECT', 'REQUIRE',
  'UNREQUIRE', 'FLAG',
]);

export function parseProgram(source: string): ParsedProgram {
  return new Parser(source).program();
}

class Parser {
  private readonly tokens: readonly Token[];
  private readonly comments: readonly CommentToken[];
  private readonly diagnostics: DslDiagnostic[];
  private i = 0;
  private commentAt = 0;
  /** Line the previous statement (or its trailing comment) ended on. Drives `blank_before`. */
  private prevLine = 0;

  constructor(private readonly source: string) {
    const lexed = lex(source);
    this.tokens = lexed.tokens;
    this.comments = lexed.comments;
    this.diagnostics = [...lexed.diagnostics];
  }

  /* ---- token access ----------------------------------------------------- */

  private cur(): Token {
    // The stream always ends with an `eof` token, so this cannot be undefined; the fallback keeps
    // `noUncheckedIndexedAccess` honest without a non-null assertion.
    return this.tokens[this.i] ?? this.eofToken();
  }

  private peek(offset: number): Token {
    return this.tokens[this.i + offset] ?? this.eofToken();
  }

  private eofToken(): Token {
    const last = this.tokens[this.tokens.length - 1];
    return (
      last ?? {
        kind: 'eof',
        text: '',
        upper: '',
        start: this.source.length,
        end: this.source.length,
        line: 1,
        col: 1,
        nlBefore: 0,
      }
    );
  }

  private next(): Token {
    const token = this.cur();
    if (token.kind !== 'eof') this.i += 1;
    return token;
  }

  private atEnd(): boolean {
    return this.cur().kind === 'eof';
  }

  private isKw(...words: readonly string[]): boolean {
    const token = this.cur();
    return token.kind === 'keyword' && words.includes(token.upper);
  }

  private isPunct(...texts: readonly string[]): boolean {
    const token = this.cur();
    return token.kind === 'punct' && texts.includes(token.text);
  }

  private eatKw(...words: readonly string[]): Token | undefined {
    return this.isKw(...words) ? this.next() : undefined;
  }

  private eatPunct(...texts: readonly string[]): Token | undefined {
    return this.isPunct(...texts) ? this.next() : undefined;
  }

  private spanOfToken(token: Token): Span {
    return { start: token.start, end: token.end, line: token.line, col: token.col };
  }

  private spanBetween(from: Token, to: Token): Span {
    return { start: from.start, end: Math.max(from.end, to.end), line: from.line, col: from.col };
  }

  private error(code: Parameters<typeof rslDiagnostic>[0], message: string, span?: Span): void {
    this.diagnostics.push(rslDiagnostic(code, message, span ?? this.spanOfToken(this.cur())));
  }

  private expectKw(word: string, context: string): Token | undefined {
    const token = this.eatKw(word);
    if (token !== undefined) return token;
    this.error(
      this.atEnd() ? 'RSL-0005' : 'RSL-0001',
      `Expected ${word} ${context}, found ${describe(this.cur())}.`,
    );
    return undefined;
  }

  private expectPunct(text: string, context: string): Token | undefined {
    const token = this.eatPunct(text);
    if (token !== undefined) return token;
    this.error(
      this.atEnd() ? 'RSL-0005' : 'RSL-0001',
      `Expected ${JSON.stringify(text)} ${context}, found ${describe(this.cur())}.`,
    );
    return undefined;
  }

  /** A ref: any ident, or a keyword used as a name (which the author will do, e.g. `SET`). */
  private expectRef(context: string): Token | undefined {
    const token = this.cur();
    if (token.kind === 'ident') return this.next();
    this.error(
      this.atEnd() ? 'RSL-0005' : 'RSL-0001',
      `Expected a reference ${context}, found ${describe(token)}.`,
    );
    return undefined;
  }

  private expectString(context: string): Token | undefined {
    if (this.cur().kind === 'string') return this.next();
    this.error(
      this.atEnd() ? 'RSL-0005' : 'RSL-0001',
      `Expected a quoted string ${context}, found ${describe(this.cur())}.`,
    );
    return undefined;
  }

  private expectNumber(context: string): Token | undefined {
    if (this.cur().kind === 'number') return this.next();
    this.error(
      this.atEnd() ? 'RSL-0005' : 'RSL-0001',
      `Expected a number ${context}, found ${describe(this.cur())}.`,
    );
    return undefined;
  }

  /* ---- trivia ----------------------------------------------------------- */

  private takeCommentsBefore(offset: number): readonly CommentToken[] {
    const out: CommentToken[] = [];
    while (this.commentAt < this.comments.length) {
      const comment = this.comments[this.commentAt];
      if (comment === undefined || comment.start >= offset) break;
      out.push(comment);
      this.commentAt += 1;
    }
    return out;
  }

  /**
   * A comment on the same line as the statement that just ended is that statement's trailing
   * comment; anything else belongs to the next statement. This is the whole of comment attachment,
   * and it is the rule an author would state if asked.
   */
  private takeTrailing(endLine: number, endOffset: number): CommentToken | undefined {
    const comment = this.comments[this.commentAt];
    if (comment === undefined) return undefined;
    if (comment.line !== endLine || comment.start < endOffset) return undefined;
    this.commentAt += 1;
    return comment;
  }

  /* ---- program ---------------------------------------------------------- */

  program(): ParsedProgram {
    const statements = this.statementList(() => this.atEnd());
    // Any comment after the last statement is still the author's text. It attaches as leading
    // trivia on a zero-statement tail rather than being dropped: T2 forbids losing a comment.
    const tail = this.takeCommentsBefore(this.source.length + 1);
    const first = tail[0];
    if (first !== undefined) {
      statements.push({
        s: 'error',
        raw: '',
        trivia: triviaFor(tail, undefined, capBlank(first.line - this.prevLine - 1), first.line),
        span: { start: first.start, end: first.start, line: first.line, col: first.col },
      });
    }
    return { statements, diagnostics: this.diagnostics };
  }

  private statementList(done: () => boolean): Statement<SExpr>[] {
    const out: Statement<SExpr>[] = [];
    let guard = 0;
    while (!done() && !this.atEnd()) {
      guard += 1;
      // A structural belt-and-braces bound. Every path below consumes at least one token, so this
      // can only fire on a bug — and a bug here freezes the editor, which is why it is a
      // diagnostic and a stop rather than an infinite loop.
      if (guard > this.tokens.length + 1) {
        this.error('RSL-0001', 'Parser made no progress; the rest of the input was skipped.');
        break;
      }
      const before = this.i;
      const statement = this.statement();
      if (statement !== undefined) out.push(statement);
      if (this.i === before) this.next();
    }
    return out;
  }

  private statement(): Statement<SExpr> | undefined {
    const startToken = this.cur();
    const leading = this.takeCommentsBefore(startToken.start);
    const firstLine = leading[0]?.line ?? startToken.line;
    // Computed *before* the body is parsed, because parsing moves `prevLine` on to this statement's
    // own end line. Getting this order wrong silently produces `blank_before: 0` everywhere, which
    // is a T2 violation that no type checks.
    const blank = capBlank(firstLine - this.prevLine - 1);

    const built = this.statementBody(startToken);
    if (built === undefined) return undefined;

    const endToken = this.tokens[this.i - 1] ?? startToken;
    const trailing = this.takeTrailing(endToken.line, endToken.end);
    this.prevLine = trailing?.line ?? endToken.line;

    return {
      ...built,
      trivia: triviaFor(leading, trailing, blank, startToken.line),
      span: this.spanBetween(startToken, endToken),
    } as Statement<SExpr>;
  }

  private statementBody(startToken: Token): Statement<SExpr> | undefined {
    if (startToken.kind === 'keyword') {
      switch (startToken.upper) {
        case 'QUESTION':
          return this.questionDef();
        case 'BLOCK':
        case 'PAGE':
          return this.containerDef(startToken.upper === 'BLOCK' ? 'block' : 'page');
        case 'IF':
          return this.ruleStmt();
        case 'SET':
          return this.setStmt();
        case 'TERMINATE':
          return this.terminateStmt();
        case 'RANDOMIZE':
          return this.randomizeStmt();
        case 'MASK':
          return this.maskStmt();
        case 'PIPE':
          return this.pipeStmt();
        case 'PRIORITY':
          return this.priorityGroup();
        case 'QUOTA':
          return this.quotaBlock();
        default:
          break;
      }
      if (ACTION_STARTERS.has(startToken.upper)) return this.actionStmt();
    }
    return this.recover(
      `${describe(startToken)} does not start a statement. Expected one of QUESTION, BLOCK, PAGE, ` +
        'IF, SET, TERMINATE, RANDOMIZE, MASK, PIPE, PRIORITY GROUP, or an action (SHOW, HIDE, …).',
    );
  }

  /**
   * Skip to the next plausible statement boundary, keeping the text.
   *
   * The skipped region becomes an `ErrorStmt` whose `raw` the printer emits verbatim. Deleting it
   * would be the worse failure: format-on-save would silently eat the line the author is
   * mid-way through writing.
   */
  private recover(message: string): Statement<SExpr> {
    const from = this.cur();
    this.error(this.atEnd() ? 'RSL-0005' : 'RSL-0001', message, this.spanOfToken(from));
    this.next();
    while (!this.atEnd()) {
      const token = this.cur();
      if (token.kind === 'keyword' && STATEMENT_STARTERS.has(token.upper) && token.nlBefore > 0) break;
      this.next();
    }
    const end = this.tokens[this.i - 1] ?? from;
    return { s: 'error', raw: this.source.slice(from.start, end.end) };
  }

  /* ---- QUESTION --------------------------------------------------------- */

  private questionDef(): Statement<SExpr> {
    this.next(); // QUESTION
    const refToken = this.expectRef('after QUESTION');
    const ref: NodeRef = {
      ref: refToken?.text ?? '',
      kind: 'question',
      ...(refToken === undefined ? {} : { span: this.spanOfToken(refToken) }),
    };

    let qtype: string | undefined;
    let label: string | undefined;
    let instruction: string | undefined;
    let required: boolean | undefined;
    let options: OptionDef<SExpr>[] | undefined;
    let rows: OptionDef<SExpr>[] | undefined;
    let columns: OptionDef<SExpr>[] | undefined;
    let validate: ValidateRule<SExpr>[] | undefined;
    const randomize: RandomizeSpec[] = [];
    const masks: MaskSpec<SExpr>[] = [];
    const pipes: PipeSpec[] = [];

    let guard = 0;
    while (!this.atEnd() && !this.isKw('END')) {
      guard += 1;
      if (guard > this.tokens.length + 1) break;
      const before = this.i;
      const token = this.cur();
      if (token.kind === 'keyword') {
        switch (token.upper) {
          case 'TYPE': {
            this.next();
            const typeToken = this.cur();
            if (typeToken.kind === 'ident' || typeToken.kind === 'keyword') {
              this.next();
              qtype = normalizeQType(typeToken);
            } else {
              this.error('RSL-0001', `Expected a question type after TYPE, found ${describe(typeToken)}.`);
            }
            continue;
          }
          case 'LABEL': {
            this.next();
            const value = this.expectString('after LABEL');
            if (label !== undefined) this.error('RSL-0016', 'Duplicate LABEL clause.');
            label = value?.str ?? label ?? '';
            continue;
          }
          case 'INSTRUCTION': {
            this.next();
            const value = this.expectString('after INSTRUCTION');
            instruction = value?.str ?? instruction ?? '';
            continue;
          }
          case 'REQUIRED':
            this.next();
            required = true;
            continue;
          case 'OPTIONAL':
            this.next();
            required = false;
            continue;
          case 'OPTIONS':
            this.next();
            options = [...(options ?? []), ...this.optionList()];
            continue;
          case 'ROWS':
            this.next();
            rows = [...(rows ?? []), ...this.optionList()];
            continue;
          case 'COLUMNS':
            this.next();
            columns = [...(columns ?? []), ...this.optionList()];
            continue;
          case 'VALIDATE':
            this.next();
            validate = [...(validate ?? []), ...this.validateList()];
            continue;
          case 'RANDOMIZE': {
            this.next();
            randomize.push(this.randomizeSpec(true));
            continue;
          }
          case 'MASK': {
            this.next();
            masks.push(this.maskSpec(false));
            continue;
          }
          case 'PIPE': {
            this.next();
            pipes.push(this.pipeSpec());
            continue;
          }
          default:
            break;
        }
      }
      // An unknown clause: report once, then skip to the next clause keyword or END so the rest of
      // the question still parses. Losing the whole question over one bad line is the behaviour
      // that makes an editor's diagnostics useless.
      this.error(
        'RSL-0006',
        `${describe(token)} is not a QUESTION clause. Expected TYPE, LABEL, INSTRUCTION, ` +
          'REQUIRED, OPTIONAL, OPTIONS, ROWS, COLUMNS, VALIDATE, RANDOMIZE, MASK, PIPE or END.',
      );
      this.next();
      while (!this.atEnd() && !(this.cur().kind === 'keyword' && QUESTION_CLAUSES.has(this.cur().upper))) {
        this.next();
      }
      if (this.i === before) this.next();
    }
    if (!this.atEnd()) this.next(); // END
    else this.error('RSL-0005', 'Unexpected end of input: QUESTION has no END.');

    return {
      s: 'question',
      ref,
      ...(qtype === undefined ? {} : { qtype }),
      ...(label === undefined ? {} : { label }),
      ...(instruction === undefined ? {} : { instruction }),
      ...(required === undefined ? {} : { required }),
      ...(options === undefined ? {} : { options }),
      ...(rows === undefined ? {} : { rows }),
      ...(columns === undefined ? {} : { columns }),
      ...(validate === undefined ? {} : { validate }),
      ...(randomize.length === 0 ? {} : { randomize }),
      ...(masks.length === 0 ? {} : { masks }),
      ...(pipes.length === 0 ? {} : { pipes }),
    };
  }

  /** `option_def = code string [ option_flag … ]`, repeated while the next token is a number. */
  private optionList(): OptionDef<SExpr>[] {
    const out: OptionDef<SExpr>[] = [];
    while (this.cur().kind === 'number') {
      const codeToken = this.next();
      const labelToken = this.expectString(`after option code ${codeToken.text}`);
      const flags: OptionFlag<SExpr>[] = [];
      let guard = 0;
      while (!this.atEnd()) {
        guard += 1;
        if (guard > this.tokens.length + 1) break;
        const flag = this.optionFlag();
        if (flag === undefined) break;
        flags.push(flag);
      }
      out.push({
        code: codeToken.num ?? 0,
        label: labelToken?.str ?? '',
        flags,
        span: this.spanBetween(codeToken, this.tokens[this.i - 1] ?? codeToken),
      });
    }
    return out;
  }

  private optionFlag(): OptionFlag<SExpr> | undefined {
    const token = this.cur();
    if (token.kind !== 'keyword') return undefined;
    switch (token.upper) {
      case 'EXCLUSIVE':
        this.next();
        return { f: 'exclusive' };
      case 'ANCHOR': {
        this.next();
        if (this.eatKw('FIRST') !== undefined) return { f: 'anchor', at: 'first' };
        if (this.eatKw('LAST') !== undefined) return { f: 'anchor', at: 'last' };
        if (this.eatKw('AT') !== undefined) {
          const position = this.expectNumber('after ANCHOR AT');
          return { f: 'anchor', at: 'fixed', position: position?.num ?? 1 };
        }
        this.error('RSL-0001', 'Expected FIRST, LAST or AT <n> after ANCHOR.');
        return { f: 'anchor', at: 'first' };
      }
      case 'SPECIFY': {
        this.next();
        return { f: 'specify', text: this.eatKw('TEXT') !== undefined };
      }
      case 'META': {
        this.next();
        const key = this.expectRef('after META');
        this.expectAssign();
        const value = this.metaLiteral();
        return { f: 'meta', key: key?.text ?? '', value };
      }
      case 'VISIBLE': {
        this.next();
        this.expectKw('IF', 'after VISIBLE');
        return { f: 'visible_if', condition: this.expr() };
      }
      case 'ENABLED': {
        this.next();
        this.expectKw('IF', 'after ENABLED');
        return { f: 'enabled_if', condition: this.expr() };
      }
      case 'AUTOSELECT': {
        this.next();
        this.expectKw('IF', 'after AUTOSELECT');
        return { f: 'autoselect_if', condition: this.expr() };
      }
      case 'PRESELECT': {
        this.next();
        if (this.eatKw('IF') !== undefined) return { f: 'preselect', condition: this.expr() };
        return { f: 'preselect' };
      }
      default:
        return undefined;
    }
  }

  private metaLiteral(): DslLiteral {
    const token = this.cur();
    if (token.kind === 'number') {
      this.next();
      return { k: 'num', v: token.num ?? 0 };
    }
    if (token.kind === 'string') {
      this.next();
      return { k: 'text', v: token.str ?? '' };
    }
    if (this.isKw('TRUE')) {
      this.next();
      return { k: 'bool', v: true };
    }
    if (this.isKw('FALSE')) {
      this.next();
      return { k: 'bool', v: false };
    }
    if (this.isKw('NULL')) {
      this.next();
      return { k: 'null' };
    }
    if (this.isKw('DATE')) {
      this.next();
      const value = this.expectString('after DATE');
      return { k: 'date', v: value?.str ?? '' };
    }
    this.error('RSL-0001', `Expected a literal, found ${describe(token)}.`);
    return { k: 'null' };
  }

  private validateList(): ValidateRule<SExpr>[] {
    const out: ValidateRule<SExpr>[] = [];
    let guard = 0;
    while (this.isKw('SELECT', 'SUM', 'RANGE', 'MATCHES', 'REQUIRE')) {
      guard += 1;
      if (guard > this.tokens.length + 1) break;
      const rule = this.validateRule();
      if (rule === undefined) break;
      out.push(rule);
    }
    return out;
  }

  private validateRule(): ValidateRule<SExpr> | undefined {
    const token = this.next();
    switch (token.upper) {
      case 'SELECT': {
        const bound = this.eatKw('AT') !== undefined
          ? this.eatKw('LEAST') !== undefined
            ? 'at_least'
            : this.eatKw('MOST') !== undefined
              ? 'at_most'
              : undefined
          : this.eatKw('EXACTLY') !== undefined
            ? 'exactly'
            : undefined;
        if (bound === undefined) {
          this.error('RSL-0001', 'Expected AT LEAST, AT MOST or EXACTLY after SELECT.');
          return undefined;
        }
        const n = this.expectNumber('after a SELECT bound');
        const message = this.optionalMessage();
        return { v: 'select', bound, n: n?.num ?? 0, ...(message === undefined ? {} : { message }) };
      }
      case 'SUM': {
        const of: VarName[] = [];
        if (this.eatKw('OF') !== undefined) {
          do {
            const ref = this.expectRef('in a SUM OF list');
            if (ref === undefined) break;
            of.push({ ref: ref.text, span: this.spanOfToken(ref) });
          } while (this.eatPunct(',') !== undefined);
        }
        this.expectPunct('=', 'after a SUM clause');
        const value = this.expectNumber('after SUM =');
        const message = this.optionalMessage();
        return {
          v: 'sum',
          ...(of.length === 0 ? {} : { of }),
          value: value?.num ?? 0,
          ...(message === undefined ? {} : { message }),
        };
      }
      case 'RANGE': {
        const lo = this.expectNumber('after RANGE');
        this.expectKw('TO', 'in a RANGE clause');
        const hi = this.expectNumber('after RANGE … TO');
        const message = this.optionalMessage();
        return {
          v: 'range',
          lo: lo?.num ?? 0,
          hi: hi?.num ?? 0,
          ...(message === undefined ? {} : { message }),
        };
      }
      case 'MATCHES': {
        // D §6.2 writes `MATCHES regex` and never defines a regex token. A quoted string is the
        // defensible reading: it needs no new lexical mode, and schema §14's `regex` validation
        // carries the pattern as a JSON string anyway.
        const pattern = this.expectString('after MATCHES');
        const message = this.optionalMessage();
        return {
          v: 'matches',
          pattern: pattern?.str ?? '',
          ...(message === undefined ? {} : { message }),
        };
      }
      case 'REQUIRE': {
        const condition = this.expr();
        const message = this.optionalMessage();
        return { v: 'require', condition, ...(message === undefined ? {} : { message }) };
      }
      default:
        this.error('RSL-0001', `${describe(token)} is not a VALIDATE rule.`, this.spanOfToken(token));
        return undefined;
    }
  }

  private optionalMessage(): string | undefined {
    if (this.eatKw('MESSAGE') === undefined) return undefined;
    return this.expectString('after MESSAGE')?.str ?? '';
  }

  /* ---- BLOCK / PAGE ------------------------------------------------------ */

  private containerDef(kind: 'block' | 'page'): Statement<SExpr> {
    this.next();
    const refToken = this.expectRef(`after ${kind.toUpperCase()}`);
    const ref: NodeRef = {
      ref: refToken?.text ?? '',
      kind,
      ...(refToken === undefined ? {} : { span: this.spanOfToken(refToken) }),
    };
    let label: string | undefined;
    const randomize: RandomizeSpec[] = [];
    while (this.isKw('LABEL', 'RANDOMIZE')) {
      if (this.eatKw('LABEL') !== undefined) {
        label = this.expectString(`after ${kind.toUpperCase()} … LABEL`)?.str ?? '';
        continue;
      }
      this.next();
      randomize.push(this.randomizeSpec(true));
    }
    const savedPrev = this.prevLine;
    this.prevLine = this.tokens[this.i - 1]?.line ?? savedPrev;
    const children = this.statementList(() => this.isKw('END'));
    this.prevLine = savedPrev;
    if (this.isKw('END')) this.next();
    else this.error('RSL-0005', `Unexpected end of input: ${kind.toUpperCase()} has no END.`);
    const container: ContainerDef<SExpr> = {
      s: kind,
      ref,
      ...(label === undefined ? {} : { label }),
      ...(randomize.length === 0 ? {} : { randomize }),
      children,
    };
    return container;
  }

  /* ---- rules ------------------------------------------------------------ */

  private ruleStmt(): Statement<SExpr> {
    this.next(); // IF
    const condition = this.expr();
    let onUnknown: 'SHOW' | 'HIDE' | 'FIRE' | 'SKIP' | undefined;
    if (this.eatKw('ON') !== undefined) {
      this.expectKw('UNKNOWN', 'after ON');
      const word = this.cur();
      if (word.kind === 'keyword' && (word.upper === 'SHOW' || word.upper === 'HIDE' || word.upper === 'SKIP')) {
        this.next();
        onUnknown = word.upper;
      } else if (word.kind === 'ident' && word.upper === 'FIRE') {
        this.next();
        onUnknown = 'FIRE';
      } else {
        this.error('RSL-0001', 'Expected SHOW, HIDE, FIRE or SKIP after ON UNKNOWN.');
      }
    }
    this.expectKw('THEN', 'after an IF condition');
    const then = this.actionList();
    let otherwise: readonly Action<SExpr>[] | undefined;
    if (this.eatKw('ELSE') !== undefined) otherwise = this.actionList();
    return {
      s: 'rule',
      condition,
      ...(onUnknown === undefined ? {} : { on_unknown: onUnknown }),
      then,
      ...(otherwise === undefined ? {} : { otherwise }),
    };
  }

  private actionList(): readonly Action<SExpr>[] {
    const out: Action<SExpr>[] = [];
    const first = this.action();
    if (first !== undefined) out.push(first);
    let guard = 0;
    while (this.isKw('AND') && this.peek(1).kind === 'keyword' && ACTION_STARTERS.has(this.peek(1).upper)) {
      guard += 1;
      if (guard > this.tokens.length + 1) break;
      this.next();
      const action = this.action();
      if (action === undefined) break;
      out.push(action);
    }
    return out;
  }

  private action(): Action<SExpr> | undefined {
    const token = this.cur();
    if (token.kind !== 'keyword' || !ACTION_STARTERS.has(token.upper)) {
      this.error('RSL-0001', `Expected an action, found ${describe(token)}.`);
      return undefined;
    }
    this.next();
    switch (token.upper) {
      case 'SHOW':
      case 'HIDE':
      case 'DISABLE':
      case 'ENABLE':
      case 'PRESELECT': {
        const a = token.upper === 'SHOW' ? 'show' : token.upper === 'HIDE' ? 'hide' : token.upper === 'DISABLE' ? 'disable' : token.upper === 'ENABLE' ? 'enable' : 'preselect';
        return { a, target: this.actionTarget() };
      }
      case 'SKIP': {
        if (this.eatKw('TO') !== undefined) return { a: 'skip_to', ref: this.nodeRef('after SKIP TO') };
        return { a: 'skip', ref: this.nodeRef('after SKIP') };
      }
      case 'TERMINATE': {
        const disposition = this.optionalDisposition();
        let custom: string | undefined;
        if (this.eatKw('CUSTOM') !== undefined) custom = this.expectRef('after CUSTOM')?.text ?? '';
        return {
          a: 'terminate',
          ...(disposition === undefined ? {} : { disposition }),
          ...(custom === undefined ? {} : { custom }),
        };
      }
      case 'SET': {
        const variable = this.varName('after SET');
        this.expectAssign();
        return { a: 'set', variable, value: this.expr() };
      }
      case 'REQUIRE':
      case 'UNREQUIRE':
        return {
          a: token.upper === 'REQUIRE' ? 'require' : 'unrequire',
          ref: this.nodeRef(`after ${token.upper}`),
        };
      case 'FLAG':
        return { a: 'flag', variable: this.varName('after FLAG') };
      default:
        this.error('RSL-0001', `${describe(token)} is not an action.`, this.spanOfToken(token));
        return undefined;
    }
  }

  private actionStmt(): Statement<SExpr> {
    const action = this.action();
    if (action === undefined) return { s: 'error', raw: '' };
    if (action.a === 'set' || action.a === 'terminate') {
      // Unreachable: `statementBody` dispatches SET and TERMINATE to their own statement forms
      // before it gets here. Kept as a narrowing rather than a cast, because `ActionStmt` excludes
      // both on purpose (see ast.ts) and a cast would hide the day that dispatch changes.
      return { s: 'error', raw: '' };
    }
    if (this.eatTrailingIf()) {
      return { s: 'action', action, condition: this.expr() };
    }
    return { s: 'action', action };
  }

  /**
   * A trailing `IF` on a bare action or a `TERMINATE` — and it must be on the *same line*.
   *
   * This is the one place the grammar is newline-sensitive, and it has to be. `HIDE Q12` followed on
   * the next line by `IF S1 = 1 THEN …` is two statements; `HIDE Q12 IF SEGMENT = "old"` (D §4.3's
   * R4) is one. Nothing else distinguishes them — the language is otherwise whitespace-insensitive,
   * so without this rule a bare action swallows the `IF` of the rule below it and the rest of that
   * rule becomes a cascade of nonsense diagnostics. Found by property P1 over multi-statement
   * programs. Reported.
   */
  private eatTrailingIf(): boolean {
    if (!this.isKw('IF') || this.cur().nlBefore > 0) return false;
    this.next();
    return true;
  }

  private actionTarget(): ActionTarget<SExpr> {
    const ref = this.nodeRef('as an action target');
    if (this.isKw('OPTION', 'ROW', 'COLUMN')) {
      const axisToken = this.next();
      const axis = axisToken.upper === 'OPTION' ? 'option' : axisToken.upper === 'ROW' ? 'row' : 'column';
      if (this.eatKw('WHERE') !== undefined) {
        return { ref, axis, where: this.expr() };
      }
      const codes: number[] = [];
      do {
        const code = this.expectNumber(`after ${axisToken.upper}`);
        if (code === undefined) break;
        codes.push(code.num ?? 0);
      } while (this.eatPunct(',') !== undefined);
      return { ref, axis, codes };
    }
    return { ref };
  }

  private optionalDisposition(): Disposition | undefined {
    if (this.eatKw('AS') === undefined) return undefined;
    const token = this.cur();
    if (token.kind !== 'ident' && token.kind !== 'keyword') {
      this.error('RSL-0001', `Expected a disposition after AS, found ${describe(token)}.`);
      return undefined;
    }
    this.next();
    const found = DISPOSITIONS.find((d) => d === token.upper);
    if (found === undefined) {
      this.error(
        'RSL-0001',
        `${JSON.stringify(token.text)} is not a disposition. Expected one of ${DISPOSITIONS.join(', ')}.`,
        this.spanOfToken(token),
      );
      return undefined;
    }
    return found;
  }

  /* ---- SET / TERMINATE -------------------------------------------------- */

  private setStmt(): Statement<SExpr> {
    this.next();
    const variable = this.varName('after SET');
    this.expectAssign();
    return { s: 'set', variable, value: this.expr() };
  }

  /**
   * The assignment operator. `=` and `==` are both accepted for the same reason D §6.2 accepts both
   * for equality: a programmer arriving from JavaScript types `==`, and rejecting the spelling they
   * already use teaches them nothing. The printer emits `=`.
   */
  private expectAssign(): void {
    if (this.eatPunct('=', '==') !== undefined) return;
    this.error(
      this.atEnd() ? 'RSL-0005' : 'RSL-0001',
      `Expected "=" after a SET target, found ${describe(this.cur())}.`,
    );
  }

  private terminateStmt(): Statement<SExpr> {
    this.next();
    const disposition = this.optionalDisposition();
    let custom: string | undefined;
    if (this.eatKw('CUSTOM') !== undefined) custom = this.expectRef('after CUSTOM')?.text ?? '';
    const condition = this.eatTrailingIf() ? this.expr() : undefined;
    return {
      s: 'terminate',
      ...(disposition === undefined ? {} : { disposition }),
      ...(custom === undefined ? {} : { custom }),
      ...(condition === undefined ? {} : { condition }),
    };
  }

  /* ---- RANDOMIZE -------------------------------------------------------- */

  private randomizeStmt(): Statement<SExpr> {
    this.next();
    return { s: 'randomize', spec: this.randomizeSpec(false) };
  }

  private randomizeSpec(insideDefinition: boolean): RandomizeSpec {
    const target = this.randTarget(insideDefinition);
    const modifiers: RandModifier[] = [];
    let guard = 0;
    while (!this.atEnd()) {
      guard += 1;
      if (guard > this.tokens.length + 1) break;
      const modifier = this.randModifier();
      if (modifier === undefined) break;
      modifiers.push(modifier);
    }
    return { target, modifiers };
  }

  private randTarget(insideDefinition: boolean): RandTarget {
    if (insideDefinition) {
      if (this.eatKw('CHILDREN') !== undefined) return { t: 'children' };
      // Inside a definition the target is implicit: `RANDOMIZE OPTIONS …` randomizes the question
      // being defined (D §6.3).
      if (this.isKw('OPTIONS', 'ROWS', 'COLUMNS')) {
        const axisToken = this.next();
        const axis = axisToken.upper === 'OPTIONS' ? 'options' : axisToken.upper === 'ROWS' ? 'rows' : 'columns';
        return { t: 'self', axis };
      }
      if (!this.isKw('PAGE', 'BLOCK') && this.cur().kind !== 'ident') return { t: 'self' };
    }
    const ref = this.nodeRef('after RANDOMIZE');
    if (this.isKw('OPTIONS', 'ROWS', 'COLUMNS')) {
      const axisToken = this.next();
      const axis = axisToken.upper === 'OPTIONS' ? 'options' : axisToken.upper === 'ROWS' ? 'rows' : 'columns';
      return { t: 'node', ref, axis };
    }
    return { t: 'node', ref };
  }

  private randModifier(): RandModifier | undefined {
    const token = this.cur();
    if (token.kind !== 'keyword') return undefined;
    switch (token.upper) {
      case 'KEEP': {
        this.next();
        const axisToken = this.cur();
        let axis: 'option' | 'row' | 'column' = 'option';
        if (this.isKw('OPTION', 'ROW', 'COLUMN')) {
          this.next();
          axis = axisToken.upper === 'OPTION' ? 'option' : axisToken.upper === 'ROW' ? 'row' : 'column';
        } else {
          this.error('RSL-0001', 'Expected OPTION, ROW or COLUMN after KEEP.');
        }
        const codes: number[] = [];
        do {
          const code = this.expectNumber('in a KEEP list');
          if (code === undefined) break;
          codes.push(code.num ?? 0);
        } while (this.eatPunct(',') !== undefined);
        let at: 'first' | 'last' | 'in_place' = 'first';
        if (this.eatKw('FIRST') !== undefined) at = 'first';
        else if (this.eatKw('LAST') !== undefined) at = 'last';
        else if (this.eatKw('IN') !== undefined) {
          this.expectKw('PLACE', 'after KEEP … IN');
          at = 'in_place';
        } else this.error('RSL-0001', 'Expected FIRST, LAST or IN PLACE after a KEEP list.');
        return { m: 'keep', axis, codes, at };
      }
      case 'SUBSET': {
        this.next();
        const n = this.expectNumber('after SUBSET');
        return { m: 'subset', n: n?.num ?? 0 };
      }
      case 'GROUP': {
        this.next();
        const name = this.expectRef('after GROUP');
        return { m: 'group', name: name?.text ?? '' };
      }
      case 'SUBBLOCKS': {
        this.next();
        const sizes: number[] = [];
        do {
          const size = this.expectNumber('in a SUBBLOCKS list');
          if (size === undefined) break;
          sizes.push(size.num ?? 0);
        } while (this.eatPunct(',') !== undefined);
        return { m: 'subblocks', sizes };
      }
      case 'EVENLY':
        this.next();
        return { m: 'evenly' };
      case 'ROTATE':
        this.next();
        return { m: 'rotate' };
      default:
        return undefined;
    }
  }

  /* ---- MASK / PIPE ------------------------------------------------------ */

  private maskStmt(): Statement<SExpr> {
    this.next();
    return { s: 'mask', spec: this.maskSpec(true) };
  }

  private maskSpec(withTarget: boolean): MaskSpec<SExpr> {
    const target = withTarget ? this.nodeRef('after MASK') : undefined;
    let axis: 'options' | 'rows' | 'columns' = 'options';
    if (this.isKw('OPTIONS', 'ROWS', 'COLUMNS')) {
      const token = this.next();
      axis = token.upper === 'OPTIONS' ? 'options' : token.upper === 'ROWS' ? 'rows' : 'columns';
    } else {
      this.error('RSL-0001', 'Expected OPTIONS, ROWS or COLUMNS in a MASK.');
    }
    let mode: 'include' | 'exclude' = 'include';
    if (this.eatKw('TO') !== undefined) mode = 'include';
    else if (this.eatKw('EXCEPT') !== undefined) mode = 'exclude';
    else this.error('RSL-0001', 'Expected TO or EXCEPT in a MASK.');

    const source = this.maskSource();

    // schema §15: `fallback.when_empty` has no default, and the compiler refuses a mask without
    // one. Requiring it here means the author decides rather than discovering the dead end in
    // field — the classic "respondent sees an empty question and cannot proceed" bug.
    let whenEmpty: 'skip' | 'show_all' | 'terminate' = 'skip';
    if (this.eatKw('WHEN') !== undefined) {
      this.expectKw('EMPTY', 'after WHEN');
      if (this.eatKw('SKIP') !== undefined) whenEmpty = 'skip';
      else if (this.eatKw('SHOW') !== undefined) {
        this.expectKw('ALL', 'after WHEN EMPTY SHOW');
        whenEmpty = 'show_all';
      } else if (this.eatKw('TERMINATE') !== undefined) whenEmpty = 'terminate';
      else this.error('RSL-0001', 'Expected SKIP, SHOW ALL or TERMINATE after WHEN EMPTY.');
    } else {
      this.error(
        'RSL-0001',
        'A MASK must declare WHEN EMPTY SKIP | SHOW ALL | TERMINATE. schema §15 gives ' +
          'fallback.when_empty no default on purpose: an unset fallback is how a respondent ends ' +
          'up on a question with no options and cannot proceed.',
      );
    }
    return {
      ...(target === undefined ? {} : { target }),
      axis,
      mode,
      source,
      when_empty: whenEmpty,
    };
  }

  private maskSource(): MaskSource<SExpr> {
    if (this.eatKw('WHERE') !== undefined) return { src: 'where', condition: this.expr() };
    const negated = this.eatKw('NOT') !== undefined;
    if (this.eatKw('SELECTED') !== undefined) {
      this.expectKw('IN', 'after SELECTED');
      return { src: 'selected_in', variable: this.varName('after SELECTED IN'), negated };
    }
    if (this.isPunct('[')) {
      const codes = this.codeList();
      return { src: 'codes', codes };
    }
    this.error('RSL-0001', 'Expected SELECTED IN <ref>, NOT SELECTED IN <ref>, a code list, or WHERE <expr>.');
    return { src: 'codes', codes: [] };
  }

  private codeList(): readonly number[] {
    const out: number[] = [];
    this.expectPunct('[', 'to start a code list');
    if (!this.isPunct(']')) {
      do {
        const code = this.expectNumber('in a code list');
        if (code === undefined) break;
        out.push(code.num ?? 0);
      } while (this.eatPunct(',') !== undefined);
    }
    this.expectPunct(']', 'to close a code list');
    return out;
  }

  private pipeStmt(): Statement<SExpr> {
    this.next();
    return { s: 'pipe', spec: this.pipeSpec() };
  }

  private pipeSpec(): PipeSpec {
    const into = this.nodeRef('after PIPE');
    this.expectKw('FROM', 'in a PIPE clause');
    const from = this.nodeRef('after PIPE … FROM');
    if (this.eatKw('AS') === undefined) return { into, from };
    if (this.eatKw('LABEL') !== undefined) return { into, from, as: 'label' };
    if (this.eatKw('CODE') !== undefined) return { into, from, as: 'code' };
    if (this.eatKw('LIST') !== undefined) return { into, from, as: 'list' };
    this.error('RSL-0001', 'Expected LABEL, CODE or LIST after PIPE … AS.');
    return { into, from };
  }

  /* ---- PRIORITY GROUP / QUOTA ------------------------------------------- */

  private priorityGroup(): Statement<SExpr> {
    this.next(); // PRIORITY
    this.expectKw('GROUP', 'after PRIORITY');
    const name = this.expectRef('after PRIORITY GROUP');
    this.expectPunct('{', 'to open a PRIORITY GROUP body');
    const savedPrev = this.prevLine;
    this.prevLine = this.tokens[this.i - 1]?.line ?? savedPrev;
    const statements = this.statementList(() => this.isPunct('}'));
    this.prevLine = savedPrev;
    this.expectPunct('}', 'to close a PRIORITY GROUP body');
    return { s: 'priority_group', name: name?.text ?? '', statements };
  }

  /**
   * `QUOTA` is P2-06. It is recognized, reported, and kept verbatim.
   *
   * Skipping to the matching brace rather than to the next statement keyword matters: a quota block
   * contains `DIMENSION`/`CELL`/`ON UNAVAILABLE` lines, and `ON` is a keyword the rule grammar
   * uses, so a naive skip would resume mid-block and emit a cascade of nonsense diagnostics on
   * perfectly good P2 syntax.
   */
  private quotaBlock(): Statement<SExpr> {
    const start = this.next();
    this.error(
      'RSL-0007',
      'QUOTA blocks are not supported until milestone P2-06. The block has been preserved ' +
        'verbatim and ignored — nothing in it has been parsed, so no part of it can be ' +
        'mis-interpreted as a rule.',
      this.spanOfToken(start),
    );
    let depth = 0;
    let opened = false;
    while (!this.atEnd()) {
      if (this.isPunct('{')) {
        depth += 1;
        opened = true;
      } else if (this.isPunct('}')) {
        depth -= 1;
        this.next();
        if (depth <= 0) break;
        continue;
      } else if (opened && depth === 0) break;
      this.next();
    }
    const end = this.tokens[this.i - 1] ?? start;
    return { s: 'unsupported', keyword: 'QUOTA', raw: this.source.slice(start.start, end.end) };
  }

  /* ---- refs ------------------------------------------------------------- */

  private nodeRef(context: string): NodeRef {
    if (this.isKw('PAGE') || this.isKw('BLOCK') || this.isKw('QUESTION')) {
      const keyword = this.next();
      const explicit = keyword.upper === 'PAGE' ? 'page' : keyword.upper === 'BLOCK' ? 'block' : 'question';
      const refToken = this.expectRef(`after ${keyword.upper}`);
      return {
        ref: refToken?.text ?? '',
        kind: explicit,
        explicit,
        ...(refToken === undefined ? {} : { span: this.spanOfToken(refToken) }),
      };
    }
    const refToken = this.expectRef(context);
    return {
      ref: refToken?.text ?? '',
      ...(refToken === undefined ? {} : { span: this.spanOfToken(refToken) }),
    };
  }

  private varName(context: string): VarName {
    const refToken = this.expectRef(context);
    return {
      ref: refToken?.text ?? '',
      ...(refToken === undefined ? {} : { span: this.spanOfToken(refToken) }),
    };
  }

  /* ---- expressions ------------------------------------------------------ */

  expr(): SExpr {
    return this.orExpr();
  }

  private orExpr(): SExpr {
    const first = this.andExpr();
    if (!this.isKw('OR')) return first;
    const args: SExpr[] = [first];
    let guard = 0;
    while (this.eatKw('OR') !== undefined) {
      guard += 1;
      if (guard > this.tokens.length + 1) break;
      args.push(this.andExpr());
    }
    // Flattened n-ary, per D §2.3 (`and`/`or` are n-ary, len >= 2) and D §10.1's flattening pass.
    // Building a right-leaning binary chain here would mean the printer's output re-parses to a
    // different shape than the builder produces for the same rule — a T1 failure that only shows
    // up on three-operand conditions.
    return { k: 'bool_op', op: 'or', args, span: joinSpans(args) };
  }

  private andExpr(): SExpr {
    const first = this.notExpr();
    if (!this.isAndAsConnective()) return first;
    const args: SExpr[] = [first];
    let guard = 0;
    while (this.isAndAsConnective()) {
      guard += 1;
      if (guard > this.tokens.length + 1) break;
      this.next();
      args.push(this.notExpr());
    }
    return { k: 'bool_op', op: 'and', args, span: joinSpans(args) };
  }

  /**
   * `AND` is overloaded: it joins conditions *and* it separates the effects of a rule
   * (`THEN SHOW Q12 AND SET X = 1`). Inside a condition the distinction is decidable with one
   * token of lookahead, because every action begins with a keyword no expression can begin with.
   */
  private isAndAsConnective(): boolean {
    if (!this.isKw('AND')) return false;
    const after = this.peek(1);
    return !(after.kind === 'keyword' && ACTION_STARTERS.has(after.upper));
  }

  private notExpr(): SExpr {
    const token = this.eatKw('NOT');
    if (token === undefined) return this.relExpr();
    // D §6.2 writes `[ "NOT" ]` — at most one. Repetition is accepted because the AST admits
    // `not(not(x))` and a printer that can emit it must have a parser that can read it back.
    const arg = this.notExpr();
    return { k: 'not', arg, span: { ...this.spanOfToken(token), end: arg.span.end } };
  }

  private relExpr(): SExpr {
    const left = this.addExpr();
    const token = this.cur();

    if (token.kind === 'punct') {
      const op = relOpOf(token.text);
      if (op !== undefined) {
        this.next();
        const right = this.addExpr();
        return { k: 'cmp', op, left, right, span: joinSpans([left, right]) };
      }
    }

    if (token.kind === 'keyword') {
      switch (token.upper) {
        case 'CONTAINS': {
          this.next();
          const right = this.addExpr();
          return { k: 'set_op', op: 'contains', left, right, span: joinSpans([left, right]) };
        }
        case 'ANY':
        case 'ALL':
        case 'NONE': {
          this.next();
          this.expectKw('OF', `after ${token.upper}`);
          const op = token.upper === 'ANY' ? 'any_of' : token.upper === 'ALL' ? 'all_of' : 'none_of';
          const right = this.addExpr();
          return { k: 'set_op', op, left, right, span: joinSpans([left, right]) };
        }
        case 'IN': {
          // A synonym for ANY OF, normalized by the printer — the same licence D §6.2 grants for
          // `==` → `=`. `Q1 IN [1,2]` is what a programmer arriving from SQL types.
          this.next();
          const right = this.addExpr();
          return { k: 'set_op', op: 'any_of', left, right, span: joinSpans([left, right]) };
        }
        case 'BETWEEN': {
          this.next();
          const lo = this.addExpr();
          this.expectKw('AND', 'in a BETWEEN range');
          const hi = this.addExpr();
          return { k: 'between', value: left, lo, hi, span: joinSpans([left, hi]) };
        }
        default:
          break;
      }
    }
    return left;
  }

  private addExpr(): SExpr {
    let left = this.mulExpr();
    let guard = 0;
    while (this.isPunct('+', '-')) {
      guard += 1;
      if (guard > this.tokens.length + 1) break;
      const op = this.next().text === '+' ? '+' : '-';
      const right = this.mulExpr();
      left = { k: 'arith', op, left, right, span: joinSpans([left, right]) };
    }
    return left;
  }

  private mulExpr(): SExpr {
    let left = this.unary();
    let guard = 0;
    while (this.isPunct('*', '/') || this.isKw('MOD')) {
      guard += 1;
      if (guard > this.tokens.length + 1) break;
      const token = this.next();
      const op = token.text === '*' ? '*' : token.text === '/' ? '/' : 'mod';
      const right = this.unary();
      left = { k: 'arith', op, left, right, span: joinSpans([left, right]) };
    }
    return left;
  }

  private unary(): SExpr {
    const minus = this.eatPunct('-');
    if (minus === undefined) return this.primary();
    const operand = this.primary();
    // `-5` folds into the literal, `-(5)` does not.
    //
    // Both must exist and stay distinguishable: `lit(-5)` and `neg(lit(5))` are different trees
    // (`exprEq` says so), so if the parser folded both the printer could not round-trip `neg`, and
    // if it folded neither then `-5` would print as `-(5)` and every numeric literal in the corpus
    // would gain parentheses. The parenthesized form is the escape hatch, and the printer knows to
    // use it (see printer.ts's `neg` case).
    if (operand.k === 'num') {
      return { k: 'num', value: -operand.value, span: { ...this.spanOfToken(minus), end: operand.span.end } };
    }
    return { k: 'neg', arg: operand, span: { ...this.spanOfToken(minus), end: operand.span.end } };
  }

  private primary(): SExpr {
    const token = this.cur();

    if (token.kind === 'number') {
      this.next();
      return { k: 'num', value: token.num ?? 0, span: this.spanOfToken(token) };
    }
    if (token.kind === 'string') {
      this.next();
      return { k: 'str', value: token.str ?? '', span: this.spanOfToken(token) };
    }
    if (this.isPunct('(')) {
      this.next();
      const inner = this.expr();
      const close = this.expectPunct(')', 'to close a parenthesized expression');
      return { k: 'paren', inner, span: { ...this.spanOfToken(token), end: (close ?? token).end } };
    }
    if (this.isPunct('[')) {
      const items: SExpr[] = [];
      this.next();
      if (!this.isPunct(']')) {
        let guard = 0;
        do {
          guard += 1;
          if (guard > this.tokens.length + 1) break;
          items.push(this.expr());
        } while (this.eatPunct(',') !== undefined);
      }
      const close = this.expectPunct(']', 'to close a list literal');
      return { k: 'codes', items, span: { ...this.spanOfToken(token), end: (close ?? token).end } };
    }
    if (token.kind === 'keyword') {
      switch (token.upper) {
        case 'TRUE':
          this.next();
          return { k: 'bool', value: true, span: this.spanOfToken(token) };
        case 'FALSE':
          this.next();
          return { k: 'bool', value: false, span: this.spanOfToken(token) };
        case 'NULL':
          this.next();
          return { k: 'null', span: this.spanOfToken(token) };
        case 'CASE':
          return this.caseExpr();
        case 'DATE': {
          if (this.peek(1).kind === 'string') {
            this.next();
            const value = this.next();
            // D §6.2 has a `date_lit` token and never defines it. `DATE "2026-01-01"` is the
            // defensible completion: no new lexical mode, and it matches D §2.2's requirement that
            // a date value be an ISO-8601 string. Validation of the string itself is the resolver's.
            return { k: 'date', value: value.str ?? '', span: this.spanBetween(token, value) };
          }
          break;
        }
        default:
          break;
      }
    }
    if ((token.kind === 'ident' || token.kind === 'keyword') && this.peek(1).kind === 'punct' && this.peek(1).text === '(') {
      return this.callExpr();
    }
    if (token.kind === 'ident' || token.kind === 'keyword') {
      // A keyword in a value position is almost always a missing operand (`IF AND x`), so it is
      // reported rather than silently treated as a name.
      if (token.kind === 'keyword') {
        this.error('RSL-0001', `Expected an expression, found the keyword ${token.upper}.`);
        return { k: 'error', span: this.spanOfToken(token) };
      }
      this.next();
      const attrs: SPathSegment[] = [];
      let guard = 0;
      while (this.isPunct('.')) {
        guard += 1;
        if (guard > this.tokens.length + 1) break;
        this.next();
        const attr = this.cur();
        if (attr.kind === 'ident' || attr.kind === 'keyword' || attr.kind === 'number') {
          this.next();
          attrs.push({ name: attr.text, span: this.spanOfToken(attr) });
        } else {
          this.error('RSL-0001', `Expected a name after "." , found ${describe(attr)}.`);
          break;
        }
      }
      const last = attrs[attrs.length - 1];
      return {
        k: 'path',
        head: token.text,
        attrs,
        span: { ...this.spanOfToken(token), end: last?.span.end ?? token.end },
      };
    }

    this.error(
      this.atEnd() ? 'RSL-0005' : 'RSL-0001',
      `Expected an expression, found ${describe(token)}.`,
    );
    // Do not consume: the caller's loops decide how to recover, and consuming here would eat a
    // `THEN` that the rule parser needs to see.
    return { k: 'error', span: this.spanOfToken(token) };
  }

  private caseExpr(): SExpr {
    const start = this.next(); // CASE
    const cases: { when: SExpr; then: SExpr }[] = [];
    let guard = 0;
    while (this.eatKw('WHEN') !== undefined) {
      guard += 1;
      if (guard > this.tokens.length + 1) break;
      const when = this.expr();
      this.expectKw('THEN', 'in a CASE arm');
      const then = this.expr();
      cases.push({ when, then });
    }
    // D §2.3: `case.else` is **required** — no implicit null fallthrough. "An implicit null
    // fallthrough is how derived variables silently become null for 4% of a sample."
    let otherwise: SExpr;
    if (this.expectKw('ELSE', 'in a CASE expression (it is required — D §2.3)') === undefined) {
      otherwise = { k: 'error', span: this.spanOfToken(this.cur()) };
    } else {
      otherwise = this.expr();
    }
    const end = this.expectKw('END', 'to close a CASE expression');
    return {
      k: 'case',
      cases,
      otherwise,
      span: { ...this.spanOfToken(start), end: (end ?? start).end },
    };
  }

  private callExpr(): SExpr {
    const nameToken = this.next();
    const nameSpan = this.spanOfToken(nameToken);
    const name = nameToken.upper;
    this.next(); // (

    const probeKind = PROBE_CALLS[name];
    if (probeKind !== undefined) {
      // A probe's argument is a content-node reference, not an expression: `SHOWN(PAGE P3)` has to
      // be readable, and `PAGE` is a keyword no expression can begin with.
      const ref = this.nodeRef(`as the target of ${name}`);
      const close = this.expectPunct(')', `to close ${name}(`);
      return {
        k: 'probe',
        probe: probeKind,
        ref: ref.ref,
        ...(ref.explicit === undefined ? {} : { explicit: ref.explicit }),
        refSpan: ref.span ?? nameSpan,
        span: { ...nameSpan, end: (close ?? nameToken).end },
      };
    }

    const aggFn = AGG_CALLS[name];
    if (aggFn !== undefined) {
      const group = this.groupSpec();
      let where: SExpr | undefined;
      let select: SExpr | undefined;
      let nulls: 'skip' | 'propagate' | 'as_zero' | undefined;
      if (this.eatKw('WHERE') !== undefined) where = this.expr();
      if (this.eatKw('SELECT') !== undefined) select = this.expr();
      if (this.eatKw('NULLS') !== undefined) {
        const mode = this.cur();
        if (mode.kind === 'ident' || mode.kind === 'keyword') {
          this.next();
          if (mode.upper === 'SKIP') nulls = 'skip';
          else if (mode.upper === 'PROPAGATE') nulls = 'propagate';
          else if (mode.upper === 'AS_ZERO') nulls = 'as_zero';
          else this.error('RSL-0001', 'Expected SKIP, PROPAGATE or AS_ZERO after NULLS.', this.spanOfToken(mode));
        } else {
          this.error('RSL-0001', 'Expected SKIP, PROPAGATE or AS_ZERO after NULLS.');
        }
      }
      const close = this.expectPunct(')', `to close ${name}(`);
      return {
        k: 'agg',
        fn: aggFn,
        group,
        ...(where === undefined ? {} : { where }),
        ...(select === undefined ? {} : { select }),
        ...(nulls === undefined ? {} : { nulls }),
        nameSpan,
        span: { ...nameSpan, end: (close ?? nameToken).end },
      };
    }

    if (name === 'CAST' || name === 'CODE') {
      const arg = this.expr();
      let to: 'num' | 'text' | 'date' | 'bool' = 'num';
      if (name === 'CAST') {
        this.expectKw('AS', 'in a CAST');
        const target = this.cur();
        if (target.kind === 'ident' || target.kind === 'keyword') {
          this.next();
          const parsed = castTargetOf(target.upper);
          if (parsed === undefined) {
            this.error(
              'RSL-0001',
              `${JSON.stringify(target.text)} is not a cast target. Expected NUM, TEXT, DATE or BOOL.`,
              this.spanOfToken(target),
            );
          } else to = parsed;
        } else {
          this.error('RSL-0001', 'Expected NUM, TEXT, DATE or BOOL after CAST … AS.');
        }
      }
      let onFail: 'null' | 'error' = 'null';
      if (this.eatKw('ON') !== undefined) {
        this.expectKw('FAIL', 'after ON in a CAST');
        if (this.eatKw('NULL') !== undefined) onFail = 'null';
        else if (this.eatKw('ERROR') !== undefined) onFail = 'error';
        else this.error('RSL-0001', 'Expected NULL or ERROR after ON FAIL.');
      }
      const close = this.expectPunct(')', `to close ${name}(`);
      return { k: 'cast', to, arg, on_fail: onFail, span: { ...nameSpan, end: (close ?? nameToken).end } };
    }

    const args: SExpr[] = [];
    if (!this.isPunct(')')) {
      let guard = 0;
      do {
        guard += 1;
        if (guard > this.tokens.length + 1) break;
        args.push(this.expr());
      } while (this.eatPunct(',') !== undefined);
    }
    const close = this.expectPunct(')', `to close ${name}(`);
    return { k: 'call', name, args, nameSpan, span: { ...nameSpan, end: (close ?? nameToken).end } };
  }

  /** The group of an aggregation — D §2.3's `Group`, in surface form. */
  private groupSpec(): SGroup {
    const token = this.cur();
    if (this.isPunct('[')) {
      this.next();
      const refs: { ref: string; span: Span }[] = [];
      if (!this.isPunct(']')) {
        let guard = 0;
        do {
          guard += 1;
          if (guard > this.tokens.length + 1) break;
          const ref = this.expectRef('in a variable list');
          if (ref === undefined) break;
          refs.push({ ref: ref.text, span: this.spanOfToken(ref) });
        } while (this.eatPunct(',') !== undefined);
      }
      const close = this.expectPunct(']', 'to close a variable list');
      return { g: 'vars', refs, span: { ...this.spanOfToken(token), end: (close ?? token).end } };
    }
    if (this.isKw('OPTIONS', 'ROWS', 'COLUMNS', 'ITERATIONS')) {
      const axisToken = this.next();
      const axis =
        axisToken.upper === 'OPTIONS'
          ? 'options'
          : axisToken.upper === 'ROWS'
            ? 'rows'
            : axisToken.upper === 'COLUMNS'
              ? 'columns'
              : 'iterations';
      this.expectKw('OF', `after ${axisToken.upper}`);
      const ref = this.expectRef(`after ${axisToken.upper} OF`);
      let at: { axis: 'row' | 'column'; ref: string } | undefined;
      if (this.isKw('ROW', 'COLUMN')) {
        const atToken = this.next();
        const atRef = this.expectRef(`after ${atToken.upper}`);
        at = { axis: atToken.upper === 'ROW' ? 'row' : 'column', ref: atRef?.text ?? '' };
      }
      return {
        g: 'axis',
        axis,
        ref: ref?.text ?? '',
        ...(at === undefined ? {} : { at }),
        span: this.spanBetween(axisToken, this.tokens[this.i - 1] ?? axisToken),
      };
    }
    const ref = this.expectRef('as an aggregation group');
    return { g: 'ref', ref: ref?.text ?? '', span: this.spanOfToken(ref ?? token) };
  }
}

/* ========================================================================== */
/* Helpers                                                                    */
/* ========================================================================== */

/**
 * Blank lines, capped at 0..2 per D §6.4: visual grouping is preserved, an accidental run of nine
 * is not.
 */
function capBlank(count: number): number {
  return Math.max(0, Math.min(2, count));
}

/**
 * Statement trivia, including the blank lines *between* leading comment blocks.
 *
 * D §6.4's `Trivia` has one `blank_before` and a flat `leading: string[]`, so it cannot say "two
 * comment blocks separated by a blank line" — and an author who separates a file header from a
 * statement's own comment with a blank line will notice its loss immediately. Encoded as empty
 * strings inside `leading`, which stays inside D's declared type (`string[]`), prints back as blank
 * lines, and re-parses to the same array. Reported as an under-specification of the Trivia shape
 * rather than as a licence to drop the blank line.
 */
function triviaFor(
  leading: readonly CommentToken[],
  trailing: CommentToken | undefined,
  blank: number,
  statementLine: number,
): Trivia {
  const lines: string[] = [];
  let previousLine: number | undefined;
  for (const comment of leading) {
    if (previousLine !== undefined) {
      for (let i = 0; i < capBlank(comment.line - previousLine - 1); i += 1) lines.push('');
    }
    lines.push(comment.text);
    // A block comment can span lines; its last line is where the next gap is measured from.
    previousLine = comment.line + comment.text.split('\n').length - 1;
  }
  if (previousLine !== undefined) {
    for (let i = 0; i < capBlank(statementLine - previousLine - 1); i += 1) lines.push('');
  }
  return {
    ...(lines.length === 0 ? {} : { leading: lines }),
    ...(trailing === undefined ? {} : { trailing: trailing.text }),
    ...(blank === 0 ? {} : { blank_before: blank }),
  };
}

function relOpOf(text: string): '==' | '!=' | '<' | '<=' | '>' | '>=' | undefined {
  switch (text) {
    case '=':
    case '==':
      return '==';
    case '<>':
    case '!=':
      return '!=';
    case '<':
      return '<';
    case '<=':
      return '<=';
    case '>':
      return '>';
    case '>=':
      return '>=';
    default:
      return undefined;
  }
}

function castTargetOf(upper: string): 'num' | 'text' | 'date' | 'bool' | undefined {
  switch (upper) {
    case 'NUM':
    case 'NUMBER':
      return 'num';
    case 'TEXT':
      return 'text';
    case 'DATE':
      return 'date';
    case 'BOOL':
    case 'BOOLEAN':
      return 'bool';
    default:
      return undefined;
  }
}

const KNOWN_QTYPES: ReadonlySet<string> = new Set([
  'SINGLE', 'MULTI', 'TEXT', 'NUMERIC', 'GRID', 'RANK', 'SLIDER', 'DATE', 'MAXDIFF', 'CONJOINT',
]);

/** D §6.2's `qtype`: a fixed list, or a plugin ident. Known ones normalize to uppercase. */
function normalizeQType(token: Token): string {
  return KNOWN_QTYPES.has(token.upper) ? token.upper : token.text;
}

function joinSpans(exprs: readonly { readonly span: Span }[]): Span {
  const first = exprs[0];
  const last = exprs[exprs.length - 1];
  if (first === undefined) return { start: 0, end: 0, line: 1, col: 1 };
  return { start: first.span.start, end: last?.span.end ?? first.span.end, line: first.span.line, col: first.span.col };
}

function describe(token: Token): string {
  switch (token.kind) {
    case 'eof':
      return 'the end of the input';
    case 'string':
      return `the string ${JSON.stringify(token.str ?? '')}`;
    case 'number':
      return `the number ${token.text}`;
    case 'keyword':
      return `the keyword ${token.upper}`;
    default:
      return JSON.stringify(token.text);
  }
}
