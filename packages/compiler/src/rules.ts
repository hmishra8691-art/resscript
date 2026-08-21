/**
 * `survey.logic_rules` → `@resscript/logic`'s `Rule[]`: the effect mapping, the order keys and
 * the flow sites (C §7, D §4.2, D §4.4, roadmap P1-08).
 *
 * WHY THIS FILE EXISTS. `compileLogic` does the whole compile-time half of the engine — canonical
 * sort, `checkRule` on every rule, CSE, the cell graph, cycles, conflicts — and none of it is
 * re-done here. What it cannot do for itself is the shape change, and there are four parts to it.
 *
 * ## 1. One flat interface → a discriminated union
 *
 * Schema's `RuleEffect` is a single interface with an open `action: RuleAction` (twelve values)
 * and all-optional payload fields, because that is what a `jsonb` column and an editing UI want.
 * Logic's `Effect` is eight arms, each carrying exactly what its cell needs, because that is what
 * `writesOf` needs to be total. The table is written out rather than derived, since the load
 * bearing rows are the ones where the two shapes do *not* line up:
 *
 * | schema `action`                | discriminated further by      | logic `Effect` arm                    |
 * |--------------------------------|-------------------------------|---------------------------------------|
 * | `show`                         | `kind: 'mask'`                | `mask` (`mode: 'include'`)            |
 * | `show`                         | option target                 | `option_state` `visible` = `TRUE`     |
 * | `show`                         | otherwise                     | `show`                                |
 * | `hide`                         | `kind: 'mask'`                | `mask` (`mode: 'exclude'`)            |
 * | `hide`                         | option target                 | `option_state` `visible` = `FALSE`    |
 * | `hide`                         | otherwise                     | `hide`                                |
 * | `skip_to`                      | `effect.target_id` present    | `skip_to` (`node_id`)                 |
 * | `skip_to`                      | no `effect.target_id`         | `skip_this`                           |
 * | `require` / `unrequire`        | option target                 | `option_state` `required` = `TRUE`/`FALSE`    |
 * | `enable` / `disable`           | option target                 | `option_state` `enabled` = `TRUE`/`FALSE`     |
 * | `select` / `deselect`          | option target                 | `option_state` `preselected` = `TRUE`/`FALSE` |
 * | `set`                          | —                             | `set` (`variable_id`, `value`)        |
 * | `fail`                         | —                             | `require_valid` (`message_key`, `scope`) |
 * | `terminate`                    | —                             | `terminate` (`disposition`)           |
 * | anything else                  | —                             | none — `CMP-0702`                     |
 *
 * Three rows need their reasoning stated.
 *
 * **`show`/`hide` on an option target is `option_state`, not `show`/`hide`.** `writesOf` returns
 * `[]` for a `show`/`hide` effect whose target is an option — visibility cells are keyed by
 * question/page/block id — so emitting the visibility arm there would produce a rule that
 * type-checks, ships, and does nothing. The option's own `visible` property is the cell that
 * exists (`opt(option_id.visible)`), so that is the arm. Which target is *legal* for the rule's
 * `kind` stays `checkTargetKind`'s business (`LGC-T034`); this file's job is to write the arm
 * whose cell matches the target, so that a rule that is reported is at least reported as a kind
 * mismatch rather than as nothing at all.
 *
 * **`require`/`unrequire` on a question target is `CMP-0702`, not a guess.** `OptProp.required`
 * is schema §5.1's per-item `required_if`, and logic's `Cell` union has no per-*question*
 * required cell at all — so `IF x THEN REQUIRE Q12` has nothing to write. The two lowerings that
 * would compile both change what the author wrote: casting the question id into an `option_id`
 * fabricates a cell nothing reads, and rewriting the rule into `require_valid` with the
 * condition `NOT x OR ANSWERED(Q12)` silently converts a requiredness toggle into a validation
 * (and has no counterpart at all for `unrequire`, which cannot relax a base requirement that no
 * rule wrote). Reported, with the gap named in `detail.reason`, rather than invented.
 *
 * **`fail` derives its `scope` from the target** — `page` for a page target, `field` for a
 * question or variable — because schema has no scope field and the target is the only thing in
 * the document that says how wide the failure is. An absent `message_key` becomes `''` and no
 * key is synthesized: a synthesized key would be reported missing from every language bundle
 * (`CMP-0200`) under a name the author cannot find in the editor.
 *
 * ## 2. `order_key` is compiler-assigned, and it is derived from flow position
 *
 * D §4.4 makes `order_key` the deterministic tie-break between rules the cell graph leaves
 * unordered, and `compileLogic` sorts on `(order_key, id)` before it derives a single index — so
 * this number is what makes "identical verdicts under 1,000 randomized rule orderings" an
 * assertion on *bytes*.
 *
 * That property is exactly why the obvious base — the rule's index in `survey.logic_rules` — is
 * **not** used. The array position is not a fact about the survey: the rows live in
 * `content.logic_rules` ordered by a fractional `sort_key` column that the `Survey` document does
 * not carry, so a reader that returns them in another order describes the same survey. An
 * index-derived key would make every rule's `order_key` (and therefore every cell index, every
 * node id and the artifact hash) a function of row delivery order, which is the one thing the
 * milestone promises is impossible.
 *
 * So `order_key = site * ORDER_KEY_SITE_STRIDE + slot`, where `site` is the rule's flow position
 * (`FlowGraph.position` of the flow node it is scoped to) and `slot` distinguishes the surfaces
 * that share a site. Flow position, and not a constant, because a rule scoped to an earlier page
 * should apply first: two rules writing one cell then apply in the order the respondent meets
 * them, which is what an author reading the trace expects. Rules with no flow site at all
 * (survey-scoped, or scoped to an unreachable node) get `UNSCOPED_ORDER_SITE`, sorting before
 * every page — a survey-scoped `SET` is a global default that a page-scoped rule may then
 * override. Rules that tie fall back to `compileLogic`'s second key, the rule id, which is a
 * ULID and therefore in authoring order: stable, document-derived, and insensitive to shuffling.
 *
 * ## 3. `flow_node_id` is compiler-assigned, and a skip rule without one does nothing
 *
 * `writesOf` returns `[]` for `skip_to`/`skip_this` when `flow_node_id` is absent, so such a rule
 * writes no cell, has no dependents and silently never fires. It is resolved here from the flow
 * graph — the node that lays out the target, or the target's containing page for a question or
 * option target — and a skip rule whose target has no flow site is `CMP-0006` and is dropped
 * rather than emitted as a no-op. Every other rule kind gets `flow_node_id` when one resolves,
 * because D §8.1's dominance analysis reads it; a `set_variable` rule on a hidden variable
 * deliberately gets none, since the only site that could be invented for it is `start`, and a
 * rule that claims to write at entry dominates everything and would make the forward-reference
 * check believe a value is available on every path.
 *
 * ## 4. Masks arrive on two surfaces
 *
 * A mask is authored on `QuestionNode.masks` — a `Mask` with a `source` and a **required**
 * `fallback` — and also, in principle, as a `kind: 'mask'` logic rule. Both become the same
 * `mask` `Effect`, so both are handled: one synthesized `Rule` per `QuestionNode.masks[]` entry
 * (with `per_item` derived from the `MaskSource`), plus the authored form. The authored form is
 * the lossy one: `RuleEffect` has no axis and no `when_empty`, and schema §15 is explicit that
 * `when_empty` has no safe default ("the empty-question dead end is worth a required field"), so
 * the axis falls back to the target question's populated axis while the fallback must be present
 * in `effect.params` — absent or illegal, it is `CMP-0702`. Inventing it is precisely the bug the
 * required field exists to prevent.
 *
 * ## What the authoring model cannot carry, and what is done about it
 *
 *  - **`on_unknown`.** CONTEXT decision 5: `content.logic_rules` has no column and migration 0008
 *    deliberately did not add one, so no `Survey` can carry it. The effect is stored as one
 *    `jsonb` blob, though, so the *bytes* can — as a stray key or inside `effect.params`. Both are
 *    read, both are `CMP-0700`, and the field is left absent on the produced rule. The rule itself
 *    is still emitted: publish is blocked by the error, and dropping it would bury the one
 *    diagnostic that names the cause under a pile of "this cell has no writer" noise.
 *  - **`priority_group`.** DSL-only (`PRIORITY GROUP g { … }`), with no schema field. It is *not*
 *    read from `effect.params`, and the asymmetry with `on_unknown` is deliberate: reading an
 *    undocumented key in order to *report* a rule is safe, reading one in order to exempt a rule
 *    from `LGC-CONFLICT` is how two writers of one `set_variable` cell get through the gate.
 *  - **`FLAG <ident>`.** CONTEXT decision 8 desugars it to `{ action: 'set', variable_id, value:
 *    TRUE }`. Nothing is added here for it: `RULE_ACTIONS` has no `flag` member, so a `Survey`
 *    cannot express one — the desugar belongs to whatever writes DSL statements into
 *    `logic_rules` (`packages/rescript-dsl`'s `resolve.ts` records the same expectation), and by
 *    the time a rule reaches this file it is already the `set` row above.
 *  - **`terminate.custom_key`.** `TerminationNode` has the column; `RuleEffect` does not. Left
 *    absent rather than read out of `params`, for the `priority_group` reason.
 *
 * Diagnostic paths are array positions (`/logic_rules/3/effect`), matching what
 * `validateStructural` reports against the same rows, and every `detail` carries `rule_id` —
 * because the *path* moves when rows are delivered in another order and the rule id does not.
 */

