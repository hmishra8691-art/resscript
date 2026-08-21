/**
 * The three quota checks P1-08 owns: `LGC-Q001` (a cell that can never be filled), `LGC-Q002`
 * (targets that do not add up) and `LGC-Q003` (a dimension that reads a variable collected after
 * the gate) — C §8, D §8.3, roadmap P1-08.
 *
 * WHY THESE THREE AND NOT MORE. `validateStructural` already owns everything decidable from the
 * document alone: `counter_scope` presence, id prefixes, refs, `dimension_ids` resolution, and the
 * `quota_gate` → plan-ref check. What is left needs the two things it cannot have — the abstract
 * solver (is this conjunction of bucket predicates satisfiable at all?) and the flow graph (is the
 * variable this dimension reads written before the gate?). Those are exactly the three codes
 * `packages/logic`'s catalogue reserved, so they are emitted under the reserved codes rather than
 * under parallel `CMP-` ones.
 *
 * ## Q001's severity: the catalogue wins over the roadmap
 *
 * The roadmap sentence this file implements calls the result a *warning*: "Publishing a plan whose
 * `[M,18_24]` cell is unreachable because the screener terminates all males produces a warning
 * naming the cell and the terminating rule." `packages/logic/src/diagnostics.ts` fixes
 * `LGC-Q001` as an **error**, and that is what is emitted here. The catalogue is the contract —
 * `LGC_SEVERITY` is a total map from code to severity precisely so that severity is a property of
 * the code and not of the call site, and `fromLogicDiagnostic` carries it through unchanged; there
 * is no API by which this file could downgrade it without lying about the code. The disagreement is
 * recorded rather than resolved silently. (It is also the defensible direction: an unfillable cell
 * in a sample plan does not become fillable in field, and a plan that cannot be filled is a
 * commercial commitment that cannot be met.)
 *
 * ## What "can never be filled" is allowed to mean
 *
 * Soundness runs in one direction, the same direction `solver.ts` states at length: the gate may
 * answer "don't know" as often as it likes and may never claim a fillable cell is unfillable. Three
 * grounds are accepted, and each is a claim about *every* respondent:
 *
 *  1. **A contradictory key.** The conjunction of the cell's per-dimension bucket `match`
 *     expressions is provably never true, so no respondent is ever assigned that combination. This
 *     is `provablyNeverTrue` on the conjunction — one call, not a bespoke domain, because a second
 *     notion of "provably false" living here is how two analyses come to disagree about one
 *     predicate (`solver.ts`'s header makes the same point about `unreachable.ts`).
 *  2. **A contradictory bucket.** One bucket's own `match` is unsatisfiable, so nobody is ever in
 *     it, so no cell keyed on it fills. Reported separately from (1) only so `detail.reason` sends
 *     the author to the bucket rather than to the cell key.
 *  3. **A screener that terminates the whole cell.** There is a `terminate` rule whose flow site
 *     dominates the gate — every respondent is evaluated against it before the gate can assign a
 *     bucket — and no assignment satisfies the cell's key without firing it. Formally
 *     `provablyNeverTrue(key ∧ ¬condition)`: if the key can hold with the terminate condition
 *     false, some respondent reaches the gate inside the cell, and there is no claim to make.
 *     Dominance is required rather than mere reachability because a terminate on one arm of a
 *     branch says nothing about the respondents who took the other arm.
 *
 * A fourth ground is deliberately absent: a cell keyed on a bucket ref no dimension declares is
 * also unfillable, and it is reported — under (1)'s code with `reason: 'unresolved_bucket'` —
 * because nothing else in the pipeline checks cell keys at all (`checkQuotas` validates
 * `dimension_ids` and stops). If a `SCH-` code ever grows for it, this arm should go.
 *
 * ## Q003 is an availability question, and it is asked at the error strength
 *
 * A dimension can only assign a bucket if the variable it reads — and every variable its buckets'
 * `match` expressions read — already has a value when the gate runs. That is the same dominance
 * question D §8.1 asks about a rule, so it is answered with the same machinery:
 * `buildVariableSites` and `writeSetDominates` from `forward-ref.ts`, not a second derivation.
 *
 * `LGC-Q003` is an error, so it is only emitted on the strong claim — *no* write site lies on any
 * path to the gate, which is `forward-ref.ts`' `none` case. The intermediate case (written on some
 * paths and not others: those respondents fall in no bucket, everyone else is fine) is the shape
 * `LGC-F002` exists for and there is no reserved quota warning to carry it, so it is silent here
 * rather than reported as an error the author cannot clear. Deciding it needs one fact
 * `forward-ref.ts` does not export — "is the gate reachable *from* this write site" — so a
 * four-line successor walk lives below. It is successor reachability, not a second dominance
 * implementation.
 *
 * ## What this module refuses to do
 *
 * It does not check `vendor_limits` against plan targets (a vendor cap is a per-vendor ceiling, not
 * a plan total, so "the plan is over-constrained" does not follow from one), it does not report an
 * interlocked plan whose cross-product is only partly enumerated (missing cells are *uncapped*,
 * which is a decision, not an inconsistency), and it does not report a plan with no gate. The
 * `LGC-Q002` section states its own omissions where they are made.
 */

