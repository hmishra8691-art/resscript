/**
 * The DSL statement AST — the round-trip unit.
 *
 * ## Why statements are not `logic.Rule`s
 *
 * `IF … THEN SHOW Q12 AND SET HEAVY_BUYER = TRUE ELSE HIDE Q12` is **one** statement and, per
 * D §9.3, *three* `Rule`s: "`THEN … AND …` with an `ELSE` desugars to one rule per effect cell",
 * and the ELSE branch folds into the same `visible` cell rather than producing a second competing
 * writer (D §4.6). D §9.3 then says "the compiler records the desugaring so the printer
 * reconstructs the `IF/THEN/ELSE` form exactly (§6.4 T1)".
 *
 * This file is that record. The statement keeps the author's grouping — one condition, an ordered
 * effect list, an optional else list — and the *conditions and values* inside it are
 * `packages/logic` `Expr`s, resolved to ids and annotated with types. Desugaring a statement into
 * `Rule[]` needs a rule-id source, an `order_key` allocator and a flow node, none of which the DSL
 * knows; that is `packages/compiler`'s job (P1-08). Keeping the statement as the round-trip unit is
 * what makes T1 provable at all: a `Rule[]` has thrown the grouping away, so no printer could
 * reconstruct it.
 *
 * ## Why the type is generic in its expression
 *
 * The parser produces `Statement<SExpr>` — surface expressions, where `[1, 3]` is a bare code list
 * with no domain and `Q1.Yes` is an unresolved dotted path. The resolver produces
 * `Statement<Expr>`. Both phases share one set of statement shapes, because two parallel unions
 * would drift and the drift would only show up as a printer that cannot print what the parser
 * parsed.
 */

import type { Disposition, Expr, NodeId, PageId, BlockId, QuestionId, VariableId } from '@resscript/logic';
import { mapChildren, walkExpr } from '@resscript/logic';
import type { Span } from './diagnostics.js';

/* ========================================================================== */
/* Trivia — D §6.4, verbatim                                                  */
/* ========================================================================== */

/**
 * D §6.4's `Trivia`, field for field.
 *
 * It lives on the **statement**, never inside the expression tree, so it does not participate in
 * structural equality for T1 and does not affect evaluation. That placement is the whole reason
 * comments can be preserved without making two structurally identical rules unequal.
 *
 * `symbolic_refs` and `paren_hints` are keyed by node id, which means any pass that renumbers node
 * ids has to remap them — see `canonicalStatement`. That coupling is the price of D's chosen shape;
 * the alternative (trivia inline on nodes) would break T1.
 */
export interface Trivia {
  /** Comment lines above the statement, verbatim, including the author's marker. */
  readonly leading?: readonly string[];
  /** End-of-line comment, verbatim. */
  readonly trailing?: string;
  /** 0 | 1 | 2, capped — preserves visual grouping without preserving accidents. */
  readonly blank_before?: number;
  /** `"Q1.Yes"` vs `"1"`: the author's choice, keyed by the enum literal's node id. */
  readonly symbolic_refs?: { readonly [nodeId: string]: string };
  /** Parens the author wrote that the printer would otherwise drop. */
  readonly paren_hints?: readonly NodeId[];
}

export const EMPTY_TRIVIA: Trivia = {};

export function triviaIsEmpty(trivia: Trivia | undefined): boolean {
  if (trivia === undefined) return true;
  return (
    (trivia.leading?.length ?? 0) === 0 &&
    trivia.trailing === undefined &&
    (trivia.blank_before ?? 0) === 0 &&
    Object.keys(trivia.symbolic_refs ?? {}).length === 0 &&
    (trivia.paren_hints?.length ?? 0) === 0
  );
}

/* ========================================================================== */
/* References                                                                 */
/* ========================================================================== */

