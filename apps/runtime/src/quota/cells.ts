/**
 * Cell resolution: which quota cells does THIS respondent occupy? — E §10, roadmap P2-06.
 *
 * This is the piece that was missing, and its absence was not a missing optimization. Everything
 * around it was built and tested: the schema's dimensions/buckets/plans, the compiler's three
 * static analyses (`LGC-Q001`/`Q002`/`Q003`), the pure state machine's `quota_gate` node, the Redis
 * client's all-or-none Lua scripts, and `gateDecision`'s fail-open/fail-closed policy. But nothing
 * turned a respondent's answers into the `CellSpec[]` that `reserve` takes, so `handler.ts` pushed a
 * `quota.reserve_deferred` event and never fed a `quota_result` back — and a session that reached a
 * gate node **stalled in `QUOTA_GATE` forever**, holding a respondent on a blank step.
 *
 * ## What a cell is, per plan type
 *
 * A `QuotaDimension` names a variable and a list of buckets, each with a `match` AST. A respondent
 * lands in at most one bucket per dimension. From there the two plan types are different
 * mathematical objects (schema `quotas.ts` says so, and the compiler's `LGC-Q002` checks their
 * arithmetic separately):
 *
 *  - **`interlocked`** — one cell, the full cross-product: `[gender=M, age=18_24]`. Every dimension
 *    must resolve, because a cell key is a tuple with one bucket per dimension; if any dimension is
 *    unresolved there is no tuple and therefore no cell.
 *  - **`marginal`** — one cell per dimension, independently: `[M]` and `[18_24]` are separate
 *    counters. A dimension that does not resolve simply contributes nothing; the others still count.
 *
 * ## Kleene UNKNOWN is "not matched", and that is the safe direction here
 *
 * A bucket's `match` is evaluated through the same three-valued engine as everything else
 * (D §2.5), and only `T` selects the bucket — `U` and `F` both mean "not this bucket". This matches
 * `case`'s documented deviation (an unknown `when` continues to the next arm) and it is the safe
 * direction for a gate: a respondent whose age was never asked lands in no age bucket, occupies no
 * cell, and is **not counted against a quota they may not belong to**. The alternative — treating
 * unknown as a match, or defaulting to the first bucket — silently loads one cell with every
 * respondent who skipped the question, and the overshoot is indistinguishable from real data.
 *
 * A respondent who occupies no cell **passes the gate**. They cannot fill a cell they are not in,
 * so there is nothing to be full of. That is not a loophole: `LGC-Q003` already blocks publishing a
 * plan whose dimension reads a variable no path writes before the gate, so "no cell" at runtime
 * means this respondent's own path left it unresolved, not that the plan is broken.
 *
 * ## Counter keys
 *
 * `q:{scope}:{plan_id}:{cell_key}`, the shape `CellSpec.key` documents and the Lua scripts index.
 * `scope` comes from `policy.counter_scope` and is the survey id or the version id — schema's
 * `QuotaPolicy` calls this out as having no safe default, because it decides whether counters carry
 * over when a live survey is republished mid-field. It is resolved by the caller and passed in;
 * this module never guesses it.
 *
 * `cell_key` joins the bucket refs with `|`. Bucket refs are validated identifiers (schema §3), so
 * the separator cannot appear inside one and the join is unambiguous.
 */

import type { QuotaCell, QuotaConfig, QuotaPlan } from '@resscript/schema';

import type { CellSpec } from './index.js';

/** Kleene verdict of a bucket's `match` AST. `null` is UNKNOWN. */
export type ConditionEvaluator = (condition: unknown) => boolean | null;

export interface ResolveCellsInput {
  readonly config: QuotaConfig;
  /** The `quota_ref` the gate node names — a plan `ref`, not an id. */
  readonly planRef: string;
  /**
   * `counter_scope` resolved to a concrete id: the survey id for `'survey'`, the version id for
   * `'version'`. Passed in because only the caller knows both.
   */
  readonly scope: string;
  /** Evaluates one bucket `match` AST against the respondent's current variable state. */
  readonly evalCondition: ConditionEvaluator;
}

export interface ResolveCellsResult {
  readonly cells: readonly CellSpec[];
  /** `dimension_ref -> bucket_ref` for every dimension that resolved. For the event log. */
  readonly buckets: { readonly [dimensionRef: string]: string };
  /** Dimension refs whose buckets all evaluated non-true. Diagnostic, not an error. */
  readonly unresolved: readonly string[];
  /** Set when `planRef` names no plan in the config — a broken artifact, not a respondent state. */
  readonly planMissing?: boolean;
}

