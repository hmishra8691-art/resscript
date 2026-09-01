/**
 * RENDERERS — the third leg of D §7.2's three-way closure (roadmap P1-12).
 *
 * Every AST kind is parseable (the DSL's parser), printable (its exhaustive `switch`), and —
 * this file — renderable. The enforcement is the mapped type itself: `Renderers` maps over
 * `AstKind`, so adding a kind to `AST_KINDS` without adding a renderer here is a TypeScript
 * error in this package, exactly as `ast-kinds.ts`'s header promises ("adding a kind here
 * without … a renderer (P1-12) is a build failure"). `RENDERER_REGISTRY` re-states the same
 * value in the `AstRendererRegistry` type P1-07 published for this leg, so the closure is
 * checked against the DSL package's own contract, not a local restatement of it.
 *
 * ## What a renderer is, and is not
 *
 * A renderer turns ONE node into read-only JSX, recursing through `ctx.child`. It is not an
 * editor: the condition tree editor recognizes the small editable subset (boolean groups, leaf
 * comparisons) and builds controls for those itself; everything else — an `agg`, a `case`, a
 * regex — renders here, faithfully, with "edit as code" as the affordance. That split is
 * deliberate: the closure guarantee is "every rule the parser accepts can be SHOWN in the
 * builder", not "every node has a form widget", and pretending otherwise would ship 58
 * half-tested widgets.
 *
 * Names come from `RenderCtx`, never from the AST — an AST stores ids (D §2.1 item 3), and
 * rendering `var_01H…` at a programmer is the failure the rename story exists to prevent.
 */

import type { Expr } from '@resscript/logic';
import { AST_KINDS, type AstKind } from '@resscript/logic';
import type { AstRendererRegistry } from '@resscript/rescript-dsl';

export interface RenderCtx {
  /** Current name of a variable id, or the id when unknown (the printer's own fallback). */
  variableName(id: string): string;
  /** Current ref of a node id (question/page/block), or the id. */
  nodeRef(id: string): string;
  /** Option label for `(domain, code)`, or the bare code. */
  optionLabel(domain: string, code: number): string;
  /**
   * The question ref that owns an enum domain, for `RECODE`'s target — the printer resolves the
   * same way. Optional so a caller that has no registry still renders the tree, with the bare
   * domain id where the ref would be.
   */
  questionOfDomain?(domain: string): string | undefined;
  /** Recursive render of a child expression. */
  child(node: Expr): React.ReactNode;
}

/**
 * The node union member(s) whose `op` can be `K`. Not `Extract<Expr, {op: K}>`: several AST
 * members carry a UNION of ops (`{op: 'neg' | 'abs' | 'floor' | 'ceil'}`), which `Extract`'s
 * assignability test drops entirely. The distributive overlap test keeps exactly the members
 * that can actually be a `K` node.
 */
type HasOp<E, K> = E extends { readonly op: infer O } ? (K extends O ? E : never) : never;
export type NodeOf<K extends AstKind> = HasOp<Expr, K>;

export type Render<K extends AstKind> = (node: NodeOf<K>, ctx: RenderCtx) => React.JSX.Element;

export type Renderers = { readonly [K in AstKind]: Render<K> };

/* ---- shared fragments ---------------------------------------------------- */

function kw(text: string): React.JSX.Element {
  return <span className="rs-expr-kw">{text}</span>;
}

/** `(a OP b)` — the parenthesized infix shape most binary nodes share. */
function infix<K extends AstKind>(symbol: string): Render<K> {
  function InfixRender(node: NodeOf<K>, ctx: RenderCtx): React.JSX.Element {
    const args = (node as { readonly args: readonly Expr[] }).args;
    return (
      <span className="rs-expr">
        ({ctx.child(args[0] as Expr)} {kw(symbol)} {ctx.child(args[1] as Expr)})
      </span>
    );
  }
  return InfixRender;
}

/** `FN(a, b, …)` — the call shape. */
function call<K extends AstKind>(name: string): Render<K> {
  function CallRender(node: NodeOf<K>, ctx: RenderCtx): React.JSX.Element {
    const args = (node as { readonly args: readonly Expr[] }).args;
    return (
      <span className="rs-expr">
        {kw(name)}(
        {args.map((arg, index) => (
          <span key={index}>
            {index > 0 ? ', ' : ''}
            {ctx.child(arg)}
          </span>
        ))}
        )
      </span>
    );
  }
  return CallRender;
}

