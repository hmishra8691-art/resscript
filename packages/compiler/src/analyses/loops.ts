/**
 * `CMP-0100` (nested loops) and the loop-spec checks the schema's structural validator does not
 * make — C §13, schema §13, roadmap P2-02.
 *
 * ## CMP-0100 was declared and never raised
 *
 * `diagnostics.ts` has carried `'CMP-0100': 'nested loops are not supported at this schema version'`
 * at severity `error` since P1-08, and nothing emitted it. `derive.ts:379` even reasons FROM it —
 * "nested loops are `CMP-0100` anyway (CONTEXT decision 9)" — to justify taking the innermost loop
 * and ignoring the rest.
 *
 * So a nested loop compiled cleanly, and the compiler then quietly treated the outer one as though
 * it were not there: `walkQuestions` keeps the innermost, the variable registry unrolls only that
 * one, and a question nested two loops deep got N variables instead of N×M. A survey that asks
 * three questions about each of four brands in each of two countries emitted a quarter of its
 * columns, with no diagnostic, and the missing data would surface as an analyst's confusion months
 * later.
 *
 * A declared-and-unemitted error code is worse than an absent one, because the code's existence is
 * what convinced a later reader that the case was handled.
 *
 * ## The rest of it: what `validate.ts` checks, and what it does not
 *
 * `validate.ts` makes exactly ONE loop check — that a `selected_options` source's `variable_id`
 * resolves. Everything else about a `LoopSpec` is unvalidated, and each gap below is a survey that
 * publishes and then misbehaves rather than one that fails to publish:
 *
 *  * `max_iterations` is what makes aggregation over a loop statically bounded (D §2.4) and what
 *    bounds the variable count. Zero unrolls nothing — a loop that emits no variables and no pages,
 *    which reads as "the loop block vanished". A large value multiplies the whole variable manifest.
 *  * `variable_naming` without `{iteration}` gives every iteration the SAME derived name. That is
 *    not a cosmetic problem: `variableSignature` keys identity on `(question, part, iteration)` so
 *    the variables stay distinct, and then two export columns carry one header. An analyst opening
 *    the file finds `Q7` twice.
 *  * An `explicit_list` with duplicate refs or codes makes `{{BRAND.label}}` ambiguous and a
 *    per-iteration join non-deterministic.
 *  * A `numeric_range` whose `to` is below its `from` is an empty loop written as though it were a
 *    full one.
 *
 * These are WARNINGS where the survey still means something and errors where it does not, which is
 * the line this codebase draws everywhere else: an error is a survey whose behaviour nobody can
 * state, a warning is one whose behaviour is statable and probably not what was meant.
 */

import { pointer, walkQuestions, type LoopSpec, type Survey } from '@resscript/schema';

import { cmpDiagnostic, sortCompileDiagnostics, type CompileDiagnostic } from '../diagnostics.js';

/** Above this, the variable manifest is being multiplied by a number nobody typed on purpose. */
const LARGE_ITERATION_COUNT = 50;

export interface LoopsInput {
  readonly survey: Survey;
}

/**
 * Every (block id, loop) pair, with the ancestor chain that reached it.
 *
 * Its own walk rather than `walkQuestions`, and that is the point: `walkQuestions` implements
 * "innermost enclosing loop wins" and therefore CANNOT see a nesting — it has already discarded the
 * outer one by the time a caller is told anything. Detecting the case the rest of the compiler
 * assumes away needs a walk that keeps the whole chain.
 */
function loopChains(survey: Survey): readonly { path: readonly string[]; loops: readonly LoopSpec[] }[] {
  const out: { path: readonly string[]; loops: readonly LoopSpec[] }[] = [];

  const visit = (
    nodes: readonly unknown[],
    path: readonly string[],
    loops: readonly LoopSpec[],
  ): void => {
    for (const raw of nodes) {
      const node = raw as {
        id?: string;
        kind?: string;
        settings?: { loop?: LoopSpec | null };
        content?: readonly unknown[];
      };
      const id = node.id ?? '';
      const loop = node.settings?.loop ?? undefined;
      const nextLoops = loop === undefined || loop === null ? loops : [...loops, loop];
      const nextPath = [...path, id];
      if (nextLoops.length > 0) out.push({ path: nextPath, loops: nextLoops });
      if (Array.isArray(node.content)) visit(node.content, nextPath, nextLoops);
    }
  };

  visit(survey.content ?? [], [], []);
  return out;
}

