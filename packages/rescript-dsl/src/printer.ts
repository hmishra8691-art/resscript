/**
 * The pretty-printer — D §6.4's two guarantees, from the printing side.
 *
 * **T1 (AST identity)** `parse(print(a)) ≡ a`. Every decision here is subordinate to it. The
 * places it is easy to lose are marked in the code: a `neg` over a numeric literal, an `explicit`
 * aggregation group over a single variable whose name collides with a question ref, and an enum
 * literal printed as a bare code.
 *
 * **T2 (source normalization)** `print(parse(s))` may change whitespace, keyword case, `==`→`=`,
 * redundant parentheses and trailing-comma style. It may **not** change comments, comment
 * position, blank-line grouping, or the author's choice of symbolic (`Q1.Yes`) vs numeric option
 * references. The first three come from `Trivia` on the statement; the last from
 * `Trivia.symbolic_refs`, which is why the printer takes trivia rather than deriving a spelling.
 *
 * One property that is easy to overlook and is the whole point of storing ids: **every reference is
 * printed from the registry's current name, not from the text the author typed.** Rename `Q1` to
 * `S1` and every rule that reads it prints `S1`, with no find-and-replace and no stored AST
 * touched (schema §3).
 */

import type {
  AggFn,
  Expr,
  Group,
  NodeId,
  PageId,
  QuestionId,
  BlockId,
  LiteralValue,
  VariableId,
} from '@resscript/logic';
import { LogicInvariant, childrenOf } from '@resscript/logic';
import type {
  Action,
  ActionTarget,
  DslLiteral,
  MaskSpec,
  NodeRef,
  OptionDef,
  PipeSpec,
  Program,
  RandomizeSpec,
  Statement,
  Trivia,
  ValidateRule,
  VarName,
} from './ast.js';
import { quote } from './lexer.js';
import { refOfBlock, refOfPage, refOfQuestion, type DslRegistry } from './registry.js';

export interface PrintOptions {
  /** Line budget before a rule statement breaks across lines. The API's default is 96. */
  readonly width?: number;
  /** One indent level. Two spaces, matching D §6.3's illustrated program. */
  readonly indent?: string;
}

const DEFAULT_WIDTH = 96;
const DEFAULT_INDENT = '  ';

