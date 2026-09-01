/**
 * The resolver: surface tree → `packages/logic` AST, with ids resolved and types annotated.
 *
 * Three jobs, and they have to happen together:
 *
 *  1. **`ref` → `id`** (schema §3). Every reference in the AST is an id, so renaming `Q1` to `S1`
 *     touches no stored logic. This is the pass that makes that true.
 *  2. **Domain placement.** `S1 = 1` must produce `{k:'enum', v:1, d:'dom_s1'}`, not
 *     `{k:'num', v:1}` — D §3.3's `compatEq` refuses `enum<d> ~ num`, so a bare number against an
 *     enum is a *type error*, not a coercion. The domain is not in the literal's syntax; it comes
 *     from the other operand. So resolution is type-directed, which is why it cannot be folded
 *     into the parser (which must stay context-free to stay total).
 *  3. **Type annotation and diagnostics**, by calling `packages/logic`'s checker — not by
 *     reimplementing it. Every semantic diagnostic an author sees in the code pane is produced by
 *     the same function the compiler runs at publish (D §3.4 requirement 2: "the editor and the
 *     compiler cannot disagree because they are the same code"). This file's only contribution is
 *     the source span: it keeps a node-id → span map and re-emits each `LGC-####` with a position.
 *
 * The one analysis performed here rather than delegated is the document-order forward reference
 * (LGC-F001) — see `forwardReferences` at the bottom for why, and for what it deliberately does
 * not claim.
 */

import type {
  AggFn,
  BlockId,
  Expr,
  Group,
  ItemBinding,
  LgcDiagnostic,
  NodeId,
  PageId,
  ProbeTarget,
  QuestionDecl,
  QuestionId,
  Type,
  VariableId,
} from '@resscript/logic';
import {
  T_BOOL,
  T_DATE,
  T_NEVER,
  T_NUM,
  T_TEXT,
  asDomainId,
  astBuilder,
  checkExpr,
  groupElementType,
  typeName,
  type AstBuilder,
} from '@resscript/logic';
import { reparameterize, statementExprs } from './ast.js';
import { prunedParenHints } from './printer.js';
import type {
  Action,
  ActionTarget,
  MaskSpec,
  NodeRef,
  OptionDef,
  OptionFlag,
  Program,
  Statement,
  Trivia,
  ValidateRule,
  VarName,
} from './ast.js';
import { rslDiagnostic, withSpan, type DslDiagnostic, type Span } from './diagnostics.js';
import type { DslRegistry } from './registry.js';
import { questionIdOf } from './registry.js';
import type { SExpr, SGroup, SetOpName } from './surface.js';
import { quote } from './lexer.js';
import type { ParsedProgram } from './parser.js';

export interface SourceMapEntry {
  readonly node: NodeId;
  /** Which statement of the program the node belongs to; node ids restart per statement. */
  readonly statement: number;
  readonly span: Span;
}

export interface ResolvedProgram {
  readonly program: Program;
  readonly diagnostics: readonly DslDiagnostic[];
  readonly source_map: readonly SourceMapEntry[];
}

/**
 * A domain for a code list whose domain could not be inferred.
 *
 * It exists so the error path still produces a well-formed `set` literal rather than a node with a
 * missing field: the checker then reports the real problem (`LGC-T021`/`LGC-T003`, a domain
 * mismatch) instead of the resolver having to invent a semantic diagnostic of its own. It can never
 * match a real domain, because a real `DomainId` is derived from a question id.
 */
const UNRESOLVED_DOMAIN = asDomainId('dom_unresolved');

const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;

export function resolveProgram(parsed: ParsedProgram, registry: DslRegistry): ResolvedProgram {
  const resolver = new Resolver(registry);
  const statements = parsed.statements.map((statement) => resolver.statement(statement));
  resolver.forwardReferences();
  return {
    program: { statements },
    diagnostics: resolver.diagnostics,
    source_map: resolver.sourceMap,
  };
}

interface Ctx {
  readonly b: AstBuilder;
  readonly spans: Map<NodeId, Span>;
  readonly symbolic: Map<NodeId, string>;
  readonly parens: NodeId[];
  readonly reads: { readonly variable: VariableId; readonly node: NodeId }[];
  item: ItemBinding | undefined;
}

interface R {
  readonly expr: Expr;
  readonly type: Type;
}

class Resolver {
  readonly diagnostics: DslDiagnostic[] = [];
  readonly sourceMap: SourceMapEntry[] = [];
  /** Variables read per statement index, for the forward-reference pass. */
  private readonly readsByStatement = new Map<number, readonly { variable: VariableId; node: NodeId }[]>();
  private readonly spansByStatement = new Map<number, ReadonlyMap<NodeId, Span>>();
  /**
   * Document position, assigned pre-order so a statement nested in a BLOCK sorts after the block
   * and before whatever follows it. The forward-reference pass compares these numbers, so they have
   * to mean "where in the file", not "where in this list".
   */
  private seq = 0;
  /** Variable → the document position of the QUESTION that emits it, for LGC-F001. */
  private readonly definedAt = new Map<VariableId, number>();

  constructor(private readonly registry: DslRegistry) {}

  /* ---- statements ------------------------------------------------------- */

  statement(statement: Statement<SExpr>): Statement<Expr> {
    const index = this.seq;
    this.seq += 1;
    if (statement.s === 'question') this.recordDefinitions(statement.ref.ref, index);
    const ctx: Ctx = {
      b: astBuilder(1),
      spans: new Map(),
      symbolic: new Map(),
      parens: [],
      reads: [],
      item: undefined,
    };
    const resolved = this.statementBody(statement, index, ctx);
    for (const [node, span] of ctx.spans) this.sourceMap.push({ node, statement: index, span });
    this.readsByStatement.set(index, ctx.reads);
    this.spansByStatement.set(index, ctx.spans);
    const trivia = mergeTrivia(statement.trivia, ctx, resolved);
    return trivia === undefined ? resolved : ({ ...resolved, trivia } as Statement<Expr>);
  }

  private statementBody(statement: Statement<SExpr>, index: number, ctx: Ctx): Statement<Expr> {
    switch (statement.s) {
      case 'question': {
        const ref = this.nodeRef(statement.ref, 'question');
        const question = ref.id === undefined ? undefined : this.registry.env.question(ref.id as QuestionId);
        return reparameterize<Statement<Expr>>({
          ...statement,
          ref,
          ...(statement.options === undefined
            ? {}
            : { options: statement.options.map((o) => this.option(o, ctx, question, 'options')) }),
          ...(statement.rows === undefined
            ? {}
            : { rows: statement.rows.map((o) => this.option(o, ctx, question, 'rows')) }),
          ...(statement.columns === undefined
            ? {}
            : { columns: statement.columns.map((o) => this.option(o, ctx, question, 'columns')) }),
          ...(statement.validate === undefined
            ? {}
            : { validate: statement.validate.map((v) => this.validate(v, ctx)) }),
          ...(statement.masks === undefined
            ? {}
            : { masks: statement.masks.map((m) => this.mask(m, ctx, question)) }),
          ...(statement.pipes === undefined
            ? {}
            : { pipes: statement.pipes.map((p) => ({ ...p, into: this.nodeRef(p.into, 'question'), from: this.nodeRef(p.from, 'question') })) }),
        });
      }
      case 'block':
      case 'page':
        return reparameterize<Statement<Expr>>({
          ...statement,
          ref: this.nodeRef(statement.ref, statement.s),
          children: statement.children.map((child) => this.statement(child)),
        });
      case 'rule':
        return reparameterize<Statement<Expr>>({
          ...statement,
          condition: this.condition(statement.condition, ctx),
          then: statement.then.map((action) => this.action(action, ctx)),
          ...(statement.otherwise === undefined
            ? {}
            : { otherwise: statement.otherwise.map((action) => this.action(action, ctx)) }),
        });
      case 'action':
        return reparameterize<Statement<Expr>>({
          ...statement,
          action: this.action(statement.action, ctx),
          ...(statement.condition === undefined ? {} : { condition: this.condition(statement.condition, ctx) }),
        });
      case 'set': {
        const variable = this.varName(statement.variable);
        return { ...statement, variable, value: this.value(statement.value, ctx, variable) };
      }
      case 'terminate':
        return reparameterize<Statement<Expr>>({
          ...statement,
          ...(statement.condition === undefined ? {} : { condition: this.condition(statement.condition, ctx) }),
        });
      case 'randomize':
        return {
          ...statement,
          spec: {
            ...statement.spec,
            target:
              statement.spec.target.t === 'node'
                ? { ...statement.spec.target, ref: this.nodeRef(statement.spec.target.ref, undefined) }
                : statement.spec.target,
          },
        };
      case 'mask':
        return { ...statement, spec: this.mask(statement.spec, ctx, undefined) };
      case 'pipe':
        return {
          ...statement,
          spec: {
            ...statement.spec,
            into: this.nodeRef(statement.spec.into, 'question'),
            from: this.nodeRef(statement.spec.from, 'question'),
          },
        };
      case 'priority_group':
        return reparameterize<Statement<Expr>>({
          ...statement,
          statements: statement.statements.map((child) => this.statement(child)),
        });
      case 'unsupported':
      case 'error':
        return statement;
      default: {
        const never: never = statement;
        throw new Error(`unhandled statement kind ${JSON.stringify(never)}`);
      }
    }
  }

