/**
 * Task 58: invalidate-forward, per Deliverable E §7.2.
 *
 * The respondent answers Q1 = "Yes", is shown Q2–Q7 because of it, answers them, then goes
 * back and changes Q1 to "No". Q2–Q7 are now answers to questions the final logic path says
 * were never asked, and they are sitting in the variable state feeding quota assignment,
 * downstream rules, and the export.
 *
 * E §7.1 weighs four policies and picks invalidate-forward: discard the answers that are
 * downstream of the change, keep the rest, record what happened. The other three all fail —
 * keep-all ships answers to unasked questions, full replay fabricates answers to
 * differently-masked questions, and forbidding back measurably increases abandonment.
 *
 * The part that makes it usable is step 3's *survival test*. A blanket "invalidate everything
 * after the changed page" is far simpler and produces a product research teams will not use:
 * a respondent 40 pages into a tracker who fixes a typo in their postcode loses the whole
 * interview and abandons. Only genuinely dependent pages are re-asked.
 *
 * Nothing is destroyed. The old values travel in the emitted event and the event log is the
 * source of truth (ADR-007), so they are recoverable forever; the current document simply
 * reflects the logic-consistent path.
 */

/* ------------------------------------------------------------------ *
 * Structural types
 * ------------------------------------------------------------------ */

/** One entry of the artifact's cell registry (C §17 `ArtifactLogicCell`). */
export interface InvalidationCell {
  readonly key: string;
  readonly kind: string;
  readonly cell: { readonly [k: string]: unknown };
}

/**
 * The subset of the compiled artifact this needs.
 *
 * `by_trigger_variable` is already the transitive downstream closure, topo-ordered, computed
 * by the compiler (C §17). So `dependents*(changed)` is a set walk over shipped data rather
 * than a graph traversal here, and — more importantly — it is a function of the published
 * bytes rather than of runtime code, which is the property ADR-002 exists to pin.
 */
export interface InvalidationArtifact {
  readonly logic: {
    readonly cells: readonly InvalidationCell[];
    readonly by_trigger_variable: { readonly [variableId: string]: readonly number[] };
  };
}

export interface InvalidationVisit {
  readonly page_id: string;
  /** Variables this visit wrote. */
  readonly wrote: readonly string[];
  /** Questions actually rendered on this visit. */
  readonly shown: readonly string[];
  /**
   * Digest of the page as it was rendered: visibility, resolved item sets, and piped text.
   *
   * E §7.2 step 3 tests three separate render properties for drift. One digest covers all
   * three, and it has to be *recorded at render time* — the alternative is re-deriving what
   * the respondent saw from an earlier variable state, which is the "full replay" policy
   * §7.1 rejects. A visit with no digest is treated as drifted (fail-safe: re-ask).
   */
  readonly render_digest?: string | null;
  readonly invalidated?: boolean;
}

/**
 * Recomputation hooks. The runtime supplies these; they read the *new* variable state.
 *
 * They are injected rather than computed here for the same reason the machine injects
 * `evalCondition`: rule evaluation lives in `packages/logic`, and `runtime-core` must stay
 * loadable in a browser and in QuickJS.
 */
export interface RecomputeProbe {
  /** Is the page visible under the new state? */
  isPageVisible(page_id: string): boolean;
  /**
   * Digest of the page under the new state, in the same form as
   * `InvalidationVisit.render_digest`. `null` means "cannot tell", which counts as drift.
   */
  recomputeDigest(page_id: string): string | null;
}

export interface InvalidateInput {
  /** The page just submitted — the one the respondent backed up to. */
  readonly trigger_page_id: string;
  /** The full visit log, oldest first. */
  readonly history: readonly InvalidationVisit[];
  /** Variable state as it stands *before* this submit is applied. */
  readonly vars: { readonly [variableId: string]: unknown };
  /** What the submit of `trigger_page_id` writes. */
  readonly writes: { readonly [variableId: string]: unknown };
  readonly artifact: InvalidationArtifact;
  readonly probe: RecomputeProbe;
  readonly now_ms: number;
}