import {
  MASK_FALLBACKS,
  pointer,
  type ContentNode,
  type Disposition as SchemaDisposition,
  type Expr as SchemaExpr,
  type JsonValue,
  type LogicRule,
  type Mask,
  type MaskFallback,
  type MaskTarget,
  type QuestionItem,
  type QuestionNode,
  type RuleAuthoredIn as SchemaAuthoredIn,
  type RuleEffect,
  type RuleEvaluation as SchemaEvaluation,
  type RuleKind as SchemaRuleKind,
  type RuleTarget,
  type Survey,
} from '@resscript/schema';
import {
  asBlockId,
  asOptionId,
  asPageId,
  asQuestionId,
  asFlowNodeId,
  asRuleId,
  asVariableId,
  astBuilder,
  hasPrefix,
  type AstBuilder,
  type Disposition,
  type Effect,
  type Expr,
  type MaskAxis,
  type OptProp,
  type Rule,
  type RuleEvaluation,
  type RuleId,
  type RuleKind,
  type Target,
  type TypeEnv,
  type VariableId,
} from '@resscript/logic';

import { cmpDiagnostic, sortCompileDiagnostics, type CompileDiagnostic } from './diagnostics.js';
import { flowNodeOfNode, pageOfQuestion } from './flow.js';
import type { FlowGraph } from './types.js';

/* ========================================================================== */
/* 1. The public surface                                                       */
/* ========================================================================== */