  private option(
    option: OptionDef<SExpr>,
    ctx: Ctx,
    question: QuestionDecl | undefined,
    axis: 'options' | 'rows' | 'columns',
  ): OptionDef<Expr> {
    return { ...option, flags: option.flags.map((flag) => this.optionFlag(flag, ctx, question, axis)) };
  }

  private optionFlag(
    flag: OptionFlag<SExpr>,
    ctx: Ctx,
    question: QuestionDecl | undefined,
    axis: 'options' | 'rows' | 'columns',
  ): OptionFlag<Expr> {
    switch (flag.f) {
      case 'visible_if':
      case 'enabled_if':
      case 'autoselect_if':
        return { ...flag, condition: this.condition(flag.condition, ctx) };
      case 'preselect':
        return flag.condition === undefined
          ? { f: 'preselect' }
          : { f: 'preselect', condition: this.condition(flag.condition, ctx) };
      case 'exclusive':
      case 'anchor':
      case 'specify':
      case 'meta':
        void question;
        void axis;
        return flag;
      default: {
        const never: never = flag;
        throw new Error(`unhandled option flag ${JSON.stringify(never)}`);
      }
    }
  }

  private validate(rule: ValidateRule<SExpr>, ctx: Ctx): ValidateRule<Expr> {
    if (rule.v !== 'require') {
      if (rule.v === 'sum' && rule.of !== undefined) {
        return { ...rule, of: rule.of.map((name) => this.varName(name)) };
      }
      return rule;
    }
    return { ...rule, condition: this.condition(rule.condition, ctx) };
  }

  private mask(mask: MaskSpec<SExpr>, ctx: Ctx, owner: QuestionDecl | undefined): MaskSpec<Expr> {
    const target = mask.target === undefined ? undefined : this.nodeRef(mask.target, 'question');
    const question =
      target?.id !== undefined ? this.registry.env.question(target.id as QuestionId) : owner;
    const source = mask.source;
    if (source.src === 'where') {
      // A per-item mask condition binds `item` (D §2.3, D §6.3's
      // `HIDE Q3 OPTION WHERE item.meta.discontinued = TRUE`). Without the binding the checker
      // would report LGC-T012 on perfectly good source.
      const binding = itemBindingFor(question, mask.axis);
      const resolvedSource = { src: 'where' as const, condition: this.condition(source.condition, ctx, binding) };
      return {
        ...(target === undefined ? {} : { target }),
        axis: mask.axis,
        mode: mask.mode,
        source: resolvedSource,
        when_empty: mask.when_empty,
      };
    }
    return {
      ...(target === undefined ? {} : { target }),
      axis: mask.axis,
      mode: mask.mode,
      source: source.src === 'selected_in' ? { ...source, variable: this.varName(source.variable) } : source,
      when_empty: mask.when_empty,
    };
  }

  private action(action: Action<SExpr>, ctx: Ctx): Action<Expr> {
    switch (action.a) {
      case 'show':
      case 'hide':
      case 'disable':
      case 'enable':
      case 'preselect':
        return { ...action, target: this.actionTarget(action.target, ctx) };
      case 'skip_to':
      case 'skip':
        return { ...action, ref: this.nodeRef(action.ref, undefined) };
      case 'require':
      case 'unrequire':
        return { ...action, ref: this.nodeRef(action.ref, 'question') };
      case 'set': {
        const variable = this.varName(action.variable);
        return { ...action, variable, value: this.value(action.value, ctx, variable) };
      }
      case 'flag':
        // D §6.3's `FLAG incomplete_q5` has no counterpart in D §4.2's `Effect` union, which has
        // seven actions and no `flag`. Resolved as a variable reference — the compiler turns it
        // into `set_variable <ref> = TRUE`, which is the only effect that can express it — so the
        // ref is checked against the registry here and reported if it does not exist.
        return { ...action, variable: this.varName(action.variable) };
      default:
        return action;
    }
  }

  private actionTarget(target: ActionTarget<SExpr>, ctx: Ctx): ActionTarget<Expr> {
    const ref = this.nodeRef(target.ref, undefined);
    if (target.where === undefined) {
      return reparameterize<ActionTarget<Expr>>({ ...target, ref });
    }
    const question = ref.id === undefined ? undefined : this.registry.env.question(ref.id as QuestionId);
    const axis = target.axis === 'row' ? 'rows' : target.axis === 'column' ? 'columns' : 'options';
    const binding = itemBindingFor(question, axis);
    return reparameterize<ActionTarget<Expr>>({ ...target, ref, where: this.condition(target.where, ctx, binding) });
  }

  /* ---- expression sites -------------------------------------------------- */

  /** A boolean-typed site: rule conditions, per-item predicates, `VALIDATE REQUIRE`. */
  private condition(expr: SExpr, ctx: Ctx, item?: ItemBinding): Expr {
    const previous = ctx.item;
    if (item !== undefined) ctx.item = item;
    const resolved = this.expr(expr, ctx, T_BOOL);
    ctx.item = previous;
    const checked = this.check(resolved.expr, ctx, item);
    this.requireBoolean(checked, ctx);
    return checked;
  }

  /**
   * `LGC-T033`: a condition must be boolean-typed.
   *
   * This is the one rule-level check the DSL performs itself, and it is here rather than in a call
   * to `checkRule` because `checkRule` takes a `Rule` — with an id, an `order_key`, a target and a
   * flow node — and a DSL statement is *one to three* rules whose ids the compiler assigns (see
   * ast.ts). The rest of `checkRule`'s checks (T030–T034, W021, I002) run there.
   *
   * It is worth doing anyway, immediately, because it is the check that keeps the three-valued
   * design honest: the rule boundary is the single coercion point (D §2.5) and it collapses UNKNOWN,
   * not numbers or strings. An implicit truthiness here would be a second, undocumented coercion
   * point — exactly what the whole design exists to prevent.
   */
  private requireBoolean(expr: Expr, ctx: Ctx): void {
    const type = expr.t;
    if (type === undefined || type.k === 'bool' || type.k === 'null' || type.k === 'never') return;
    const span = ctx.spans.get(expr.n);
    this.diagnostics.push({
      code: 'LGC-T033',
      severity: 'error',
      message:
        `Condition must be boolean, got ${typeName(type)}. There is no implicit truthiness: the ` +
        'rule boundary is the single coercion point and it collapses UNKNOWN, not numbers or strings.',
      path: '',
      ...(span === undefined ? {} : { span }),
      detail: { node: expr.n, got: typeName(type) },
    });
  }

