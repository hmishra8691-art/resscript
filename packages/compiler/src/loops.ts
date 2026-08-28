/**
 * Loop unrolling: one authored page inside a loop becomes N per-iteration pages (C §13, roadmap
 * P2-02).
 *
 * ## Why unrolling, and why it is not a compromise
 *
 * The alternative is a runtime that walks a loop dynamically — a back-edge in the flow graph, an
 * iteration counter on the session, per-iteration variable resolution at answer time. That is the
 * design the `LoopFrame`/`iteration_stack` shape in `apps/runtime/src/session/types.ts` was sketched
 * for, and it has never been written.
 *
 * Unrolling is what the rest of the system already assumes. `schema/types/content.ts` says it in
 * `LoopSpec`'s own comment: "The compiler unrolls loop iterations into concrete variables
 * (`Q7_1`…`Q7_5`), which is what keeps aggregation over a loop statically bounded." `variables.ts`
 * already does exactly that and is tested. `logic/registry.ts`'s `loop_iterations` group resolves by
 * collecting those unrolled variables. So the variable half of looping has been unrolled since P1;
 * the page half simply was not, which is why a `loop` flow node ran its target once.
 *
 * Unrolling the pages too makes the runtime need NO changes at all: `machine.ts` derives a node's
 * pages from `graph.page_order` filtered by `page_entry`, so a loop whose target contributes N× the
 * pages is walked correctly by the `case 'sequence': case 'loop':` arm that already exists. The
 * comment there — treating the two identically — becomes true rather than a placeholder.
 *
 * ## Why sharing logic cells across iterations is CORRECT, not a shortcut
 *
 * The obvious objection: N unrolled pages share one authored question id, so they share one
 * visibility cell, one items cell, one validation. If a rule could differ per iteration, that would
 * be a silent bug.
 *
 * No rule can. `packages/logic`'s `Expr` union has **no node that reads the current iteration** —
 * no `iteration`, no `index`, no `current`. The only per-item binding is `item`/`item_attr`, which
 * binds to an option, row or column, not to a loop iteration. A loop is reachable from logic solely
 * as an aggregation *group* (`loop_iterations`), which reads across iterations rather than within
 * one.
 *
 * So a rule's verdict is provably iteration-invariant, and one shared cell is not an approximation
 * of N cells — it is the same value N times. This is the same argument that makes the variable
 * unrolling static, and it is the reason this design is finishable rather than a rewrite.
 *
 * **What would change that**: adding an iteration-reading expression node. At that point the logic
 * program needs per-iteration cells and this file's assumption becomes a bug. The invariant is
 * therefore asserted in `loops.test.ts` against the real `Expr` union, so adding such a node fails
 * a test that names this file, rather than silently invalidating it.
 *
 * ## Ids are DERIVED, never minted
 *
 * `apps/worker/src/authoring-model.ts` states the house rule for synthesized ids: "the flow node ids
 * are DERIVED from the content ids rather than minted (`fn_<block body>`), because the compiler must
 * be deterministic — a fresh ULID per compile would change `graph.json`, change the artifact hash,
 * and destroy the one property the milestone is judged on."
 *
 * A page id cannot change its prefix the way a flow node id can (`pages/<lang>/<id>.json` and
 * `PageId` are both `pg_`-shaped), so the iteration is encoded into the BODY, replacing its last
 * four characters. That is a lossy transform, so it can collide with a real authored page id — and
 * "collides with probability 1/32^4" is not a property worth shipping. `checkDerivedPageIds` reports
 * a collision as `CMP-0108` instead, which makes it a publish error somebody reads rather than
 * corrupt data nobody notices.
 */

import { pointer, walkQuestions, type LoopSpec, type Survey } from '@resscript/schema';

import { cmpDiagnostic, type CompileDiagnostic } from './diagnostics.js';

/**
 * Crockford base32's alphabet, in value order. Excludes I, L, O and U — `app.ulid`'s domain CHECK is
 * `^[a-z]{2,5}_[0-7][0-9A-HJKMNP-TV-Z]{25}$`, so a derived id that used them would be rejected by
 * the database that stores the artifact's page references.
 */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * The marker that separates an iteration suffix from the body it replaced.
 *
 * `V` because it is in the alphabet and is not a digit, so a suffix always reads as `V###` rather
 * than as four more body characters. `authoring-model.ts` hit the same constraint and recorded it:
 * "which is why 'LOOP' and 'SOURCE' could not have been used".
 */
