/**
 * Session replay — the shapes and the redaction behind `GET /preview/:hash/replay/:session_id`
 * (P1-11's last acceptance line, E §12.3's "highest-value message in the list").
 *
 * A replay is not a simulation. Three earlier decisions make it a pure re-derivation of what one
 * respondent actually saw: ADR-006 (every randomization decision is a function of the session's
 * `random_seed`), ADR-007 (`runtime.response_events` is the source of truth, so the respondent's
 * inputs are still on disk), and E §2.3 (the machine is a pure reducer, so seed + inputs re-drive
 * it). Migration 0014's `runtime.replay_session` supplies the seed, the pin and the input list;
 * the handler re-drives `handleSubmitCore` over them with NO `persist`; this module owns what a
 * step LOOKS like and what a human is allowed to see in it.
 *
 * ## Why the write path cannot be reached from here
 *
 * Structural, not disciplined: nothing in this module takes a `RuntimeWriter`, a `SessionStore`,
 * or a `persist` closure, so there is no seam a replay could write through even by mistake. The
 * handler's replay branch builds its `SubmitDeps` without `persist` for the same reason, and a
 * test drives a replay with a writer whose every write method throws.
 *
 * ## Redaction, which is the price of replaying production sessions
 *
 * Migration 0014's header records the decision: replay is allowed for PRODUCTION sessions, not
 * only `is_test` ones, because the dispute it exists to settle ("the client says the rotation is
 * wrong", ADR-006) is always about a production respondent. The database returns the events
 * unredacted to the ONE role that holds the artifact manifest, and the redaction happens HERE —
 * security §8.1's rule, verbatim: the value is replaced "before the trace leaves the runtime",
 * for everyone including Owners, "because a trace is a debugging artifact and there is no
 * debugging reason to see a respondent's email".
 *
 * Two places carry values and both are redacted: the recorded input echoed on each step, and the
 * trace's `value(<variable>)` cells. It is done by VARIABLE ID against the manifest's `pii` flags
 * — the same flags the compiler stamped and the exporter reads (arch §3.4) — rather than by
 * pattern-matching values, because a regex over serialized output fails the first time someone
 * nests an object (security §8.1's own argument for a tainted-value type over log scrubbing).
 */

import type { ManifestVariableLike, RenderedPage } from '@resscript/runtime-core';
import type { ReplayEvent, ReplaySource } from '../session/durable.js';
import type { SessionState } from '../session/types.js';
import { createSession } from '../entry.js';

/**
 * What a redacted value renders as. E §14.2's panel spells it `●●●●`; the marker is a STRING and
 * not a deletion so the debug panel still shows that the variable was written, which is half of
 * what a programmer reading a replay needs to know.
 */
export const PII_REDACTED = '●●●●';

export interface ReplayQuestion {
  readonly question_id: string;
  readonly ref: string;
  /**
   * Axis → the item codes IN THE ORDER THIS RESPONDENT SAW THEM, after masking. This is the
   * P1-11 test's subject ("every option order match the original exactly") and it is taken from
   * the rendered page rather than recomputed, so a bug in ordering shows up as a diff instead of
   * being reproduced identically on both sides of the comparison.
   */
  readonly order: { readonly [axis: string]: readonly number[] };
}

/** How the step ENDED, so a truncated replay is never mistaken for a short interview. */
export type ReplayOutcome =
  | 'submitted'          // the recorded submit advanced the machine, as it did originally
  | 'final'              // the recorded submit finalized the session
  | 'unsubmitted'        // no further recorded input: where the respondent actually stopped
  | 'validation_failed'  // the pipeline rejected a value the original run accepted — a real bug
  | 'stale'
  | 'back_refused'
  | 'replayed';          // the idempotency guard matched: two events with identical values

export interface ReplayStep {
  /**
   * The event `seq` whose replay PRODUCED this page: `1` (the birth event) for the entry render,
   * and thereafter the submit that advanced into it. Defined for every step including the last,
   * which is what a step keyed by "the submit made on it" could not manage.
   */
  readonly seq: number;
  readonly page_id: string;
  readonly questions: readonly ReplayQuestion[];
  readonly skipped: readonly { readonly question_id: string; readonly reason: string }[];
  /** E §7.2's render digest — the same string invalidate-forward compares. */
  readonly digest: string;
  /**
   * The orders handed to the ENGINE, keyed `<question>.<axis>`, computed over the declared item
   * list before masking (E §8.3). Kept alongside `questions[].order` on purpose: when the two
   * disagree the cause is a mask, and a rotation dispute is usually exactly that confusion.
   */
  readonly orders: { readonly [scope: string]: readonly number[] };
  /** E §14.2's rule verdicts for this page: cells, writers, conditions, collapses. */
  readonly trace: unknown;
  /** The recorded input replayed against this page, pii-redacted. Null on the final step. */
  readonly submitted: Record<string, unknown> | null;
  readonly outcome: ReplayOutcome;
  /**
   * Present only for `validation_failed`, which on a PINNED artifact is a finding rather than an
   * expected outcome: the original run accepted these values, so a refusal now means a validation
   * whose verdict depends on something outside the seed and the recorded inputs.
   */
  readonly failures?: readonly { readonly question_id: string; readonly message_key: string }[];
}

export interface ReplayResult {
  readonly session_id: string;
  readonly artifact_hash: string;
  /** ADR-006's key, echoed so the panel can seed a fresh preview from the same randomness. */
  readonly seed: string;
  readonly language: string;
  readonly is_test: boolean;
  readonly steps: readonly ReplayStep[];
  /** The disposition the replay reached, or null for a session that never finalized. */
  readonly disposition: string | null;
}