  /** A `SET`/`FLAG` value site: the expected type is the target variable's declared type. */
  private value(expr: SExpr, ctx: Ctx, variable: VarName): Expr {
    const decl = variable.id === undefined ? undefined : this.registry.env.byId(variable.id);
    const expected = decl === undefined ? undefined : this.registry.env.typeOf(decl);
    const resolved = this.expr(expr, ctx, expected);
    return this.check(resolved.expr, ctx, undefined);
  }

  /**
   * Run the checker and re-emit its diagnostics with source spans.
   *
   * The annotated tree is kept: D §2.1 item 5 says types are inferred then cached on the node, and
   * the evaluator trusts `t` rather than re-deriving it. A parser that returned an unannotated tree
   * would make every consumer re-run the checker.
   */
  private check(expr: Expr, ctx: Ctx, item: ItemBinding | undefined): Expr {
    const result = checkExpr(expr, this.registry.env, item === undefined ? {} : { item });
    for (const diagnostic of result.diagnostics) this.diagnostics.push(this.position(diagnostic, ctx));
    return result.expr;
  }

  private position(diagnostic: LgcDiagnostic, ctx: Ctx): DslDiagnostic {
    const node = diagnostic.detail?.['node'];
    const span = typeof node === 'number' ? ctx.spans.get(node) : undefined;
    return withSpan(diagnostic, span);
  }

  /* ---- references -------------------------------------------------------- */

  private nodeRef(ref: NodeRef, expected: 'question' | 'page' | 'block' | undefined): NodeRef {
    const kind = ref.explicit ?? ref.kind ?? expected;
    if (kind === 'page' || kind === 'block') {
      const id =
        kind === 'page' ? this.registry.nodes?.pageByRef?.(ref.ref) : this.registry.nodes?.blockByRef?.(ref.ref);
      if (id === undefined) {
        // Not an error. logic's `PageDecl`/`BlockDecl` carry no `ref` (see registry.ts), so without
        // a caller-supplied `NodeIndex` there is nothing to resolve against. The author's text is
        // kept and the compiler, which has the content tree, resolves it at publish.
        this.warn(
          'RSL-0012',
          `${kind === 'page' ? 'Page' : 'Block'} ${JSON.stringify(ref.ref)} was not resolved to an id. ` +
            "The type environment does not name pages or blocks, so the reference is kept as text " +
            'and resolved by the compiler.',
          ref.span,
        );
        return { ...ref, kind };
      }
      return { ...ref, kind, id: id as PageId | BlockId };
    }
    const questionId = questionIdOf(this.registry, ref.ref);
    if (questionId === undefined) {
      // A ref that is neither a question nor a page/block: if a *variable* of that name exists the
      // author probably meant the question that emits it, so the message says so rather than
      // "unknown".
      const variable = this.registry.env.byRef(ref.ref);
      const owner = variable === undefined ? undefined : this.registry.env.ownerQuestion(variable.id);
      if (owner !== undefined) return { ...ref, kind: 'question', id: owner.id };
      this.error(
        'LGC-T001',
        `Unknown reference ${JSON.stringify(ref.ref)}: no question, page, block or variable of that name.`,
        ref.span,
        { ref: ref.ref },
      );
      return { ...ref, ...(kind === undefined ? {} : { kind }) };
    }
    return { ...ref, kind: 'question', id: questionId };
  }

  private varName(name: VarName): VarName {
    const decl = this.registry.env.byRef(name.ref);
    if (decl === undefined) {
      this.error('LGC-T001', `Unknown variable ${JSON.stringify(name.ref)}.`, name.span, { ref: name.ref });
      return name;
    }
    return { ...name, id: decl.id };
  }

  private error(
    code: 'LGC-T001',
    message: string,
    span: Span | undefined,
    detail: { readonly [key: string]: string },
  ): void {
    // Reported under the checker's own code rather than a new RSL one: "unknown variable id, or a
    // reference that resolves to nothing" is exactly LGC-T001 (D §3.5), and two codes for one
    // defect means the UI renders it twice with different copy.
    this.diagnostics.push({
      code,
      severity: 'error',
      message,
      path: '',
      ...(span === undefined ? {} : { span }),
      detail,
    });
  }

  private warn(code: 'RSL-0012', message: string, span: Span | undefined): void {
    this.diagnostics.push(rslDiagnostic(code, message, span ?? ZERO_SPAN));
  }

  private recordDefinitions(ref: string, index: number): void {
    const questionId = questionIdOf(this.registry, ref);
    if (questionId === undefined) return;
    const question = this.registry.env.question(questionId);
    if (question === undefined) return;
    for (const variableId of question.emits) {
      if (!this.definedAt.has(variableId)) this.definedAt.set(variableId, index);
    }
  }

  /* ---- expressions ------------------------------------------------------- */

  private mk<T extends Expr>(node: T, span: Span, ctx: Ctx): T {
    ctx.spans.set(node.n, span);
    return node;
  }