export interface BuildRulesOptions {
  /**
   * Pointer prefix for diagnostics. `''` — the whole survey document is the root — for the
   * compile gate; a caller that validates a rule inside a larger envelope passes its own.
   */
  readonly path?: string;
}

export interface BuildRulesResult {
  /** Canonical `(order_key, id)` order, the same order `compileLogic` will re-derive. */
  readonly rules: readonly Rule[];
  readonly diagnostics: readonly CompileDiagnostic[];
}

/**
 * The gap between two `order_key` sites.
 *
 * 1000, not 1, so the surfaces that share a flow site (authored rules, then one slot per mask on
 * a question) stay ordered among themselves without colliding with the next site. A question
 * carrying a thousand masks would spill into the next site's band; the consequence is two equal
 * keys, and `compileLogic` breaks that tie on the rule id, so determinism survives the spill.
 */
export const ORDER_KEY_SITE_STRIDE = 1000;

/** The site of a rule the flow does not position: survey-scoped, or scoped to a dead node. */
export const UNSCOPED_ORDER_SITE = -1;

/** Slot of an authored rule within its site. Masks synthesized from a question follow it. */
export const AUTHORED_ORDER_SLOT = 0;

/**
 * The rule id of the rule synthesized from a question-level mask.
 *
 * A synthesized rule needs an id — it keys `valid`/`terminate` cells, the trace and
 * `CompiledRule.id` — and there is no `logic_rules` row to take one from. The mask's own `msk_`
 * id is the stable, unique seed (`validateStructural` declares it), so it is prefixed rather than
 * re-branded: `rul_msk_01J…` is still self-describing, still injective, and cannot be mistaken
 * for a rule the author wrote.
 */
export function synthesizedMaskRuleId(maskId: string): RuleId {
  return asRuleId(`rul_${maskId}`);
}

export function buildRules(
  survey: Survey,
  graph: FlowGraph,
  env: TypeEnv,
  options: BuildRulesOptions = {},
): BuildRulesResult {
  const diagnostics: CompileDiagnostic[] = [];
  const questions = questionsOf(survey);
  const ctx: Ctx = {
    graph,
    env,
    path: options.path ?? '',
    pageOfQuestion: pageOfQuestion(survey),
    questionById: indexQuestions(questions),
    questionOfOption: indexOptions(questions),
    questionOfVariable: indexVariables(survey),
    diagnostics,
  };

  const rules: Rule[] = [];
  survey.logic_rules.forEach((rule, index) => {
    const lowered = lowerAuthored(rule, index, ctx);
    if (lowered !== undefined) rules.push(lowered);
  });
  for (const site of maskSites(survey)) {
    const lowered = lowerQuestionMask(site, ctx);
    if (lowered !== undefined) rules.push(lowered);
  }

  return {
    rules: rules.sort(byCanonicalOrder),
    diagnostics: sortCompileDiagnostics(diagnostics),
  };
}

/** `compileLogic`'s own comparator, applied here so the array itself is comparable byte-wise. */
function byCanonicalOrder(a: Rule, b: Rule): number {
  return a.order_key !== b.order_key
    ? a.order_key - b.order_key
    : a.id < b.id
      ? -1
      : a.id > b.id
        ? 1
        : 0;
}

interface Ctx {
  readonly graph: FlowGraph;
  readonly env: TypeEnv;
  readonly path: string;
  /** Question / text node id → its page. */
  readonly pageOfQuestion: ReadonlyMap<string, string>;
  readonly questionById: ReadonlyMap<string, QuestionNode>;
  /** Option / row / column id → the question that declares it. */
  readonly questionOfOption: ReadonlyMap<string, string>;
  /** Variable id → the question that emits it, when one does. */
  readonly questionOfVariable: ReadonlyMap<string, string>;
  readonly diagnostics: CompileDiagnostic[];
}

/* ========================================================================== */
/* 2. Authored rules                                                           */
/* ========================================================================== */

function lowerAuthored(rule: LogicRule, index: number, ctx: Ctx): Rule | undefined {
  const path = `${ctx.path}${pointer('logic_rules', index)}`;
  reportOnUnknown(rule, path, ctx);

  const kind = kindOf(rule.kind);
  const target = targetOf(rule.target);
  const site = flowSiteOf(rule.target, ctx);
  // One builder per rule: every expression this file synthesizes for one rule must have
  // distinct node ids, and ids restart at 1 per rule because `compileLogic`'s interner
  // renumbers densely across the whole program anyway (see `derive.ts`).
  const b = astBuilder();
  const effect = effectOf(rule, kind, path, b, ctx);
  if (effect === undefined) return undefined;

  if ((effect.action === 'skip_to' || effect.action === 'skip_this') && site === undefined) {
    ctx.diagnostics.push(
      cmpDiagnostic(
        'CMP-0006',
        `Skip rule ${rule.id} is scoped to a ${rule.target.type} that no flow node lays out, so ` +
          'it has no flow cell to write and could never fire.',
        path,
        { rule_id: rule.id, target_type: rule.target.type },
      ),
    );
    return undefined;
  }

  const label = rule.notes;
  return {
    id: asRuleId(rule.id),
    kind,
    target,
    condition: asLogicExpr(rule.condition),
    effect,
    evaluation: evaluationOf(rule.evaluation),
    authored_in: authoredInOf(rule.authored_in),
    order_key: orderKeyOf(site, AUTHORED_ORDER_SLOT, ctx),
    ...(site === undefined ? {} : { flow_node_id: asFlowNodeId(site) }),
    ...(label === undefined || label === null || label === '' ? {} : { label }),
  };
}