import {
  DISPOSITION_FACTS,
  pointer,
  type Disposition,
  type Expr as SchemaExpr,
  type QuotaBucket,
  type QuotaCell,
  type QuotaDimension,
  type QuotaPlan,
  type Survey,
  type VariableId as SchemaVariableId,
} from '@resscript/schema';
import {
  asVariableId,
  astBuilder,
  diagnostic,
  readsOf,
  type Expr,
  type LgcJsonValue,
  type Rule,
  type TypeEnv,
  type VariableId,
} from '@resscript/logic';

import { fromLogicDiagnostic, sortCompileDiagnostics, type CompileDiagnostic } from '../diagnostics.js';
import { dominates, type FlowGraph, type VariableSites } from '../types.js';
import { provablyNeverTrue } from './solver.js';
import { writeSetDominates } from './forward-ref.js';

/* ========================================================================== */
/* 1. The input                                                                */
/* ========================================================================== */

export interface QuotasInput {
  readonly survey: Survey;
  readonly graph: FlowGraph;
  /** `buildRules`' output: the `terminate` rules and their resolved flow sites. */
  readonly rules: readonly Rule[];
  readonly env: TypeEnv;
  /** `buildVariableSites`' output, shared with the forward-reference pass. */
  readonly sites: VariableSites;
}

/**
 * How far a percentage sum may drift from 100 before it is called inconsistent.
 *
 * Half a percentage point, in the units the field is authored in. Not zero: a 7-cell plan split
 * evenly is authored as 14.3 seven times, which sums to 100.1, and an author who wrote the obvious
 * thing must not be told their plan is broken. Not larger: at 1.0 a plan that genuinely omits a
 * one-percent cell reads as fine, and the omission is the defect this check is for.
 */
export const PERCENTAGE_SUM_TOLERANCE = 0.5;

/** The nominal total a percentage-mode plan's cells must sum to. */
const PERCENTAGE_TOTAL = 100;

/** Cap on the ids a single diagnostic lists. A 400-cell plan must not produce a 400-id detail. */
const MAX_DETAIL_ITEMS = 20;

export function analyzeQuotas(input: QuotasInput): readonly CompileDiagnostic[] {
  const quotas = input.survey.quotas;
  if (quotas === undefined || quotas === null) return [];
  const ctx = buildContext(input);
  return sortCompileDiagnostics([
    ...unfillableCells(ctx),
    ...inconsistentTargets(ctx),
    ...postGateDimensions(ctx),
  ]);
}

/* ========================================================================== */
/* 2. The shared index                                                         */
/* ========================================================================== */

interface Terminator {
  readonly ruleId: string;
  readonly condition: Expr;
  readonly disposition: Disposition;
  /** `undefined` = survey-scoped, which is evaluated everywhere and so precedes every gate. */
  readonly flowNodeId: string | undefined;
}

interface Ctx {
  readonly survey: Survey;
  readonly graph: FlowGraph;
  readonly env: TypeEnv;
  readonly sites: VariableSites;
  readonly dimensions: ReadonlyMap<string, QuotaDimension>;
  /** Dimension index in `quotas.dimensions`, for pointers. */
  readonly dimensionAt: ReadonlyMap<string, number>;
  /** Plan ref → the reachable `quota_gate` nodes that gate it, in flow order. */
  readonly gates: ReadonlyMap<string, readonly string[]>;
  readonly terminators: readonly Terminator[];
}

