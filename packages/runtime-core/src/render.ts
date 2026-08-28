/**
 * P1-09 page render, per Deliverable E §9.
 *
 * E §9.2 lists the stages as: base items, masking, fallback, option state, randomization, piping.
 * The order this module actually runs, and why, is below — the two differ on where randomization
 * sits, because `packages/logic` needs the display order as an *input*.
 *
 *   1. base items    — the question's options / rows / columns from the artifact
 *   2. order          — randomize the DECLARED list; this is `EvalContext.orders`
 *   3. masking       — filter to `Verdict.items`, preserving that order
 *   4. fallback      — when masking emptied the set
 *   5. option state  — logic's per-item verdicts, over the survivors only
 *   6. subset limit  — take n of what survived, and record which n
 *   7. piping        — interpolate label and instruction text
 *
 * ## Steps 2–4 belong to `packages/logic`, not to this module
 *
 * An authored `Mask` does not reach the runtime as data to be applied. The compiler synthesizes
 * **one logic rule per `QuestionNode.masks[]` entry** (compiler `rules.ts` §4), so a mask becomes a
 * `mask` effect writing an `items` cell in the compiled cell graph, and `applyMask` — the
 * include/exclude set operation — lives in `packages/logic/src/rules.ts`. Evaluating the page
 * therefore already produces the surviving item set, reachable as `Verdict.items(qid, axis)`, with
 * `Verdict.maskFallbacks` carrying which fallbacks fired.
 *
 * An earlier version of this module re-implemented masking from `CompiledQuestion.masks`. That was
 * wrong twice over: the two implementations could disagree, and once logic was wired every mask
 * would have been applied **twice** — harmless for a plain include/exclude, but a `show_all`
 * fallback firing in one layer and then being re-emptied by the other gives an answer neither
 * layer would give alone, and a `subset` design variable would be recorded twice.
 * `CompiledQuestion.masks` is emitted into the page as provenance, not as an instruction.
 *
 * So this module owns steps 1, 5 and 6, and takes 2–4 as injected verdicts. `itemsFor` is the
 * seam: today the runtime passes nothing and every item survives; once the engine is wired it
 * passes `Verdict.items`. The renderer's shape does not change either way.
 *
 * ## The order is computed from the FULL list, then filtered
 *
 * `EvalContext.orders` in `packages/logic` is documented as "item display orders **already
 * computed** by runtime-core's seeded PRNG, keyed by `orderScope(question, axis)`, each value the
 * item codes in display order. **The engine never shuffles.**" So the order is an input to
 * evaluation, produced before the engine knows which items a mask leaves standing — which fixes
 * the sequence: randomize the declared list, then filter by the verdict.
 *
 * This is what makes an order a function of `(seed, question, axis)` alone. Randomizing the
 * *surviving* items instead would make it depend on the mask, so the same seed would produce a
 * different order for a respondent whose earlier answers masked one brand away, the engine's
 * `orders` and the rendered order would disagree, and E §8.3's shared-group guarantee would hold
 * only for questions whose masks happened to match.
 *
 * It is also why E §8.3 says to permute a group's *canonical* list and filter afterwards. That is
 * the same rule stated for the shared-group case; here it is applied universally.
 *
 * ## The digest
 *
 * The render produces a `digest`, which is what makes invalidate-forward (E §7.2) work: that
 * algorithm needs to know whether a page's *rendering* drifted, and it cannot re-derive what the
 * respondent saw without replaying the session (the policy E §7.1 rejects). So the render records
 * a digest of visibility, item sets and piped text, and the drift test is a string comparison.
 */

import { hashString } from './prng.js';
import { pipe, type EscapeContext } from './piping.js';
import {
  randomize,
  type OrderGroup,
  type RandomizationSpec,
  type RandomizeItem,
} from './randomize.js';

/* ------------------------------------------------------------------ *
 * Structural types — mirrors of `CompiledPage` / `CompiledQuestion`
 * ------------------------------------------------------------------ */

/** The axis of a question an item belongs to. */
export type Axis = 'options' | 'rows' | 'columns';

export interface RenderItem extends RandomizeItem {
  readonly label?: string | null;
}

