/**
 * One rule row ⇄ one DSL statement — the mapping both halves of P1-12's round trip share.
 *
 * `POST /versions/:id/rules` with `source` needs statement → rule; the builder's "view as
 * ResScript" needs rule → statement. Keeping the two directions in ONE module is what makes
 * D §7.2's isomorphism checkable at all: split across a route and a component they would drift,
 * and the drift would surface as the acceptance failure — a rule that reopens as a different
 * rule after a trip through code mode.
 *
 * ## What maps, and what refuses
 *
 * A rule ROW holds exactly one condition and one effect (`content.logic_rules`); a rule
 * STATEMENT holds one condition and an ordered effect list with an optional ELSE. D §9.3
 * desugars the many-effect form into one rule per effect cell — and that desugaring needs a
 * rule-id source and an `order_key` allocator, which is `packages/compiler`'s job (P1-08), not
 * this file's. So statement → rule accepts the one-statement / one-effect / no-ELSE /
 * no-ON-UNKNOWN subset and REFUSES the rest with a detail naming the construct, rather than
 * silently keeping the first effect and dropping the ELSE (the worst possible reading).
 *
 * ## Where the target lives
 *
 * Most effects name their own target (`SHOW Q12`), so statement → rule derives it. Two do not
 * carry a content target in the text at all — `TERMINATE` names a disposition, not a node — and
 * for those the caller keeps the rule's existing target (the API body carries one; the builder
 * holds one). A `skip_to` rule targets its DESTINATION node, doubled into `effect.target_id`
 * exactly as schema §7's comment prescribes ("for skip_to: the destination is in target_id") —
 * so "what affects P3" also lists the skip rules that land there.
 */

import type { Expr } from '@resscript/logic';
import { isExprShape } from '@resscript/logic';
import type {
  Action,
  NodeRef,
  RuleStmt,
  Statement,
  Trivia,
  VarName,
} from '@resscript/rescript-dsl';
import type { RuleAction, RuleEvaluation, RuleKind } from '@resscript/schema';

/* -------------------------------------------------------------------------- */
/* Shapes                                                                     */
/* -------------------------------------------------------------------------- */

/** `content.logic_rules.effect`, typed as far as this app reasons about it. */
export interface RuleEffectShape {
  readonly action: RuleAction;
  /** For `set`: the value AST. */
  readonly value?: Expr;
  /** For `skip_to`: the destination node id (schema §7's comment). */
  readonly target_id?: string;
  readonly disposition?: string;
  readonly message_key?: string;
  /** `enable`/`disable`/`show`/`hide` on an axis subset: `{axis, codes}`. */
  readonly params?: { readonly axis?: 'option' | 'row' | 'column'; readonly codes?: readonly number[] };
}

export interface RuleShape {
  readonly kind: RuleKind;
  readonly target_kind: 'node' | 'item' | 'variable';
  readonly target_node_id: string | null;
  readonly target_item_id: string | null;
  readonly target_variable_id: string | null;
  readonly condition: Expr;
  readonly effect: RuleEffectShape;
  readonly evaluation?: RuleEvaluation;
}

/** id → display names. Misses fall back to the raw id, which the printer also does. */
export interface RefNames {
  nodeRef(id: string): { readonly ref: string; readonly kind: 'question' | 'page' | 'block' } | undefined;
  variableName(id: string): string | undefined;
}

/* -------------------------------------------------------------------------- */
/* rule → statement (the "view as ResScript" direction)                        */
/* -------------------------------------------------------------------------- */

export type StatementResult =
  | { readonly ok: true; readonly statement: RuleStmt<Expr> }
  | { readonly ok: false; readonly reason: string };

export function statementFromRule(
  rule: {
    readonly kind: RuleKind;
    readonly target_node_id: string | null;
    readonly target_variable_id: string | null;
    /** The stored jsonb; validated here (`isExprShape`), not trusted. */
    readonly condition: unknown;
    /** The stored jsonb; its shape was validated by the route that wrote it. */
    readonly effect: unknown;
    readonly trivia?: unknown;
  },
  names: RefNames,
): StatementResult {
  const condition = rule.condition;
  if (!isExprShape(condition)) return { ok: false, reason: 'the stored condition is not an AST' };
  const effect = rule.effect as RuleEffectShape;
  const action = actionFromEffect(rule, effect, names);
  if (action === undefined) {
    return {
      ok: false,
      reason: `the ${String(effect.action)} effect has no ResScript spelling yet — edit it in the builder`,
    };
  }
  const trivia = rule.trivia as Trivia | undefined;
  return {
    ok: true,
    statement: {
      s: 'rule',
      condition,
      then: [action],
      ...(trivia === undefined || Object.keys(trivia).length === 0 ? {} : { trivia }),
    },
  };
}