  private expr(surface: SExpr, ctx: Ctx, expect: Type | undefined): R {
    switch (surface.k) {
      case 'paren': {
        const inner = this.expr(surface.inner, ctx, expect);
        // D §6.4: `paren_hints` exists because `(A AND B) OR C` and `A AND B OR C` are the same
        // AST, and stripping the author's clarifying parentheses in a rule they are about to review
        // with a client is hostile even though it is technically lossless.
        ctx.parens.push(inner.expr.n);
        return inner;
      }
      case 'num': {
        if (expect?.k === 'enum') {
          const lit = this.mk(ctx.b.enumLit(surface.value, expect.d), surface.span, ctx);
          return { expr: lit, type: expect };
        }
        return { expr: this.mk(ctx.b.numLit(surface.value), surface.span, ctx), type: T_NUM };
      }
      case 'str':
        return { expr: this.mk(ctx.b.textLit(surface.value), surface.span, ctx), type: T_TEXT };
      case 'bool':
        return { expr: this.mk(ctx.b.boolLit(surface.value), surface.span, ctx), type: T_BOOL };
      case 'null':
        return { expr: this.mk(ctx.b.nullLit(), surface.span, ctx), type: { k: 'null' } };
      case 'date': {
        if (!ISO_DATE.test(surface.value)) {
          this.diagnostics.push(
            rslDiagnostic(
              'RSL-0013',
              `${quote(surface.value)} is not an ISO-8601 date. D §2.2 requires dates to be ISO-8601 ` +
                'and always UTC — there are no local dates in the value model.',
              surface.span,
            ),
          );
        }
        return { expr: this.mk(ctx.b.dateLit(surface.value), surface.span, ctx), type: T_DATE };
      }
      case 'codes':
        return this.codeList(surface, ctx, expect);
      case 'path':
        return this.path(surface, ctx, expect);
      case 'probe': {
        const target = this.probeTarget(surface.ref, surface.explicit, surface.refSpan);
        return {
          expr: this.mk(ctx.b.probe(surface.probe, target), surface.span, ctx),
          type: T_BOOL,
        };
      }
      case 'call':
        return this.call(surface, ctx, expect);
      case 'agg':
        return this.agg(surface, ctx);
      case 'case': {
        const cases = surface.cases.map((arm) => ({
          when: this.expr(arm.when, ctx, T_BOOL).expr,
          then: this.expr(arm.then, ctx, expect),
        }));
        const otherwise = this.expr(surface.otherwise, ctx, expect ?? cases[0]?.then.type);
        const node = ctx.b.caseExpr(
          cases.map((arm) => ({ when: arm.when, then: arm.then.expr })),
          otherwise.expr,
        );
        return { expr: this.mk(node, surface.span, ctx), type: expect ?? cases[0]?.then.type ?? otherwise.type };
      }
      case 'cast': {
        const arg = this.expr(surface.arg, ctx, undefined);
        const node = ctx.b.cast(surface.to, arg.expr, surface.on_fail);
        return { expr: this.mk(node, surface.span, ctx), type: castType(surface.to) };
      }
      case 'not': {
        const arg = this.expr(surface.arg, ctx, T_BOOL);
        return { expr: this.mk(ctx.b.not(arg.expr), surface.span, ctx), type: T_BOOL };
      }
      case 'bool_op': {
        const args = surface.args.map((arg) => this.expr(arg, ctx, T_BOOL).expr);
        const node = surface.op === 'and' ? ctx.b.and(...args) : ctx.b.or(...args);
        return { expr: this.mk(node, surface.span, ctx), type: T_BOOL };
      }
      case 'cmp': {
        const [left, right] = this.operands(surface.left, surface.right, ctx);
        return {
          expr: this.mk(ctx.b.cmp(surface.op, left.expr, right.expr), surface.span, ctx),
          type: T_BOOL,
        };
      }
      case 'set_op': {
        const [left, right] = this.setOperands(surface.op, surface.left, surface.right, ctx);
        return {
          expr: this.mk(ctx.b.setOp(surface.op, left.expr, right.expr), surface.span, ctx),
          // Every infix set operator is a predicate; the three set-valued ones are call-spelled.
          type: T_BOOL,
        };
      }
      case 'between': {
        // Desugared to `x >= lo AND x <= hi`. There is no `between` AST kind (D §2.3), and adding
        // one would break the builder isomorphism (D §7.1) — the builder renders comparisons, not
        // ranges. So the printer emits the desugared form, which is a normalization beyond the list
        // T2 enumerates; reported.
        const value = this.expr(surface.value, ctx, undefined);
        const lo = this.expr(surface.lo, ctx, value.type);
        const hi = this.expr(surface.hi, ctx, value.type);
        const valueAgain = this.expr(surface.value, ctx, undefined);
        const lower = this.mk(ctx.b.cmp('>=', value.expr, lo.expr), surface.span, ctx);
        const upper = this.mk(ctx.b.cmp('<=', valueAgain.expr, hi.expr), surface.span, ctx);
        return { expr: this.mk(ctx.b.and(lower, upper), surface.span, ctx), type: T_BOOL };
      }
      case 'arith': {
        const left = this.expr(surface.left, ctx, T_NUM);
        const right = this.expr(surface.right, ctx, T_NUM);
        return {
          expr: this.mk(ctx.b.binArith(surface.op, left.expr, right.expr), surface.span, ctx),
          type: T_NUM,
        };
      }
      case 'neg': {
        const arg = this.expr(surface.arg, ctx, T_NUM);
        return { expr: this.mk(ctx.b.unArith('neg', arg.expr), surface.span, ctx), type: T_NUM };
      }
      case 'error':
        // The parser already reported it. A null literal keeps the enclosing tree well-formed so
        // the *other* diagnostics in the statement are still real, which is the point of recovery.
        return { expr: this.mk(ctx.b.nullLit(), surface.span, ctx), type: T_NEVER };
      default: {
        const never: never = surface;
        throw new Error(`unhandled surface expression ${JSON.stringify(never)}`);
      }
    }
  }

  /**
   * Resolve a comparison's operands, deciding which side goes first.
   *
   * `S1 = 1` needs `S1` resolved before `1` can be known to be `enum<dom_s1>`; `1 = S1` needs the
   * reverse. Deciding by "which side is a context-free literal" is the only rule that handles both
   * without a unification pass.
   */
  private operands(leftSurface: SExpr, rightSurface: SExpr, ctx: Ctx): readonly [R, R] {
    const leftNeeds = needsContext(leftSurface);
    const rightNeeds = needsContext(rightSurface);
    if (leftNeeds && !rightNeeds) {
      const right = this.expr(rightSurface, ctx, undefined);
      const left = this.expr(leftSurface, ctx, right.type);
      return [left, right];
    }
    const left = this.expr(leftSurface, ctx, undefined);
    const right = this.expr(rightSurface, ctx, left.type);
    return [left, right];
  }

  /**
   * A set operator's operands.
   *
   * `contains` takes a set on the left and an element on the right; every other predicate takes two
   * sets. Either side can be the one that determines the domain, so the side that does not need a
   * context is resolved first — the same rule as `operands`, with the extra step of converting
   * between `set<d>` and `enum<d>` because the two sides of `CONTAINS` are not the same type.
   */
  private setOperands(
    op: SetOpName,
    leftSurface: SExpr,
    rightSurface: SExpr,
    ctx: Ctx,
  ): readonly [R, R] {
    const elementRight = op === 'contains';
    if (needsContext(leftSurface) && !needsContext(rightSurface)) {
      const right = this.expr(rightSurface, ctx, undefined);
      const domain = domainOf(right.type);
      const left = this.expr(leftSurface, ctx, domain === undefined ? undefined : { k: 'set', d: domain });
      return [left, right];
    }
    const left = this.expr(leftSurface, ctx, undefined);
    const domain = domainOf(left.type);
    const rightExpect: Type | undefined =
      domain === undefined ? undefined : elementRight ? { k: 'enum', d: domain } : { k: 'set', d: domain };
    const right = this.expr(rightSurface, ctx, rightExpect);
    return [left, right];
  }

  private codeList(
    surface: SExpr & { readonly k: 'codes' },
    ctx: Ctx,
    expect: Type | undefined,
  ): R {
    let domain = expect?.k === 'set' || expect?.k === 'enum' ? expect.d : undefined;
    const codes: number[] = [];
    /** The author's spelling of each element, so a symbolic list round-trips (D §6.4 T2). */
    const spellings: string[] = [];
    let anySymbolic = false;

    for (const item of surface.items) {
      if (item.k === 'num') {
        codes.push(item.value);
        spellings.push(String(item.value));
        continue;
      }
      if (item.k === 'path' && item.attrs.length === 1) {
        const symbolic = this.symbolicOption(item.head, item.attrs[0]?.name ?? '', item.span);
        if (symbolic !== undefined) {
          domain = domain ?? symbolic.domain;
          codes.push(symbolic.code);
          spellings.push(`${item.head}.${item.attrs[0]?.name ?? ''}`);
          anySymbolic = true;
          continue;
        }
      }
      this.diagnostics.push(
        rslDiagnostic(
          'RSL-0001',
          'A list literal takes option codes or symbolic option references (`[1, 3]`, ' +
            '`[Q5.Apple, Q5.Cherry]`). D §6.2 admits only literals here, because a dynamic list ' +
            'would make the dependency graph undecidable (D §7.1).',
          item.span,
        ),
      );
    }

    if (domain === undefined) {
      this.diagnostics.push(
        rslDiagnostic(
          'RSL-0021',
          'Cannot infer which option list these codes belong to. A code list takes its domain from ' +
            'the operand it is compared against (`Q5 ANY OF [1, 3]`), or from a symbolic reference ' +
            'inside it (`[Q5.Apple]`). Enum domains are nominal (D §2.2), so a code with no domain ' +
            'has no meaning.',
          surface.span,
        ),
      );
    }

    const node = this.mk(ctx.b.setLit(codes, domain ?? UNRESOLVED_DOMAIN), surface.span, ctx);
    if (anySymbolic) {
      // A `set` literal is one node, so D §6.4's per-node `symbolic_refs` cannot record a spelling
      // per element. The whole rendered list is stored instead — still a string keyed by a node id,
      // still exactly what T2 requires ("the author's choice of symbolic vs numeric option
      // references" preserved), and it re-parses to the same normalized literal.
      ctx.symbolic.set(node.n, `[${spellings.join(', ')}]`);
    }
    return { expr: node, type: { k: 'set', d: domain ?? UNRESOLVED_DOMAIN } };
  }