function buildContext(input: QuotasInput): Ctx {
  const quotas = input.survey.quotas;
  const dimensions = new Map<string, QuotaDimension>();
  const dimensionAt = new Map<string, number>();
  (quotas?.dimensions ?? []).forEach((dimension, index) => {
    if (!dimensions.has(dimension.id)) {
      dimensions.set(dimension.id, dimension);
      dimensionAt.set(dimension.id, index);
    }
  });

  // Flow order, not document order: the first gate a respondent meets is the one whose
  // diagnostics an author reads first, and `graph.order` is the only order that says which.
  const gates = new Map<string, string[]>();
  for (const id of input.graph.order) {
    const node = input.graph.nodes.get(id);
    if (node?.type !== 'quota_gate') continue;
    const existing = gates.get(node.quota_ref);
    if (existing === undefined) gates.set(node.quota_ref, [id]);
    else existing.push(id);
  }

  const terminators: Terminator[] = [];
  for (const rule of input.rules) {
    if (rule.effect.action !== 'terminate') continue;
    // A non-terminal disposition on a terminate effect cannot be produced by `rules.ts`'
    // mapping, but the union admits `IN_PROGRESS`, and "the respondent continues" is not a
    // termination — claiming a cell is closed by one would be the unsound direction.
    if (!DISPOSITION_FACTS[rule.effect.disposition].terminal) continue;
    terminators.push({
      ruleId: rule.id,
      condition: rule.condition,
      disposition: rule.effect.disposition,
      flowNodeId: rule.flow_node_id,
    });
  }

  return {
    survey: input.survey,
    graph: input.graph,
    env: input.env,
    sites: input.sites,
    dimensions,
    dimensionAt,
    gates,
    terminators,
  };
}

/**
 * Schema carries an AST opaquely (`{ op: string, …JSON }`) and names the checker as the place a
 * wrong `op` becomes an error. Same cast, same reasoning, as `registry.ts` and `rules.ts`: the
 * checker reports `LGC-T002`, and re-deciding node shapes here would reject kinds logic knows.
 */
function asLogicExpr(expression: SchemaExpr): Expr {
  return expression as unknown as Expr;
}

/**
 * The return leg of the id boundary, exactly as `forward-ref.ts` states it: `VariableSites` is
 * keyed in schema's id space and `TypeEnv` answers in logic's, and the prefix was checked on the
 * way in. Unchecked here for that reason — a second parse is a second contract.
 */
function schemaVariableId(id: VariableId): SchemaVariableId {
  return id as unknown as SchemaVariableId;
}

/* ========================================================================== */
/* 3. LGC-Q001 — a cell that can never be filled                               */
/* ========================================================================== */

/** One resolved position of a cell key: which dimension, which bucket. */
interface KeyPart {
  readonly dimension: QuotaDimension;
  readonly bucket: QuotaBucket;
}

interface ResolvedKey {
  readonly parts: readonly KeyPart[];
  /** Bucket refs the key names that no dimension at that position declares. */
  readonly unresolved: readonly string[];
}

function resolveKey(plan: QuotaPlan, cell: QuotaCell, ctx: Ctx): ResolvedKey {
  const parts: KeyPart[] = [];
  const unresolved: string[] = [];
  plan.dimension_ids.forEach((dimensionId, position) => {
    const dimension = ctx.dimensions.get(dimensionId);
    // An unresolvable dimension id is `SCH-1004` from `checkQuotas`; nothing to add.
    if (dimension === undefined) return;
    const ref = cell.key[position];
    if (ref === undefined) {
      unresolved.push(`(no ref at position ${String(position)})`);
      return;
    }
    const bucket = dimension.buckets.find((candidate) => candidate.ref === ref);
    if (bucket === undefined) unresolved.push(ref);
    else parts.push({ dimension, bucket });
  });
  return { parts, unresolved };
}