/** `(a AND b AND …)` — the n-ary boolean shape. */
function nary<K extends AstKind>(word: string): Render<K> {
  function NaryRender(node: NodeOf<K>, ctx: RenderCtx): React.JSX.Element {
    const args = (node as { readonly args: readonly Expr[] }).args;
    return (
      <span className="rs-expr">
        (
        {args.map((arg, index) => (
          <span key={index}>
            {index > 0 ? <> {kw(word)} </> : null}
            {ctx.child(arg)}
          </span>
        ))}
        )
      </span>
    );
  }
  return NaryRender;
}

/* ---- the closed registry -------------------------------------------------- */

export const RENDERERS: Renderers = {
  lit: (node, ctx) => {
    switch (node.v.k) {
      case 'null':
        return kw('NULL');
      case 'bool':
        return kw(node.v.v ? 'TRUE' : 'FALSE');
      case 'num':
        return <span className="rs-expr">{String(node.v.v)}</span>;
      case 'text':
        return <span className="rs-expr">&quot;{node.v.v}&quot;</span>;
      case 'date':
        return (
          <span className="rs-expr">
            {kw('DATE')} &quot;{node.v.v}&quot;
          </span>
        );
      case 'enum':
        return <span className="rs-expr">{ctx.optionLabel(node.v.d, node.v.v)}</span>;
      case 'set':
        return (
          <span className="rs-expr">
            [{node.v.v.map((code) => ctx.optionLabel(node.v.k === 'set' ? node.v.d : '', code)).join(', ')}]
          </span>
        );
      default: {
        const never: never = node.v;
        return <span>{JSON.stringify(never)}</span>;
      }
    }
  },
  var: (node, ctx) => <span className="rs-chip">{ctx.variableName(node.var)}</span>,
  probe: (node, ctx) => (
    <span className="rs-expr">
      {kw(node.kind.toUpperCase())}(
      {node.target.kind === 'variable' ? ctx.variableName(node.target.id) : ctx.nodeRef(node.target.id)})
    </span>
  ),
  item: () => kw('item'),
  item_attr: (node) => (
    <span className="rs-expr">
      {kw('item')}.{node.meta_key === undefined ? node.attr : `meta.${node.meta_key}`}
    </span>
  ),
  '==': infix('='),
  '!=': infix('≠'),
  '<': infix('<'),
  '<=': infix('≤'),
  '>': infix('>'),
  '>=': infix('≥'),
  contains: infix('CONTAINS'),
  any_of: infix('ANY OF'),
  all_of: infix('ALL OF'),
  none_of: infix('NONE OF'),
  set_eq: infix('SET ='),
  subset_of: infix('SUBSET OF'),
  union: call('UNION'),
  intersect: call('INTERSECT'),
  difference: call('DIFFERENCE'),
  and: nary('AND'),
  or: nary('OR'),
  not: (node, ctx) => (
    <span className="rs-expr">
      {kw('NOT')} {ctx.child(node.args[0])}
    </span>
  ),
  '+': infix('+'),
  '-': infix('−'),
  '*': infix('×'),
  '/': infix('÷'),
  mod: infix('MOD'),
  pow: infix('^'),
  neg: (node, ctx) => <span className="rs-expr">−{ctx.child(node.args[0])}</span>,
  abs: call('ABS'),
  floor: call('FLOOR'),
  ceil: call('CEIL'),
  round: call('ROUND'),
  min: call('MIN'),
  max: call('MAX'),
  clamp: call('CLAMP'),
  agg: (node, ctx) => (
    <span className="rs-expr">
      {kw(node.fn.toUpperCase())}({kw('over')} {describeGroup(node.over, ctx)}
      {node.where === undefined ? null : <> {kw('WHERE')} {ctx.child(node.where)}</>}
      {node.select === undefined ? null : <> {kw('SELECT')} {ctx.child(node.select)}</>})
    </span>
  ),
  concat: call('CONCAT'),
  len: call('LEN'),
  lower: call('LOWER'),
  upper: call('UPPER'),
  trim: call('TRIM'),
  starts_with: infix('STARTS WITH'),
  ends_with: infix('ENDS WITH'),
  str_contains: infix('CONTAINS TEXT'),
  matches: (node, ctx) => (
    <span className="rs-expr">
      {ctx.child(node.args[0])} {kw('MATCHES')} /{node.pattern}/{node.flags ?? ''}
    </span>
  ),
  substr: call('SUBSTR'),
  split_count: call('SPLIT_COUNT'),
  word_count: call('WORD_COUNT'),
  date_diff: (node, ctx) => (
    <span className="rs-expr">
      {kw('DATE_DIFF')}({node.unit}, {ctx.child(node.args[0])}, {ctx.child(node.args[1])})
    </span>
  ),
  date_add: (node, ctx) => (
    <span className="rs-expr">
      {kw('DATE_ADD')}({node.unit}, {ctx.child(node.args[0])}, {ctx.child(node.args[1])})
    </span>
  ),
  date_part: (node, ctx) => (
    <span className="rs-expr">
      {kw('DATE_PART')}({node.part}, {ctx.child(node.args[0])})
    </span>
  ),
  date_trunc: (node, ctx) => (
    <span className="rs-expr">
      {kw('DATE_TRUNC')}({node.unit}, {ctx.child(node.args[0])})
    </span>
  ),
  case: (node, ctx) => (
    <span className="rs-expr">
      {kw('CASE')}{' '}
      {node.cases.map((arm, index) => (
        <span key={index}>
          {kw('WHEN')} {ctx.child(arm.when)} {kw('THEN')} {ctx.child(arm.then)}{' '}
        </span>
      ))}
      {kw('ELSE')} {ctx.child(node.else)} {kw('END')}
    </span>
  ),
  coalesce: call('COALESCE'),
  cast: (node, ctx) => (
    <span className="rs-expr">
      {kw(node.to === 'num' ? 'CODE' : `TO_${node.to.toUpperCase()}`)}({ctx.child(node.args[0])})
    </span>
  ),
  /**
   * The cross-domain escape, rendered as prose rather than as a function call.
   *
   * "matched by code against <Q>" is what the node means, and it is the one node in the tree that
   * asserts something the type system could not check — so it reads as a claim the reviewer is
   * being asked to agree with, not as machinery.
   */
  recode: (node, ctx) => (
    <span className="rs-expr">
      {ctx.child(node.args[0])} {kw('matched by code against')}{' '}
      <span className="rs-chip">{ctx.questionOfDomain?.(node.to) ?? node.to}</span>
    </span>
  ),
  label_of: (node, ctx) => (
    <span className="rs-expr">
      {kw('LABEL_OF')}({ctx.child(node.args[0])}
      {node.form === undefined ? null : `, ${node.form}`})
    </span>
  ),
};