export interface RenderQuestion {
  readonly id: string;
  readonly ref: string;
  readonly question_type: string;
  readonly required?: boolean;
  readonly label?: string | null;
  readonly instruction?: string | null;
  readonly options?: readonly RenderItem[];
  readonly rows?: readonly RenderItem[];
  readonly columns?: readonly RenderItem[];
  /**
   * Emitted by the compiler as provenance. NOT applied here — the compiler already turned each
   * one into a logic rule (see the module header), so applying them again would double them.
   */
  readonly masks?: readonly unknown[];
  readonly randomize_options?: RandomizationSpec;
  readonly randomize_rows?: RandomizationSpec;
  readonly randomize_columns?: RandomizationSpec;
}

export interface RenderPage {
  readonly id: string;
  readonly ref?: string;
  readonly questions: readonly RenderQuestion[];
}

/** Logic's verdict for one item. Injected, because rule evaluation lives elsewhere. */
export interface OptionState {
  /** Rendered but not selectable. */
  readonly disabled?: boolean;
  /** Removed from the render entirely — distinct from masked out, and recorded separately. */
  readonly hidden?: boolean;
}

export interface RenderCtx {
  /** Session variable state, for piping. */
  readonly vars: { readonly [variableId: string]: unknown };
  /** Question-level visibility after rule evaluation. Absent means visible. */
  readonly isQuestionVisible?: (question_id: string) => boolean;
  /**
   * The item codes surviving masking for one axis, i.e. `Verdict.items(qid, axis)` (E §9.2 steps
   * 2–3). Return `null` — or omit the hook — to mean "no mask applies", which is not the same as
   * an empty array: an empty array is a mask that resolved to nothing and must trigger the
   * question's fallback, and conflating the two produces the empty-question dead end that
   * `fallback.when_empty` exists to prevent.
   */
  readonly itemsFor?: (question_id: string, axis: Axis) => readonly number[] | null;
  /**
   * What to do when `itemsFor` returns an empty set. Comes from the mask's `fallback.when_empty`,
   * which the schema makes required with no default (C §15). Absent is treated as
   * `skip_question`: not showing a question is recoverable, showing an unanswerable one is a dead
   * end the respondent cannot leave.
   */
  readonly emptyFallbackFor?: (question_id: string, axis: Axis) => MaskFallback | undefined;
  /** Per-item logic verdicts (E §9.2 step 4). */
  readonly optionState?: (question_id: string, axis: Axis, item: RenderItem) => OptionState;
  /** The canonical item list for a shared-order group (E §8.3). */
  readonly groupFor?: (group_ref: string) => OrderGroup | undefined;
  /**
   * Precomputed display orders, keyed `<question id>.<axis>` — the same map that goes into
   * `EvalContext.orders`.
   *
   * Supplying it is how the renderer and the logic engine are made to agree *structurally* rather
   * than coincidentally. Both need the order: the engine reads it for `item_attr:'position'`, the
   * renderer presents it. If each computed its own they would agree only as long as nobody changed
   * one of the two call sites — and a disagreement means the position a rule reasons about is not
   * the position the respondent sees.
   *
   * Omit it and the renderer computes the order itself, which is correct for a render with no logic
   * evaluation (and is what the tests below mostly do).
   */
  readonly orders?: { readonly [scope: string]: readonly number[] };
  /**
   * This respondent's ticket for the counter-backed randomization modes (E §8.4, roadmap P2-03).
   *
   * A RESOLVED INTEGER, because this render is synchronous and pure — the ticket comes from a
   * shared Redis counter and `apps/runtime` resolves it once per session before rendering. Absent
   * means `rotate` and `fixed_order_list` report `randomize.needs_counter` and leave the declared
   * order alone, which is the honest degradation: an unrotated survey is visibly unrotated, while a
   * seeded shuffle standing in for a rotation is an unbalanced design nobody notices until
   * fieldwork ends.
   */
  readonly respondentIndex?: number;
  /** What a null pipe target renders as. Per-survey configurable; default `""`. */
  readonly emptyToken?: string;
  /** Output context for piped text. The renderer owns escaping, not the author. */
  readonly escapeContext?: EscapeContext;
}

export interface RenderedAxis {
  readonly items: readonly RenderItem[];
  /** Items logic disabled, by code. Rendered but not selectable. */
  readonly disabled_codes: readonly number[];
}

export interface RenderedQuestion {
  readonly id: string;
  readonly ref: string;
  readonly question_type: string;
  readonly required: boolean;
  readonly label: string | null;
  readonly instruction: string | null;
  readonly options?: RenderedAxis;
  readonly rows?: RenderedAxis;
  readonly columns?: RenderedAxis;
}