export function analyzeLoops(input: LoopsInput): readonly CompileDiagnostic[] {
  const out: CompileDiagnostic[] = [];
  const chains = loopChains(input.survey);

  /* ---- CMP-0100: nesting ------------------------------------------------ */

  // ONE report per nesting, keyed on the OUTERMOST loop of the chain, carrying the greatest depth
  // seen under it.
  //
  // Keying on the path prefix — which is what I wrote first — produces one row per DEPTH: a
  // three-deep nesting yields both the depth-2 chain and the depth-3 chain, because those are
  // different prefixes. That is two rows for one authoring mistake whose fix is the same edit
  // either way, and a diagnostic list that multiplies by nesting depth is how it becomes noise.
  // The outermost loop is the stable identity of the violation: "this loop contains another one".
  const worst = new Map<LoopSpec, { path: readonly string[]; loops: readonly LoopSpec[] }>();
  for (const chain of chains) {
    if (chain.loops.length < 2) continue;
    const outer = chain.loops[0] as LoopSpec;
    const existing = worst.get(outer);
    if (existing === undefined || chain.loops.length > existing.loops.length) {
      worst.set(outer, chain);
    }
  }
  // Sorted by path so the diagnostic array does not move when content is reordered.
  const nested = [...worst.values()].sort((a, b) =>
    a.path.join('/') < b.path.join('/') ? -1 : 1,
  );
  for (const chain of nested) {
    out.push(
      cmpDiagnostic(
        'CMP-0100',
        `This block is inside ${String(chain.loops.length)} nested loops, which this schema ` +
          'version does not support. The compiler unrolls a loop into concrete per-iteration ' +
          'variables, and it unrolls only the INNERMOST one — so a question nested two loops deep ' +
          'would silently emit one loop’s worth of columns instead of the product, and the ' +
          'missing data would not surface until somebody read the export. Restructure so at most ' +
          'one loop encloses any question.',
        pointer('content'),
        {
          depth: chain.loops.length,
          block_path: chain.path,
          iteration_refs: chain.loops.map((l) => l.iteration_variable_ref),
        },
      ),
    );
  }

  /* ---- The spec checks validate.ts does not make ------------------------ */

  // Deduped by loop identity, because one loop reached through several descendant paths is one
  // authoring object and should produce one diagnostic.
  const seen = new Set<LoopSpec>();
  const ordered = [...chains].sort((a, b) => (a.path.join('/') < b.path.join('/') ? -1 : 1));

  for (const chain of ordered) {
    for (const loop of chain.loops) {
      if (seen.has(loop)) continue;
      seen.add(loop);
      const at = pointer('content');
      const ref = loop.iteration_variable_ref;

      if (!Number.isInteger(loop.max_iterations) || loop.max_iterations < 1) {
        out.push(
          cmpDiagnostic(
            'CMP-0104',
            `The loop ${JSON.stringify(ref)} has max_iterations ` +
              `${JSON.stringify(loop.max_iterations)}. It is what makes aggregation over the loop ` +
              'statically bounded and what decides how many variables exist, so a value below 1 ' +
              'unrolls nothing at all — no variables, no pages — which reads as the loop block ' +
              'having vanished rather than as a configuration error.',
            at,
            { iteration_variable_ref: ref, max_iterations: loop.max_iterations },
          ),
        );
      } else if (loop.max_iterations > LARGE_ITERATION_COUNT) {
        out.push(
          cmpDiagnostic(
            'CMP-0105',
            `The loop ${JSON.stringify(ref)} allows ${String(loop.max_iterations)} iterations, ` +
              'which multiplies every variable inside it by that number. This is a warning rather ' +
              'than an error because a long loop is sometimes exactly right — but the export ' +
              'column count and the compile time both scale with it, so it is worth confirming ' +
              'the number was intended.',
            at,
            { iteration_variable_ref: ref, max_iterations: loop.max_iterations },
          ),
        );
      }

      if (!loop.variable_naming.includes('{iteration}')) {
        out.push(
          cmpDiagnostic(
            'CMP-0106',
            `The loop ${JSON.stringify(ref)} names its variables ` +
              `${JSON.stringify(loop.variable_naming)}, which does not contain {iteration}. Every ` +
              'iteration would derive the SAME name. The variables stay distinct — identity is ' +
              'keyed on (question, part, iteration), not on the name — so nothing breaks at ' +
              'compile time and the export instead carries two columns under one header, which an ' +
              'analyst discovers by opening the file.',
            at,
            { iteration_variable_ref: ref, variable_naming: loop.variable_naming },
          ),
        );
      }

      if (loop.source.kind === 'explicit_list') {
        const refs = loop.source.items.map((i) => i.ref);
        const codes = loop.source.items.map((i) => i.code);
        const dupRefs = [...new Set(refs.filter((r, i) => refs.indexOf(r) !== i))].sort();
        const dupCodes = [...new Set(codes.filter((c, i) => codes.indexOf(c) !== i))].sort(
          (a, b) => a - b,
        );
        if (dupRefs.length > 0 || dupCodes.length > 0) {
          out.push(
            cmpDiagnostic(
              'CMP-0107',
              `The loop ${JSON.stringify(ref)} lists duplicate items. A ref is how ` +
                `{{${ref}.label}} resolves and a code is how an iteration joins to an answer, so ` +
                'a duplicate of either makes one iteration indistinguishable from another — in ' +
                'the piped text a respondent reads, and in the export.',
              at,
              { iteration_variable_ref: ref, duplicate_refs: dupRefs, duplicate_codes: dupCodes },
            ),
          );
        }
        if (loop.source.items.length === 0) {
          out.push(
            cmpDiagnostic(
              'CMP-0104',
              `The loop ${JSON.stringify(ref)} has an explicit list with no items, so it iterates ` +
                'zero times. An empty loop written as though it were a full one is a block that ' +
                'silently contributes nothing.',
              at,
              { iteration_variable_ref: ref, item_count: 0 },
            ),
          );
        }
      }

      if (loop.source.kind === 'numeric_range' && loop.source.to < loop.source.from) {
        out.push(
          cmpDiagnostic(
            'CMP-0104',
            `The loop ${JSON.stringify(ref)} ranges from ${String(loop.source.from)} to ` +
              `${String(loop.source.to)}, which is empty. Written this way it looks like a loop ` +
              'that runs, and it runs zero times.',
            at,
            { iteration_variable_ref: ref, from: loop.source.from, to: loop.source.to },
          ),
        );
      }
    }
  }

  return sortCompileDiagnostics(out);
}