/**
 * `CMP-0700`, for an `ON UNKNOWN` that reached the document anyway.
 *
 * Read from two places because both are reachable: `content.logic_rules.effect` is one `jsonb`
 * column with a `jsonb_typeof = 'object'` check and nothing else, so a writer can put a stray
 * `on_unknown` key beside `action`, and `RuleEffect.params` is the declared free-form bag. The
 * type admits neither, which is the point — the cast is what lets the check exist at all.
 */
function reportOnUnknown(rule: LogicRule, path: string, ctx: Ctx): void {
  const bag = rule.effect as unknown as { readonly [key: string]: JsonValue | undefined };
  const stray = bag['on_unknown'];
  const inParams = rule.effect.params?.['on_unknown'];
  const declared = stray ?? inParams;
  if (declared === undefined || declared === null) return;
  ctx.diagnostics.push(
    cmpDiagnostic(
      'CMP-0700',
      `Rule ${rule.id} carries ON UNKNOWN, which the current authoring schema cannot persist ` +
        '(content.logic_rules has no column for it), so the compiled rule would not agree with ' +
        'the document it was compiled from.',
      `${path}/effect`,
      { rule_id: rule.id, on_unknown: declared },
    ),
  );
}

/* ========================================================================== */
/* 3. The effect mapping                                                       */
/* ========================================================================== */

function effectOf(
  rule: LogicRule,
  kind: RuleKind,
  path: string,
  b: AstBuilder,
  ctx: Ctx,
): Effect | undefined {
  const effect = rule.effect;
  switch (effect.action) {
    case 'show':
      if (kind === 'mask') return maskEffect(rule, 'include', path, b, ctx);
      if (rule.target.type === 'option') {
        return optionState(rule.target.id, 'visible', true, b);
      }
      return { action: 'show' };

    case 'hide':
      if (kind === 'mask') return maskEffect(rule, 'exclude', path, b, ctx);
      if (rule.target.type === 'option') {
        return optionState(rule.target.id, 'visible', false, b);
      }
      return { action: 'hide' };

    case 'skip_to':
      return skipEffect(rule, path, ctx);

    case 'require':
      return optionStateOf(rule, 'required', true, path, b, ctx);
    case 'unrequire':
      return optionStateOf(rule, 'required', false, path, b, ctx);
    case 'enable':
      return optionStateOf(rule, 'enabled', true, path, b, ctx);
    case 'disable':
      return optionStateOf(rule, 'enabled', false, path, b, ctx);
    case 'select':
      return optionStateOf(rule, 'preselected', true, path, b, ctx);
    case 'deselect':
      return optionStateOf(rule, 'preselected', false, path, b, ctx);

    case 'set': {
      const variableId = setTargetOf(rule);
      if (variableId === undefined) {
        unexpressible(rule, 'no_variable_target', path, ctx, 'SET names no variable to write.');
        return undefined;
      }
      // An absent value is an assignment of null, not a missing field: that is the write D §2.5
      // already performs when the condition is UNKNOWN, and dropping the effect instead would
      // leave the cell with a writer the author asked for and no write.
      const value =
        effect.value === undefined || effect.value === null
          ? b.nullLit()
          : asLogicExpr(effect.value);
      return { action: 'set', variable_id: variableId, value };
    }

    case 'fail':
      return {
        action: 'require_valid',
        message_key: effect.message_key ?? '',
        scope: rule.target.type === 'page' ? 'page' : 'field',
      };

    case 'terminate':
      return { action: 'terminate', disposition: dispositionOf(effect.disposition) };

    default: {
      // Not `never`: `RuleAction` is closed in the type and open in the `jsonb` column, so this
      // is the arm an action from a newer (or hand-edited) document lands in. A diagnostic, not
      // a throw, and not a silent drop — the rule would otherwise disappear from the artifact
      // with nothing said about it.
      const action: string = effect.action;
      unexpressible(
        rule,
        'unknown_action',
        path,
        ctx,
        `Rule action ${JSON.stringify(action)} maps to no effect this engine can evaluate.`,
      );
      return undefined;
    }
  }
}

function optionStateOf(
  rule: LogicRule,
  prop: OptProp,
  value: boolean,
  path: string,
  b: AstBuilder,
  ctx: Ctx,
): Effect | undefined {
  if (rule.target.type !== 'option') {
    unexpressible(
      rule,
      'no_option_cell',
      path,
      ctx,
      `A ${rule.effect.action} effect writes opt(option.${prop}), and this rule targets a ` +
        `${rule.target.type}: the cell union has no per-${rule.target.type} ${prop} cell, so ` +
        'there is nothing to write. Scope the rule to the item, or state the requirement as a ' +
        'validation rule.',
      { prop },
    );
    return undefined;
  }
  return optionState(rule.target.id, prop, value, b);
}

function optionState(optionId: string, prop: OptProp, value: boolean, b: AstBuilder): Effect {
  return { action: 'option_state', option_id: asOptionId(optionId), prop, value: b.boolLit(value) };
}

/**
 * `skip_to` with a destination, `skip_this` without one.
 *
 * There is no `skip` action in `RULE_ACTIONS`, so "skip this node" is authored as `skip_to` with
 * no `target_id` — the absence *is* the arm, which is why it is not reported. A destination that
 * names a question resolves to the page that lays it out, because the runtime navigates pages;
 * one that names a variable is nothing a respondent can be sent to.
 */
