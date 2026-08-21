/**
 * The seam between `packages/logic` and the renderer.
 *
 * Everything up to here was built with logic's verdicts *injected*: `renderPage` takes `itemsFor`,
 * `isQuestionVisible` and `optionState` as hooks, and the machine takes `evalCondition`. This module
 * is what fills them in — one function that evaluates a page and returns the hooks.
 *
 * ## Order of operations, and why it is not negotiable
 *
 * ```
 * 1. computeOrders(page, seed)     the display order of every randomized axis
 * 2. evaluate(program, vars, ctx)  with those orders in EvalContext
 * 3. renderPage(page, seed, ctx)   with the SAME orders, plus the verdict as hooks
 * ```
 *
 * The orders come first because `EvalContext.orders` is an *input* to evaluation — logic reads it
 * for `item_attr:'position'` and never shuffles. And the same map goes to both steps, not two
 * computations of it, so the position a rule reasons about is the position the respondent sees. That
 * agreement is structural here; when each side computed its own it held only as long as nobody
 * edited one of the two call sites.
 *
 * ## What this module does not do
 *
 * It does not persist, log, or decide dispositions. A `termination` in the verdict is *reported*,
 * because turning it into a disposition means releasing a quota reservation and writing an event —
 * both of which are the caller's, and neither of which belongs in a pure function.
 */

import { toCompiledLogic, type RehydratedLogic } from './artifact-logic.js';
import {
  computeOrders,
  orderScope,
  type Axis,
  type OptionState,
  type RenderCtx,
  type RenderItem,
  type RenderPage,
} from './render.js';
import type { OrderGroup } from './randomize.js';
// `itemsKey` is the engine's own key format for the `items` cell map. Imported rather than restated:
// the map `toCompiledLogic` builds is keyed with this exact function, so a local copy would be a
// second spelling that could drift — and a drifted key makes every lookup miss, which reports "no
// mask applies" for every axis. Safe-direction wrong, which is the hardest kind to notice.
import { itemsKey } from '@resscript/logic';

/* ------------------------------------------------------------------ *
 * Structural mirrors of what packages/logic returns
 *
 * `evaluate`, `varStateOf` and `evalCondition` are injected rather than imported. The point is not
 * to avoid a dependency — `artifact-logic.ts` already imports `itemsKey` and `optionKey` as values —
 * but to keep the *engine module* out of a bundle that only renders. It is the largest thing in
 * `packages/logic`, and a client that server-renders and evaluates nothing should not ship it.
 * ------------------------------------------------------------------ */

/** The subset of `Verdict` this module reads. Injected so the engine stays a peer dependency. */
export interface PageVerdict {
  readonly visible: (nodeId: string) => boolean;
  readonly items: (questionId: never, axis: never) => readonly number[];
  readonly option: (optionId: string, prop: never) => boolean;
  readonly value: (variableId: never) => unknown;
  readonly validations: readonly {
    readonly rule_id: string;
    readonly message_key: string;
    readonly scope: 'field' | 'page';
    readonly target: string;
  }[];
  readonly termination:
    | { readonly rule_id: string; readonly disposition: string; readonly custom_key?: string }
    | undefined;
  readonly maskFallbacks: readonly unknown[];
}

/**
 * `evaluate` from `packages/logic`, injected.
 *
 * Taken as a parameter rather than imported so this module — and therefore every module that
 * imports the renderer — does not force the engine into a bundle that only needs to render. A
 * client that evaluates passes it; a server-rendered page with no client logic does not.
 */
export type EvaluateFn = (
  program: unknown,
  vars: unknown,
  ctx: unknown,
) => PageVerdict;

/** `varStateOf` from `packages/logic`, injected for the same reason. */
export type VarStateFn = (values: { readonly [id: string]: unknown }) => unknown;

/**
 * `evalCondition` from `packages/logic`, injected. Returns Kleene `'T' | 'F' | 'U'`.
 *
 * Needed separately from `evaluate` because a flow branch's condition is not a cell: it lives on the
 * graph, is evaluated when the machine reaches the node, and can read cells the page evaluation
 * produced (`SHOWN(Q5)` and the like). So it runs against the same verdict rather than a second
 * evaluation of the page.
 */