export interface AnswersInvalidatedEvent {
  readonly type: 'answers_invalidated';
  readonly trigger_page: string;
  readonly changed_variables: readonly string[];
  readonly invalidated_pages: readonly string[];
  readonly invalidated_variables: readonly string[];
  readonly kept_pages: readonly string[];
  /** Retained in the event, never in the document. Recoverable forever (ADR-007). */
  readonly old_values: { readonly [variableId: string]: unknown };
}

export interface InvalidateProvenance {
  readonly p: 'invalidated';
  readonly by_page: string;
  readonly at: number;
}

export interface InvalidateResult {
  /** Variables the submit actually changed. Empty means nothing was invalidated. */
  readonly changed: readonly string[];
  readonly invalidated_pages: readonly string[];
  readonly kept_pages: readonly string[];
  readonly invalidated_variables: readonly string[];
  /** New variable state: writes applied, invalidated variables nulled. */
  readonly vars: { readonly [variableId: string]: unknown };
  /** Provenance entries to merge, for the invalidated variables only. */
  readonly provenance: { readonly [variableId: string]: InvalidateProvenance };
  /** History with invalidated visits marked. Kept, not deleted — history is a log. */
  readonly history: readonly InvalidationVisit[];
  /** Exactly one event, or null when nothing changed. */
  readonly event: AnswersInvalidatedEvent | null;
}

/* ------------------------------------------------------------------ *
 * Value comparison
 * ------------------------------------------------------------------ */

/**
 * Order-sensitive deep equality.
 *
 * Arrays are compared in order and NOT as sets, even though a multi-select's value reads like
 * one. A ranking question's value is an ordered array where reordering is the entire answer,
 * so an order-insensitive compare would silently keep every page downstream of a changed
 * ranking. Comparing in order can only over-invalidate, which costs the respondent time;
 * comparing as sets can under-invalidate, which corrupts data. Prefer the former.
 */