export interface RenderedPage {
  readonly page_id: string;
  readonly questions: readonly RenderedQuestion[];
  /**
   * Questions not shown, with the reason.
   *
   * `masked_empty` is deliberately distinct from `hidden`: E §9.2 requires that a question
   * dropped by an empty mask is recorded as `masked_empty` and NOT as a respondent skip, because
   * "the respondent chose not to answer" and "logic left nothing to answer" are different facts
   * and an analyst needs to tell them apart.
   */
  readonly skipped: readonly { question_id: string; reason: 'hidden' | 'masked_empty' }[];
  /** Set when an emptied axis' fallback is `terminate`. The caller owns the disposition. */
  readonly terminate?: { question_id: string; axis: Axis };
  /** Events to append: mask fallbacks, missing groups, counter-backed modes. */
  readonly events: readonly { kind: string; question_id: string; detail?: string }[];
  /**
   * `subset` results to persist as `design` variables. "Which subset did they see" is required
   * for analysis (E §8.4) and is not recoverable once the item list changes.
   */
  readonly design_writes: readonly { question_id: string; axis: Axis; codes: readonly number[] }[];
  /**
   * Digest of visibility, item sets and piped text. Recorded on the page visit so
   * invalidate-forward can detect render drift with a string comparison (E §7.2 step 3).
   */
  readonly digest: string;
}

/* ------------------------------------------------------------------ *
 * One axis
 * ------------------------------------------------------------------ */

export type MaskFallback = 'skip_question' | 'show_all' | 'terminate';

const AXES: readonly Axis[] = ['options', 'rows', 'columns'];

/**
 * The key `EvalContext.orders` is indexed by. Must match `packages/logic`'s `orderScope`, which is
 * the same two-part join — restated rather than imported so `runtime-core` keeps no runtime
 * dependency on the engine for a string template.
 */
export function orderScope(questionId: string, axis: Axis): string {
  return `${questionId}.${axis}`;
}

/**
 * Compute the display order of every randomized axis on a page.
 *
 * This is the value that goes into `EvalContext.orders` AND into `RenderCtx.orders`, so the engine
 * and the renderer reason about one order rather than two that happen to match. Computed over the
 * DECLARED item list, before masking, for the reason in the module header.
 *
 * An axis with no randomization spec is absent rather than mapped to its declared codes: absent
 * means "no order was imposed", and `item_attr:'position'` falling back to declared position is the
 * engine's own default.
 */
export function computeOrders(
  page: RenderPage,
  seed: string,
  opts: {
    groupFor?: (group_ref: string) => OrderGroup | undefined;
    /**
     * This respondent's counter ticket (P2-03). MUST match what the renderer is given, or the
     * engine reasons about a different order than the respondent sees — which is the exact class of
     * divergence `orders` is shared between the two to prevent.
     */
    respondentIndex?: number;
  } = {},
): { readonly [scope: string]: readonly number[] } {
  const out: { [scope: string]: readonly number[] } = {};

  for (const q of page.questions) {
    for (const axis of AXES) {
      const base = axisItems(q, axis);
      const spec = axisSpec(q, axis);
      if (!base || !spec || spec.mode === 'none' || base.length < 2) continue;

      const group = spec.group_ref ? opts.groupFor?.(spec.group_ref) : undefined;
      // `subset` is ordered unlimited here; the limit is applied per render, after masking, so the
      // respondent always sees n of what survived.
      const orderSpec: RandomizationSpec =
        spec.mode === 'subset' ? { ...spec, mode: 'shuffle' } : spec;
      const r = randomize(base, orderSpec, seed, {
        axis_key: `${q.id}.${axis}`,
        ...(group ? { group } : {}),
        ...(opts.respondentIndex === undefined ? {} : { respondent_index: opts.respondentIndex }),
      });
      out[orderScope(q.id, axis)] = r.items.map(i => i.code);
    }
  }

  return out;
}

function axisItems(q: RenderQuestion, axis: Axis): readonly RenderItem[] | undefined {
  if (axis === 'options') return q.options;
  if (axis === 'rows') return q.rows;
  return q.columns;
}

function axisSpec(q: RenderQuestion, axis: Axis): RandomizationSpec | undefined {
  if (axis === 'options') return q.randomize_options;
  if (axis === 'rows') return q.randomize_rows;
  return q.randomize_columns;
}