export function print(program: Program, registry: DslRegistry, options: PrintOptions = {}): string {
  const printer = new Printer(registry, options);
  const lines = printer.statements(program.statements, 0);
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

/** One statement, for the studio's per-rule code pane (09-ui §7.3's builder → code toggle). */
export function printStatement(
  statement: Statement<Expr>,
  registry: DslRegistry,
  options: PrintOptions = {},
): string {
  return print({ statements: [statement] }, registry, options);
}

/** One expression, for diagnostics, the flow editor's branch labels and the spec export (P3-05). */
export function printExpr(
  expr: Expr,
  registry: DslRegistry,
  trivia: Trivia = {},
  options: PrintOptions = {},
): string {
  return new Printer(registry, options).expr(expr, 0, trivia);
}

/* ========================================================================== */
/* Precedence                                                                 */
/* ========================================================================== */

/**
 * D §6.2's precedence ladder, low to high. `PRIMARY` is anything that never needs parentheses.
 *
 * A child is parenthesized when its level is *below* the level its position requires, which is the
 * minimal-parenthesization rule. `Trivia.paren_hints` then adds back the parentheses the author
 * wrote — and the two must not both fire, or the round trip would grow a pair of parentheses on
 * every pass and idempotence (T2) would fail on the second print.
 */
const P_OR = 1;
const P_AND = 2;
const P_NOT = 3;
const P_REL = 4;
const P_ADD = 5;
const P_MUL = 6;
const P_UNARY = 7;
const P_PRIMARY = 8;

interface Rendered {
  readonly text: string;
  readonly prec: number;
}

class Printer {
  private readonly width: number;
  private readonly pad: string;

  constructor(
    private readonly registry: DslRegistry,
    options: PrintOptions,
  ) {
    this.width = options.width ?? DEFAULT_WIDTH;
    this.pad = options.indent ?? DEFAULT_INDENT;
  }

  /* ---- statements -------------------------------------------------------- */

  statements(statements: readonly Statement<Expr>[], depth: number): readonly string[] {
    const out: string[] = [];
    for (const statement of statements) {
      const trivia = statement.trivia ?? {};
      const blank = Math.max(0, Math.min(2, trivia.blank_before ?? 0));
      // A blank line before the very first statement of a file would be printed and then re-read
      // as `blank_before` on that statement, so it is stable either way; the `index > 0` guard is
      // only about not opening a file with whitespace when nothing preceded it.
      for (let i = 0; i < blank; i += 1) out.push('');
      for (const comment of trivia.leading ?? []) out.push(`${this.indent(depth)}${comment}`);
      const body = this.statement(statement, depth);
      if (body.length === 0) continue;
      if (trivia.trailing !== undefined) {
        const last = body[body.length - 1] ?? '';
        body[body.length - 1] = `${last} ${trivia.trailing}`;
      }
      out.push(...body);
    }
    return out;
  }

  private indent(depth: number): string {
    return this.pad.repeat(depth);
  }

  private statement(statement: Statement<Expr>, depth: number): string[] {
    const trivia = statement.trivia ?? {};
    const pad = this.indent(depth);
    switch (statement.s) {
      case 'question':
        return this.question(statement, depth, trivia);
      case 'block':
      case 'page': {
        const out = [`${pad}${statement.s.toUpperCase()} ${this.nodeRefText(statement.ref)}`];
        if (statement.label !== undefined) out.push(`${this.indent(depth + 1)}LABEL ${quote(statement.label)}`);
        for (const spec of statement.randomize ?? []) {
          out.push(`${this.indent(depth + 1)}RANDOMIZE ${this.randomize(spec)}`);
        }
        out.push(...this.statements(statement.children, depth + 1));
        out.push(`${pad}END`);
        return out;
      }
      case 'rule':
        return this.rule(statement, depth, trivia);
      case 'action': {
        const action = this.action(statement.action, trivia);
        const condition =
          statement.condition === undefined ? '' : ` IF ${this.expr(statement.condition, 0, trivia)}`;
        return [`${pad}${action}${condition}`];
      }
      case 'set':
        return [`${pad}SET ${this.varText(statement.variable)} = ${this.expr(statement.value, 0, trivia)}`];
      case 'terminate': {
        const disposition = statement.disposition === undefined ? '' : ` AS ${statement.disposition}`;
        const custom = statement.custom === undefined ? '' : ` CUSTOM ${statement.custom}`;
        const condition =
          statement.condition === undefined ? '' : ` IF ${this.expr(statement.condition, 0, trivia)}`;
        return [`${pad}TERMINATE${disposition}${custom}${condition}`];
      }
      case 'randomize':
        return [`${pad}RANDOMIZE ${this.randomize(statement.spec)}`];
      case 'mask':
        return [`${pad}MASK ${this.mask(statement.spec, trivia)}`];
      case 'pipe':
        return [`${pad}PIPE ${this.pipe(statement.spec)}`];
      case 'priority_group': {
        const out = [`${pad}PRIORITY GROUP ${statement.name} {`];
        out.push(...this.statements(statement.statements, depth + 1));
        out.push(`${pad}}`);
        return out;
      }
      case 'unsupported':
      case 'error':
        // Verbatim, including its own internal newlines. The author's text is never reformatted by
        // a printer that could not read it — reformatting what you did not parse is how a formatter
        // corrupts a file.
        return statement.raw === '' ? [] : statement.raw.split('\n').map((line, i) => (i === 0 ? `${pad}${line}` : line));
      default: {
        const never: never = statement;
        throw new LogicInvariant(`no printer for statement kind ${JSON.stringify(never)}`);
      }
    }
  }

  private question(
    statement: Statement<Expr> & { readonly s: 'question' },
    depth: number,
    trivia: Trivia,
  ): string[] {
    const pad = this.indent(depth);
    const inner = this.indent(depth + 1);
    const item = this.indent(depth + 2);
    const out = [`${pad}QUESTION ${this.nodeRefText(statement.ref)}`];
    // A fixed clause order, so two authorings of the same question print identically. This is a
    // normalization beyond the list T2 enumerates and is reported as such; the alternative is a
    // printer whose output depends on the order the author happened to type the clauses, which
    // makes a diff between two versions of the same question unreadable.
    if (statement.qtype !== undefined) out.push(`${inner}TYPE ${statement.qtype}`);
    if (statement.label !== undefined) out.push(`${inner}LABEL ${quote(statement.label)}`);
    if (statement.instruction !== undefined) out.push(`${inner}INSTRUCTION ${quote(statement.instruction)}`);
    if (statement.required === true) out.push(`${inner}REQUIRED`);
    if (statement.required === false) out.push(`${inner}OPTIONAL`);
    for (const [clause, list] of [
      ['OPTIONS', statement.options],
      ['ROWS', statement.rows],
      ['COLUMNS', statement.columns],
    ] as const) {
      if (list === undefined) continue;
      out.push(`${inner}${clause}`);
      for (const option of list) out.push(`${item}${this.option(option, trivia)}`);
    }
    if (statement.validate !== undefined) {
      out.push(`${inner}VALIDATE`);
      for (const rule of statement.validate) out.push(`${item}${this.validate(rule, trivia)}`);
    }
    for (const spec of statement.randomize ?? []) out.push(`${inner}RANDOMIZE ${this.randomize(spec)}`);
    for (const mask of statement.masks ?? []) out.push(`${inner}MASK ${this.mask(mask, trivia)}`);
    for (const pipe of statement.pipes ?? []) out.push(`${inner}PIPE ${this.pipe(pipe)}`);
    out.push(`${pad}END`);
    return out;
  }

  private option(option: OptionDef<Expr>, trivia: Trivia): string {
    const parts = [String(option.code), quote(option.label)];
    for (const flag of option.flags) {
      switch (flag.f) {
        case 'exclusive':
          parts.push('EXCLUSIVE');
          break;
        case 'anchor':
          parts.push(
            flag.at === 'fixed' ? `ANCHOR AT ${String(flag.position ?? 1)}` : `ANCHOR ${flag.at.toUpperCase()}`,
          );
          break;
        case 'specify':
          parts.push(flag.text ? 'SPECIFY TEXT' : 'SPECIFY');
          break;
        case 'meta':
          parts.push(`META ${flag.key} = ${literalText(flag.value)}`);
          break;
        case 'visible_if':
          parts.push(`VISIBLE IF ${this.expr(flag.condition, 0, trivia)}`);
          break;
        case 'enabled_if':
          parts.push(`ENABLED IF ${this.expr(flag.condition, 0, trivia)}`);
          break;
        case 'autoselect_if':
          parts.push(`AUTOSELECT IF ${this.expr(flag.condition, 0, trivia)}`);
          break;
        case 'preselect':
          parts.push(
            flag.condition === undefined ? 'PRESELECT' : `PRESELECT IF ${this.expr(flag.condition, 0, trivia)}`,
          );
          break;
        default: {
          const never: never = flag;
          throw new LogicInvariant(`no printer for option flag ${JSON.stringify(never)}`);
        }
      }
    }
    return parts.join(' ');
  }

  private validate(rule: ValidateRule<Expr>, trivia: Trivia): string {
    const message = rule.message === undefined ? '' : ` MESSAGE ${quote(rule.message)}`;
    switch (rule.v) {
      case 'select': {
        const bound = rule.bound === 'at_least' ? 'AT LEAST' : rule.bound === 'at_most' ? 'AT MOST' : 'EXACTLY';
        return `SELECT ${bound} ${String(rule.n)}${message}`;
      }
      case 'sum': {
        const of = rule.of === undefined ? '' : ` OF ${rule.of.map((name) => this.varText(name)).join(', ')}`;
        return `SUM${of} = ${String(rule.value)}${message}`;
      }
      case 'range':
        return `RANGE ${String(rule.lo)} TO ${String(rule.hi)}${message}`;
      case 'matches':
        return `MATCHES ${quote(rule.pattern)}${message}`;
      case 'require':
        return `REQUIRE ${this.expr(rule.condition, 0, trivia)}${message}`;
      default: {
        const never: never = rule;
        throw new LogicInvariant(`no printer for validate rule ${JSON.stringify(never)}`);
      }
    }
  }

  private rule(
    statement: Statement<Expr> & { readonly s: 'rule' },
    depth: number,
    trivia: Trivia,
  ): string[] {
    const pad = this.indent(depth);
    const condition = this.expr(statement.condition, 0, trivia);
    const onUnknown = statement.on_unknown === undefined ? '' : ` ON UNKNOWN ${statement.on_unknown}`;
    const then = statement.then.map((action) => this.action(action, trivia));
    const otherwise = (statement.otherwise ?? []).map((action) => this.action(action, trivia));
    const single =
      `${pad}IF ${condition}${onUnknown} THEN ${then.join(' AND ')}` +
      (otherwise.length === 0 ? '' : ` ELSE ${otherwise.join(' AND ')}`);
    if (single.length <= this.width) return [single];

    // The broken form of D §9.2: operands of the top-level connective one per line at a three-space
    // continuation indent, then THEN/ELSE at two. Deterministic, so re-printing is a no-op (T2).
    const out: string[] = [];
    const root = statement.condition;
    if ((root.op === 'and' || root.op === 'or') && root.args.length > 1) {
      const keyword = root.op.toUpperCase();
      root.args.forEach((arg, index) => {
        const text = this.expr(arg, (root.op === 'and' ? P_AND : P_OR) + 1, trivia);
        out.push(index === 0 ? `${pad}IF ${text}` : `${pad}   ${keyword} ${text}`);
      });
    } else {
      out.push(`${pad}IF ${condition}`);
    }
    if (onUnknown !== '') out.push(`${pad}  ON UNKNOWN ${statement.on_unknown ?? ''}`);
    then.forEach((action, index) => {
      out.push(index === 0 ? `${pad}  THEN ${action}` : `${pad}   AND ${action}`);
    });
    otherwise.forEach((action, index) => {
      out.push(index === 0 ? `${pad}  ELSE ${action}` : `${pad}   AND ${action}`);
    });
    return out;
  }

  private action(action: Action<Expr>, trivia: Trivia): string {
    switch (action.a) {
      case 'show':
      case 'hide':
      case 'disable':
      case 'enable':
      case 'preselect':
        return `${action.a.toUpperCase()} ${this.target(action.target, trivia)}`;
      case 'skip_to':
        return `SKIP TO ${this.nodeRefText(action.ref)}`;
      case 'skip':
        return `SKIP ${this.nodeRefText(action.ref)}`;
      case 'terminate': {
        const disposition = action.disposition === undefined ? '' : ` AS ${action.disposition}`;
        const custom = action.custom === undefined ? '' : ` CUSTOM ${action.custom}`;
        return `TERMINATE${disposition}${custom}`;
      }
      case 'set':
        return `SET ${this.varText(action.variable)} = ${this.expr(action.value, 0, trivia)}`;
      case 'require':
        return `REQUIRE ${this.nodeRefText(action.ref)}`;
      case 'unrequire':
        return `UNREQUIRE ${this.nodeRefText(action.ref)}`;
      case 'flag':
        return `FLAG ${this.varText(action.variable)}`;
      default: {
        const never: never = action;
        throw new LogicInvariant(`no printer for action ${JSON.stringify(never)}`);
      }
    }
  }

  private target(target: ActionTarget<Expr>, trivia: Trivia): string {
    const ref = this.nodeRefText(target.ref);
    if (target.axis === undefined) return ref;
    const axis = target.axis.toUpperCase();
    if (target.where !== undefined) return `${ref} ${axis} WHERE ${this.expr(target.where, 0, trivia)}`;
    return `${ref} ${axis} ${(target.codes ?? []).map((code) => String(code)).join(', ')}`;
  }

  private randomize(spec: RandomizeSpec): string {
    const parts: string[] = [];
    if (spec.target.t === 'children') parts.push('CHILDREN');
    else if (spec.target.t === 'self') {
      if (spec.target.axis !== undefined) parts.push(spec.target.axis.toUpperCase());
    } else {
      parts.push(this.nodeRefText(spec.target.ref));
      if (spec.target.axis !== undefined) parts.push(spec.target.axis.toUpperCase());
    }
    for (const modifier of spec.modifiers) {
      switch (modifier.m) {
        case 'keep': {
          const at = modifier.at === 'in_place' ? 'IN PLACE' : modifier.at.toUpperCase();
          parts.push(
            `KEEP ${modifier.axis.toUpperCase()} ${modifier.codes.map((c) => String(c)).join(', ')} ${at}`,
          );
          break;
        }
        case 'subset':
          parts.push(`SUBSET ${String(modifier.n)}`);
          break;
        case 'group':
          parts.push(`GROUP ${modifier.name}`);
          break;
        case 'subblocks':
          parts.push(`SUBBLOCKS ${modifier.sizes.map((s) => String(s)).join(', ')}`);
          break;
        case 'evenly':
          parts.push('EVENLY');
          break;
        case 'rotate':
          parts.push('ROTATE');
          break;
        default: {
          const never: never = modifier;
          throw new LogicInvariant(`no printer for randomization modifier ${JSON.stringify(never)}`);
        }
      }
    }
    return parts.join(' ');
  }

  private mask(mask: MaskSpec<Expr>, trivia: Trivia): string {
    const target = mask.target === undefined ? '' : `${this.nodeRefText(mask.target)} `;
    const mode = mask.mode === 'include' ? 'TO' : 'EXCEPT';
    const source =
      mask.source.src === 'selected_in'
        ? `${mask.source.negated ? 'NOT ' : ''}SELECTED IN ${this.varText(mask.source.variable)}`
        : mask.source.src === 'codes'
          ? `[${mask.source.codes.map((c) => String(c)).join(', ')}]`
          : `WHERE ${this.expr(mask.source.condition, 0, trivia)}`;
    const empty =
      mask.when_empty === 'skip' ? 'SKIP' : mask.when_empty === 'show_all' ? 'SHOW ALL' : 'TERMINATE';
    return `${target}${mask.axis.toUpperCase()} ${mode} ${source} WHEN EMPTY ${empty}`;
  }

  private pipe(pipe: PipeSpec): string {
    const as = pipe.as === undefined ? '' : ` AS ${pipe.as.toUpperCase()}`;
    return `${this.nodeRefText(pipe.into)} FROM ${this.nodeRefText(pipe.from)}${as}`;
  }

  /* ---- references -------------------------------------------------------- */

  private nodeRefText(ref: NodeRef): string {
    const prefix = ref.explicit === undefined ? '' : `${ref.explicit.toUpperCase()} `;
    if (ref.id === undefined) return `${prefix}${ref.ref}`;
    const kind = ref.kind ?? 'question';
    const current =
      kind === 'question'
        ? refOfQuestion(this.registry, ref.id as QuestionId)
        : kind === 'page'
          ? refOfPage(this.registry, ref.id as PageId)
          : refOfBlock(this.registry, ref.id as BlockId);
    // Falling back to the authored text rather than to the id: an id in the code pane is
    // unreadable, and printing nothing would silently delete the target of a rule.
    return `${prefix}${current ?? ref.ref}`;
  }

  /**
   * A question probe target, disambiguated only when it has to be.
   *
   * A scalar question emits a variable with the same name (schema §1), so a bare `ANSWERED(Q12)`
   * re-parses as the *variable* probe. Where that collision exists the printer writes
   * `ANSWERED(QUESTION Q12)`; where it does not, the bare ref is what the author would write.
   */
  private questionProbeText(id: QuestionId): string {
    const ref = refOfQuestion(this.registry, id) ?? id;
    return this.registry.env.byRef(ref) === undefined ? ref : `QUESTION ${ref}`;
  }

  private varText(name: VarName): string {
    if (name.id === undefined) return name.ref;
    return this.variableName(name.id, name.ref);
  }

  private variableName(id: VariableId, fallback: string): string {
    return this.registry.env.byId(id)?.name ?? fallback;
  }

  /**
   * The question ref that owns an enum domain, for `RECODE`'s target.
   *
   * A domain is not itself nameable in the surface syntax — it is derived from the question that
   * declares the option list — so the printed form names the question, which is also what the
   * author wrote. Two questions sharing one domain (a shared option list) is the case that makes
   * this ambiguous; the FIRST in registry order wins, which is stable because `env.questions()`
   * is document-ordered, and either ref denotes the same domain so neither is wrong.
   */
  private refOfDomain(domain: string): string | undefined {
    for (const question of this.registry.env.questions()) {
      if (question.domain === domain) return question.ref;
    }
    return undefined;
  }

  /* ---- expressions ------------------------------------------------------- */

  /**
   * `anchor` means: an enum or set literal in this position must carry its domain *in the text*.
   *
   * Enum domains are nominal (D §2.2), and a bare code carries no domain — `1` re-parses as `num`
   * unless something in its context says otherwise. Normally the context does: the other operand of
   * the comparison, or the declared type of the `SET` target. But `[1] CONTAINS 1` has a literal on
   * both sides and nothing to infer from, so printing bare codes there produces source that
   * re-parses to a *differently typed* tree — precisely the failure D §6.4 says P5 exists to catch,
   * and P5 duly caught it.
   *
   * Where that happens the printer emits the symbolic form (`[Q5.Apple] CONTAINS Q5.Apple`), which
   * anchors the domain. That is a deliberate ordering of the two guarantees: T2 asks the printer not
   * to change the author's numeric-vs-symbolic choice, but T1 says the text must mean the same tree,
   * and a formatting preference cannot outrank meaning. Reported.
   */
  expr(expr: Expr, minPrec: number, trivia: Trivia, anchor = false): string {
    const rendered = this.render(expr, trivia, anchor);
    const needsParens = rendered.prec < minPrec;
    if (needsParens) return `(${rendered.text})`;
    // `paren_hints`: parentheses the author wrote that the printer would drop (D §6.4). Applied only
    // when the printer did not already add a pair, or every round trip would nest one deeper and
    // idempotence would fail on the second print.
    const hinted = (trivia.paren_hints ?? []).includes(expr.n);
    return hinted ? `(${rendered.text})` : rendered.text;
  }

  private render(expr: Expr, trivia: Trivia, anchor: boolean): Rendered {
    switch (expr.op) {
      case 'lit':
        return { text: this.literal(expr.v, expr.n, trivia, anchor), prec: P_PRIMARY };
      case 'var':
        return { text: this.variableName(expr.var, expr.var), prec: P_PRIMARY };
      case 'probe': {
        const name = expr.kind.toUpperCase();
        const target = expr.target;
        const text =
          target.kind === 'variable'
            ? this.variableName(target.id, target.id)
            : target.kind === 'question'
              ? this.questionProbeText(target.id)
              : `PAGE ${refOfPage(this.registry, target.id) ?? target.id}`;
        return { text: `${name}(${text})`, prec: P_PRIMARY };
      }
      case 'item':
        return { text: 'item', prec: P_PRIMARY };
      case 'item_attr':
        return {
          text: expr.meta_key === undefined ? `item.${expr.attr}` : `item.meta.${expr.meta_key}`,
          prec: P_PRIMARY,
        };
      case '==':
      case '!=':
      case '<':
      case '<=':
      case '>':
      case '>=': {
        // `=` not `==`, and `<>` normalized to `!=`: D §6.2 says both spellings parse as equality
        // and pretty-print as `=`, "matching the example in schema §19".
        const op = expr.op === '==' ? '=' : expr.op;
        const anchorLeft = this.needsAnchor(expr.args[0], expr.args[1], trivia);
        const left = this.expr(expr.args[0], P_ADD, trivia, anchorLeft);
        const right = this.expr(expr.args[1], P_ADD, trivia);
        return { text: `${left} ${op} ${right}`, prec: P_REL };
      }
      case 'contains':
      case 'any_of':
      case 'all_of':
      case 'none_of': {
        const keyword =
          expr.op === 'contains' ? 'CONTAINS' : expr.op === 'any_of' ? 'ANY OF' : expr.op === 'all_of' ? 'ALL OF' : 'NONE OF';
        const anchorLeft = this.needsAnchor(expr.args[0], expr.args[1], trivia);
        const left = this.expr(expr.args[0], P_ADD, trivia, anchorLeft);
        const right = this.expr(expr.args[1], P_ADD, trivia);
        return { text: `${left} ${keyword} ${right}`, prec: P_REL };
      }
      case 'set_eq':
      case 'subset_of':
      case 'union':
      case 'intersect':
      case 'difference': {
        // D §6.2's infix `set_op` list stops at CONTAINS / ANY OF / ALL OF / NONE OF / IN, so these
        // five have no infix spelling in the grammar and are printed as calls. Reported.
        const anchorLeft = this.needsAnchor(expr.args[0], expr.args[1], trivia);
        const args = [
          this.expr(expr.args[0], 0, trivia, anchorLeft),
          this.expr(expr.args[1], 0, trivia),
        ];
        return { text: `${expr.op.toUpperCase()}(${args.join(', ')})`, prec: P_PRIMARY };
      }
      case 'and':
      case 'or': {
        const keyword = expr.op.toUpperCase();
        const prec = expr.op === 'and' ? P_AND : P_OR;
        // `prec + 1`, not `prec`: a nested `or` inside an `or` must keep its parentheses. D §2.3
        // makes `and`/`or` n-ary and D §10.1 flattens nested ones as a *compile-time optimizer pass*,
        // which means `or(a, or(b, c))` is a legal AST that the parser would flatten on the way back
        // in. Printing `a OR (b OR c)` is what keeps T1 true for a tree the builder can produce by
        // nesting two ANY groups. Found by P1.
        return {
          text: expr.args.map((arg) => this.expr(arg, prec + 1, trivia)).join(` ${keyword} `),
          prec,
        };
      }
      case 'not':
        return { text: `NOT ${this.expr(expr.args[0], P_NOT, trivia)}`, prec: P_NOT };
      case '+':
      case '-': {
        const left = this.expr(expr.args[0], P_ADD, trivia);
        const right = this.expr(expr.args[1], P_MUL, trivia);
        return { text: `${left} ${expr.op} ${right}`, prec: P_ADD };
      }
      case '*':
      case '/':
      case 'mod': {
        const symbol = expr.op === 'mod' ? 'MOD' : expr.op;
        const left = this.expr(expr.args[0], P_MUL, trivia);
        const right = this.expr(expr.args[1], P_UNARY, trivia);
        return { text: `${left} ${symbol} ${right}`, prec: P_MUL };
      }
      case 'neg': {
        const operand = expr.args[0];
        // `-(5)`, not `-5`. A leading `-` on a numeric literal folds into the literal at parse time
        // (see parser.ts's `unary`), so printing `-5` here would re-parse as `lit(-5)` and T1 would
        // fail on exactly the trees a builder produces for "negate this number".
        // `-(-x)`, never `--x`: two adjacent minus signs are a `--` line comment (D §6.2), so
        // printing `neg(neg(x))` without parentheses turns the rest of the line into a comment and
        // the statement silently loses its condition. Found by property P1.
        const needsParens = operand.op === 'neg' || (operand.op === 'lit' && operand.v.k === 'num');
        const text = needsParens ? `(${this.expr(operand, 0, trivia)})` : this.expr(operand, P_UNARY, trivia);
        return { text: `-${text}`, prec: P_UNARY };
      }
      case 'abs':
      case 'floor':
      case 'ceil':
        return { text: this.call(expr.op.toUpperCase(), [expr.args[0]], trivia), prec: P_PRIMARY };
      case 'pow':
        return { text: this.call('POW', [expr.args[0], expr.args[1]], trivia), prec: P_PRIMARY };
      case 'round':
        return { text: this.call('ROUND', [expr.args[0], expr.args[1]], trivia), prec: P_PRIMARY };
      case 'min':
      case 'max':
      case 'clamp':
        return { text: this.call(expr.op.toUpperCase(), expr.args, trivia), prec: P_PRIMARY };
      case 'agg':
        return { text: this.agg(expr, trivia), prec: P_PRIMARY };
      case 'concat':
        return { text: this.call('CONCAT', expr.args, trivia), prec: P_PRIMARY };
      case 'len':
      case 'lower':
      case 'upper':
      case 'trim':
      case 'word_count':
        return { text: this.call(expr.op.toUpperCase(), [expr.args[0]], trivia), prec: P_PRIMARY };
      case 'starts_with':
      case 'ends_with':
      case 'str_contains':
      case 'split_count':
        return { text: this.call(expr.op.toUpperCase(), [expr.args[0], expr.args[1]], trivia), prec: P_PRIMARY };
      case 'matches': {
        const args = [this.expr(expr.args[0], 0, trivia), quote(expr.pattern)];
        if (expr.flags !== undefined) args.push(quote(expr.flags));
        return { text: `MATCHES(${args.join(', ')})`, prec: P_PRIMARY };
      }
      case 'substr':
        return { text: this.call('SUBSTR', expr.args, trivia), prec: P_PRIMARY };
      case 'date_diff':
        return {
          text: `DATE_DIFF(${expr.unit.toUpperCase()}, ${this.expr(expr.args[0], 0, trivia)}, ${this.expr(expr.args[1], 0, trivia)})`,
          prec: P_PRIMARY,
        };
      case 'date_add':
        return {
          text: `DATE_ADD(${expr.unit.toUpperCase()}, ${this.expr(expr.args[0], 0, trivia)}, ${this.expr(expr.args[1], 0, trivia)})`,
          prec: P_PRIMARY,
        };
      case 'date_part':
        return {
          text: `DATE_PART(${expr.part.toUpperCase()}, ${this.expr(expr.args[0], 0, trivia)})`,
          prec: P_PRIMARY,
        };
      case 'date_trunc':
        return {
          text: `DATE_TRUNC(${expr.unit.toUpperCase()}, ${this.expr(expr.args[0], 0, trivia)})`,
          prec: P_PRIMARY,
        };
      case 'case': {
        const arms = expr.cases
          .map((arm) => `WHEN ${this.expr(arm.when, 0, trivia)} THEN ${this.expr(arm.then, 0, trivia, anchor)}`)
          .join(' ');
        // The `ELSE` is never elided. D §2.5: it is mandatory in the AST, and "the pretty-printer
        // never elides the `else`, so the behaviour is visible in the source".
        return { text: `CASE ${arms} ELSE ${this.expr(expr.else, 0, trivia, anchor)} END`, prec: P_PRIMARY };
      }
      case 'coalesce':
        // The anchor flows into the arms: a `COALESCE` takes its type from the same expectation its
        // arms do, so if the coalesce has to carry its domain, each arm does.
        return {
          text: `COALESCE(${expr.args.map((arg) => this.expr(arg, 0, trivia, anchor)).join(', ')})`,
          prec: P_PRIMARY,
        };
      case 'cast': {
        const onFail = expr.on_fail === 'error' ? ' ON FAIL ERROR' : '';
        return {
          text: `CAST(${this.expr(expr.args[0], 0, trivia)} AS ${expr.to.toUpperCase()}${onFail})`,
          prec: P_PRIMARY,
        };
      }
      case 'label_of': {
        const form = expr.form === 'long' ? ', LONG' : '';
        return { text: `LABEL_OF(${this.expr(expr.args[0], 0, trivia)}${form})`, prec: P_PRIMARY };
      }
      case 'recode': {
        // Printed against the QUESTION that owns the domain, not the domain id: `RECODE(Q1, Q4)`
        // is what the author wrote and what they can read back. A domain with no question — which
        // a hand-built artifact could carry — falls back to the id rather than losing the node.
        const ref = this.refOfDomain(expr.to) ?? expr.to;
        return { text: `RECODE(${this.expr(expr.args[0], 0, trivia)}, ${ref})`, prec: P_PRIMARY };
      }
      default: {
        const never: never = expr;
        // The three-way closure of D §7.2 in its runtime form: a node kind with no printer is a
        // thrown invariant naming the kind, and `closure.test.ts` turns that into a named CI
        // failure. The compile-time half is this `never` guard.
        throw new LogicInvariant(`no printer for AST kind ${JSON.stringify((never as { op?: string }).op)}`);
      }
    }
  }

  /**
   * True when neither operand can supply the other's domain, so the left one must carry its own.
   *
   * Mirrors the resolver's `needsContext`: it resolves whichever side is self-determining first, and
   * if both sides are literals there is nothing to resolve first.
   */
  private needsAnchor(left: Expr, right: Expr, trivia: Trivia): boolean {
    return isContextDependent(left, trivia) && isContextDependent(right, trivia);
  }

  /**
   * A symbolic spelling for a code in a domain: `Q5.Apple`.
   *
   * Derived from the registry by finding a question whose option list *is* that domain and an item
   * carrying that code. `undefined` when the registry cannot name one — a shared option-list
   * template with no owning question in this registry, say — in which case the caller falls back to
   * the bare code and the round trip loses the domain. That case is reported as a known limitation
   * rather than papered over with an invented syntax for "a code in domain X".
   */
  private anchorFor(domain: string, code: number): string | undefined {
    for (const question of this.registry.env.questions()) {
      if (question.domain !== domain) continue;
      for (const axis of [question.options, question.rows, question.columns]) {
        for (const item of axis) {
          if (item.code !== code) continue;
          const ref = item.ref ?? String(item.code);
          return `${refOfQuestion(this.registry, question.id) ?? question.ref}.${ref}`;
        }
      }
    }
    // No question owns this domain — a `derived` enum variable (`AGE_BAND`) is the normal case. Its
    // codes are spelled against the variable instead: `AGE_BAND.2`.
    for (const decl of this.registry.env.variables()) {
      if (decl.domain !== domain) continue;
      const type = this.registry.env.typeOf(decl);
      if (type.k !== 'enum' && type.k !== 'set') continue;
      return `${decl.name}.${String(code)}`;
    }
    return undefined;
  }

  private call(name: string, args: readonly Expr[], trivia: Trivia): string {
    return `${name}(${args.map((arg) => this.expr(arg, 0, trivia)).join(', ')})`;
  }

  private agg(expr: Expr & { readonly op: 'agg' }, trivia: Trivia): string {
    const name = AGG_NAMES[expr.fn];
    const parts = [this.group(expr.over)];
    if (expr.where !== undefined) parts.push(`WHERE ${this.expr(expr.where, 0, trivia)}`);
    if (expr.select !== undefined) parts.push(`SELECT ${this.expr(expr.select, 0, trivia)}`);
    if (expr.nulls !== undefined && expr.nulls !== 'skip') parts.push(`NULLS ${expr.nulls.toUpperCase()}`);
    return `${name}(${parts.join(' ')})`;
  }

  private group(group: Group): string {
    switch (group.kind) {
      case 'explicit':
        // Always bracketed, even for one member. An unbracketed single variable would re-parse as
        // a `question_emits` group whenever a question shares the variable's name — which is the
        // normal case for a multi-select's set view (`Q5` names both the question and the set),
        // so T1 would fail on the most common group in a real survey.
        return `[${group.variable_ids.map((id) => this.variableName(id, id)).join(', ')}]`;
      case 'question_emits':
        return refOfQuestion(this.registry, group.question_id) ?? group.question_id;
      case 'options':
        return `OPTIONS OF ${refOfQuestion(this.registry, group.question_id) ?? group.question_id}`;
      case 'matrix_rows': {
        const at = group.column_ref === undefined ? '' : ` COLUMN ${group.column_ref}`;
        return `ROWS OF ${refOfQuestion(this.registry, group.question_id) ?? group.question_id}${at}`;
      }
      case 'matrix_cols': {
        const at = group.row_ref === undefined ? '' : ` ROW ${group.row_ref}`;
        return `COLUMNS OF ${refOfQuestion(this.registry, group.question_id) ?? group.question_id}${at}`;
      }
      case 'loop_iterations':
        return `ITERATIONS OF ${refOfQuestion(this.registry, group.question_id) ?? group.question_id}`;
      default: {
        const never: never = group;
        throw new LogicInvariant(`no printer for group kind ${JSON.stringify(never)}`);
      }
    }
  }

  private literal(value: LiteralValue, node: NodeId, trivia: Trivia, anchor: boolean): string {
    const symbolic = trivia.symbolic_refs?.[String(node)];
    switch (value.k) {
      case 'null':
        return 'NULL';
      case 'bool':
        return value.v ? 'TRUE' : 'FALSE';
      case 'num':
        return numberText(value.v);
      case 'text':
        return quote(value.v);
      case 'date':
        return `DATE ${quote(value.v)}`;
      case 'enum': {
        // The author's symbolic spelling wins (T2 forbids changing it). Otherwise the bare code:
        // re-parsing recovers the domain from the operand this literal is compared against, which
        // is the only position a well-typed enum literal can occupy (D §3.3's `compatEq` rejects
        // `enum<d> ~ num`, so there is no context where a bare code means anything else) — unless
        // `anchor` says the context cannot supply it.
        if (symbolic !== undefined) return symbolic;
        return (anchor ? this.anchorFor(value.d, value.v) : undefined) ?? numberText(value.v);
      }
      case 'set': {
        if (symbolic !== undefined) return symbolic;
        const codes = value.v.map((code) => (anchor ? this.anchorFor(value.d, code) : undefined) ?? numberText(code));
        return `[${codes.join(', ')}]`;
      }
      default: {
        const never: never = value;
        throw new LogicInvariant(`no printer for literal ${JSON.stringify(never)}`);
      }
    }
  }
}

/* ========================================================================== */
/* Paren hints                                                                */
/* ========================================================================== */

/**
 * Keep only the parentheses the printer would otherwise **drop**.
 *
 * D §6.4 defines `paren_hints` as "parens the author wrote that the printer would drop", and the
 * distinction is load-bearing rather than pedantic. The parser records every parenthesis it sees,
 * because it cannot know from inside `primary()` whether the enclosing operator needs them. If the
 * structural ones were kept as hints, then for an AST that never had trivia at all — one built by
 * the visual builder — `parse(print(a))` would come back carrying hints, and T1 would fail on every
 * rule with a nested `OR`. So the resolver prunes: a hint survives only where the printer's
 * precedence rules would not have emitted the parenthesis anyway.
 *
 * The precedence walk below mirrors `render`. Two copies of one table is a drift risk, and the
 * mitigation is the round-trip properties: a disagreement shows up immediately as P1 or P2 failing
 * on a parenthesized condition.
 */
export function prunedParenHints(exprs: readonly Expr[], hints: readonly NodeId[]): readonly NodeId[] {
  if (hints.length === 0) return hints;
  const candidates = new Set(hints);
  const kept: NodeId[] = [];
  const visit = (expr: Expr, minPrec: number): void => {
    if (candidates.has(expr.n) && precOf(expr) >= minPrec) kept.push(expr.n);
    for (const [child, childMin] of childMinPrec(expr)) visit(child, childMin);
  };
  for (const expr of exprs) visit(expr, 0);
  return kept.sort((a, b) => a - b);
}

function precOf(expr: Expr): number {
  switch (expr.op) {
    case 'or':
      return P_OR;
    case 'and':
      return P_AND;
    case 'not':
      return P_NOT;
    case '==':
    case '!=':
    case '<':
    case '<=':
    case '>':
    case '>=':
    case 'contains':
    case 'any_of':
    case 'all_of':
    case 'none_of':
      return P_REL;
    case '+':
    case '-':
      return P_ADD;
    case '*':
    case '/':
    case 'mod':
      return P_MUL;
    case 'neg':
      return P_UNARY;
    default:
      return P_PRIMARY;
  }
}

/** Each child of `expr` with the minimum precedence its position tolerates unparenthesized. */
function childMinPrec(expr: Expr): readonly (readonly [Expr, number])[] {
  switch (expr.op) {
    // `+ 1` for the same reason as the printer's `and`/`or` case: a same-operator child is
    // parenthesized structurally, so the author's parenthesis there is not a hint.
    case 'and':
      return expr.args.map((arg) => [arg, P_AND + 1] as const);
    case 'or':
      return expr.args.map((arg) => [arg, P_OR + 1] as const);
    case 'not':
      return [[expr.args[0], P_NOT]];
    case '==':
    case '!=':
    case '<':
    case '<=':
    case '>':
    case '>=':
    case 'contains':
    case 'any_of':
    case 'all_of':
    case 'none_of':
      return [
        [expr.args[0], P_ADD],
        [expr.args[1], P_ADD],
      ];
    case '+':
    case '-':
      return [
        [expr.args[0], P_ADD],
        [expr.args[1], P_MUL],
      ];
    case '*':
    case '/':
    case 'mod':
      return [
        [expr.args[0], P_MUL],
        [expr.args[1], P_UNARY],
      ];
    case 'neg': {
      const operand = expr.args[0];
      // The printer parenthesizes a negated numeric literal and a doubly-negated expression itself,
      // so a hint in either position is structural rather than the author's.
      const forced = operand.op === 'neg' || (operand.op === 'lit' && operand.v.k === 'num');
      return [[operand, forced ? P_PRIMARY + 1 : P_UNARY]];
    }
    default:
      // Every other kind prints its children inside delimiters of its own, so no child of it is
      // ever parenthesized by precedence and every author parenthesis in one is a real hint.
      return childrenOf(expr).map((child) => [child, 0] as const);
  }
}

/* ========================================================================== */
/* Helpers                                                                    */
/* ========================================================================== */

/** D §2.3's `Agg.fn` → its call name. See parser.ts's `AGG_CALLS` for why min/max differ. */
const AGG_NAMES: { readonly [K in AggFn]: string } = {
  count: 'COUNT',
  sum: 'SUM',
  mean: 'MEAN',
  min: 'MIN_OF',
  max: 'MAX_OF',
  any: 'ANY',
  all: 'ALL',
  distinct_count: 'DISTINCT_COUNT',
  stdev: 'STDEV',
  first_answered: 'FIRST_ANSWERED',
  last_answered: 'LAST_ANSWERED',
};

/**
 * True when this expression's type comes from its context rather than from itself — an enum or set
 * literal with no symbolic spelling, or a construct that inherits its type from the same
 * expectation (`COALESCE`, `CASE`).
 */
function isContextDependent(expr: Expr, trivia: Trivia): boolean {
  switch (expr.op) {
    case 'lit':
      return (
        (expr.v.k === 'enum' || expr.v.k === 'set') && trivia.symbolic_refs?.[String(expr.n)] === undefined
      );
    case 'coalesce':
      return expr.args.some((arg) => isContextDependent(arg, trivia));
    case 'case':
      return (
        expr.cases.some((arm) => isContextDependent(arm.then, trivia)) ||
        isContextDependent(expr.else, trivia)
      );
    default:
      return false;
  }
}

function literalText(value: DslLiteral): string {
  switch (value.k) {
    case 'num':
      return numberText(value.v);
    case 'text':
      return quote(value.v);
    case 'bool':
      return value.v ? 'TRUE' : 'FALSE';
    case 'date':
      return `DATE ${quote(value.v)}`;
    case 'null':
      return 'NULL';
    default: {
      const never: never = value;
      throw new LogicInvariant(`no printer for meta literal ${JSON.stringify(never)}`);
    }
  }
}

/**
 * A number, in a form the lexer reads back identically.
 *
 * `Number.prototype.toString` is the right choice for the finite doubles the value model admits
 * (D §2.2: NaN and Infinity are invariant errors, so they cannot appear) — except for exponent
 * notation, which the lexer does not accept. A magnitude that would print as `1e+21` is written out
 * in full so the round trip survives it.
 */
function numberText(value: number): string {
  const plain = String(value);
  if (!plain.includes('e') && !plain.includes('E')) return plain;
  return value.toFixed(0);
}