function nodeRefOf(id: string, names: RefNames, explicitFor?: readonly ('page' | 'block')[]): NodeRef {
  const named = names.nodeRef(id);
  const kind = named?.kind ?? 'question';
  const explicit =
    (explicitFor ?? []).includes(kind as 'page' | 'block') && (kind === 'page' || kind === 'block')
      ? { explicit: kind }
      : {};
  return {
    ref: named?.ref ?? id,
    id: id as Exclude<NodeRef['id'], undefined>,
    kind,
    ...explicit,
  };
}

function varNameOf(id: string, names: RefNames): VarName {
  return { ref: names.variableName(id) ?? id, id: id as Exclude<VarName['id'], undefined> };
}

function actionFromEffect(
  rule: { readonly target_node_id: string | null; readonly target_variable_id: string | null },
  effect: RuleEffectShape,
  names: RefNames,
): Action<Expr> | undefined {
  const node = rule.target_node_id;
  switch (effect.action) {
    case 'show':
    case 'hide':
    case 'enable':
    case 'disable': {
      if (node === null) return undefined;
      const axis = effect.params?.axis;
      const codes = effect.params?.codes;
      return {
        a: effect.action,
        target: {
          ref: nodeRefOf(node, names),
          ...(axis === undefined ? {} : { axis }),
          ...(codes === undefined ? {} : { codes }),
        },
      };
    }
    case 'skip_to': {
      const destination = effect.target_id ?? node;
      if (destination === null || destination === undefined) return undefined;
      // `SKIP TO PAGE P3`: the explicit keyword disambiguates a page ref the way the corpus
      // spells it; a question destination needs none.
      return { a: 'skip_to', ref: nodeRefOf(destination, names, ['page', 'block']) };
    }
    case 'require':
    case 'unrequire': {
      if (node === null) return undefined;
      return { a: effect.action, ref: nodeRefOf(node, names) };
    }
    case 'terminate':
      return {
        a: 'terminate',
        ...(effect.disposition === undefined ? {} : { disposition: effect.disposition as never }),
      };
    case 'set': {
      const variable = rule.target_variable_id;
      if (variable === null || effect.value === undefined || !isExprShape(effect.value)) return undefined;
      return { a: 'set', variable: varNameOf(variable, names), value: effect.value };
    }
    // `select`/`deselect`/`fail` have no P1-07 action spelling; the builder edits them directly.
    default:
      return undefined;
  }
}

/* -------------------------------------------------------------------------- */
/* statement → rule (the `source` half of POST /versions/:id/rules)            */
/* -------------------------------------------------------------------------- */

export interface RuleFromStatement {
  readonly kind: RuleKind;
  /** Absent when the text names no content target (`TERMINATE`) — the caller's target stands. */
  readonly target?:
    | { readonly target_kind: 'node'; readonly target_node_id: string }
    | { readonly target_kind: 'variable'; readonly target_variable_id: string };
  readonly condition: Expr;
  readonly effect: RuleEffectShape;
  readonly trivia: Trivia;
}

export type RuleFromStatementResult =
  | { readonly ok: true; readonly rule: RuleFromStatement }
  | { readonly ok: false; readonly code: string; readonly message: string };

function refuse(code: string, message: string): RuleFromStatementResult {
  return { ok: false, code, message };
}