function unfillableCells(ctx: Ctx): readonly CompileDiagnostic[] {
  const out: CompileDiagnostic[] = [];
  const plans = ctx.survey.quotas?.plans ?? [];

  plans.forEach((plan, planIndex) => {
    const gate = ctx.gates.get(plan.ref)?.[0];
    plan.cells.forEach((cell, cellIndex) => {
      const path = pointer('quotas', 'plans', planIndex, 'cells', cellIndex);
      const key = resolveKey(plan, cell, ctx);
      const base = {
        plan_id: plan.id,
        plan_ref: plan.ref,
        plan_type: plan.type,
        cell_key: [...cell.key],
        cell_index: cellIndex,
      } satisfies { readonly [k: string]: LgcJsonValue };

      if (key.unresolved.length > 0) {
        out.push(
          report(
            `Cell [${cell.key.join(', ')}] of quota plan ${plan.ref} names ` +
              `${String(key.unresolved.length)} bucket ref(s) no dimension of the plan declares, ` +
              'so no respondent is ever assigned to it and the cell can never be filled.',
            path,
            { ...base, reason: 'unresolved_bucket', bucket_refs: key.unresolved.slice(0, MAX_DETAIL_ITEMS) },
          ),
        );
        return;
      }
      if (key.parts.length === 0) return;

      // (2) before (1): a contradictory bucket explains a contradictory key, and naming the
      // bucket sends the author to the predicate they have to fix.
      const badBucket = key.parts.find((part) =>
        provablyNeverTrue(asLogicExpr(part.bucket.match), ctx.env),
      );
      if (badBucket !== undefined) {
        out.push(
          report(
            `Bucket ${badBucket.bucket.ref} of dimension ${badBucket.dimension.ref} has a match ` +
              'condition no respondent can satisfy, so every cell keyed on it — including ' +
              `[${cell.key.join(', ')}] of plan ${plan.ref} — can never be filled.`,
            path,
            {
              ...base,
              reason: 'unsatisfiable_bucket',
              dimension_id: badBucket.dimension.id,
              dimension_ref: badBucket.dimension.ref,
              bucket_ref: badBucket.bucket.ref,
            },
          ),
        );
        return;
      }

      const conjunction = keyConjunction(key.parts);
      if (key.parts.length > 1 && provablyNeverTrue(conjunction, ctx.env)) {
        out.push(
          report(
            `Cell [${cell.key.join(', ')}] of quota plan ${plan.ref} is unfillable: the bucket ` +
              'match conditions of its dimensions contradict each other, so no respondent can ' +
              'satisfy all of them at once.',
            path,
            {
              ...base,
              reason: 'contradictory_key',
              dimension_ids: key.parts.map((part) => part.dimension.id),
              dimension_refs: key.parts.map((part) => part.dimension.ref),
            },
          ),
        );
        return;
      }

      const closing = gate === undefined ? undefined : terminatorClosing(conjunction, gate, ctx);
      if (closing !== undefined) {
        out.push(
          report(
            `Cell [${cell.key.join(', ')}] of quota plan ${plan.ref} is unreachable: rule ` +
              `${closing.ruleId} terminates (${closing.disposition}) every respondent who would ` +
              `fall in it before quota gate ${gate ?? ''} is evaluated, so the cell can never be ` +
              'filled and its target can never be met.',
            path,
            {
              ...base,
              reason: 'terminated_before_gate',
              rule_id: closing.ruleId,
              disposition: closing.disposition,
              flow_node_id: gate ?? null,
              rule_flow_node_id: closing.flowNodeId ?? null,
            },
          ),
        );
      }
    });
  });

  return out;
}

/**
 * The conjunction of the key's bucket predicates.
 *
 * One `and` node over the authored expressions, with the node ids they arrived with. Node ids
 * collide across the operands — each bucket's AST numbers from 1 — and that is harmless here:
 * nothing in `solver.ts` memoizes on `Expr.n`, and `compileLogic`'s interner (which does) never
 * sees this tree, because it is built for the query and discarded.
 */
function keyConjunction(parts: readonly KeyPart[]): Expr {
  const b = astBuilder();
  const matches = parts.map((part) => asLogicExpr(part.bucket.match));
  const only = matches[0];
  if (only === undefined) return b.boolLit(true);
  return matches.length === 1 ? only : b.and(...matches);
}

/**
 * The terminate rule that closes this cell, if one provably does.
 *
 * `key ∧ ¬condition` never true means every assignment that puts a respondent in the cell also
 * fires the rule. The dominance test is what makes "before the gate" a fact rather than a
 * coincidence: a terminate scoped to a node the respondent may bypass leaves the cell fillable by
 * whoever bypassed it.
 */