/**
 * A reference to a content node, as written plus as resolved.
 *
 * `ref` is what the author typed; `id` is what it resolved to. The printer prints the *current*
 * ref of `id` when it has one — that is the entire rename story (schema §3): renaming `Q1` to `S1`
 * changes the text the code pane shows without touching a stored AST.
 *
 * `id` is optional and frequently absent for pages and blocks, and that is not laziness: logic's
 * `PageDecl` and `BlockDecl` carry no `ref` field (only `QuestionDecl` does), so a type environment
 * alone cannot resolve `SKIP TO P7`. A caller with the content tree supplies a `NodeIndex`
 * (see registry.ts) and then it can. Reported as a gap rather than worked around.
 */
export interface NodeRef {
  readonly ref: string;
  readonly id?: QuestionId | PageId | BlockId;
  readonly kind?: 'question' | 'page' | 'block';
  /**
   * Set when the author wrote a `QUESTION`/`PAGE`/`BLOCK` keyword before the ref, which the printer
   * must reproduce.
   *
   * `QUESTION` exists for one reason: `ANSWERED(Q12)` is ambiguous. A scalar question emits a
   * variable with the *same* name as its own ref (schema §1: `Q1` single-select → variable `Q1`), and
   * D §2.3's `Probe.target` distinguishes `{kind:'variable'}` from `{kind:'question'}`. D §6.2 gives
   * no syntax for saying which, so a bare ref has to pick one — variable, since that is what a
   * condition normally means — and `ANSWERED(QUESTION Q12)` is how an author asks about the question
   * itself. Reported as an under-specification.
   */
  readonly explicit?: 'question' | 'page' | 'block';
  readonly span?: Span;
}

export interface VarName {
  readonly ref: string;
  readonly id?: VariableId;
  readonly span?: Span;
}

/* ========================================================================== */
/* Shared clause shapes                                                       */
/* ========================================================================== */

/** A literal in a non-expression position (`META brand_id = 7`). */
export type DslLiteral =
  | { readonly k: 'num'; readonly v: number }
  | { readonly k: 'text'; readonly v: string }
  | { readonly k: 'bool'; readonly v: boolean }
  | { readonly k: 'date'; readonly v: string }
  | { readonly k: 'null' };

export type OptionFlag<E> =
  | { readonly f: 'exclusive' }
  | { readonly f: 'anchor'; readonly at: 'first' | 'last' | 'fixed'; readonly position?: number }
  | { readonly f: 'specify'; readonly text: boolean }
  | { readonly f: 'meta'; readonly key: string; readonly value: DslLiteral }
  | { readonly f: 'visible_if' | 'enabled_if' | 'autoselect_if'; readonly condition: E }
  | { readonly f: 'preselect'; readonly condition?: E };

export interface OptionDef<E> {
  readonly code: number;
  readonly label: string;
  readonly flags: readonly OptionFlag<E>[];
  readonly span?: Span;
}

export type ValidateRule<E> =
  | {
      readonly v: 'select';
      readonly bound: 'at_least' | 'at_most' | 'exactly';
      readonly n: number;
      readonly message?: string;
    }
  | { readonly v: 'sum'; readonly of?: readonly VarName[]; readonly value: number; readonly message?: string }
  | { readonly v: 'range'; readonly lo: number; readonly hi: number; readonly message?: string }
  | { readonly v: 'matches'; readonly pattern: string; readonly message?: string }
  | { readonly v: 'require'; readonly condition: E; readonly message?: string };

/**
 * What a `RANDOMIZE` applies to.
 *
 * `self` is the form D §6.3 uses inside a question definition — `RANDOMIZE OPTIONS KEEP OPTION 97,
 * 99 LAST GROUP fruit_list`, with no ref, because the target is the question being defined. D §6.2's
 * `rand_target` production has no such form (it always names a ref), and its `question_clause` list
 * names a `randomize_clause` it never defines. Reported; `self` is the reading that makes §6.3
 * parse.
 */
export type RandTarget =
  | { readonly t: 'node'; readonly ref: NodeRef; readonly axis?: 'options' | 'rows' | 'columns' }
  | { readonly t: 'self'; readonly axis?: 'options' | 'rows' | 'columns' }
  | { readonly t: 'children' };