const ITERATION_MARKER = 'V';

/** How many Crockford digits the iteration gets. Three is 32,768 — far above any real cap. */
const ITERATION_DIGITS = 3;

/**
 * `pg_01ABC…` at iteration 3 becomes `pg_01AB…V003`-shaped: the body's last four characters are
 * replaced by the marker plus the iteration.
 *
 * Replacing rather than appending because the length is fixed at 26 by the ULID domain. Iteration 1
 * gets a derived id too, deliberately: if iteration 1 kept the authored id, a loop would have one
 * page addressed differently from its siblings, and every downstream map would need to know which
 * case it was looking at. Uniform is worth one redundant id.
 */
export function derivedPageId(pageId: string, iteration: number): string {
  const underscore = pageId.indexOf('_');
  const prefix = pageId.slice(0, underscore + 1);
  const body = pageId.slice(underscore + 1);
  let digits = '';
  let n = Math.max(0, Math.floor(iteration));
  for (let i = 0; i < ITERATION_DIGITS; i += 1) {
    digits = (CROCKFORD[n % 32] as string) + digits;
    n = Math.floor(n / 32);
  }
  const keep = body.slice(0, Math.max(0, body.length - (ITERATION_DIGITS + 1)));
  return `${prefix}${keep}${ITERATION_MARKER}${digits}`;
}

/** Page id → its enclosing loop, for pages inside one. */
export function loopsByPage(survey: Survey): ReadonlyMap<string, LoopSpec> {
  const out = new Map<string, LoopSpec>();
  // `walkQuestions` gives (question, innermost loop) and the compiler needs (page, loop). A page is
  // the question's parent, so the association is built by walking the tree here — and the innermost
  // loop is the right one for the same reason walkQuestions picks it: nested loops are CMP-0100.
  const visit = (nodes: readonly unknown[], loop: LoopSpec | undefined): void => {
    for (const raw of nodes) {
      const node = raw as {
        id?: string;
        type?: string;
        settings?: { loop?: LoopSpec | null };
        children?: readonly unknown[];
      };
      const own = node.settings?.loop ?? undefined;
      const inner = own === undefined || own === null ? loop : own;
      if (node.type === 'page' && inner !== undefined) out.set(node.id ?? '', inner);
      if (Array.isArray(node.children)) visit(node.children, inner);
    }
  };
  visit(survey.content ?? [], undefined);
  return out;
}

/** How many times a loop unrolls. Bounded by `max_iterations`, which is the whole point of it. */
export function iterationCount(loop: LoopSpec): number {
  const cap = Number.isInteger(loop.max_iterations) ? loop.max_iterations : 0;
  if (cap < 1) return 0;
  if (loop.source.kind === 'explicit_list') {
    // The list bounds it below the cap: unrolling 20 iterations for a 4-item list would emit 16
    // pages nobody can reach and 16 sets of export columns that are always empty.
    return Math.min(cap, loop.source.items.length);
  }
  if (loop.source.kind === 'numeric_range') {
    const span = loop.source.to - loop.source.from + 1;
    return Math.min(cap, Math.max(0, span));
  }
  // `selected_options`: the real count depends on a respondent's answer, which is not knowable at
  // compile time. The cap is the unroll, and iterations beyond the respondent's selection count are
  // handled by page visibility at runtime — not here.
  return cap;
}

export interface UnrolledPage {
  /** The derived id this iteration's page is addressed by. */
  readonly id: string;
  /** The authored page id — what the logic program's cells are keyed on. */
  readonly authoredId: string;
  /** 1-based. */
  readonly iteration: number;
}

/**
 * Expand a flow-ordered page list, replacing each looped page with its iterations.
 *
 * ITERATION-MAJOR within a page, page-minor: page A iteration 1, page A iteration 2, … then page B.
 * That is wrong for most real loops, which want "every page of the block, then the next iteration",
 * so the ordering is decided by the caller through `pagesOfLoop` below rather than assumed here.
 */