function skipEffect(rule: LogicRule, path: string, ctx: Ctx): Effect | undefined {
  const destination = rule.effect.target_id;
  if (destination === undefined || destination === null) return { action: 'skip_this' };
  if (hasPrefix('pg', destination)) {
    return { action: 'skip_to', node_id: asPageId(destination) };
  }
  if (hasPrefix('blk', destination)) {
    return { action: 'skip_to', node_id: asBlockId(destination) };
  }
  if (hasPrefix('qst', destination)) {
    const page = ctx.pageOfQuestion.get(destination);
    if (page !== undefined) return { action: 'skip_to', node_id: asPageId(page) };
    unexpressible(
      rule,
      'no_skip_destination',
      path,
      ctx,
      `SKIP TO names question ${destination}, which is on no page, so there is no node to skip to.`,
      { target_id: destination },
    );
    return undefined;
  }
  unexpressible(
    rule,
    'no_skip_destination',
    path,
    ctx,
    `SKIP TO names ${destination}, which is not a page, a block or a question.`,
    { target_id: destination },
  );
  return undefined;
}

/**
 * The `mask` arm of a `kind: 'mask'` *rule* — the lossy authoring surface.
 *
 * `RuleEffect` declares neither an axis nor a `when_empty`, so both come from `params`, and the
 * two are treated differently on purpose: the axis has a document-derived default (the target
 * question has only one populated axis in every case but a matrix, and for a matrix the options
 * are the axis a rule would name), while `when_empty` has none at all — schema §15 refuses to
 * default it because `show_all` is wrong for a brand battery, `skip_question` for a screener and
 * `terminate` for both. Absent, it is reported.
 */
function maskEffect(
  rule: LogicRule,
  mode: 'include' | 'exclude',
  path: string,
  b: AstBuilder,
  ctx: Ctx,
): Effect | undefined {
  if (rule.target.type !== 'question') {
    unexpressible(
      rule,
      'no_items_cell',
      path,
      ctx,
      `A mask writes items(question.axis) and this rule targets a ${rule.target.type}.`,
    );
    return undefined;
  }
  const question = ctx.questionById.get(rule.target.id);
  const params = rule.effect.params;
  const fallback = params?.['when_empty'];
  if (typeof fallback !== 'string' || !isMaskFallback(fallback)) {
    unexpressible(
      rule,
      'mask_fallback_missing',
      path,
      ctx,
      'A mask rule needs fallback.when_empty and RuleEffect has no field for it; schema §15 ' +
        'gives it no default, because an empty masked question is an unrecoverable dead end and ' +
        'every one of the three answers is wrong for some survey. Author the mask on the ' +
        'question instead, where the field is required.',
      { when_empty: fallback === undefined ? null : (fallback as JsonValue) },
    );
    return undefined;
  }
  const declaredAxis = params?.['applies_to'];
  const axis =
    typeof declaredAxis === 'string' && isMaskTarget(declaredAxis)
      ? axisOf(declaredAxis)
      : populatedAxis(question);
  const value = rule.effect.value;
  if (value === undefined || value === null) {
    unexpressible(
      rule,
      'no_per_item_condition',
      path,
      ctx,
      'A mask rule carries its per-item condition in effect.value, and this one has none.',
    );
    return undefined;
  }
  return {
    action: 'mask',
    applies_to: axis,
    mode,
    per_item: asLogicExpr(value),
    fallback: { when_empty: fallback },
  };
}

/** Every mapping failure, under one code, discriminated by `detail.reason`. */
function unexpressible(
  rule: LogicRule,
  reason: string,
  path: string,
  ctx: Ctx,
  message: string,
  detail: { readonly [key: string]: JsonValue } = {},
): void {
  ctx.diagnostics.push(
    cmpDiagnostic('CMP-0702', message, `${path}/effect`, {
      rule_id: rule.id,
      kind: rule.kind,
      action: rule.effect.action,
      target_type: rule.target.type,
      reason,
      ...detail,
    }),
  );
}

/* ========================================================================== */
/* 4. Question-level masks                                                     */
/* ========================================================================== */

interface MaskSite {
  readonly question: QuestionNode;
  readonly mask: Mask;
  /** Index within `QuestionNode.masks`, which is the author's own order of application. */
  readonly index: number;
  readonly path: string;
}

/**
 * Every `QuestionNode.masks[]` entry, in document order, with a pointer to it.
 *
 * The walk carries the path rather than reconstructing it, for the reason `validateStructural`
 * does the same: a mask diagnostic that pointed only at the question would make the author
 * bisect a matrix with four masks by hand. Iterative, per this package's house rule — content
 * blocks nest, and a stack overflow in field is worse than one in CI.
 */
function maskSites(survey: Survey): readonly MaskSite[] {
  const out: MaskSite[] = [];
  const stack: { readonly node: ContentNode; readonly path: readonly (string | number)[] }[] = [];
  const pushAll = (nodes: readonly ContentNode[], base: readonly (string | number)[]): void => {
    for (let i = nodes.length - 1; i >= 0; i -= 1) {
      const node = nodes[i];
      if (node !== undefined) stack.push({ node, path: [...base, i] });
    }
  };
  pushAll(survey.content, ['content']);

  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) break;
    const node = frame.node;
    if (node.type === 'block' || node.type === 'page') {
      pushAll(node.children, [...frame.path, 'children']);
      continue;
    }
    if (node.type !== 'question') continue;
    (node.masks ?? []).forEach((mask, index) => {
      out.push({
        question: node,
        mask,
        index,
        path: pointer(...frame.path, 'masks', index),
      });
    });
  }
  return out;
}