export type RandModifier =
  | {
      readonly m: 'keep';
      readonly axis: 'option' | 'row' | 'column';
      readonly codes: readonly number[];
      readonly at: 'first' | 'last' | 'in_place';
    }
  | { readonly m: 'subset'; readonly n: number }
  | { readonly m: 'group'; readonly name: string }
  | { readonly m: 'subblocks'; readonly sizes: readonly number[] }
  | { readonly m: 'evenly' }
  | { readonly m: 'rotate' };

export interface RandomizeSpec {
  readonly target: RandTarget;
  readonly modifiers: readonly RandModifier[];
}

export type MaskSource<E> =
  | { readonly src: 'selected_in'; readonly variable: VarName; readonly negated: boolean }
  | { readonly src: 'codes'; readonly codes: readonly number[] }
  | { readonly src: 'where'; readonly condition: E };

export interface MaskSpec<E> {
  /** Absent when the mask is a clause inside a `QUESTION` block, present for `MASK Q6 …`. */
  readonly target?: NodeRef;
  readonly axis: 'options' | 'rows' | 'columns';
  readonly mode: 'include' | 'exclude';
  readonly source: MaskSource<E>;
  /** No default, ever. schema §15: the empty-question dead end is worth a required field. */
  readonly when_empty: 'skip' | 'show_all' | 'terminate';
}

export interface PipeSpec {
  readonly into: NodeRef;
  readonly from: NodeRef;
  readonly as?: 'label' | 'code' | 'list';
}

export interface ActionTarget<E> {
  readonly ref: NodeRef;
  readonly axis?: 'option' | 'row' | 'column';
  readonly codes?: readonly number[];
  /** `HIDE Q3 OPTION WHERE item.meta.discontinued = TRUE` — a per-item predicate. */
  readonly where?: E;
}

export type Action<E> =
  | { readonly a: 'show' | 'hide' | 'disable' | 'enable' | 'preselect'; readonly target: ActionTarget<E> }
  | { readonly a: 'skip_to' | 'skip'; readonly ref: NodeRef }
  | { readonly a: 'terminate'; readonly disposition?: Disposition; readonly custom?: string }
  | { readonly a: 'set'; readonly variable: VarName; readonly value: E }
  | { readonly a: 'require' | 'unrequire'; readonly ref: NodeRef }
  | { readonly a: 'flag'; readonly variable: VarName };

/* ========================================================================== */
/* Statements                                                                 */
/* ========================================================================== */

interface StatementBase {
  readonly trivia?: Trivia;
  readonly span?: Span;
}

export interface QuestionDef<E> extends StatementBase {
  readonly s: 'question';
  readonly ref: NodeRef;
  readonly qtype?: string;
  readonly label?: string;
  readonly instruction?: string;
  /** `true` = REQUIRED, `false` = OPTIONAL, absent = the author said nothing. */
  readonly required?: boolean;
  readonly options?: readonly OptionDef<E>[];
  readonly rows?: readonly OptionDef<E>[];
  readonly columns?: readonly OptionDef<E>[];
  readonly validate?: readonly ValidateRule<E>[];
  readonly randomize?: readonly RandomizeSpec[];
  readonly masks?: readonly MaskSpec<E>[];
  readonly pipes?: readonly PipeSpec[];
}

/**
 * `BLOCK` and `PAGE`.
 *
 * D §6.2 lists `block_def | page_def` in `statement` and then never defines either production —
 * the EBNF sketch defines `question_def` in full and stops. The form here is the defensible
 * completion: the same `<KEYWORD> <ref> … END` shape as `question_def`, an optional `LABEL`, an
 * optional `RANDOMIZE CHILDREN …` (schema §5's `settings.randomize_children`, which is the only
 * block/page setting the P1-07 grammar surface needs), and nested statements. Reported as an
 * under-specification.
 */
export interface ContainerDef<E> extends StatementBase {
  readonly s: 'block' | 'page';
  readonly ref: NodeRef;
  readonly label?: string;
  readonly randomize?: readonly RandomizeSpec[];
  readonly children: readonly Statement<E>[];
}

