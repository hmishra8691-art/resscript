/**
 * The expressions the authoring model deliberately does not store — C §4, D §2.2, F §1.1.
 *
 * WHY THIS FILE EXISTS. `validateStructural` permits `kind: 'derived'` with **no** `expression`
 * when the variable has a `source`, and says why in its own comment: the multi-select set view
 * and the NPS band "are synthesized at compile time from the question's own structure", because
 * Deliverable D's AST has no operator that collects the true booleans of a fan-out and a band
 * table is data rather than an expression. `question-kit` states the same fact from the other
 * side as `Derivation = { kind: 'structural' }`. Somebody has to turn that declaration into an
 * actual `Expr` before `compileLogic` can build a cell for it, and this is that somebody: the
 * derived variable's `value` cell has a writer only if this file produced one
 * (`packages/logic/src/compile.ts` skips a `derived` decl whose `expression` is `undefined`).
 *
 * WHY IT ROUTES THROUGH `question-kit` FIRST. `StructuralDerivation` is the plugin's own
 * statement of what the derivation is — which booleans, in which order, and for the band which
 * intervals map to which codes. `planQuestionEmissions` in `packages/schema` can be asked the
 * same question, but its own comment calls it a stand-in for the plugin contract ("In P1-04 this
 * becomes the plugin contract's `declareVariables()`"), so reading it in preference to the
 * plugin would make a first-party table authoritative over the plugin that replaced it. The
 * sibling-scan fallback below exists for the case a caller passes no registry (fixtures do, and
 * `CompileInput.plugins` is optional for exactly that reason); it reconstructs the same
 * information from `survey.variables`, which is the only other place it is recorded.
 *
 * WHAT IT REFUSES TO DO. It reports nothing about plugins. A missing or throwing plugin is
 * `CMP-0400`/`CMP-0401`, owned by the plugin pass; emitting a second diagnostic here would
 * double-report the same fact against a different code. When the plugin path yields nothing this
 * file falls back silently and, if the fallback yields nothing either, returns `undefined` so
 * the caller can raise the one diagnostic that is genuinely ours (`CMP-0103`).
 *
 * WHY EVERY TREE COMES FROM `astBuilder()`. D §2.1 item 4: node ids are the memo table's index.
 * A hand-written tree with a duplicated `n` still evaluates — it just returns another node's
 * cached value — so the failure is a wrong verdict rather than a crash, and it is invisible in
 * review. The builder owns the counter, so it cannot happen. Ids restart at 1 per expression,
 * which is what `compileLogic`'s CSE pass expects: it hash-conses and renumbers globally.
 */

import {
  walkQuestions,
  type JsonObject,
  type LoopSpec,
  type QuestionId,
  type QuestionNode,
  type Survey,
  type Variable,
  type VariablePart,
} from '@resscript/schema';
import { astBuilder, type DomainId, type Expr, type VariableId } from '@resscript/logic';
import {
  NPS_BANDS,
  applySchemaDefaults,
  declareVariablesFor,
  fromQuestionNode,
  type DeclarationPart,
  type NumericBand,
  type PluginRegistry,
  type StructuralDerivation,
} from '@resscript/question-kit';

import type { CompileDiagnostic } from './diagnostics.js';

/**
 * Everything the synthesis needs that only the registry adapter can know.
 *
 * `domain` and `variableId` are passed in rather than recomputed because both are decisions
 * `registry.ts` has already made: the domain id is *synthesized* (there is no `enum_domain_id`
 * column — CONTEXT decision 6), so a second synthesis here could disagree with the first, and
 * the resulting `set<dom_a>` expression assigned to a `set<dom_b>` variable would be an
 * `LGC-T021` that names two ids the author never wrote.
 */
export interface DeriveContext {
  /** The question that emits the variable. */
  readonly question: QuestionNode;
  /** The variable's own synthesized enum domain. Absent when it is not an enum/set. */
  readonly domain: DomainId | undefined;
  /** Every variable this question emits, across every loop iteration, in registry order. */
  readonly variablesOfQuestion: readonly Variable[];
  /** Variable name → id, over the whole registry. Kit declarations name their members. */
  readonly variableId: (name: string) => VariableId | undefined;
  /** Defaults to none; see the header on why an absent registry is a supported case. */
  readonly plugins?: PluginRegistry | undefined;
}