export function ruleFromStatements(statements: readonly Statement<Expr>[]): RuleFromStatementResult {
  if (statements.length !== 1) {
    return refuse(
      'one_statement',
      `a rule is one statement; the source parsed to ${String(statements.length)}`,
    );
  }
  const statement = statements[0];
  if (statement === undefined || statement.s !== 'rule') {
    return refuse(
      'not_a_rule',
      `expected an IF … THEN … rule statement, got ${statement?.s ?? 'nothing'}`,
    );
  }
  if (statement.otherwise !== undefined) {
    return refuse(
      'else_not_storable',
      'ELSE desugars to one rule per effect cell (D §9.3), which is the compiler\'s job (P1-08); ' +
        'store the ELSE branch as its own rule',
    );
  }
  if (statement.on_unknown !== undefined) {
    return refuse(
      'on_unknown_not_storable',
      'ON UNKNOWN lands with the compiler\'s rule model (D §4.1); the rules API has no column for it yet',
    );
  }
  if (statement.then.length !== 1) {
    return refuse(
      'one_effect',
      `a rule row holds one effect; this statement has ${String(statement.then.length)} — split it, or keep it in code`,
    );
  }
  const action = statement.then[0];
  if (action === undefined) return refuse('one_effect', 'the statement has no effect');
  const mapped = mapAction(action);
  if (!mapped.ok) return mapped;
  return {
    ok: true,
    rule: {
      ...mapped.rule,
      condition: statement.condition,
      trivia: statement.trivia ?? {},
    },
  };
}

type MappedAction =
  | { readonly ok: true; readonly rule: Omit<RuleFromStatement, 'condition' | 'trivia'> }
  | { readonly ok: false; readonly code: string; readonly message: string };

function mapAction(action: Action<Expr>): MappedAction {
  switch (action.a) {
    case 'show':
    case 'hide':
    case 'enable':
    case 'disable': {
      const id = action.target.ref.id;
      if (id === undefined) {
        return refuse('unresolved_target', `${action.a.toUpperCase()} names a ref that did not resolve`);
      }
      if (action.target.where !== undefined) {
        return refuse(
          'per_item_predicate',
          'a per-item WHERE is a mask (schema §15), not a rule effect; use the mask editor',
        );
      }
      const axis = action.target.axis;
      const codes = action.target.codes;
      const params =
        axis === undefined && codes === undefined
          ? {}
          : { params: { ...(axis === undefined ? {} : { axis }), ...(codes === undefined ? {} : { codes }) } };
      return {
        ok: true,
        rule: {
          kind: action.a === 'show' || action.a === 'hide' ? 'display' : 'option_state',
          target: { target_kind: 'node', target_node_id: id },
          effect: { action: action.a, ...params },
        },
      };
    }
    case 'skip_to':
    case 'skip': {
      const id = action.ref.id;
      if (id === undefined) {
        return refuse('unresolved_target', 'SKIP TO names a ref that did not resolve');
      }
      return {
        ok: true,
        rule: {
          kind: 'skip',
          target: { target_kind: 'node', target_node_id: id },
          effect: { action: 'skip_to', target_id: id },
        },
      };
    }
    case 'require':
    case 'unrequire': {
      const id = action.ref.id;
      if (id === undefined) {
        return refuse('unresolved_target', `${action.a.toUpperCase()} names a ref that did not resolve`);
      }
      return {
        ok: true,
        rule: {
          kind: 'validate',
          target: { target_kind: 'node', target_node_id: id },
          effect: { action: action.a },
        },
      };
    }
    case 'terminate':
      return {
        ok: true,
        rule: {
          kind: 'terminate',
          // No target in the text: TERMINATE names a disposition. The caller's target stands
          // (`rules_one_target` still wants one — the row is pinned to the page it fires from).
          effect: {
            action: 'terminate',
            ...(action.disposition === undefined ? {} : { disposition: action.disposition }),
          },
        },
      };
    case 'set': {
      const id = action.variable.id;
      if (id === undefined) {
        return refuse('unresolved_target', 'SET names a variable that did not resolve');
      }
      return {
        ok: true,
        rule: {
          kind: 'set_variable',
          target: { target_kind: 'variable', target_variable_id: id },
          effect: { action: 'set', value: action.value },
        },
      };
    }
    case 'flag':
    case 'preselect':
      return refuse(
        'effect_not_storable',
        `${action.a.toUpperCase()} has no rules-API mapping yet — reported, not guessed`,
      );
    default: {
      const never: never = action;
      return refuse('effect_not_storable', `unknown action ${JSON.stringify(never)}`);
    }
  }
}