export interface RuleStmt<E> extends StatementBase {
  readonly s: 'rule';
  readonly condition: E;
  /**
   * D §6.2 offers four spellings — `SHOW | HIDE | FIRE | SKIP` — for what D §4.1 stores as one
   * bit (`on_unknown: 'default' | 'fire'`). All four mean "fire on UNKNOWN"; the word merely
   * echoes the effect. Kept verbatim so the round trip is exact, and reported.
   */
  readonly on_unknown?: 'SHOW' | 'HIDE' | 'FIRE' | 'SKIP';
  readonly then: readonly Action<E>[];
  readonly otherwise?: readonly Action<E>[];
}

/**
 * A bare action with no `IF` — `HIDE Q3 OPTION 4`, straight out of D §6.3.
 *
 * D §6.2's `statement` production does not include one; D §6.3 uses three of them. Modelled as
 * its own statement kind rather than as a `RuleStmt` with a `TRUE` condition, because printing it
 * back as `IF TRUE THEN HIDE Q3 OPTION 4` would be a normalization T2 does not license and would
 * make the §6.3 corpus fail its own round trip. The compiler turns it into a rule with a constant
 * condition. Reported as a contradiction between §6.2 and §6.3.
 */
export interface ActionStmt<E> extends StatementBase {
  readonly s: 'action';
  /**
   * `set` and `terminate` are excluded, and the exclusion is load-bearing rather than tidy.
   *
   * `SET X = 1` and `TERMINATE AS SCREENOUT` are statements in their own right (D §6.2's `set_stmt`
   * and `terminate_stmt`), so allowing them here too would give one piece of text two AST shapes —
   * and T1 (`parse(print(a)) ≡ a`) is false for whichever shape the parser does not choose. Found by
   * property P1, which is exactly the kind of ambiguity it exists to find; closed in the type system
   * so it cannot come back.
   */
  readonly action: Exclude<Action<E>, { readonly a: 'set' } | { readonly a: 'terminate' }>;
  /** `HIDE Q3 OPTION 4 IF SEGMENT = "old"` — D §4.3's R4 form: an action with a trailing IF. */
  readonly condition?: E;
}

export interface SetStmt<E> extends StatementBase {
  readonly s: 'set';
  readonly variable: VarName;
  readonly value: E;
}

export interface TerminateStmt<E> extends StatementBase {
  readonly s: 'terminate';
  readonly disposition?: Disposition;
  readonly custom?: string;
  readonly condition?: E;
}

export interface RandomizeStmt extends StatementBase {
  readonly s: 'randomize';
  readonly spec: RandomizeSpec;
}

export interface MaskStmt<E> extends StatementBase {
  readonly s: 'mask';
  readonly spec: MaskSpec<E>;
}

export interface PipeStmt extends StatementBase {
  readonly s: 'pipe';
  readonly spec: PipeSpec;
}

export interface PriorityGroupStmt<E> extends StatementBase {
  readonly s: 'priority_group';
  readonly name: string;
  readonly statements: readonly Statement<E>[];
}

/**
 * A construct the grammar has but this milestone does not implement — today, exactly `QUOTA`
 * (P2-06).
 *
 * The author's text is kept verbatim and printed back verbatim. That is deliberate: the brief says
 * a deferred construct must be "reject[ed] with a clear diagnostic rather than mis-pars[ed]", and
 * the worst possible reading of "reject" is "delete the user's quota plan on format-on-save".
 */
export interface UnsupportedStmt extends StatementBase {
  readonly s: 'unsupported';
  readonly keyword: string;
  readonly raw: string;
}

/** An unparseable region. Its text is preserved for the same reason `UnsupportedStmt`'s is. */
export interface ErrorStmt extends StatementBase {
  readonly s: 'error';
  readonly raw: string;
}

export type Statement<E = Expr> =
  | QuestionDef<E>
  | ContainerDef<E>
  | RuleStmt<E>
  | ActionStmt<E>
  | SetStmt<E>
  | TerminateStmt<E>
  | RandomizeStmt
  | MaskStmt<E>
  | PipeStmt
  | PriorityGroupStmt<E>
  | UnsupportedStmt
  | ErrorStmt;