export function valueEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  // null and undefined are both "no answer" as far as invalidation is concerned: a variable
  // absent from `vars` and one explicitly nulled are the same state to a respondent.
  if (a == null || b == null) return a == null && b == null;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((x, i) => valueEquals(x, b[i]));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a as object).sort();
    const kb = Object.keys(b as object).sort();
    if (ka.length !== kb.length || !ka.every((k, i) => k === kb[i])) return false;
    return ka.every(k =>
      valueEquals((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    );
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * Dependency closure
 * ------------------------------------------------------------------ */

/**
 * Which variables are transitively downstream of `changed`.
 *
 * Reads the compiler's precomputed closure and keeps the `value(...)` cells, since those are
 * the ones that name a variable. `changed` itself is excluded: the trigger page's own writes
 * are being *set*, not invalidated.
 */
export function dependentVariables(
  artifact: InvalidationArtifact,
  changed: readonly string[],
): Set<string> {
  const out = new Set<string>();
  const changedSet = new Set(changed);

  for (const v of changed) {
    const cellIndices = artifact.logic.by_trigger_variable[v];
    if (!cellIndices) continue;
    for (const idx of cellIndices) {
      const cell = artifact.logic.cells[idx];
      if (!cell || cell.kind !== 'value') continue;
      const varId = cell.cell['variable_id'];
      if (typeof varId === 'string' && !changedSet.has(varId)) out.add(varId);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * The algorithm
 * ------------------------------------------------------------------ */

/**
 * Apply a back-submit and invalidate forward (E §7.2 steps 2–5).
 *
 * The caller has already run filtering and validation for the trigger page (steps 5.3–5.4):
 * nothing is invalidated until the back-submit is itself valid, so a failed back-submit
 * changes nothing.
 *
 * Quota interaction (step 6) is the caller's: a released reservation needs Redis, and this
 * function stays pure.
 */
export function invalidateForward(input: InvalidateInput): InvalidateResult {
  const { trigger_page_id, history, vars, writes, artifact, probe, now_ms } = input;

  // ---- step 2: what actually changed ------------------------------------
  const changed = Object.keys(writes).filter(v => !valueEquals(vars[v], writes[v]));
  const nextVars: Record<string, unknown> = { ...vars, ...writes };

  if (changed.length === 0) {
    // The common case: a respondent goes back to *look* at Q1, not to change it. Downstream
    // answers stand and no event is emitted.
    return {
      changed: [],
      invalidated_pages: [],
      kept_pages: [],
      invalidated_variables: [],
      vars: nextVars,
      provenance: {},
      history,
      event: null,
    };
  }

  // ---- step 3: the invalidation frontier --------------------------------
  // Downstream is everything strictly after the trigger page's entry. `lastIndexOf` is
  // deliberate: on a re-visit the relevant entry is the current one, not the original.
  const triggerIdx = history.map(v => v.page_id).lastIndexOf(trigger_page_id);
  const downstreamFrom = triggerIdx === -1 ? history.length : triggerIdx + 1;

  const dependents = dependentVariables(artifact, changed);

  const invalidatedPages: string[] = [];
  const keptPages: string[] = [];
  const invalidatedVariables: string[] = [];
  const nextHistory: InvalidationVisit[] = history.slice(0, downstreamFrom);

  for (let i = downstreamFrom; i < history.length; i++) {
    const visit = history[i]!;

    // Already-invalidated visits stay invalidated; re-testing them would resurrect answers
    // that a previous back-submit correctly discarded.
    if (visit.invalidated) {
      nextHistory.push(visit);
      if (!invalidatedPages.includes(visit.page_id)) invalidatedPages.push(visit.page_id);
      continue;
    }

    const notVisible = !probe.isPageVisible(visit.page_id);
    // One digest covers all three render properties E §7.2 tests: visibility, item sets, and
    // piped text. A visit with no recorded digest cannot be shown to be unchanged, so it is
    // treated as drifted — re-asking a question is recoverable, keeping a stale answer is not.
    const recomputed = probe.recomputeDigest(visit.page_id);
    const drifted =
      visit.render_digest == null || recomputed == null || recomputed !== visit.render_digest;
    const dependsOnChange = visit.wrote.some(v => dependents.has(v));

    if (notVisible || drifted || dependsOnChange) {
      nextHistory.push({ ...visit, invalidated: true });
      if (!invalidatedPages.includes(visit.page_id)) invalidatedPages.push(visit.page_id);
      // ---- step 4 ------------------------------------------------------
      for (const v of visit.wrote) {
        if (!invalidatedVariables.includes(v)) invalidatedVariables.push(v);
      }
    } else {
      nextHistory.push(visit);
      if (!keptPages.includes(visit.page_id)) keptPages.push(visit.page_id);
    }
  }

  // Old values go into the event, not the document. Captured before nulling.
  const oldValues: Record<string, unknown> = {};
  for (const v of invalidatedVariables) oldValues[v] = vars[v] ?? null;
  for (const v of changed) oldValues[v] = vars[v] ?? null;

  const provenance: Record<string, InvalidateProvenance> = {};
  for (const v of invalidatedVariables) {
    nextVars[v] = null;
    provenance[v] = { p: 'invalidated', by_page: trigger_page_id, at: now_ms };
  }

  // ---- step 5: exactly one event ---------------------------------------
  const event: AnswersInvalidatedEvent = {
    type: 'answers_invalidated',
    trigger_page: trigger_page_id,
    changed_variables: changed,
    invalidated_pages: invalidatedPages,
    invalidated_variables: invalidatedVariables,
    kept_pages: keptPages,
    old_values: oldValues,
  };

  return {
    changed,
    invalidated_pages: invalidatedPages,
    kept_pages: keptPages,
    invalidated_variables: invalidatedVariables,
    vars: nextVars,
    provenance,
    history: nextHistory,
    event,
  };
}

/**
 * How many questions a back-submit would cost the respondent, for the confirmation prompt
 * E §7.2 requires ("Changing this answer means we'll need to ask you 6 questions again").
 *
 * Runs the same survival test without applying anything, so the number the respondent is
 * shown and the invalidation they get cannot disagree.
 */
export function invalidationCost(input: InvalidateInput): {
  questions: number;
  pages: number;
} {
  const result = invalidateForward(input);
  const shown = new Map<string, number>();
  for (const v of input.history) {
    if (result.invalidated_pages.includes(v.page_id)) {
      shown.set(v.page_id, Math.max(shown.get(v.page_id) ?? 0, v.shown.length));
    }
  }
  let questions = 0;
  for (const n of shown.values()) questions += n;
  return { questions, pages: result.invalidated_pages.length };
}