  private path(surface: SExpr & { readonly k: 'path' }, ctx: Ctx, expect: Type | undefined): R {
    const head = surface.head;
    const attrs = surface.attrs;

    /* ---- the implicit item ---------------------------------------------- */
    if (head.toUpperCase() === 'ITEM') {
      if (attrs.length === 0) {
        return {
          expr: this.mk(ctx.b.item(), surface.span, ctx),
          type: ctx.item?.elem ?? T_NEVER,
        };
      }
      const first = attrs[0]?.name.toLowerCase() ?? '';
      if (first === 'meta') {
        const key = attrs[1]?.name;
        if (key === undefined) {
          this.diagnostics.push(
            rslDiagnostic('RSL-0001', 'Expected a key after `item.meta`.', surface.span),
          );
          return { expr: this.mk(ctx.b.item(), surface.span, ctx), type: T_NEVER };
        }
        // `attr` is ignored by both the checker and the evaluator when `meta_key` is present, but
        // *some* value must be chosen or a builder-authored and a DSL-authored meta lookup would
        // not be `exprEq`. `label` is the choice: a meta value is authored data, like a label.
        const node = ctx.b.itemAttr('label', key);
        return { expr: this.mk(node, surface.span, ctx), type: ctx.item?.meta[key] ?? T_NEVER };
      }
      if (first === 'code' || first === 'label' || first === 'position' || first === 'selected') {
        const node = ctx.b.itemAttr(first);
        const type = first === 'label' ? T_TEXT : first === 'selected' ? T_BOOL : T_NUM;
        return { expr: this.mk(node, surface.span, ctx), type };
      }
      this.diagnostics.push(
        rslDiagnostic(
          'RSL-0001',
          `\`item.${attrs[0]?.name ?? ''}\` is not an item attribute. Expected code, label, ` +
            'position, selected, or meta.<key>.',
          surface.span,
        ),
      );
      return { expr: this.mk(ctx.b.item(), surface.span, ctx), type: T_NEVER };
    }

    /* ---- a symbolic option reference: Q5.Apple -------------------------- */
    if (attrs.length === 1) {
      const attr = attrs[0]?.name ?? '';
      if (attr.toLowerCase() !== 'label') {
        const symbolic = this.symbolicOption(head, attr, surface.span);
        if (symbolic !== undefined) {
          const node = this.mk(ctx.b.enumLit(symbolic.code, symbolic.domain), surface.span, ctx);
          // D §3.4 requirement 3: the diagnostic offers the symbolic form because it is "the
          // mechanism that makes logic survive an option label change". Recording the author's
          // choice is what lets the printer give it back to them.
          ctx.symbolic.set(node.n, `${head}.${attr}`);
          return { expr: node, type: { k: 'enum', d: symbolic.domain } };
        }
      }
    }

    /* ---- a variable, optionally with `.label` or a domain-qualified code -- */
    const decl = this.registry.env.byRef(head);
    if (decl === undefined) {
      // An unresolved name becomes a `var` node carrying the *text* the author typed, not a null
      // literal. Two reasons, and the second is the important one:
      //
      //  1. The checker then reports it, as `LGC-T001` on that node — one diagnostic, from the
      //     catalogue, with a span, rather than a lookalike invented here.
      //  2. The printer prints an unresolvable id by falling back to its text, so `format` on a file
      //     with a typo gives the typo back. A null literal would silently rewrite `NOPE` to `NULL`,
      //     which is a formatter deleting the author's work — the R1 failure mode exactly.
      //
      // The cast is the one place a `VariableId` is not a real id. It is confined to a tree that
      // already carries a publish-blocking error, so it cannot reach an artifact.
      const node = this.mk(ctx.b.variable(head as unknown as VariableId), surface.span, ctx);
      return { expr: node, type: T_NEVER };
    }
    const variable = this.mk(ctx.b.variable(decl.id), attrs.length === 0 ? surface.span : { ...surface.span, end: surface.span.start + head.length }, ctx);
    ctx.reads.push({ variable: decl.id, node: variable.n });
    const variableType = this.registry.env.typeOf(decl);
    if (attrs.length === 0) return { expr: variable, type: variableType };

    const rawAttr = attrs[0]?.name ?? '';
    if (attrs.length === 1 && /^\d+$/.test(rawAttr) && (variableType.k === 'enum' || variableType.k === 'set')) {
      // `AGE_BAND.2` — a code qualified by a variable's domain.
      //
      // It exists because a `derived` enum variable (schema §4 `kind: 'derived'`) has an enum domain
      // and no question, so there is no `Q5.Apple` spelling for its codes — and without *some*
      // spelling the printer cannot anchor a domain that no operand supplies, which breaks T1 for
      // `SET AGE_BAND = COALESCE(1, 2)`. Found by property P1. D §6.2's `var_path` production admits
      // it (`ref { "." ident }`) and never says what it means; this is the reading that makes the
      // domain recoverable.
      const code = Number.parseInt(rawAttr, 10);
      const node = this.mk(ctx.b.enumLit(code, variableType.d), surface.span, ctx);
      ctx.symbolic.set(node.n, `${head}.${rawAttr}`);
      return { expr: node, type: { k: 'enum', d: variableType.d } };
    }
    const attr = rawAttr.toLowerCase();
    if (attr === 'label' && attrs.length === 1) {
      // `BRAND.label` in D §6.2's `var_path` comment. Normalized by the printer to `LABEL_OF(BRAND)`
      // so there is one spelling per AST node; reported as a normalization.
      return { expr: this.mk(ctx.b.labelOf(variable), surface.span, ctx), type: T_TEXT };
    }
    this.diagnostics.push(
      rslDiagnostic(
        'RSL-0022',
        `${JSON.stringify(head)} has no member ${JSON.stringify(attrs[0]?.name ?? '')}. A dotted path is ` +
          'either a symbolic option reference on a question (`Q5.Apple`) or `.label` on a variable.',
        surface.span,
      ),
    );
    void expect;
    return { expr: variable, type: variableType };
  }

  /** `Q5.Apple` → the option's code and its question's domain, or undefined if it is not one. */
  private symbolicOption(
    head: string,
    attr: string,
    span: Span,
  ): { readonly code: number; readonly domain: ReturnType<typeof asDomainId> } | undefined {
    const questionId = questionIdOf(this.registry, head);
    if (questionId === undefined) return undefined;
    const question = this.registry.env.question(questionId);
    if (question === undefined || question.domain === undefined) return undefined;
    const items = [...question.options, ...question.rows, ...question.columns];
    // By `ref` first, then by code: schema §19's own example gives options `"ref": "1"`, so the
    // numeric spelling is a legitimate ref, and the printer falls back to `Q5.3` when it has to
    // anchor a domain explicitly.
    const byRef = items.find((item) => item.ref === attr);
    const byCode = items.find((item) => String(item.code) === attr);
    const found = byRef ?? byCode;
    if (found === undefined) {
      this.diagnostics.push(
        rslDiagnostic(
          'RSL-0014',
          `${JSON.stringify(head)} has no option ${JSON.stringify(attr)}. Symbolic option references ` +
            "resolve against the option's stable ref (schema §5.1), not its label — labels are " +
            'translated, so matching on them breaks in every non-base language.',
          span,
          { question: head, option: attr },
        ),
      );
      return undefined;
    }
    return { code: found.code, domain: question.domain };
  }