function terminatorClosing(
  conjunction: Expr,
  gate: string,
  ctx: Ctx,
): Terminator | undefined {
  for (const terminator of ctx.terminators) {
    const site = terminator.flowNodeId;
    if (site !== undefined && !dominates(ctx.graph, site, gate)) continue;
    const b = astBuilder();
    if (provablyNeverTrue(b.and(conjunction, b.not(terminator.condition)), ctx.env)) {
      return terminator;
    }
  }
  return undefined;
}

function report(
  message: string,
  path: string,
  detail: { readonly [key: string]: LgcJsonValue },
): CompileDiagnostic {
  return fromLogicDiagnostic(diagnostic('LGC-Q001', message, path, detail));
}

/* ========================================================================== */
/* 4. LGC-Q002 — targets that do not add up                                    */
/* ========================================================================== */

/**
 * The three arithmetic claims this file is prepared to make, and the two it is not.
 *
 * `types/quotas.ts` assigns the check in its own comment: "the compiler checks that interlocked
 * cell targets are consistent with any marginal targets on the same dimensions and warns on an
 * over-constrained plan". Made concrete:
 *
 *  1. **Interlocked over marginal.** For an interlocked plan `P` and a marginal plan `M` sharing a
 *     dimension `D`, the sum of `P`'s count targets over the cells whose `D` position is bucket `b`
 *     cannot exceed `M`'s count target for `b`. `P` promises more interviews in `b` than `M`
 *     allows, and one of the two numbers is wrong. Count mode only: a percentage on one plan and a
 *     count on the other are commensurable only through a plan total that the schema does not
 *     carry.
 *  2. **Percentages that do not close.** A percentage-mode plan's targets must sum to 100 within
 *     `PERCENTAGE_SUM_TOLERANCE`. For an interlocked plan that is over all cells (the cross-product
 *     partitions the sample); for a marginal plan it is *per dimension*, because a marginal plan's
 *     cells are independent one-dimension targets and summing across dimensions would compare 100%
 *     of gender with 100% of age and report every correct plan.
 *  3. **A key stated twice.** Two cells with the same key are two targets for one cell. Whichever
 *     the runtime honours, the other is a number the author believes is in force and is not.
 *
 * Not attempted, deliberately:
 *
 *  - **"Cell targets sum below a declared total."** There is no declared total. `QuotaPlan` has no
 *    `total`, and the nearest thing in the document — `vendor_limits[].max_completes` and
 *    `Vendor.max_completes` — is a per-vendor ceiling on a survey, not a plan total: a plan under
 *    the sum of its vendor caps is normal (that is what makes the caps caps). Comparing them would
 *    warn on every correctly authored multi-vendor study.
 *  - **A partly enumerated cross-product.** An interlocked plan that omits some combinations leaves
 *    them uncapped, which is a common and deliberate authoring choice ("no target for 65+ in this
 *    wave"), not an inconsistency.
 */
function inconsistentTargets(ctx: Ctx): readonly CompileDiagnostic[] {
  const out: CompileDiagnostic[] = [];
  const plans = ctx.survey.quotas?.plans ?? [];

  plans.forEach((plan, planIndex) => {
    out.push(...duplicateKeys(plan, planIndex));
    out.push(...percentagesThatDoNotClose(plan, planIndex, ctx));
    out.push(...interlockedOverMarginal(plan, planIndex, plans, ctx));
  });
  return out;
}

function warn(
  message: string,
  path: string,
  detail: { readonly [key: string]: LgcJsonValue },
): CompileDiagnostic {
  return fromLogicDiagnostic(diagnostic('LGC-Q002', message, path, detail));
}

/** `target` in count mode, `target_pct` in percentage mode. `undefined` = no target declared. */
function countTarget(cell: QuotaCell): number | undefined {
  const value = cell.target;
  return value === undefined || value === null ? undefined : value;
}

function percentageTarget(cell: QuotaCell): number | undefined {
  const value = cell.target_pct;
  return value === undefined || value === null ? undefined : value;
}

function isPercentageMode(plan: QuotaPlan): boolean {
  // The field is optional; `count` is the shape the rest of the model assumes, and a plan whose
  // cells carry only `target_pct` is percentage-mode whatever the field says.
  if (plan.target_mode === 'percentage') return true;
  if (plan.target_mode === 'count') return false;
  return plan.cells.some((cell) => percentageTarget(cell) !== undefined);
}