const EMPTY: ResolveCellsResult = { cells: [], buckets: {}, unresolved: [] };

export function resolveCells(input: ResolveCellsInput): ResolveCellsResult {
  const plan = input.config.plans.find(p => p.ref === input.planRef);
  if (plan === undefined) return { ...EMPTY, planMissing: true };

  const byId = new Map(input.config.dimensions.map(d => [String(d.id), d]));

  const buckets: { [dimensionRef: string]: string } = {};
  const unresolved: string[] = [];
  // Bucket ref per dimension, in `dimension_ids` order — the order a cell key is a tuple in.
  const picked: (string | undefined)[] = [];

  for (const dimensionId of plan.dimension_ids) {
    const dimension = byId.get(String(dimensionId));
    if (dimension === undefined) {
      // A plan naming a dimension the config does not define. `validateStructural` rejects this at
      // publish; treated as unresolved rather than thrown so a gate on a hand-edited artifact
      // degrades to "no cell" instead of 500-ing a respondent mid-survey.
      picked.push(undefined);
      unresolved.push(String(dimensionId));
      continue;
    }
    // First bucket whose match is TRUE. Declared order is the tie-break, so overlapping buckets
    // are resolved the way the author wrote them rather than by iteration accident.
    const hit = dimension.buckets.find(b => input.evalCondition(b.match) === true);
    if (hit === undefined) {
      picked.push(undefined);
      unresolved.push(dimension.ref);
      continue;
    }
    picked.push(hit.ref);
    buckets[dimension.ref] = hit.ref;
  }

  const cells =
    plan.type === 'interlocked'
      ? interlockedCells(plan, picked, input.scope)
      : marginalCells(plan, picked, input.scope);

  return { cells, buckets, unresolved };
}

/**
 * The single cross-product cell, if every dimension resolved AND the plan declares that cell.
 *
 * A tuple the plan does not declare is not an error: an interlocked plan need not enumerate every
 * combination, and an undeclared combination is simply uncounted (there is no target to be full
 * of). The compiler's `LGC-Q002` is what reports a plan whose declared cells do not add up.
 */
function interlockedCells(
  plan: QuotaPlan,
  picked: readonly (string | undefined)[],
  scope: string,
): readonly CellSpec[] {
  if (picked.some(ref => ref === undefined)) return [];
  const key = picked.join('|');
  const cell = plan.cells.find(c => c.key.join('|') === key);
  if (cell === undefined) return [];
  return [spec(plan, cell, key, scope)];
}

/**
 * One cell per resolved dimension, matched against the plan's single-element cell keys.
 *
 * Marginal targets are per-dimension by definition, so a plan of two dimensions produces up to two
 * independent counters and a respondent who resolves only one of them still counts against that
 * one. `reserve` remains all-or-none across whatever this returns, which is correct: a respondent
 * admitted to the gender cell but rejected by the age cell must not occupy either.
 */
function marginalCells(
  plan: QuotaPlan,
  picked: readonly (string | undefined)[],
  scope: string,
): readonly CellSpec[] {
  const out: CellSpec[] = [];
  for (const ref of picked) {
    if (ref === undefined) continue;
    const cell = plan.cells.find(c => c.key.length === 1 && c.key[0] === ref);
    if (cell === undefined) continue;
    out.push(spec(plan, cell, ref, scope));
  }
  return out;
}

function spec(plan: QuotaPlan, cell: QuotaCell, cellKey: string, scope: string): CellSpec {
  return { key: `q:${scope}:${String(plan.id)}:${cellKey}`, mode: cell.mode };
}

/**
 * The plan a gate node names, or `undefined`. Exported so the caller can decide what a gate over a
 * missing plan means before doing any work — see `overflowFor`.
 */
export function planFor(config: QuotaConfig | undefined, planRef: string): QuotaPlan | undefined {
  return config?.plans.find(p => p.ref === planRef);
}

/**
 * The disposition a full cell sends a respondent to.
 *
 * `plan.overflow` when the author set one. Falling back to `QUOTA_FULL` rather than to the gate's
 * `on_full` edge being required: E §11 makes `QUOTA_FULL` a first-class disposition with its own
 * redirect, and `CMP-0300` already blocks publishing a survey that can reach a disposition it has
 * no redirect for — so the fallback is a disposition the artifact is guaranteed to handle.
 */
export function overflowFor(plan: QuotaPlan | undefined): string {
  return plan?.overflow ?? 'QUOTA_FULL';
}