  private probeTarget(
    ref: string,
    explicit: 'question' | 'page' | 'block' | undefined,
    span: Span,
  ): ProbeTarget {
    if (explicit === 'page') {
      const id = this.registry.nodes?.pageByRef?.(ref);
      if (id === undefined) {
        this.warn(
          'RSL-0012',
          `Page ${JSON.stringify(ref)} was not resolved to an id; the type environment does not name pages.`,
          span,
        );
        // A probe must have *some* target. An unresolvable page id produces LGC-T016 from the
        // checker, which is the correct diagnostic for "this target does not exist".
        return { kind: 'page', id: ref as unknown as PageId };
      }
      return { kind: 'page', id };
    }
    if (explicit === 'question') {
      const id = questionIdOf(this.registry, ref);
      if (id === undefined) {
        this.error('LGC-T001', `Unknown question ${JSON.stringify(ref)}.`, span, { ref });
        return { kind: 'question', id: ref as unknown as QuestionId };
      }
      return { kind: 'question', id };
    }
    if (explicit === 'block') {
      // D §2.3's `Probe.target` admits variable, question and page — not block. `SHOWN(BLOCK X)` is
      // therefore unrepresentable rather than merely unimplemented, so it is rejected here.
      this.diagnostics.push(
        rslDiagnostic(
          'RSL-0008',
          'A probe cannot target a block: D §2.3 gives `Probe.target` the kinds variable, question ' +
            'and page. Probe a page or a question inside the block instead.',
          span,
        ),
      );
      return { kind: 'question', id: ref as unknown as QuestionId };
    }
    const variable = this.registry.env.byRef(ref);
    if (variable !== undefined) return { kind: 'variable', id: variable.id };
    const questionId = questionIdOf(this.registry, ref);
    if (questionId !== undefined) return { kind: 'question', id: questionId };
    // Not reported here: the checker's `LGC-T016` ("a probe target does not exist") is exactly this
    // defect, and it arrives with the node's span attached. Reporting it twice would put two
    // messages in the gutter for one mistake.
    void span;
    return { kind: 'question', id: ref as unknown as QuestionId };
  }

  /* ---- calls and aggregations -------------------------------------------- */

  private call(surface: SExpr & { readonly k: 'call' }, ctx: Ctx, expect: Type | undefined): R {
    const args = surface.args;
    const arity = (min: number, max: number): boolean => {
      if (args.length >= min && args.length <= max) return true;
      this.diagnostics.push(
        rslDiagnostic(
          'RSL-0011',
          `${surface.name} takes ${min === max ? String(min) : `${String(min)} to ${String(max)}`} ` +
            `argument(s), got ${String(args.length)}.`,
          surface.span,
        ),
      );
      return false;
    };
    const at = (index: number, expected?: Type): Expr => {
      const arg = args[index];
      return arg === undefined
        ? this.mk(ctx.b.nullLit(), surface.span, ctx)
        : this.expr(arg, ctx, expected).expr;
    };

    switch (surface.name) {
      /* ---- strings ----------------------------------------------------- */
      case 'CONCAT': {
        arity(1, 64);
        const node = ctx.b.concat(...args.map((_, index) => at(index, T_TEXT)));
        return { expr: this.mk(node, surface.span, ctx), type: T_TEXT };
      }
      case 'LEN':
      case 'LOWER':
      case 'UPPER':
      case 'TRIM':
      case 'WORD_COUNT': {
        arity(1, 1);
        const op = surface.name === 'WORD_COUNT' ? 'word_count' : (surface.name.toLowerCase() as 'len' | 'lower' | 'upper' | 'trim');
        const node = ctx.b.strUnary(op, at(0, T_TEXT));
        const type = op === 'len' || op === 'word_count' ? T_NUM : T_TEXT;
        return { expr: this.mk(node, surface.span, ctx), type };
      }
      case 'STARTS_WITH':
      case 'ENDS_WITH':
      case 'STR_CONTAINS':
      case 'SPLIT_COUNT': {
        arity(2, 2);
        const op = surface.name.toLowerCase() as 'starts_with' | 'ends_with' | 'str_contains' | 'split_count';
        const node = ctx.b.strBinary(op, at(0, T_TEXT), at(1, T_TEXT));
        return { expr: this.mk(node, surface.span, ctx), type: op === 'split_count' ? T_NUM : T_BOOL };
      }
      case 'MATCHES': {
        arity(2, 3);
        const pattern = literalString(args[1]);
        const flags = literalString(args[2]);
        if (pattern === undefined) {
          this.diagnostics.push(
            rslDiagnostic(
              'RSL-0011',
              'MATCHES takes a literal pattern: `MATCHES(OE, "^[A-Z]{2}$")`. D §2.3 allows a ' +
                'literal pattern only, so that the compiler can prove it is linear-time (LGC-T025) ' +
                'rather than discovering a catastrophic backtrack in field.',
              surface.span,
            ),
          );
        }
        const node = ctx.b.matches(at(0, T_TEXT), pattern ?? '', flags);
        return { expr: this.mk(node, surface.span, ctx), type: T_BOOL };
      }
      case 'SUBSTR': {
        arity(2, 3);
        const node = ctx.b.substr(at(0, T_TEXT), at(1, T_NUM), args.length > 2 ? at(2, T_NUM) : undefined);
        return { expr: this.mk(node, surface.span, ctx), type: T_TEXT };
      }
      /* ---- arithmetic --------------------------------------------------- */
      case 'ABS':
      case 'FLOOR':
      case 'CEIL': {
        arity(1, 1);
        const node = ctx.b.unArith(surface.name.toLowerCase() as 'abs' | 'floor' | 'ceil', at(0, T_NUM));
        return { expr: this.mk(node, surface.span, ctx), type: T_NUM };
      }
      case 'ROUND': {
        arity(2, 2);
        return { expr: this.mk(ctx.b.round(at(0, T_NUM), at(1, T_NUM)), surface.span, ctx), type: T_NUM };
      }
      case 'POW': {
        arity(2, 2);
        return { expr: this.mk(ctx.b.binArith('pow', at(0, T_NUM), at(1, T_NUM)), surface.span, ctx), type: T_NUM };
      }
      case 'MOD': {
        arity(2, 2);
        return { expr: this.mk(ctx.b.binArith('mod', at(0, T_NUM), at(1, T_NUM)), surface.span, ctx), type: T_NUM };
      }
      case 'MIN':
      case 'MAX': {
        arity(1, 64);
        const node = ctx.b.nAryArith(
          surface.name.toLowerCase() as 'min' | 'max',
          ...args.map((_, index) => at(index, T_NUM)),
        );
        return { expr: this.mk(node, surface.span, ctx), type: T_NUM };
      }
      case 'CLAMP': {
        arity(3, 3);
        const node = ctx.b.nAryArith('clamp', at(0, T_NUM), at(1, T_NUM), at(2, T_NUM));
        return { expr: this.mk(node, surface.span, ctx), type: T_NUM };
      }
      /* ---- sets --------------------------------------------------------- */
      case 'UNION':
      case 'INTERSECT':
      case 'DIFFERENCE':
      case 'SET_EQ':
      case 'SUBSET_OF': {
        arity(2, 2);
        const op =
          surface.name === 'SET_EQ'
            ? 'set_eq'
            : surface.name === 'SUBSET_OF'
              ? 'subset_of'
              : (surface.name.toLowerCase() as 'union' | 'intersect' | 'difference');
        const leftArg = args[0];
        const rightArg = args[1];
        if (leftArg === undefined || rightArg === undefined) {
          return { expr: this.mk(ctx.b.nullLit(), surface.span, ctx), type: T_NEVER };
        }
        const [left, right] = this.setOperands(op, leftArg, rightArg, ctx);
        const node = ctx.b.setOp(op, left.expr, right.expr);
        const type: Type = op === 'set_eq' || op === 'subset_of' ? T_BOOL : left.type;
        return { expr: this.mk(node, surface.span, ctx), type };
      }
      /* ---- dates -------------------------------------------------------- */
      case 'DATE_DIFF': {
        arity(3, 3);
        const unit = unitOf(args[0], ['day', 'month', 'year', 'hour', 'minute', 'second']);
        if (unit === undefined) this.badUnit(surface.span, 'DATE_DIFF', 'day, month, year, hour, minute, second');
        const node = ctx.b.dateDiff(unit ?? 'day', at(1, T_DATE), at(2, T_DATE));
        return { expr: this.mk(node, surface.span, ctx), type: T_NUM };
      }
      case 'DATE_ADD': {
        arity(3, 3);
        const unit = unitOf(args[0], ['day', 'month', 'year']);
        if (unit === undefined) this.badUnit(surface.span, 'DATE_ADD', 'day, month, year');
        const node = ctx.b.dateAdd((unit ?? 'day') as 'day' | 'month' | 'year', at(1, T_DATE), at(2, T_NUM));
        return { expr: this.mk(node, surface.span, ctx), type: T_DATE };
      }
      case 'DATE_PART': {
        arity(2, 2);
        const part = unitOf(args[0], ['year', 'month', 'day', 'dow', 'hour']);
        if (part === undefined) this.badUnit(surface.span, 'DATE_PART', 'year, month, day, dow, hour');
        const node = ctx.b.datePart((part ?? 'year') as 'year' | 'month' | 'day' | 'dow' | 'hour', at(1, T_DATE));
        return { expr: this.mk(node, surface.span, ctx), type: T_NUM };
      }
      case 'DATE_TRUNC': {
        arity(2, 2);
        const unit = unitOf(args[0], ['day', 'month', 'year']);
        if (unit === undefined) this.badUnit(surface.span, 'DATE_TRUNC', 'day, month, year');
        const node = ctx.b.dateTrunc((unit ?? 'day') as 'day' | 'month' | 'year', at(1, T_DATE));
        return { expr: this.mk(node, surface.span, ctx), type: T_DATE };
      }
      /* ---- conditionals ------------------------------------------------- */
      case 'COALESCE': {
        arity(1, 64);
        const resolved = args.map((arg) => this.expr(arg, ctx, expect));
        // The type is the expectation when there is one, else the first arm that resolved to
        // something. Returning `never` when there is no expectation would make a `COALESCE` on the
        // left of a comparison give the right-hand side no domain to inherit.
        const inferred = resolved.find((r) => r.type.k !== 'never')?.type;
        return {
          expr: this.mk(ctx.b.coalesce(...resolved.map((r) => r.expr)), surface.span, ctx),
          type: expect ?? inferred ?? T_NEVER,
        };
      }
      case 'RECODE': {
        // `RECODE(<expr>, <question ref>)` — D §3.2's explicit cross-domain escape.
        //
        // The target is written as a QUESTION, not a domain: a domain has no name in the surface
        // syntax, it is derived from the option list a question declares, and naming the question
        // is what the author is actually thinking. The AST stores the resolved `DomainId`, so
        // renaming the question afterwards touches nothing.
        arity(2, 2);
        const targetRef = args[1];
        const ref =
          targetRef !== undefined && targetRef.k === 'path' && targetRef.attrs.length === 0
            ? targetRef.head
            : undefined;
        const questionId = ref === undefined ? undefined : questionIdOf(this.registry, ref);
        const domain = questionId === undefined ? undefined : this.registry.env.question(questionId)?.domain;
        if (domain === undefined) {
          this.diagnostics.push(
            rslDiagnostic(
              'RSL-0010',
              `RECODE's second argument must name a question with an option list; ` +
                `${ref ?? 'that expression'} is not one. The target is the question whose codes ` +
                'you are reinterpreting into, for example RECODE(Q1, Q4).',
              (targetRef ?? surface).span,
              ...(ref === undefined ? [] : [{ ref }]),
            ),
          );
          return { expr: this.mk(ctx.b.nullLit(), surface.span, ctx), type: T_NEVER };
        }
        const operand = this.expr(args[0] as never, ctx, undefined);
        const node = ctx.b.recode(operand.expr, domain);
        return {
          expr: this.mk(node, surface.span, ctx),
          type: operand.type.k === 'set' ? { k: 'set', d: domain } : { k: 'enum', d: domain },
        };
      }
      case 'LABEL_OF': {
        arity(1, 2);
        // `SHORT` is the default (`exprEq` compares `form ?? 'short'`), so it is normalized away:
        // carrying it would make a DSL-authored `LABEL_OF(X, SHORT)` structurally distinct from a
        // builder-authored `label_of` with no form, and they are the same node.
        const form = unitOf(args[1], ['short', 'long']);
        const node = ctx.b.labelOf(at(0, undefined), form === 'long' ? 'long' : undefined);
        return { expr: this.mk(node, surface.span, ctx), type: T_TEXT };
      }
      default:
        this.diagnostics.push(
          rslDiagnostic(
            'RSL-0010',
            `Unknown function ${surface.name}. ResScript has no user-defined functions (D §7.1): ` +
              'every function is a node kind in the AST, because a function the visual builder ' +
              'cannot draw would make code mode one-way.',
            surface.nameSpan,
            { name: surface.name },
          ),
        );
        return { expr: this.mk(ctx.b.nullLit(), surface.span, ctx), type: T_NEVER };
    }
  }