export type EvalConditionFn = (condition: unknown, env: unknown) => 'T' | 'F' | 'U';

/* ------------------------------------------------------------------ *
 * Input and output
 * ------------------------------------------------------------------ */

export interface EvaluatePageInput {
  readonly page: RenderPage;
  readonly logic: RehydratedLogic;
  /** The session seed. Fixed at entry and never changed (ADR-006). */
  readonly seed: string;
  readonly vars: { readonly [variableId: string]: unknown };
  /** Resolved i18n bundle for the session's language, keyed by `label_key`. */
  readonly labels?: { readonly [labelKey: string]: string };
  /** True when a page was submitted. What separates `asked` from `shown`. */
  readonly pageSubmitted?: (pageId: string) => boolean;
  /** The canonical item list for a shared-order group (E §8.3). */
  readonly groupFor?: (group_ref: string) => OrderGroup<RenderItem> | undefined;
  readonly evaluate: EvaluateFn;
  readonly varStateOf: VarStateFn;
  /** Omit when the caller has no flow branches to evaluate; `evalCondition` is then absent. */
  readonly evalCondition?: EvalConditionFn;
}

export interface EvaluatedPage {
  /**
   * The hooks `renderPage` takes, including the orders, ready to spread into a `RenderCtx`.
   *
   * `vars`, `emptyToken` and `escapeContext` are the caller's — they are presentation concerns the
   * verdict has no opinion about.
   */
  readonly renderHooks: Pick<
    RenderCtx,
    'isQuestionVisible' | 'itemsFor' | 'optionState' | 'groupFor' | 'orders'
  >;
  /** For the machine's `PureCtx`. Page-level rather than question-level visibility. */
  readonly isPageVisible: (pageId: string) => boolean;
  /** The orders handed to the engine, so the caller can persist or trace them. */
  readonly orders: { readonly [scope: string]: readonly number[] };
  readonly validations: PageVerdict['validations'];
  /** Reported, not acted on: finalizing is the caller's (see the module header). */
  readonly termination: PageVerdict['termination'];
  /**
   * For the machine's `PureCtx.evalCondition`: a flow branch condition, against this page's verdict.
   *
   * `'U'` becomes `null`, which the machine treats as UNKNOWN and answers by taking the else arm —
   * matching the compiler's `CMP-0700`. Absent when no `evalCondition` was injected, so a caller
   * that forgot to supply one gets a missing hook rather than every branch silently taking the first
   * arm.
   */
  readonly evalCondition?: (condition: unknown) => boolean | null;
  readonly verdict: PageVerdict;
}

/* ------------------------------------------------------------------ *
 * The adapter
 * ------------------------------------------------------------------ */

/**
 * Evaluate one page and return the renderer's hooks.
 *
 * Pure given a pure `evaluate`: no clock, no I/O, no persistence. The same `(page, logic, seed,
 * vars)` always produce the same hooks, which is what lets the client run this and ADR-004's
 * divergence check compare the two sides.
 */