export function unrollPageOrder(
  pageOrder: readonly string[],
  loops: ReadonlyMap<string, LoopSpec>,
): readonly UnrolledPage[] {
  const out: UnrolledPage[] = [];
  // Grouped into runs of consecutive pages sharing a loop, so the iteration wraps the whole run:
  // a loop over "brand" asking three questions on three pages must ask all three about brand 1
  // before starting brand 2. Emitting page-major would ask question 1 about every brand, then
  // question 2 about every brand — a different survey.
  let i = 0;
  while (i < pageOrder.length) {
    const pageId = pageOrder[i] as string;
    const loop = loops.get(pageId);
    if (loop === undefined) {
      out.push({ id: pageId, authoredId: pageId, iteration: 0 });
      i += 1;
      continue;
    }
    // The maximal run of consecutive pages under the SAME loop object.
    let j = i;
    while (j < pageOrder.length && loops.get(pageOrder[j] as string) === loop) j += 1;
    const run = pageOrder.slice(i, j);
    const count = iterationCount(loop);
    for (let iteration = 1; iteration <= count; iteration += 1) {
      for (const id of run) {
        out.push({ id: derivedPageId(id, iteration), authoredId: id, iteration });
      }
    }
    i = j;
  }
  return out;
}

/**
 * `CMP-0108`: a derived per-iteration id collides with an authored page id, or with another derived
 * one.
 *
 * Reported rather than worked around. The transform replaces four characters of a ULID body, so a
 * collision is possible — and a collision means two different pages share an artifact file path and
 * a `page_entry` key, which would silently serve one page's content where the other was expected.
 * "Unlikely" is not a property to ship when the check costs one set.
 */
export function checkDerivedPageIds(
  unrolled: readonly UnrolledPage[],
  authoredPageIds: readonly string[],
): readonly CompileDiagnostic[] {
  const authored = new Set(authoredPageIds);
  const seen = new Map<string, UnrolledPage>();
  const out: CompileDiagnostic[] = [];

  for (const page of unrolled) {
    if (page.iteration === 0) continue;
    const clash = seen.get(page.id);
    // A derived id colliding with an AUTHORED page that is not its own source is the dangerous
    // case; colliding with its own source cannot happen, since the marker replaces four characters
    // a ULID body could match only by coincidence — which is exactly what this reports.
    if (clash !== undefined || (authored.has(page.id) && page.id !== page.authoredId)) {
      out.push(
        cmpDiagnostic(
          'CMP-0108',
          `The per-iteration page id ${JSON.stringify(page.id)}, derived from ` +
            `${JSON.stringify(page.authoredId)} at iteration ${String(page.iteration)}, collides ` +
            'with an id that already exists. Per-iteration ids are DERIVED rather than minted so ' +
            'that a recompile produces a byte-identical artifact, and deriving replaces four ' +
            'characters of the page id — which can, rarely, land on an id already in use. Two ' +
            'pages sharing an id would share an artifact file and a flow entry, serving one ' +
            'page’s content where the other was expected. Changing the colliding page’s id ' +
            'resolves it.',
          pointer('content'),
          {
            derived_id: page.id,
            authored_id: page.authoredId,
            iteration: page.iteration,
            collides_with: clash === undefined ? 'authored_page' : 'another_iteration',
          },
        ),
      );
      continue;
    }
    seen.set(page.id, page);
  }
  return out;
}

/**
 * Variables a question emits AT ONE ITERATION.
 *
 * The reason this exists: `emitsOf` in `emit/pages.ts` collects every variable whose
 * `source.question_id` matches, which for a looped question is ALL N iterations' variables. One
 * rendered question carrying N iterations' worth of variables is how an answer at iteration 2 would
 * be written to iteration 1's column — or to all of them.
 */
export function emitsAtIteration(
  survey: Survey,
  questionId: string,
  iteration: number,
): readonly string[] {
  const out: string[] = [];
  for (const variable of survey.variables ?? []) {
    const source = variable.source as { question_id?: string; iteration?: number } | undefined;
    if (source?.question_id !== questionId) continue;
    // iteration 0 means "not in a loop", and such a question's variables carry no iteration.
    const own = source.iteration;
    if (iteration === 0 ? own !== undefined : own !== iteration) continue;
    out.push(variable.id);
  }
  return out;
}

/**
 * Does any question in this survey sit inside a loop?
 *
 * Used to skip the whole unrolling path for the overwhelmingly common case of a survey with no
 * loops, so that adding this feature costs a survey without loops one map lookup.
 */
export function hasLoops(survey: Survey): boolean {
  let found = false;
  walkQuestions(survey.content ?? [], (_question, loop) => {
    if (loop !== undefined) found = true;
  });
  return found;
}