export type StatementKind = Statement<never>['s'];

export interface Program<E = Expr> {
  readonly statements: readonly Statement<E>[];
}

/* ========================================================================== */
/* Mapping over the expressions of a statement                                */
/* ========================================================================== */

/**
 * Rewrite every expression in a statement, in a fixed traversal order.
 *
 * The order is load-bearing, not incidental: `canonicalStatement` renumbers node ids through this
 * traversal and remaps `symbolic_refs` / `paren_hints` against the result, so two structurally
 * equal statements must visit their expressions in the same sequence or T1 would compare trivia
 * maps keyed by different numbers. Changing the order here changes what "the same statement" means.
 */
/**
 * Re-attach an expression type parameter that an object spread erased.
 *
 * `{ ...statement, condition: f(statement.condition) }` does not have type `Statement<B>` under
 * `exactOptionalPropertyTypes`, even when every expression-bearing field has been rewritten: the
 * spread carries the *old* parameter on each optional field it copied, and TypeScript cannot relate
 * `Statement<A>` to `Statement<B>` for unrelated `A`/`B`.
 *
 * The honest alternative is to rebuild every statement field by field at each of the dozen call
 * sites, which is a lot of boilerplate whose bugs (a dropped optional field) are exactly the bugs
 * the round-trip property tests would catch anyway. So there is one documented escape hatch instead
 * of a dozen inline casts, and the invariant it depends on is stated once: **the caller must have
 * rewritten every field that carries an expression.** `statementExprs` walks the same traversal, so
 * a missed field shows up as an expression the resolver never resolved — a surface node reaching the
 * printer, which throws rather than printing nonsense.
 */
export function reparameterize<T>(value: object): T {
  return value as T;
}

export function mapStatementExprs<A, B>(statement: Statement<A>, f: (expr: A) => B): Statement<B> {
  switch (statement.s) {
    case 'question':
      return reparameterize<Statement<B>>({
        ...statement,
        ...(statement.options === undefined ? {} : { options: statement.options.map((o) => mapOption(o, f)) }),
        ...(statement.rows === undefined ? {} : { rows: statement.rows.map((o) => mapOption(o, f)) }),
        ...(statement.columns === undefined ? {} : { columns: statement.columns.map((o) => mapOption(o, f)) }),
        ...(statement.validate === undefined
          ? {}
          : { validate: statement.validate.map((v) => mapValidate(v, f)) }),
        ...(statement.masks === undefined ? {} : { masks: statement.masks.map((m) => mapMask(m, f)) }),
      });
    case 'block':
    case 'page':
      return reparameterize<Statement<B>>({
        ...statement,
        children: statement.children.map((child) => mapStatementExprs(child, f)),
      });
    case 'rule':
      return reparameterize<Statement<B>>({
        ...statement,
        condition: f(statement.condition),
        then: statement.then.map((a) => mapAction(a, f)),
        ...(statement.otherwise === undefined
          ? {}
          : { otherwise: statement.otherwise.map((a) => mapAction(a, f)) }),
      });
    case 'action':
      return reparameterize<Statement<B>>({
        ...statement,
        action: mapAction(statement.action, f),
        ...(statement.condition === undefined ? {} : { condition: f(statement.condition) }),
      });
    case 'set':
      return reparameterize<Statement<B>>({ ...statement, value: f(statement.value) });
    case 'terminate':
      return reparameterize<Statement<B>>({
        ...statement,
        ...(statement.condition === undefined ? {} : { condition: f(statement.condition) }),
      });
    case 'mask':
      return reparameterize<Statement<B>>({ ...statement, spec: mapMask(statement.spec, f) });
    case 'priority_group':
      return reparameterize<Statement<B>>({
        ...statement,
        statements: statement.statements.map((s) => mapStatementExprs(s, f)),
      });
    case 'randomize':
    case 'pipe':
    case 'unsupported':
    case 'error':
      return statement;
    default: {
      const never: never = statement;
      // A statement kind with no mapping would silently lose its expressions — the class of bug
      // that makes a printer drop a condition. Loud, not silent.
      throw new Error(`unhandled statement kind ${JSON.stringify(never)}`);
    }
  }
}