interface AxisOutcome {
  readonly axis: RenderedAxis | null;
  readonly skip_question: boolean;
  readonly terminate: boolean;
  readonly events: { kind: string; question_id: string; detail?: string }[];
  readonly design_codes: readonly number[] | null;
}

function renderAxis(
  q: RenderQuestion,
  axis: Axis,
  base: readonly RenderItem[],
  seed: string,
  ctx: RenderCtx,
): AxisOutcome {
  const events: { kind: string; question_id: string; detail?: string }[] = [];

  // ---- 5 (first): the display order of the DECLARED list ---------------
  //
  // Computed before masking is applied, because this is the value `EvalContext.orders` carries into
  // logic evaluation and it must be a function of (seed, question, axis) alone. See the header.
  const spec = axisSpec(q, axis);
  let ordered: readonly RenderItem[] = base;
  let subsetLimit: number | null = null;

  const precomputed = ctx.orders?.[orderScope(q.id, axis)];
  if (precomputed !== undefined) {
    // Order the base list BY the precomputed codes. Not `precomputed.map(byCode)`: a code the
    // artifact no longer has would become a hole, and an item the order omits must still render —
    // appended in declared order — rather than vanishing.
    const rank = new Map(precomputed.map((code, i) => [code, i]));
    ordered = [...base].sort(
      (a, b) => (rank.get(a.code) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.code) ?? Number.MAX_SAFE_INTEGER),
    );
    if (spec?.mode === 'subset') subsetLimit = spec.n ?? base.length;
  } else if (spec) {
    const group = spec.group_ref ? ctx.groupFor?.(spec.group_ref) : undefined;
    // `subset` is deferred: taking the first n here and then masking could leave fewer than n
    // items, and "show them n of these" is the authored intent. The limit is applied after the
    // verdict instead, and `n` is carried down.
    const orderSpec: RandomizationSpec =
      spec.mode === 'subset' ? { ...spec, mode: 'shuffle' } : spec;
    const r = randomize(base, orderSpec, seed, {
      axis_key: `${q.id}.${axis}`,
      ...(group ? { group } : {}),
      ...(ctx.respondentIndex === undefined ? {} : { respondent_index: ctx.respondentIndex }),
    });
    ordered = r.items;
    if (r.event) events.push({ kind: r.event, question_id: q.id, detail: axis });
    if (spec.mode === 'subset') subsetLimit = spec.n ?? base.length;
  }

  // ---- 2/3: the masked item set, from logic, and its fallback ----------
  const allowed = ctx.itemsFor?.(q.id, axis) ?? null;
  let masked: readonly RenderItem[];

  if (allowed === null) {
    masked = ordered;
  } else {
    const keep = new Set(allowed);
    // Filter the ordered list rather than reordering it to `allowed`: the verdict is a set, and
    // taking order from it would make the display order depend on cell-graph evaluation order.
    masked = ordered.filter(item => keep.has(item.code));
  }

  if (masked.length === 0 && ordered.length > 0) {
    const fallback = ctx.emptyFallbackFor?.(q.id, axis) ?? 'skip_question';
    if (fallback === 'show_all') {
      // Reverts to the ordered declared list, not to `base`: the respondent still sees the order
      // this session's seed produced.
      masked = ordered;
      events.push({ kind: 'mask.fallback_show_all', question_id: q.id, detail: axis });
    } else if (fallback === 'terminate') {
      return { axis: null, skip_question: false, terminate: true, events, design_codes: null };
    } else {
      return { axis: null, skip_question: true, terminate: false, events, design_codes: null };
    }
  }

  // ---- 4: option state, over the survivors only -----------------------
  const disabled: number[] = [];
  const surviving = masked.filter(item => {
    const state = ctx.optionState?.(q.id, axis, item);
    if (state?.hidden) return false;
    if (state?.disabled) disabled.push(item.code);
    return true;
  });

  // A question whose every item logic hid is as unanswerable as one an empty mask produced.
  // Reported the same way downstream because from the respondent's side it is the same event.
  if (surviving.length === 0 && masked.length > 0) {
    return {
      axis: null,
      skip_question: true,
      terminate: false,
      events: [...events, { kind: 'option_state.all_hidden', question_id: q.id }],
      design_codes: null,
    };
  }

  // ---- 5 (second): apply a `subset` limit to the survivors ------------
  if (subsetLimit === null) {
    return {
      axis: { items: surviving, disabled_codes: disabled },
      skip_question: false,
      terminate: false,
      events,
      design_codes: null,
    };
  }

  const kept = surviving.slice(0, Math.max(0, Math.min(subsetLimit, surviving.length)));
  return {
    axis: { items: kept, disabled_codes: disabled },
    skip_question: false,
    terminate: false,
    events,
    // "Which subset did they see" is required for analysis (E §8.4) and is not recoverable once
    // the item list or the mask changes, so it is persisted as a `design` variable.
    design_codes: kept.map(i => i.code),
  };
}