function duplicateKeys(plan: QuotaPlan, planIndex: number): readonly CompileDiagnostic[] {
  const first = new Map<string, number>();
  const out: CompileDiagnostic[] = [];
  plan.cells.forEach((cell, cellIndex) => {
    const key = cell.key.join(' ');
    const seen = first.get(key);
    if (seen === undefined) {
      first.set(key, cellIndex);
      return;
    }
    out.push(
      warn(
        `Quota plan ${plan.ref} states cell [${cell.key.join(', ')}] twice, so it carries two ` +
          'targets for one cell and only one of them can be in force.',
        pointer('quotas', 'plans', planIndex, 'cells', cellIndex),
        {
          plan_id: plan.id,
          plan_ref: plan.ref,
          reason: 'duplicate_cell_key',
          cell_key: [...cell.key],
          cell_index: cellIndex,
          first_cell_index: seen,
        },
      ),
    );
  });
  return out;
}

function percentagesThatDoNotClose(
  plan: QuotaPlan,
  planIndex: number,
  ctx: Ctx,
): readonly CompileDiagnostic[] {
  if (!isPercentageMode(plan)) return [];
  const path = pointer('quotas', 'plans', planIndex, 'cells');
  const base = { plan_id: plan.id, plan_ref: plan.ref, plan_type: plan.type };

  // Interlocked: one sum over the whole cross-product.
  if (plan.type === 'interlocked') {
    const declared = plan.cells.filter((cell) => percentageTarget(cell) !== undefined);
    if (declared.length === 0 || declared.length !== plan.cells.length) return [];
    const sum = declared.reduce((acc, cell) => acc + (percentageTarget(cell) ?? 0), 0);
    if (Math.abs(sum - PERCENTAGE_TOTAL) <= PERCENTAGE_SUM_TOLERANCE) return [];
    return [
      warn(
        `The percentage targets of quota plan ${plan.ref} sum to ${formatPercent(sum)}, not 100, ` +
          'so the plan either over-commits the sample or leaves part of it unallocated.',
        path,
        { ...base, reason: 'percentages_do_not_sum', sum, expected: PERCENTAGE_TOTAL, cell_count: declared.length },
      ),
    ];
  }

  // Marginal: one sum per dimension. A cell's dimension is the position of its single ref.
  const byDimension = new Map<string, { sum: number; count: number; complete: boolean }>();
  for (const cell of plan.cells) {
    const dimensionId = marginalDimensionOf(plan, cell, ctx);
    if (dimensionId === undefined) continue;
    const target = percentageTarget(cell);
    const acc = byDimension.get(dimensionId) ?? { sum: 0, count: 0, complete: true };
    byDimension.set(dimensionId, {
      sum: acc.sum + (target ?? 0),
      count: acc.count + 1,
      complete: acc.complete && target !== undefined,
    });
  }

  const out: CompileDiagnostic[] = [];
  for (const [dimensionId, acc] of byDimension) {
    if (!acc.complete || acc.count === 0) continue;
    if (Math.abs(acc.sum - PERCENTAGE_TOTAL) <= PERCENTAGE_SUM_TOLERANCE) continue;
    const dimension = ctx.dimensions.get(dimensionId);
    out.push(
      warn(
        `The percentage targets of quota plan ${plan.ref} on dimension ` +
          `${dimension?.ref ?? dimensionId} sum to ${formatPercent(acc.sum)}, not 100.`,
        path,
        {
          ...base,
          reason: 'percentages_do_not_sum',
          dimension_id: dimensionId,
          dimension_ref: dimension?.ref ?? null,
          sum: acc.sum,
          expected: PERCENTAGE_TOTAL,
          cell_count: acc.count,
        },
      ),
    );
  }
  return out;
}

function formatPercent(value: number): string {
  return `${String(Math.round(value * 100) / 100)}%`;
}