  private badUnit(span: Span, fn: string, expected: string): void {
    this.diagnostics.push(
      rslDiagnostic('RSL-0001', `${fn}'s first argument must be one of: ${expected}.`, span),
    );
  }

  private agg(surface: SExpr & { readonly k: 'agg' }, ctx: Ctx): R {
    const group = this.group(surface.group);
    const items = this.registry.env.groupItems(group);
    const elem = groupElementType(group, items, this.registry.env);
    const binding: ItemBinding = { elem, meta: metaTypes(items) };

    const previous = ctx.item;
    ctx.item = binding;
    const where = surface.where === undefined ? undefined : this.expr(surface.where, ctx, T_BOOL).expr;
    const select = surface.select === undefined ? undefined : this.expr(surface.select, ctx, undefined);
    ctx.item = previous;

    const node = ctx.b.agg({
      fn: surface.fn as AggFn,
      over: group,
      ...(where === undefined ? {} : { where }),
      ...(select === undefined ? {} : { select: select.expr }),
      ...(surface.nulls === undefined ? {} : { nulls: surface.nulls }),
    });
    return { expr: this.mk(node, surface.span, ctx), type: aggType(surface.fn, select?.type ?? elem) };
  }

  private group(surface: SGroup): Group {
    switch (surface.g) {
      case 'vars': {
        const ids: VariableId[] = [];
        for (const entry of surface.refs) {
          const decl = this.registry.env.byRef(entry.ref);
          if (decl === undefined) {
            this.error('LGC-T001', `Unknown variable ${JSON.stringify(entry.ref)} in a group list.`, entry.span, {
              ref: entry.ref,
            });
            continue;
          }
          ids.push(decl.id);
        }
        return { kind: 'explicit', variable_ids: ids };
      }
      case 'axis': {
        const questionId = questionIdOf(this.registry, surface.ref);
        if (questionId === undefined) {
          this.error(
            'LGC-T001',
            `Unknown question ${JSON.stringify(surface.ref)} in an aggregation group.`,
            surface.span,
            { ref: surface.ref },
          );
          return { kind: 'explicit', variable_ids: [] };
        }
        switch (surface.axis) {
          case 'options':
            return { kind: 'options', question_id: questionId };
          case 'rows':
            return surface.at?.axis === 'column'
              ? { kind: 'matrix_rows', question_id: questionId, column_ref: surface.at.ref }
              : { kind: 'matrix_rows', question_id: questionId };
          case 'columns':
            return surface.at?.axis === 'row'
              ? { kind: 'matrix_cols', question_id: questionId, row_ref: surface.at.ref }
              : { kind: 'matrix_cols', question_id: questionId };
          default:
            // D §2.3's `loop_iterations` carries both a question id and a loop id; logic's `LoopId`
            // is the loop-owning question's id (schema has no loop prefix), so both are the same
            // ref here. Loops are P2-02; the group form exists so the AST kind has a production.
            return { kind: 'loop_iterations', question_id: questionId, loop_id: questionId };
        }
      }
      default: {
        const questionId = questionIdOf(this.registry, surface.ref);
        if (questionId !== undefined) return { kind: 'question_emits', question_id: questionId };
        const decl = this.registry.env.byRef(surface.ref);
        if (decl !== undefined) return { kind: 'explicit', variable_ids: [decl.id] };
        this.diagnostics.push(
          rslDiagnostic(
            'RSL-0020',
            `${JSON.stringify(surface.ref)} is neither a question nor a variable, so it cannot be an ` +
              'aggregation group. Use a question ref, a variable list `[A, B]`, or ' +
              'OPTIONS/ROWS/COLUMNS/ITERATIONS OF <question>.',
            surface.span,
            { ref: surface.ref },
          ),
        );
        return { kind: 'explicit', variable_ids: [] };
      }
    }
  }