/**
 * One `Rule` per authored mask.
 *
 * The condition is the literal `TRUE`, and it has to be: a `Mask` carries no condition at all —
 * neither here nor in the DSL's `MaskSpec` — because a mask *always* applies and the per-item
 * predicate plus the fallback are what vary. The consequence is that `checkRule` reports
 * `LGC-W030` ("condition is provably constant") for every synthesized mask rule, which is
 * correct and expected; the compile gate is where that is filtered, not here, because inventing
 * a non-constant condition (`ANSWERED(source)` is the tempting one) would silently replace the
 * author's `when_empty` with "show everything".
 */
function lowerQuestionMask(site: MaskSite, ctx: Ctx): Rule | undefined {
  const b = astBuilder();
  const perItem = perItemOf(site, b, ctx);
  if (perItem === undefined) return undefined;
  const questionSite = flowSiteOfQuestion(site.question.id, ctx);
  const axis = axisOf(site.mask.applies_to);
  return {
    id: synthesizedMaskRuleId(site.mask.id),
    kind: 'mask',
    target: { type: 'question', id: asQuestionId(site.question.id) },
    condition: b.boolLit(true),
    effect: {
      action: 'mask',
      applies_to: axis,
      mode: site.mask.mode === 'include' ? 'include' : 'exclude',
      per_item: perItem,
      fallback: { when_empty: site.mask.fallback.when_empty },
    },
    // `on_change` and not `on_page_enter`: the item set is a cell like any other and the graph
    // decides when it is recomputed. `on_page_enter` would be a claim about *when* that the
    // authoring model never made.
    evaluation: 'on_change',
    authored_in: 'visual',
    order_key: orderKeyOf(questionSite, AUTHORED_ORDER_SLOT + 1 + site.index, ctx),
    ...(questionSite === undefined ? {} : { flow_node_id: asFlowNodeId(questionSite) }),
    // A label, because E §14.2's trace shows `rule_label` and a mask that fires with a blank
    // one is the hardest kind of rule to recognize in a trace. Derived, so it is stable.
    label: `mask ${site.mask.mode} ${axis} of ${site.question.ref}`,
  };
}

/**
 * `MaskSource` → the per-item predicate, with `item` / `item_attr` bound by `checkEffect`.
 *
 * `selected_in` is spelled `CONTAINS(source, item)` for a set-typed source and `item == source`
 * for an enum-typed one, read off the declaration rather than assumed: a single-select source is
 * an ordinary "ask only about the brand they picked" mask, and `CONTAINS` on it would be
 * `LGC-T011` on a survey that is correct. A source that is neither still lowers to `CONTAINS`,
 * so the checker reports the real problem (a mask sourced from a number) under its own code.
 */
function perItemOf(site: MaskSite, b: AstBuilder, ctx: Ctx): Expr | undefined {
  const source = site.mask.source;
  switch (source.kind) {
    case 'selected_in':
      return membership(source.variable_id, b, ctx);
    case 'not_selected_in':
      return b.not(membership(source.variable_id, b, ctx));
    case 'explicit':
      return explicitCodes(site, source.item_ids, b, ctx);
    case 'expression_per_item':
      return asLogicExpr(source.condition);
    default: {
      const never: never = source;
      // Schema grew a mask source this compiler does not know. A diagnostic naming the mask
      // beats a crashed publish job, and beats a mask that silently keeps everything.
      void never;
      ctx.diagnostics.push(
        cmpDiagnostic(
          'CMP-0702',
          'Mask source kind is not one this compiler can lower to a per-item condition.',
          site.path,
          {
            rule_id: synthesizedMaskRuleId(site.mask.id),
            mask_id: site.mask.id,
            reason: 'unknown_mask_source',
          },
        ),
      );
      return undefined;
    }
  }
}

function membership(variableId: string, b: AstBuilder, ctx: Ctx): Expr {
  const id = asVariableId(variableId);
  const declared = ctx.env.byId(id);
  return declared?.type === 'enum'
    ? b.cmp('==', b.item(), b.variable(id))
    : b.setOp('contains', b.variable(id), b.item());
}

/**
 * An explicit item list, as a set literal when the question has a domain and as code
 * comparisons when it does not.
 *
 * The domain form is two nodes for twenty brands and states the nominal claim the checker can
 * verify; the fallback exists because a question with no enum-typed emission (a numeric matrix
 * masked on its rows) has no domain to build a set literal in, and `item_attr('code')` is `num`
 * for every question. Codes are resolved across all three axes rather than only the mask's own:
 * an author who names a row id on an options mask has made a mistake worth reporting, and an
 * axis-restricted lookup would silently drop the item instead.
 */
function explicitCodes(
  site: MaskSite,
  itemIds: readonly string[],
  b: AstBuilder,
  ctx: Ctx,
): Expr {
  const question = site.question;
  const byId = new Map<string, number>();
  for (const item of itemsOf(question)) {
    if (!byId.has(item.id)) byId.set(item.id, item.code);
  }

  const codes: number[] = [];
  const unresolved: string[] = [];
  for (const itemId of itemIds) {
    const code = byId.get(itemId);
    if (code === undefined) unresolved.push(itemId);
    else codes.push(code);
  }
  if (unresolved.length > 0) {
    ctx.diagnostics.push(
      cmpDiagnostic(
        'CMP-0702',
        `Mask on ${question.ref} names ${String(unresolved.length)} item(s) the question does ` +
          'not declare, so the mask keeps or drops items that do not exist.',
        site.path,
        {
          rule_id: synthesizedMaskRuleId(site.mask.id),
          mask_id: site.mask.id,
          reason: 'unresolved_mask_item',
          item_ids: unresolved,
        },
      ),
    );
  }

  const domain = ctx.env.question(asQuestionId(question.id))?.domain;
  if (domain !== undefined) return b.setOp('contains', b.setLit(codes, domain), b.item());
  const tests = codes.map((code) => b.cmp('==', b.itemAttr('code'), b.numLit(code)));
  const first = tests[0];
  if (first === undefined) return b.boolLit(false);
  return tests.length === 1 ? first : b.or(...tests);
}