/** The dimension a marginal plan's one-ref cell belongs to. */
function marginalDimensionOf(plan: QuotaPlan, cell: QuotaCell, ctx: Ctx): string | undefined {
  // A marginal cell names one bucket. Its position in `key` is the position of its dimension in
  // `dimension_ids` when the key is padded, and simply "the dimension that declares the ref" when
  // it is not — real documents write `key: ['M']` rather than `['M', null]`, so the ref lookup is
  // what actually resolves, and it is checked against the plan's own dimensions so a ref shared by
  // two dimensions cannot be attributed to one the plan does not use.
  for (const dimensionId of plan.dimension_ids) {
    const dimension = ctx.dimensions.get(dimensionId);
    if (dimension === undefined) continue;
    if (cell.key.some((ref) => dimension.buckets.some((bucket) => bucket.ref === ref))) {
      return dimension.id;
    }
  }
  return undefined;
}

function interlockedOverMarginal(
  plan: QuotaPlan,
  planIndex: number,
  plans: readonly QuotaPlan[],
  ctx: Ctx,
): readonly CompileDiagnostic[] {
  if (plan.type !== 'interlocked' || isPercentageMode(plan)) return [];
  const out: CompileDiagnostic[] = [];

  // bucket ref → the interlocked plan's count target summed over the cells that use it, per
  // dimension position. Only cells with a declared count contribute; a cell with no target is
  // uncapped, and treating it as zero would make an uncapped cell look like a conforming one.
  plan.dimension_ids.forEach((dimensionId, position) => {
    const dimension = ctx.dimensions.get(dimensionId);
    if (dimension === undefined) return;
    const sums = new Map<string, { sum: number; cells: number[] }>();
    plan.cells.forEach((cell, cellIndex) => {
      const ref = cell.key[position];
      const target = countTarget(cell);
      if (ref === undefined || target === undefined) return;
      const acc = sums.get(ref) ?? { sum: 0, cells: [] };
      acc.sum += target;
      acc.cells.push(cellIndex);
      sums.set(ref, acc);
    });

    for (const other of plans) {
      if (other.type !== 'marginal' || other.id === plan.id) continue;
      if (!other.dimension_ids.includes(dimensionId)) continue;
      if (isPercentageMode(other)) continue;
      for (const cell of other.cells) {
        const ref = cell.key.find((candidate) =>
          dimension.buckets.some((bucket) => bucket.ref === candidate),
        );
        const marginal = countTarget(cell);
        if (ref === undefined || marginal === undefined) continue;
        const acc = sums.get(ref);
        if (acc === undefined || acc.sum <= marginal) continue;
        out.push(
          warn(
            `Quota plan ${plan.ref} targets ${String(acc.sum)} interviews in bucket ${ref} of ` +
              `dimension ${dimension.ref} (summed over ${String(acc.cells.length)} interlocked ` +
              `cells), which exceeds the marginal target of ${String(marginal)} declared by plan ` +
              `${other.ref} on the same bucket. The plan is over-constrained: the interlocked ` +
              'cells cannot all be filled without breaching the marginal.',
            pointer('quotas', 'plans', planIndex, 'cells'),
            {
              plan_id: plan.id,
              plan_ref: plan.ref,
              plan_type: plan.type,
              reason: 'interlocked_exceeds_marginal',
              dimension_id: dimension.id,
              dimension_ref: dimension.ref,
              bucket_ref: ref,
              interlocked_sum: acc.sum,
              marginal_target: marginal,
              marginal_plan_id: other.id,
              marginal_plan_ref: other.ref,
              cell_indexes: acc.cells.slice(0, MAX_DETAIL_ITEMS),
            },
          ),
        );
      }
    }
  });

  return out;
}

/* ========================================================================== */
/* 5. LGC-Q003 — a dimension that reads a post-gate variable                   */
/* ========================================================================== */