export interface SynthesizedDerivation {
  readonly expression: Expr;
  /**
   * Reserved for a synthesis that succeeds but is worth reporting. Empty today: every failure
   * mode found so far is total (there is nothing to build), and a half-built expression is worse
   * than none — it type-checks and computes the wrong set.
   */
  readonly diagnostics: readonly CompileDiagnostic[];
}

/**
 * One member of a set view: the boolean that carries it and the code it stands for.
 *
 * Resolved to a `VariableId` here rather than carried as a name because the AST references ids
 * (D §2.1 item 3) — a name in an AST would break on the next `renameRef`.
 */
interface ResolvedMember {
  readonly id: VariableId;
  readonly code: number;
}

/**
 * Synthesize the expression a structurally derived variable was declared without.
 *
 * `undefined` means "there is no structure here to derive from", which is the caller's cue to
 * emit `CMP-0103`. It is never a silent success: a `derived` variable with no expression has no
 * cell writer, so the respondent sees a permanently-null column.
 */
export function synthesizeDerived(
  survey: Survey,
  variable: Variable,
  context: DeriveContext,
): SynthesizedDerivation | undefined {
  const part = variable.source?.part;
  if (part === undefined) return undefined;
  switch (part.kind) {
    case 'set_view':
      return setViewExpression(survey, variable, context);
    case 'suffix':
      // Only `band` today. A plugin that declares another suffixed companion gets it synthesized
      // as soon as its declaration is a `numeric_band`; anything else is an unknown computation
      // and must fail loudly rather than compile to a null column.
      return bandExpression(survey, variable, context);
    case 'scalar':
    case 'option':
    case 'row':
    case 'column':
    case 'cell':
    case 'other_specify':
    case 'design_task':
      return undefined;
    default: {
      const never: never = part;
      // Not a throw: an unrecognized part reaching here means schema grew an arm, and the
      // compiler's answer to that is a diagnostic naming the variable, not a crashed job.
      void never;
      return undefined;
    }
  }
}

/* ========================================================================== */
/* 1. The set view over a fan-out                                              */
/* ========================================================================== */

/**
 * `Q2 : set<dom_q2>` — the codes whose boolean fan-out member is true.
 *
 * ENCODING, and why it is not an `agg`. The natural reading is "aggregate the question's own
 * emissions", and `{ kind: 'question_emits', question_id }` even excludes the `set_view` itself
 * so the group is exactly the fan-out. But no aggregation function in `AGG_FNS` returns a set:
 * `check.ts`'s `aggResultType` maps count/distinct_count to `num`, sum/mean/stdev to `num`,
 * min/max to the (ordered) member type, any/all to `bool` and first/last_answered to the member
 * type — and the member type here is `bool`, not `enum`. So every `agg` spelling of this either
 * type-errors or produces a boolean. Writing it as `agg` would need a `collect` function, i.e. a
 * new member of a closed registry that the parser, the printer and the builder UI all have to
 * grow (D §7.2's four-file rule) — for one synthesized expression no author can write.
 *
 * So it is an explicit `union` fold over one `case` per option:
 *
 *   union(union(CASE WHEN Q2r1 THEN {1} ELSE {} END, CASE WHEN Q2r2 THEN {2} ELSE {} END), …)
 *
 * which types as `set<dom>` by the rules already in the checker (`case` unifies `set<dom>` with
 * `set<dom>`; `union` of two `set<dom>` is `set<dom>`) and whose value is exactly
 * `evaluateDerivation`'s `set_view`: the codes of the true members, order-free. Left-associated
 * so the tree is deterministic, which matters because CSE hash-conses it.
 */