function mapOption<A, B>(option: OptionDef<A>, f: (expr: A) => B): OptionDef<B> {
  return { ...option, flags: option.flags.map((flag) => mapFlag(flag, f)) };
}

function mapFlag<A, B>(flag: OptionFlag<A>, f: (expr: A) => B): OptionFlag<B> {
  // Exhaustive rather than `default: return flag`: a new flag that carries a condition would be
  // passed through unmapped by a default case, which is a surface expression reaching the printer.
  switch (flag.f) {
    case 'visible_if':
    case 'enabled_if':
    case 'autoselect_if':
      return { ...flag, condition: f(flag.condition) };
    case 'preselect':
      return flag.condition === undefined ? { f: 'preselect' } : { f: 'preselect', condition: f(flag.condition) };
    case 'exclusive':
    case 'anchor':
    case 'specify':
    case 'meta':
      return flag;
    default: {
      const never: never = flag;
      throw new Error(`unhandled option flag ${JSON.stringify(never)}`);
    }
  }
}

function mapValidate<A, B>(rule: ValidateRule<A>, f: (expr: A) => B): ValidateRule<B> {
  // `require` is the only validate rule that carries an expression; the rest are closed data.
  return rule.v === 'require' ? { ...rule, condition: f(rule.condition) } : rule;
}

function mapMask<A, B>(mask: MaskSpec<A>, f: (expr: A) => B): MaskSpec<B> {
  return mask.source.src === 'where'
    ? { ...mask, source: { src: 'where', condition: f(mask.source.condition) } }
    : { ...mask, source: mask.source };
}

function mapAction<A, B>(action: Action<A>, f: (expr: A) => B): Action<B> {
  // Same cast rationale as `mapStatementExprs`.
  switch (action.a) {
    case 'show':
    case 'hide':
    case 'disable':
    case 'enable':
    case 'preselect':
      return {
        ...action,
        target:
          action.target.where === undefined
            ? reparameterize<ActionTarget<B>>({ ...action.target })
            : reparameterize<ActionTarget<B>>({ ...action.target, where: f(action.target.where) }),
      };
    case 'set':
      return { ...action, value: f(action.value) };
    case 'skip':
    case 'skip_to':
    case 'terminate':
    case 'require':
    case 'unrequire':
    case 'flag':
      return action;
    default: {
      const never: never = action;
      throw new Error(`unhandled action ${JSON.stringify(never)}`);
    }
  }
}

/** Every expression of a statement, in `mapStatementExprs` order. */
export function statementExprs<E>(statement: Statement<E>): readonly E[] {
  const out: E[] = [];
  mapStatementExprs(statement, (expr) => {
    out.push(expr);
    return expr;
  });
  return out;
}

/* ========================================================================== */
/* Canonical form — the relation `≡` of D §6.4 T1                             */
/* ========================================================================== */

/**
 * A statement in canonical form: spans dropped, cached types and compile-time group resolutions
 * dropped, node ids renumbered pre-order from 1 through the whole statement, and trivia's node-id
 * keys remapped to match.
 *
 * With that done, `≡` is plain deep equality, which is what the property tests want: `exprEq`
 * alone would compare the trees and ignore the trivia, and a hand-written statement comparator
 * would be a third definition of the AST's shape that could drift from `mapStatementExprs`.
 *
 * `t` and `resolved` are dropped because both are *derived*: the checker fills `t` (D §2.1 item 5)
 * and `resolved` (D §10.1's compile-time group resolution), so a parsed-and-checked tree carries
 * them and a hand-built one does not, while being the same tree.
 */