/* ------------------------------------------------------------------ *
 * The page
 * ------------------------------------------------------------------ */

/**
 * Render one page for one session.
 *
 * Pure: identical `(page, seed, ctx)` produce an identical `RenderedPage`, digest included.
 * That is what lets the client render the same page from the same inputs and lets ADR-004's
 * divergence check compare the two.
 */
export function renderPage(
  page: RenderPage,
  seed: string,
  ctx: RenderCtx,
): RenderedPage {
  const questions: RenderedQuestion[] = [];
  const skipped: { question_id: string; reason: 'hidden' | 'masked_empty' }[] = [];
  const events: { kind: string; question_id: string; detail?: string }[] = [];
  const designWrites: { question_id: string; axis: Axis; codes: readonly number[] }[] = [];
  let terminate: { question_id: string; axis: Axis } | undefined;

  // Canonical parts of the digest, accumulated in page order so the digest is stable.
  const digestParts: string[] = [];

  const pipeText = (text: string | null | undefined): string | null => {
    if (text == null) return null;
    return pipe(text, ctx.vars, {
      emptyToken: ctx.emptyToken ?? '',
      escapeContext: ctx.escapeContext ?? 'none',
    });
  };

  for (const q of page.questions) {
    if (ctx.isQuestionVisible && !ctx.isQuestionVisible(q.id)) {
      skipped.push({ question_id: q.id, reason: 'hidden' });
      digestParts.push(`${q.id}|hidden`);
      continue;
    }

    const axes: Partial<Record<Axis, RenderedAxis>> = {};
    let skip = false;

    for (const axis of AXES) {
      const base = axisItems(q, axis);
      if (!base) continue;

      const outcome = renderAxis(q, axis, base, seed, ctx);
      events.push(...outcome.events);

      if (outcome.terminate) {
        // First terminate wins; the caller finalizes the session, so continuing to render the
        // rest of the page would be wasted work on a page nobody sees.
        terminate ??= { question_id: q.id, axis };
        skip = true;
        break;
      }
      if (outcome.skip_question) {
        skip = true;
        break;
      }
      if (outcome.axis) {
        axes[axis] = outcome.axis;
        if (outcome.design_codes) {
          designWrites.push({ question_id: q.id, axis, codes: outcome.design_codes });
        }
      }
    }

    if (skip) {
      skipped.push({ question_id: q.id, reason: 'masked_empty' });
      digestParts.push(`${q.id}|masked_empty`);
      continue;
    }

    const label = pipeText(q.label);
    const instruction = pipeText(q.instruction);

    questions.push({
      id: q.id,
      ref: q.ref,
      question_type: q.question_type,
      required: q.required ?? false,
      label,
      instruction,
      ...(axes.options ? { options: axes.options } : {}),
      ...(axes.rows ? { rows: axes.rows } : {}),
      ...(axes.columns ? { columns: axes.columns } : {}),
    });

    // Item codes AND their order both enter the digest: a reordered list is a different render
    // as far as a respondent's answer is concerned, and disabled state changes what they can
    // pick. Piped text is included because that is what E §7.2 calls "the question it read
    // changed".
    const axisPart = AXES.filter(a => axes[a])
      .map(a => `${a}:${axes[a]!.items.map(i => i.code).join(',')}` +
        `!${[...axes[a]!.disabled_codes].sort((x, y) => x - y).join(',')}`)
      .join(';');
    digestParts.push(`${q.id}|shown|${axisPart}|${label ?? ''}|${instruction ?? ''}`);
  }

  return {
    page_id: page.id,
    questions,
    skipped,
    ...(terminate ? { terminate } : {}),
    events,
    design_writes: designWrites,
    digest: hashString(digestParts.join('\n')),
  };
}