function setViewExpression(
  survey: Survey,
  variable: Variable,
  context: DeriveContext,
): SynthesizedDerivation | undefined {
  const domain = context.domain;
  if (domain === undefined) return undefined;
  const members = setViewMembers(survey, variable, context);
  // Zero members is a multi-select with no options. `union` has no identity element to fold from
  // and an empty-set literal would compile a column that is always `{}`, which reads as real
  // data; the question itself is the defect and the caller says so.
  if (members === undefined || members.length === 0) return undefined;

  const b = astBuilder();
  const arms = members.map((member) =>
    b.caseExpr(
      [{ when: b.variable(member.id), then: b.setLit([member.code], domain) }],
      b.setLit([], domain),
    ),
  );
  let expression: Expr | undefined;
  for (const arm of arms) {
    expression = expression === undefined ? arm : b.setOp('union', expression, arm);
  }
  return expression === undefined ? undefined : { expression, diagnostics: [] };
}

function setViewMembers(
  survey: Survey,
  variable: Variable,
  context: DeriveContext,
): readonly ResolvedMember[] | undefined {
  const declared = structuralDerivation(survey, variable, context);
  if (declared !== undefined && declared.computation === 'set_view') {
    const out: ResolvedMember[] = [];
    for (const member of declared.members) {
      const id = context.variableId(member.variableName);
      // A non-numeric code cannot become an `enum` literal: logic's `LiteralValue` types enum and
      // set codes as `number`. `interop.ts` refuses the same coercion for the same reason —
      // `Number('BRAND_C')` fabricates a code and `Number('07')` collides with an existing one.
      if (id === undefined || typeof member.code !== 'number') return undefined;
      out.push({ id, code: member.code });
    }
    return out;
  }
  return siblingFanOut(variable, context);
}

/**
 * The fallback: the question's own `option` variables, from the registry.
 *
 * Restricted to the variable's own loop iteration. A set view at iteration 3 that collected
 * iteration 1's booleans would be wrong in a way that only shows up on looped surveys, which is
 * the class of bug nobody finds in a test wave.
 */
function siblingFanOut(
  variable: Variable,
  context: DeriveContext,
): readonly ResolvedMember[] | undefined {
  const iteration = variable.source?.iteration;
  const out: ResolvedMember[] = [];
  for (const sibling of context.variablesOfQuestion) {
    const part = sibling.source?.part;
    if (part === undefined || part.kind !== 'option') continue;
    if (sibling.source?.iteration !== iteration) continue;
    const id = context.variableId(sibling.name);
    if (id === undefined) return undefined;
    out.push({ id, code: part.code });
  }
  // Ordered by code, not by registry position: the code is the item's stable identity (C §5.1),
  // so reordering the option list must not change the compiled tree and therefore must not
  // change the artifact hash.
  return [...out].sort((a, b) => a.code - b.code);
}

/* ========================================================================== */
/* 2. The band over a scalar                                                   */
/* ========================================================================== */

/**
 * `Q7_band : enum<dom_q7>` — a closed-interval table over the scalar the same question emits.
 *
 * `case` with a required `else`: D §2.3 argues at length against implicit null fallthrough, and
 * the else arm carries real meaning here. `evaluateDerivation`'s `numeric_band` returns `null`
 * for a score outside every band ("out of every band is `null`, not the nearest band: … quietly
 * rounding it into a band would fabricate a promoter"), so the else arm is a null literal, and
 * `unify` accepts it against `enum<dom>` because nullity is a value-level property (D §3.1).
 */
function bandExpression(
  survey: Survey,
  variable: Variable,
  context: DeriveContext,
): SynthesizedDerivation | undefined {
  const domain = context.domain;
  if (domain === undefined) return undefined;

  const declared = structuralDerivation(survey, variable, context);
  const banded =
    declared !== undefined && declared.computation === 'numeric_band' ? declared : undefined;
  // The fallback table applies to the suffix `band` and to nothing else. Without that guard a
  // plugin companion named `Q9_raw` — a suffix this compiler has never heard of — would silently
  // compile to the NPS band table over whatever scalar the question happens to emit, which type
  // checks, evaluates, and is wrong. An unknown suffix has to reach `CMP-0103`.
  const suffix = variable.source?.part.kind === 'suffix' ? variable.source.part.suffix : undefined;
  if (banded === undefined && suffix !== 'band') return undefined;
  const bands: readonly NumericBand[] = banded?.bands ?? NPS_BANDS;
  const source =
    banded === undefined ? siblingScalar(variable, context) : context.variableId(banded.source);
  if (source === undefined || bands.length === 0) return undefined;

  const codes: number[] = [];
  for (const band of bands) {
    if (typeof band.code !== 'number') return undefined;
    codes.push(band.code);
  }

  const b = astBuilder();
  const cases = bands.map((band, index) => ({
    when: b.and(
      b.cmp('>=', b.variable(source), b.numLit(band.from)),
      b.cmp('<=', b.variable(source), b.numLit(band.to)),
    ),
    then: b.enumLit(codes[index] ?? 0, domain),
  }));
  return { expression: b.caseExpr(cases, b.nullLit()), diagnostics: [] };
}