export function canonicalStatement(statement: Statement<Expr>): Statement<Expr> {
  let next = 1;
  const remap = new Map<NodeId, NodeId>();

  const rewrite = (expr: Expr): Expr => {
    const id = next;
    next += 1;
    remap.set(expr.n, id);
    const bare = stripDerived(expr);
    return mapChildren({ ...bare, n: id }, rewrite);
  };

  const mapped = mapStatementExprs(statement, rewrite);
  const withoutSpan = dropSpans(mapped);
  const trivia = statement.trivia;
  if (trivia === undefined || triviaIsEmpty(trivia)) {
    const { trivia: _drop, ...rest } = withoutSpan as Statement<Expr> & { trivia?: Trivia };
    void _drop;
    return rest as Statement<Expr>;
  }
  return { ...withoutSpan, trivia: remapTrivia(trivia, remap) } as Statement<Expr>;
}

/**
 * `≡` proper — D §6.4's relation for T1: canonical form with trivia removed.
 *
 * D is explicit that "trivia … does not participate in structural equality for T1", and the
 * distinction is not academic. The printer sometimes *creates* trivia: an enum literal in a position
 * where no operand can supply its domain is printed symbolically (see printer.ts's `anchor`), and
 * re-parsing that records a `symbolic_refs` entry the original tree never had. The trees are the
 * same rule; only the spelling the printer had to choose is new. T1 compares this; P4 compares the
 * trivia.
 */
export function structuralStatement(statement: Statement<Expr>): Statement<Expr> {
  const { trivia: _drop, ...rest } = canonicalStatement(statement) as Statement<Expr> & {
    trivia?: Trivia;
  };
  void _drop;
  return rest as Statement<Expr>;
}

export function canonicalProgram(program: Program): Program {
  return { statements: program.statements.map(canonicalStatement) };
}

function remapTrivia(trivia: Trivia, remap: ReadonlyMap<NodeId, NodeId>): Trivia {
  const symbolic = trivia.symbolic_refs;
  const hints = trivia.paren_hints;
  const nextSymbolic: { [nodeId: string]: string } = {};
  if (symbolic !== undefined) {
    for (const key of Object.keys(symbolic)) {
      const value = symbolic[key];
      const to = remap.get(Number(key));
      if (value !== undefined && to !== undefined) nextSymbolic[String(to)] = value;
    }
  }
  const nextHints =
    hints === undefined
      ? undefined
      : [...new Set(hints.map((n) => remap.get(n)).filter((n): n is NodeId => n !== undefined))].sort(
          (a, b) => a - b,
        );
  return {
    ...(trivia.leading === undefined ? {} : { leading: trivia.leading }),
    ...(trivia.trailing === undefined ? {} : { trailing: trivia.trailing }),
    ...((trivia.blank_before ?? 0) === 0 ? {} : { blank_before: trivia.blank_before }),
    ...(Object.keys(nextSymbolic).length === 0 ? {} : { symbolic_refs: nextSymbolic }),
    ...(nextHints === undefined || nextHints.length === 0 ? {} : { paren_hints: nextHints }),
  };
}

function stripDerived(expr: Expr): Expr {
  const copy: { [key: string]: unknown } = { ...expr };
  delete copy['t'];
  delete copy['resolved'];
  return copy as unknown as Expr;
}

/** Recursively drop `span` from a statement and its clauses. Structural, so it uses JSON shape. */
function dropSpans<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => dropSpans(item)) as unknown as T;
  if (typeof value !== 'object' || value === null) return value;
  if (isExprLike(value)) return value;
  const out: { [key: string]: unknown } = {};
  for (const key of Object.keys(value as object)) {
    if (key === 'span') continue;
    out[key] = dropSpans((value as { [key: string]: unknown })[key]);
  }
  return out as unknown as T;
}

/** Expressions are already canonicalized by `mapStatementExprs`; do not walk into them. */
function isExprLike(value: object): boolean {
  return 'op' in value && 'n' in value;
}

/** Node ids used by a statement's expressions, in traversal order. */
export function statementNodeIds(statement: Statement<Expr>): readonly NodeId[] {
  const out: NodeId[] = [];
  for (const expr of statementExprs(statement)) walkExpr(expr, (node) => out.push(node.n));
  return out;
}