/* ========================================================================== */
/* 5. Order keys and flow sites                                                */
/* ========================================================================== */

function orderKeyOf(flowNodeId: string | undefined, slot: number, ctx: Ctx): number {
  const position = flowNodeId === undefined ? undefined : ctx.graph.position.get(flowNodeId);
  const site = position ?? UNSCOPED_ORDER_SITE;
  return site * ORDER_KEY_SITE_STRIDE + slot;
}

/** The flow node a rule is evaluated at. See the header, part 3, on the `variable` arm. */
function flowSiteOf(target: RuleTarget, ctx: Ctx): string | undefined {
  switch (target.type) {
    case 'question':
      return flowSiteOfQuestion(target.id, ctx);
    case 'page':
    case 'block':
      return flowNodeOfNode(ctx.graph, target.id);
    case 'option': {
      const question = ctx.questionOfOption.get(target.id);
      return question === undefined ? undefined : flowSiteOfQuestion(question, ctx);
    }
    case 'variable': {
      const question = ctx.questionOfVariable.get(target.id);
      return question === undefined ? undefined : flowSiteOfQuestion(question, ctx);
    }
    case 'survey':
      return undefined;
    default: {
      const never: never = target;
      throw new Error(`Unhandled rule target: ${JSON.stringify(never)}`);
    }
  }
}

/**
 * A question's own flow site, falling back to its page's.
 *
 * `contentSites` carries question ids as well as page ids — a flow node that lays out a page lays
 * out its children — so the direct lookup answers for every laid-out question. The fallback is
 * for a question reached through a site recorded on the page alone.
 */
function flowSiteOfQuestion(questionId: string, ctx: Ctx): string | undefined {
  const direct = flowNodeOfNode(ctx.graph, questionId);
  if (direct !== undefined) return direct;
  const page = ctx.pageOfQuestion.get(questionId);
  return page === undefined ? undefined : flowNodeOfNode(ctx.graph, page);
}

/* ========================================================================== */
/* 6. The boundary casts                                                       */
/* ========================================================================== */

/**
 * Schema's six-arm `RuleTarget` → logic's six-arm `Target`.
 *
 * The ids are branded at exactly this point. `asQuestionId` and friends throw on a wrong prefix,
 * which is correct here for the reason `registry.ts` gives: prefix wellformedness is
 * `validateStructural`'s contract (it checks each arm's id against `['qst']`, `['pg']`, …) and
 * the gate runs it first, so a throw means a caller skipped the gate rather than that an author
 * typed something.
 */
function targetOf(target: RuleTarget): Target {
  switch (target.type) {
    case 'question':
      return { type: 'question', id: asQuestionId(target.id) };
    case 'page':
      return { type: 'page', id: asPageId(target.id) };
    case 'block':
      return { type: 'block', id: asBlockId(target.id) };
    case 'option':
      return { type: 'option', id: asOptionId(target.id) };
    case 'variable':
      return { type: 'variable', id: asVariableId(target.id) };
    case 'survey':
      return { type: 'survey' };
    default: {
      const never: never = target;
      throw new Error(`Unhandled rule target: ${JSON.stringify(never)}`);
    }
  }
}

/**
 * Where a `set` writes: the rule's target, or `effect.target_id` when the target is elsewhere.
 *
 * B §4.4's `rules_one_target` makes `target_kind = 'variable'` biconditional with
 * `target_variable_id`, so the target is the authoritative carrier; `effect.target_id` is read as
 * a fallback because schema permits a `var_` id there and a document written by hand may use it.
 * Prefix-tested rather than branded, so a `set` pointed at a question is a diagnostic and not a
 * throw — unlike `target`, this field's own prefix set is not checked per arm by the gate.
 */
function setTargetOf(rule: LogicRule): VariableId | undefined {
  if (rule.target.type === 'variable') return asVariableId(rule.target.id);
  const explicit = rule.effect.target_id;
  if (explicit !== undefined && explicit !== null && hasPrefix('var', explicit)) {
    return asVariableId(explicit);
  }
  return undefined;
}

/**
 * Every one of these is a `switch` over strings that coincide today, and not a cast, for the
 * reason `partKindOf` states in `registry.ts`: the two unions are declared independently
 * (`packages/logic` cannot import schema — ADR-010), so a new member on either side has to be a
 * compile error somewhere, and this file is the only place it can be.
 */
function kindOf(kind: SchemaRuleKind): RuleKind {
  switch (kind) {
    case 'display':
      return 'display';
    case 'skip':
      return 'skip';
    case 'mask':
      return 'mask';
    case 'set_variable':
      return 'set_variable';
    case 'validate':
      return 'validate';
    case 'option_state':
      return 'option_state';
    case 'terminate':
      return 'terminate';
    default: {
      const never: never = kind;
      throw new Error(`Unhandled rule kind: ${JSON.stringify(never)}`);
    }
  }
}