/**
 * The fallback source for a band: the scalar the same question and iteration emits.
 *
 * The codes come from `NPS_BANDS` and never from a local table. That constant's own comment pins
 * it to schema's `NPS_BAND_DOMAIN` ("Codes match `NPS_BAND_DOMAIN`'s ordering") — which is the
 * domain the synthesized enum literals are read against — and a third definition of "code 1 is
 * detractor" would eventually be the one that is wrong.
 */
function siblingScalar(variable: Variable, context: DeriveContext): VariableId | undefined {
  const iteration = variable.source?.iteration;
  for (const sibling of context.variablesOfQuestion) {
    if (sibling.source?.part.kind !== 'scalar') continue;
    if (sibling.source.iteration !== iteration) continue;
    return context.variableId(sibling.name);
  }
  return undefined;
}

/* ========================================================================== */
/* 3. Asking the plugin                                                        */
/* ========================================================================== */

/**
 * The plugin's own `StructuralDerivation` for this variable, when there is one.
 *
 * Config defaults are applied first. Without them a plugin that reads a defaulted key
 * (`multi_select`'s `ctx.config.other.enabled`) throws on a question whose stored config predates
 * that key, and F §5's "a new optional field with a default is backward compatible" promise is
 * only real if the top-up happens on every path that calls the plugin — the same argument
 * `declare.ts`'s `compose` makes for cell controls.
 */
function structuralDerivation(
  survey: Survey,
  variable: Variable,
  context: DeriveContext,
): StructuralDerivation | undefined {
  const plugins = context.plugins;
  const part = variable.source?.part;
  if (plugins === undefined || part === undefined) return undefined;
  const resolved = plugins.resolveForCompile(context.question.question_type);
  if (resolved === undefined) return undefined;

  const config = applySchemaDefaults(
    resolved.plugin.configSchema,
    context.question.config ?? {},
  ) as JsonObject;
  const loop = loopOf(survey, context.question.id);
  const iteration = variable.source?.iteration;
  const authored = fromQuestionNode(
    { ...context.question, config },
    loop === undefined || iteration === undefined ? {} : { loop: { spec: loop, iteration } },
  );

  const { declarations } = declareVariablesFor(resolved.plugin, authored, { registry: plugins });
  for (const declaration of declarations) {
    if (declaration.kind !== 'derived') continue;
    if (declaration.derivation.kind !== 'structural') continue;
    if (!partsAgree(declaration.source.part, part)) continue;
    return declaration.derivation.structural;
  }
  return undefined;
}

/**
 * Do a kit declaration part and a stored part describe the same variable?
 *
 * Only the two structurally-derivable shapes are compared, and by tag rather than through
 * `toVariablePart`: that function needs an item-ref resolver and a code lookup to answer a
 * question that here has no items in it at all.
 */
function partsAgree(declared: DeclarationPart, stored: VariablePart): boolean {
  if (stored.kind === 'set_view') return declared.kind === 'set_view';
  if (stored.kind === 'suffix') {
    return declared.kind === 'meta' && declared.suffix === stored.suffix;
  }
  return false;
}

/**
 * The innermost loop enclosing a question, or `undefined`.
 *
 * Resolved through `walkQuestions` rather than by a second tree walk of our own, because it
 * already implements the "innermost enclosing loop wins" rule and nested loops are `CMP-0100`
 * anyway (CONTEXT decision 9).
 */
function loopOf(survey: Survey, questionId: QuestionId): LoopSpec | undefined {
  let found: LoopSpec | undefined;
  walkQuestions(survey.content, (question, loop) => {
    if (question.id === questionId && loop !== undefined) found = loop;
  });
  return found;
}