/**
 * The same value, in the exact type `@resscript/rescript-dsl` published for this leg. `never`
 * as the node parameter is the standard contravariant bottom: every per-kind renderer accepts
 * it, so this assignment compiles exactly when `RENDERERS` covers every `AstKind` — D §7.2's
 * closure as a type error, not a review item.
 */
export const RENDERER_REGISTRY: AstRendererRegistry<(node: never, ctx: RenderCtx) => React.JSX.Element> =
  RENDERERS;

function describeGroup(over: NodeOf<'agg'>['over'], ctx: RenderCtx): string {
  switch (over.kind) {
    case 'explicit':
      return over.variable_ids.map((id) => ctx.variableName(id)).join(', ');
    case 'question_emits':
    case 'options':
      return ctx.nodeRef(over.question_id);
    case 'matrix_rows':
      return `${ctx.nodeRef(over.question_id)} ROWS`;
    case 'matrix_cols':
      return `${ctx.nodeRef(over.question_id)} COLUMNS`;
    case 'loop_iterations':
      return `${ctx.nodeRef(over.question_id)} ITERATIONS`;
    default: {
      const never: never = over;
      return JSON.stringify(never);
    }
  }
}

/**
 * Render any expression through the closed registry.
 *
 * The one cast in this file: indexing `RENDERERS` by `node.op` erases the correlation between
 * the key and the node parameter (TypeScript cannot relate them through an index expression),
 * and the cast re-attaches what the mapped type already guarantees — `RENDERERS[node.op]`
 * accepts exactly a node of that `op`.
 */
export function ExprView({ node, ctx }: { readonly node: Expr; readonly ctx: RenderCtx }): React.JSX.Element {
  const render = RENDERERS[node.op] as Render<AstKind> as (n: Expr, c: RenderCtx) => React.JSX.Element;
  return render(node, ctx);
}

/** Every kind, re-exported for the runtime coverage test beside this file. */
export { AST_KINDS };