function evaluationOf(evaluation: SchemaEvaluation | undefined): RuleEvaluation {
  switch (evaluation) {
    case 'on_page_enter':
      return 'on_page_enter';
    case 'on_submit':
      return 'on_submit';
    case 'on_change':
    case undefined:
      // The schema field is optional and the engine's is not. `on_change` is the recompute
      // discipline the cell graph already implements, so it is the default that adds no claim.
      return 'on_change';
    default: {
      const never: never = evaluation;
      throw new Error(`Unhandled rule evaluation: ${JSON.stringify(never)}`);
    }
  }
}

function authoredInOf(authoredIn: SchemaAuthoredIn | undefined): 'visual' | 'dsl' {
  switch (authoredIn) {
    case 'dsl':
      return 'dsl';
    case 'visual':
    case undefined:
      // Matches `content.logic_rules.authored_in`'s own column default, and for its reason: it
      // is the claim that promises the least, so a writer that forgot understates fidelity.
      return 'visual';
    default: {
      const never: never = authoredIn;
      throw new Error(`Unhandled authored_in: ${JSON.stringify(never)}`);
    }
  }
}

/**
 * `TERMINATE` with no disposition is `TERMINATE`, not `SCREENOUT`.
 *
 * Both are terminal, flow-reachable and redirect-required, so `CMP-0300` behaves identically on
 * either. The difference is what the export claims: "screened out" is an analytic statement about
 * why the respondent left, and the document did not make it.
 */
function dispositionOf(disposition: SchemaDisposition | null | undefined): Disposition {
  switch (disposition) {
    case 'COMPLETE':
      return 'COMPLETE';
    case 'SCREENOUT':
      return 'SCREENOUT';
    case 'QUOTA_FULL':
      return 'QUOTA_FULL';
    case 'QUALITY':
      return 'QUALITY';
    case 'DUPLICATE':
      return 'DUPLICATE';
    case 'FRAUD':
      return 'FRAUD';
    case 'CUSTOM':
      return 'CUSTOM';
    case 'IN_PROGRESS':
      return 'IN_PROGRESS';
    case 'ABANDONED':
      return 'ABANDONED';
    case 'TIMED_OUT':
      return 'TIMED_OUT';
    case 'TERMINATE':
    case null:
    case undefined:
      return 'TERMINATE';
    default: {
      const never: never = disposition;
      throw new Error(`Unhandled disposition: ${JSON.stringify(never)}`);
    }
  }
}

function axisOf(target: MaskTarget): MaskAxis {
  switch (target) {
    case 'options':
      return 'options';
    case 'rows':
      return 'rows';
    case 'columns':
      return 'columns';
    default: {
      const never: never = target;
      throw new Error(`Unhandled mask axis: ${JSON.stringify(never)}`);
    }
  }
}

function isMaskFallback(value: string): value is MaskFallback {
  return (MASK_FALLBACKS as readonly string[]).includes(value);
}

function isMaskTarget(value: string): value is MaskTarget {
  return value === 'options' || value === 'rows' || value === 'columns';
}

/** The axis a mask rule means when it does not say. See `maskEffect`. */
function populatedAxis(question: QuestionNode | undefined): MaskAxis {
  if (question === undefined) return 'options';
  if ((question.options ?? []).length > 0) return 'options';
  if ((question.rows ?? []).length > 0) return 'rows';
  if ((question.columns ?? []).length > 0) return 'columns';
  return 'options';
}

/**
 * Schema carries the AST opaquely (`{ op: string, …JSON }`) and says the checker is where a wrong
 * `op` becomes an error. That checker is `checkExpr`, which reports `LGC-T002`; re-deciding it
 * here would either duplicate `isExprShape` or reject a node kind logic knows and this file does
 * not. Same cast, same reasoning, as `registry.ts`.
 */
function asLogicExpr(expression: SchemaExpr): Expr {
  return expression as unknown as Expr;
}

/* ========================================================================== */
/* 7. Indexes                                                                  */
/* ========================================================================== */

/** Option / row / column id → its question, so an option-targeted rule can find a flow site. */
function indexOptions(questions: readonly QuestionNode[]): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const question of questions) {
    for (const item of itemsOf(question)) {
      if (!out.has(item.id)) out.set(item.id, question.id);
    }
  }
  return out;
}

function indexVariables(survey: Survey): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const variable of survey.variables) {
    const questionId = variable.source?.question_id;
    if (questionId !== undefined) out.set(variable.id, questionId);
  }
  return out;
}

function indexQuestions(questions: readonly QuestionNode[]): ReadonlyMap<string, QuestionNode> {
  const out = new Map<string, QuestionNode>();
  for (const question of questions) out.set(question.id, question);
  return out;
}

/** Every item of every axis, in axis order. Masks and the option index both read all three. */
function itemsOf(question: QuestionNode): readonly QuestionItem[] {
  return [...(question.options ?? []), ...(question.rows ?? []), ...(question.columns ?? [])];
}

/** Iterative, for the reason `maskSites` is: blocks nest. */
function questionsOf(survey: Survey): readonly QuestionNode[] {
  const out: QuestionNode[] = [];
  const stack: ContentNode[] = [];
  const pushAll = (nodes: readonly ContentNode[]): void => {
    for (let i = nodes.length - 1; i >= 0; i -= 1) {
      const node = nodes[i];
      if (node !== undefined) stack.push(node);
    }
  };
  pushAll(survey.content);
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) break;
    if (node.type === 'block' || node.type === 'page') pushAll(node.children);
    else if (node.type === 'question') out.push(node);
  }
  return out;
}