export function evaluatePage(input: EvaluatePageInput): EvaluatedPage {
  // ---- 1. orders, before evaluation ------------------------------------
  const orders = computeOrders(input.page, input.seed, {
    ...(input.groupFor ? { groupFor: input.groupFor } : {}),
  });

  // ---- 2. evaluate ------------------------------------------------------
  // `maskItems` is scoped to the question being rendered, which is why the artifact cannot carry it
  // and `toCompiledLogic` demands it. Built from this page's declared items: an `options` group
  // iterates options, so an item is its code in the question's domain (D §2.3).
  const program = toCompiledLogic(input.logic, (questionId, axis) => {
    const q = input.page.questions.find(candidate => candidate.id === questionId);
    if (!q) return [];
    const items = axis === 'options' ? q.options : axis === 'rows' ? q.rows : q.columns;
    return (items ?? []).map(item => ({ option_id: item.id as never, code: item.code }));
  });

  const verdict = input.evaluate(program, input.varStateOf(input.vars), {
    orders,
    ...(input.labels ? { labels: input.labels } : {}),
    ...(input.pageSubmitted ? { pageSubmitted: input.pageSubmitted } : {}),
  });

  // ---- 3. the hooks -----------------------------------------------------
  const itemsFor = (question_id: string, axis: Axis): readonly number[] | null => {
    // Ask whether the program HAS an `items` cell for this axis, rather than inferring it from the
    // value. No cell means no mask rule targets the axis, so there is nothing to narrow — and the
    // distinction is not cosmetic: with no cell, `Verdict.items` falls through to `baseItems`, which
    // returns `[]` for an axis absent from the (normally fully-materialized) `base_items` record.
    // Reading that `[]` as "a mask emptied this axis" fires the question's fallback and DROPS THE
    // QUESTION, silently. A correct artifact never hits it; a truncated or hand-built one would, and
    // losing a question is the worst way to find out.
    if (!program.itemsCell.has(itemsKey(question_id as never, axis as never))) return null;

    const codes = verdict.items(question_id as never, axis as never);
    // A mask that resolved to exactly the declared set has narrowed nothing. Reported as `null` so
    // the renderer takes its no-mask path rather than re-filtering to the same list.
    const declared = declaredCodes(input.page, question_id, axis);
    if (declared === null) return null;
    if (codes.length === declared.length && codes.every(c => declared.includes(c))) return null;
    return codes;
  };

  const optionState = (_question_id: string, _axis: Axis, item: RenderItem): OptionState => {
    // `visible` and `enabled` are separate props: a hidden option is gone from the render, a
    // disabled one is shown and not selectable. Collapsing them would silently drop an option the
    // author meant to grey out.
    const visible = verdict.option(item.id, 'visible' as never);
    const enabled = verdict.option(item.id, 'enabled' as never);
    return {
      ...(visible ? {} : { hidden: true }),
      ...(enabled ? {} : { disabled: true }),
    };
  };

  // A `CellReader` over the verdict. The engine's own reader returns `undefined` for a cell with no
  // entry, and that is meaningful — `NO_CELLS` exists for exactly this — so the wrappers below must
  // not coerce a missing cell into `false`, which would make an unevaluated `visible` cell read as
  // "hidden" and drop the question.
  const cells = {
    value: (id: never) => verdict.value(id),
    visible: (nodeId: string) => verdict.visible(nodeId),
    items: (questionId: never, axis: never) => verdict.items(questionId, axis),
    option: (optionId: string, prop: never) => verdict.option(optionId, prop),
    // Validation verdicts are reported as a list rather than per target, so this answers from it:
    // AND over every failure naming the target, `undefined` when none do.
    valid: (targetId: string) =>
      verdict.validations.some(v => v.target === targetId) ? false : undefined,
  };

  const evalConditionFn = input.evalCondition;
  const evalCondition = evalConditionFn
    ? (condition: unknown): boolean | null => {
        const tri = evalConditionFn(condition, {
          vars: input.varStateOf(input.vars),
          ctx: {
            orders,
            ...(input.labels ? { labels: input.labels } : {}),
            ...(input.pageSubmitted ? { pageSubmitted: input.pageSubmitted } : {}),
          },
          cells,
          schema: input.logic.schema,
        });
        return tri === 'T' ? true : tri === 'F' ? false : null;
      }
    : undefined;

  return {
    renderHooks: {
      isQuestionVisible: (question_id: string) => verdict.visible(question_id),
      itemsFor,
      optionState,
      orders,
      ...(input.groupFor ? { groupFor: input.groupFor } : {}),
    },
    isPageVisible: (pageId: string) => verdict.visible(pageId),
    orders,
    validations: verdict.validations,
    termination: verdict.termination,
    ...(evalCondition ? { evalCondition } : {}),
    verdict,
  };
}

/** The codes an axis declares, or null when the question has no such axis. */
function declaredCodes(
  page: RenderPage,
  questionId: string,
  axis: Axis,
): readonly number[] | null {
  const q = page.questions.find(candidate => candidate.id === questionId);
  if (!q) return null;
  const items = axis === 'options' ? q.options : axis === 'rows' ? q.rows : q.columns;
  if (!items) return null;
  return items.map(item => item.code);
}

/** Re-exported so a caller building an `EvalContext` by hand uses the same key. */
export { orderScope };