  /* ---- the document-order forward reference ------------------------------ */

  /**
   * LGC-F001 within one source file, and nothing more.
   *
   * D §8.1 is emphatic that the real analysis is a *dominance* query over the flow graph, not a
   * document-order comparison, "because document order is wrong the moment there is a branch". That
   * analysis needs `graph.json` and belongs to the compiler (P1-08).
   *
   * What is decidable here is narrower and still worth having: within a single ResScript document,
   * a rule that reads a variable emitted by a `QUESTION` defined *later in the same document* is a
   * forward reference, because a DSL document expresses no branches — its order *is* its flow. That
   * is the exact defect the week-12 demo turns on ("Rule R14 on Q41 reads Q52, asked later"), and
   * catching it as you type is the whole point of running the checker in the editor.
   *
   * Deliberately not claimed: anything about variables whose emitting question is not in this
   * document. Those get no diagnostic here at all, rather than a guess.
   */
  forwardReferences(): void {
    if (this.definedAt.size === 0) return;

    for (const [index, reads] of this.readsByStatement) {
      const spans = this.spansByStatement.get(index);
      for (const read of reads) {
        const definition = this.definedAt.get(read.variable);
        if (definition === undefined || definition <= index) continue;
        const decl = this.registry.env.byId(read.variable);
        const owner = decl === undefined ? undefined : this.registry.env.ownerQuestion(decl.id);
        const span = spans?.get(read.node);
        this.diagnostics.push({
          code: 'LGC-F001',
          severity: 'error',
          message:
            `Forward reference: this statement reads ${decl?.name ?? read.variable}, which is ` +
            `collected by ${owner?.ref ?? 'a question'} defined later in this document. On every ` +
            'path the value is UNKNOWN when the rule evaluates, and UNKNOWN collapses to "do not ' +
            'fire" (D §2.5). Move the question earlier, or the rule later.',
          path: '',
          ...(span === undefined ? {} : { span }),
          detail: {
            variable: read.variable,
            ...(owner === undefined ? {} : { question: owner.ref }),
            reads_at: index,
            set_at: definition,
          },
        });
      }
    }
  }
}

/* ========================================================================== */
/* Helpers                                                                    */
/* ========================================================================== */

const ZERO_SPAN: Span = { start: 0, end: 0, line: 1, col: 1 };

function mergeTrivia(
  parsed: Trivia | undefined,
  ctx: Ctx,
  resolved: Statement<Expr>,
): Trivia | undefined {
  const symbolic: { [nodeId: string]: string } = {};
  for (const [node, text] of ctx.symbolic) symbolic[String(node)] = text;
  // Only the *redundant* parentheses become hints — see `prunedParenHints` for why keeping the
  // structural ones would break T1 for every builder-authored rule with a nested OR.
  const hints = prunedParenHints(statementExprs(resolved), [...new Set(ctx.parens)]);
  const merged: Trivia = {
    ...(parsed ?? {}),
    ...(Object.keys(symbolic).length === 0 ? {} : { symbolic_refs: symbolic }),
    ...(hints.length === 0 ? {} : { paren_hints: hints }),
  };
  return Object.keys(merged).length === 0 ? undefined : merged;
}

/**
 * True when this expression's *type* cannot be known without an expected type from its context.
 *
 * The resolver uses it to decide which side of a comparison to resolve first: `S1 = 1` needs `S1`
 * resolved before `1` can be known to be `enum<dom_s1>`, and `1 = S1` needs the reverse.
 *
 * It has to look *through* the constructs that inherit an expectation, not just at the top node:
 * `COALESCE(1, 2) = Q9` needs the right side resolved first, because the coalesce's arms take their
 * type from the same expectation the coalesce does. Checking only the top node made
 * `COALESCE(1, 2)` look self-determining and produced a `num` coalesce compared to an enum — found
 * by property P6.
 *
 * A code list is self-determining when any element is symbolic (`[Q5.Apple, 3]` carries its domain),
 * which is also how the printer anchors a list that would otherwise lose it.
 */
function needsContext(surface: SExpr): boolean {
  switch (surface.k) {
    case 'paren':
      return needsContext(surface.inner);
    case 'num':
      return true;
    case 'codes':
      return !surface.items.some((item) => item.k === 'path' && item.attrs.length === 1);
    case 'case':
      return surface.cases.some((arm) => needsContext(arm.then)) || needsContext(surface.otherwise);
    case 'call':
      return surface.name === 'COALESCE' && surface.args.some((arg) => needsContext(arg));
    default:
      return false;
  }
}

/** The enum domain a type carries, whether it is an element type or a set type. */
function domainOf(type: Type): ReturnType<typeof asDomainId> | undefined {
  return type.k === 'enum' || type.k === 'set' ? type.d : undefined;
}

function literalString(surface: SExpr | undefined): string | undefined {
  if (surface === undefined) return undefined;
  return surface.k === 'str' ? surface.value : undefined;
}

/** A bare identifier argument used as an enumerated keyword (`DATE_DIFF(YEAR, …)`). */
function unitOf<T extends string>(surface: SExpr | undefined, allowed: readonly T[]): T | undefined {
  if (surface === undefined || surface.k !== 'path' || surface.attrs.length > 0) return undefined;
  const lower = surface.head.toLowerCase();
  return allowed.find((option) => option === lower);
}

function castType(to: 'num' | 'text' | 'date' | 'bool'): Type {
  switch (to) {
    case 'num':
      return T_NUM;
    case 'text':
      return T_TEXT;
    case 'date':
      return T_DATE;
    default:
      return T_BOOL;
  }
}

/** The result type of an aggregation — D §3.3's table, only as far as domain placement needs it. */
function aggType(fn: string, projected: Type): Type {
  switch (fn) {
    case 'count':
    case 'distinct_count':
    case 'sum':
    case 'mean':
    case 'stdev':
      return T_NUM;
    case 'any':
    case 'all':
      return T_BOOL;
    default:
      return projected;
  }
}

function metaTypes(items: readonly { readonly meta?: { readonly [key: string]: string | number | boolean | null } }[]): {
  readonly [key: string]: Type;
} {
  const out: { [key: string]: Type } = {};
  for (const item of items) {
    if (item.meta === undefined) continue;
    for (const key of Object.keys(item.meta)) {
      const raw = item.meta[key];
      out[key] = typeof raw === 'number' ? T_NUM : typeof raw === 'boolean' ? T_BOOL : typeof raw === 'string' ? T_TEXT : T_NEVER;
    }
  }
  return out;
}

/**
 * The `item` binding for a per-item mask or option predicate.
 *
 * It is built from the question's item declarations rather than from a `Group`, because D §2.3's
 * `Group` union has no member for "the rows of this question as *items*" — `matrix_rows` resolves
 * to variables. A per-item mask on rows iterates row declarations, so the binding is assembled here.
 */
function itemBindingFor(
  question: QuestionDecl | undefined,
  axis: 'options' | 'rows' | 'columns',
): ItemBinding {
  if (question === undefined) return { elem: T_NEVER, meta: {} };
  const items = axis === 'options' ? question.options : axis === 'rows' ? question.rows : question.columns;
  const elem: Type = question.domain === undefined ? T_NEVER : { k: 'enum', d: question.domain };
  return { elem, meta: metaTypes(items) };
}