/* ------------------------------------------------------------------ *
 * Redaction (security §8.1, E §14.2)
 * ------------------------------------------------------------------ */

/**
 * The pii-flagged variables of an artifact, by ID and by NAME.
 *
 * Both spellings, because a submit may be keyed either way (`filterSubmit` accepts both) and a
 * redaction that only knew one of them would leak the other. The manifest is the authority: it is
 * what the compiler stamped from `content.variables.pii` and what the exporter reads.
 */
export function piiVariableIds(
  manifest: readonly ManifestVariableLike[] | undefined,
): ReadonlySet<string> {
  const out = new Set<string>();
  for (const v of manifest ?? []) {
    if (!v.pii) continue;
    out.add(v.id);
    if (v.name) out.add(v.name);
  }
  return out;
}

/** Replace the VALUES of pii variables, keeping the keys — "written, not shown". */
export function redactValues(
  values: Record<string, unknown> | null,
  pii: ReadonlySet<string>,
): Record<string, unknown> | null {
  if (values === null) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) out[k] = pii.has(k) ? PII_REDACTED : v;
  return out;
}

/**
 * Redact a logic trace in place of nothing — a new array, same order.
 *
 * A trace cell is keyed by `packages/logic`'s `cellKey`, so a variable's value cell is spelled
 * `value(<variable_id>)` and that is the only cell shape whose `result` can be a respondent's
 * personal data. Visibility, item and validity cells hold booleans and code lists, which are
 * structure rather than content and are exactly what a replay is being read for.
 */
export function redactTrace(trace: unknown, pii: ReadonlySet<string>): unknown {
  if (!Array.isArray(trace) || pii.size === 0) return trace;
  return trace.map(entry => {
    const cell = (entry as { cell?: unknown } | null)?.cell;
    if (typeof cell !== 'string') return entry;
    const m = /^value\((.+)\)$/.exec(cell);
    if (!m || !pii.has(m[1] as string)) return entry;
    return { ...(entry as object), result: PII_REDACTED };
  });
}

/* ------------------------------------------------------------------ *
 * Shaping
 * ------------------------------------------------------------------ */

const AXES = ['options', 'rows', 'columns'] as const;

/**
 * The page half of a step, read off the rendered page and the trace the same render produced.
 *
 * `debug` is the object `evaluateAndRender` builds for a test session — the replay surface asks
 * for it explicitly (see the handler's `trace` render option) because a PRODUCTION session's
 * trace is a 5% digest sample in the field (E §14.1) and a replay must show the verdicts anyway.
 * Capturing it here is not a second code path: the engine produces the trace on every evaluation
 * regardless, and this surface is merely allowed to see it.
 */
export function replayPage(
  seq: number,
  page: RenderedPage,
  debug: Record<string, unknown> | undefined,
  pii: ReadonlySet<string>,
): Omit<ReplayStep, 'submitted' | 'outcome'> {
  const questions: ReplayQuestion[] = page.questions.map(q => {
    const order: Record<string, readonly number[]> = {};
    for (const axis of AXES) {
      const rendered = q[axis];
      if (rendered) order[axis] = rendered.items.map(i => i.code);
    }
    return { question_id: q.id, ref: q.ref, order };
  });

  return {
    seq,
    page_id: page.page_id,
    questions,
    skipped: page.skipped.map(s => ({ question_id: s.question_id, reason: s.reason })),
    digest: page.digest,
    orders: (debug?.['orders'] as ReplayStep['orders'] | undefined) ?? {},
    trace: redactTrace(debug?.['trace'] ?? [], pii),
  };
}

/**
 * The submit body a recorded event replays as: the page it was submitted against, and its inputs.
 */
export function submitBodyFor(
  event: ReplayEvent,
  currentPageId: string | null,
): { page_id: string; values: Record<string, unknown> } {
  return {
    // The event's own page id wins. It is null only when the id was not an `app.ulid` and the
    // typed column could not hold it (the handler's persist closure), in which case the machine's
    // cursor is the same page by construction — and if it is not, the pipeline answers `stale`,
    // which the step records rather than papers over.
    page_id: event.page_id ?? currentPageId ?? '',
    values: event.values ?? {},
  };
}

/**
 * The session state a replay starts from: the RECORDED seed, language and test flag, on the
 * RECORDED pin, with an empty variable state.
 *
 * Empty is the point — the whole claim of replay is that the stored `vars` are reproduced by
 * re-driving the inputs, not copied. Seeding from `response_documents` instead would make the
 * replay agree with the projection by construction and prove nothing about the reducer.
 *
 * `started_at` is the fixed clock: every timestamp the replay produces comes from it, so two
 * replays of one session are identical and a diff between them is always a real change.
 */
export function initialReplayState(source: ReplaySource, surveyId: string): SessionState {
  const base = createSession({
    session_id: source.session_id,
    // Derived from the session id rather than minted, for the reason `rebuildSession` gives: a
    // fresh random id per replay would make two replays of one session differ in a field.
    respondent_id: `rsp_${source.session_id.slice(4)}`,
    survey_id: surveyId,
    artifact_hash: source.artifact_hash,
    random_seed: source.random_seed,
    language: source.language,
  });
  return {
    ...base,
    survey_version_id: source.survey_version_id,
    is_test: source.is_test,
    started_at: source.started_at,
    last_activity_at: source.started_at,
    server_time_ms: source.started_at,
    // Seq 1 is the birth event; the first recorded submit is seq 2, and `handleSubmitCore`
    // derives the seq it would append from this. Nothing consumes it on the replay path (there
    // is no persist), but a state that lied about its position would make the trace's own
    // bookkeeping disagree with the events being replayed.
    last_event_seq: 1,
  };
}