function postGateDimensions(ctx: Ctx): readonly CompileDiagnostic[] {
  // No start node means every variable is a post-gate variable and none of it is news:
  // `CMP-0001` is the one diagnostic worth reading, the same reason `forward-ref.ts` declines.
  if (ctx.graph.start === '') return [];

  const out: CompileDiagnostic[] = [];
  const reported = new Set<string>();

  for (const plan of ctx.survey.quotas?.plans ?? []) {
    const gate = ctx.gates.get(plan.ref)?.[0];
    // A plan with no reachable gate assigns nothing at all, which is a flow problem rather than
    // an ordering one, and no reserved code names it.
    if (gate === undefined) continue;

    for (const dimensionId of plan.dimension_ids) {
      const dimension = ctx.dimensions.get(dimensionId);
      if (dimension === undefined) continue;
      const at = ctx.dimensionAt.get(dimensionId) ?? 0;

      for (const read of variablesRead(dimension)) {
        const dedupe = `${dimensionId} ${read.id}`;
        if (reported.has(dedupe)) continue;
        const availability = availabilityAt(read.id, gate, ctx);
        if (availability !== 'none') continue;
        reported.add(dedupe);

        const decl = ctx.env.byId(read.id);
        const owner = ctx.env.ownerQuestion(read.id);
        const writeSites = ctx.sites.writes.get(schemaVariableId(read.id)) ?? [];
        out.push(
          fromLogicDiagnostic(
            diagnostic(
              'LGC-Q003',
              `Quota dimension ${dimension.ref} reads ${decl?.name ?? read.id}, which no path ` +
                `sets before quota gate ${gate} is evaluated (it is collected at ` +
                `${owner?.ref ?? 'no question'}). The dimension can never assign a bucket, so ` +
                `every respondent falls outside every cell of plan ${plan.ref}.`,
              pointer('quotas', 'dimensions', at, ...read.path),
              {
                plan_id: plan.id,
                plan_ref: plan.ref,
                dimension_id: dimension.id,
                dimension_ref: dimension.ref,
                variable_id: read.id,
                variable_name: decl?.name ?? read.id,
                source: read.source,
                flow_node_id: gate,
                gate_flow_position: ctx.graph.position.get(gate) ?? null,
                write_question_id: owner?.id ?? null,
                write_question_ref: owner?.ref ?? null,
                write_flow_node_ids: [...writeSites],
              },
            ),
          ),
        );
      }
    }
  }
  return out;
}

interface DimensionRead {
  readonly id: VariableId;
  /** Pointer segments *relative to the dimension*, so the diagnostic lands on the field. */
  readonly path: readonly (string | number)[];
  /** `variable_id` or the bucket whose `match` reads it. For `detail`, not for control flow. */
  readonly source: string;
}

/**
 * Every variable a dimension needs a value for: the one it is defined over, plus everything its
 * buckets' predicates read.
 *
 * The bucket predicates matter as much as `variable_id` does — a bucket keyed on `AGE` inside a
 * dimension over `GENDER` needs `AGE` at the gate just as much — and they are the case the
 * `variable_id`-only reading of `LGC-Q003` would miss.
 */
function variablesRead(dimension: QuotaDimension): readonly DimensionRead[] {
  const out: DimensionRead[] = [];
  const seen = new Set<string>();
  const add = (id: VariableId, path: readonly (string | number)[], source: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ id, path, source });
  };

  add(asVariableId(dimension.variable_id), ['variable_id'], 'variable_id');
  dimension.buckets.forEach((bucket, index) => {
    for (const id of readsOf(asLogicExpr(bucket.match))) {
      add(id, ['buckets', index, 'match'], `bucket:${bucket.ref}`);
    }
  });
  return out;
}

type Availability = 'all' | 'some' | 'none';

/**
 * How much of the path space has this variable by the time the gate runs.
 *
 * `writeSetDominates` answers "always"; the successor walk answers "ever". `LGC-Q003` is an error
 * and therefore only fires on "never" — see the header on why the middle case is silent.
 */
function availabilityAt(id: VariableId, gate: string, ctx: Ctx): Availability {
  const key = schemaVariableId(id);
  if (ctx.sites.preEntry.has(key)) return 'all';
  const sites = new Set(ctx.sites.writes.get(key) ?? []);
  if (sites.size === 0) {
    // A variable nothing writes is unknown at every node — including a `hidden` one on a flow
    // with no start, which `preEntry` covers, so reaching here means genuinely no writer.
    return 'none';
  }
  if (writeSetDominates(ctx.graph, sites, gate)) return 'all';
  for (const site of sites) {
    if (reaches(ctx.graph, site, gate)) return 'some';
  }
  return 'none';
}

/** `true` when the gate is reachable from `from`. Successor reachability, not dominance. */
function reaches(graph: FlowGraph, from: string, gate: string): boolean {
  if (from === gate) return true;
  if (!graph.reachable.has(from)) return false;
  const seen = new Set<string>([from]);
  const stack: string[] = [from];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) break;
    for (const next of graph.successors.get(node) ?? []) {
      if (next === gate) return true;
      if (seen.has(next)) continue;
      seen.add(next);
      stack.push(next);
    }
  }
  return false;
}
