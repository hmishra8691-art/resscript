/**
 * POST /s/:token/submit — E §5's steps, in E §5's order.
 *
 * ```
 *  1. LOAD          session (Redis → Postgres rebuild); replay / stale-tab / back triage
 *  2. RE-EVALUATE   the page from STORED vars — authoritative, ignoring client claims
 *  3. FILTER        anti-tamper: discard + record everything inconsistent with step 2
 *  4. VALIDATE      over the FILTERED values; failure = genuine no-op, re-render
 *  5. APPLY         merge vars with provenance; recompute derived (via evaluation #2)
 *  6. HOOKS         (QuickJS — deferred; recorded as an event when a page declares one)
 *  7. ADVANCE       the machine, with conditions bound to the POST-apply verdict
 *  8. PERSIST       one transaction: event + document + session projection; then Redis CAS
 *  9. DIVERGENCE    compare the client digest to the server's, field by field
 * 10. RESPOND       next page, or disposition
 * ```
 *
 * The single most important line of the whole file is the order of 2 and 3: visibility is
 * recomputed from stored state BEFORE the submitted values are looked at, so a submit cannot
 * influence the evaluation that judges it (E §6). And validation failing at 4 must change
 * NOTHING — no event, no document write, no variable mutation — because that no-op is what
 * makes "fix the error and resubmit" safe to retry forever.
 */

import { createLogger } from '@resscript/observability';
import {
  evaluatePage,
  filterSubmit,
  hashString,
  invalidateForward,
  renderPage,
  runValidations,
  type EvaluatedPage,
  type FilterResult,
  type PageValidationFailure,
  type RenderPage,
  type RenderedPage,
} from '@resscript/runtime-core';
import { evalCondition, evaluate, varStateOf } from '@resscript/logic';
import type { ArtifactHead } from './artifact/loader.js';
import type { RehydratedLogic } from '@resscript/runtime-core';
import { generateULID } from './entry.js';
import { makeCtx, step, type Cmd, type Input, type MachineArtifact } from './machine/index.js';
import type { PageVisit, SessionState } from './session/types.js';

const log = createLogger({ service: 'runtime-submit' });

/* ------------------------------------------------------------------ *
 * Request and response shapes
 * ------------------------------------------------------------------ */

export interface SubmitBody {
  readonly page_id: string;
  readonly values: Record<string, unknown>;
  readonly idempotency_key?: string;
  readonly client_trace?: {
    readonly state_hash?: string;
    readonly shown_hash?: string;
    readonly items_hash?: string;
    readonly orders_hash?: string;
    readonly artifact_hash?: string;
    readonly engine_version?: string;
  };
  readonly timings?: { readonly total_ms?: number; readonly focus_loss_ms?: number };
}

export type SubmitOutcome =
  | { readonly kind: 'advanced'; readonly session: SessionState;
      readonly cmds: readonly Cmd[]; readonly events: readonly Record<string, unknown>[] }
  | { readonly kind: 'final'; readonly session: SessionState; readonly disposition: string }
  | { readonly kind: 'validation_failed'; readonly session: SessionState;
      readonly page: RenderedPage; readonly failures: readonly PageValidationFailure[] }
  | { readonly kind: 'replay'; readonly response: unknown }
  | { readonly kind: 'stale'; readonly current_page_id: string | null }
  | { readonly kind: 'back_refused'; readonly reason: string };

export interface SubmitDeps {
  readonly head: ArtifactHead;
  readonly logic: RehydratedLogic;
  readonly loadPage: (pageId: string) => Promise<RenderPage | null>;
  readonly now: () => number;
  /** Persist through runtime.submit_page. Absent = in-memory mode (tests); seq still advances. */
  readonly persist?: (w: {
    expected_seq: number; event_id: string; event_type: string; page_id: string | null;
    vars: Record<string, unknown>; values: Record<string, unknown> | null;
    rejected_values: Record<string, unknown> | null; payload: Record<string, unknown>;
    client_trace: Record<string, unknown> | null; duration_ms: number | null;
    status: string; disposition: string | null; current_page_id: string | null;
    page_timings: Record<string, unknown>; revision: number;
  }) => Promise<number>;
}

/* ------------------------------------------------------------------ *
 * Evaluation plumbing
 * ------------------------------------------------------------------ */

function evaluateWith(
  page: RenderPage,
  session: SessionState,
  logic: RehydratedLogic,
  vars: Record<string, unknown>,
): EvaluatedPage {
  const submitted = new Set(
    session.history.filter(v => v.submitted_at !== null).map(v => String(v.page_id)),
  );
  return evaluatePage({
    page,
    logic,
    seed: session.random_seed,
    vars,
    pageSubmitted: id => submitted.has(id),
    evaluate: evaluate as never,
    varStateOf: varStateOf as never,
    evalCondition: evalCondition as never,
  });
}

/** The shown-question set the filter and the validator both consume. */
function shownSet(page: RenderPage, evaluated: EvaluatedPage): Set<string> {
  const out = new Set<string>();
  for (const q of page.questions) {
    if (evaluated.renderHooks.isQuestionVisible?.(q.id) ?? true) out.add(q.id);
  }
  return out;
}

/**
 * The server's half of the divergence digest (E §5.1). Field-by-field, so a mismatch
 * localizes: a stale artifact, a stale bundle, a state drift and a real engine bug are four
 * different diagnoses, and an undifferentiated "divergence" metric gets muted within a week.
 */
export function serverDigest(
  session: SessionState,
  page: RenderPage,
  evaluated: EvaluatedPage,
  shown: ReadonlySet<string>,
): Record<string, string> {
  const sortedVars = Object.keys(session.vars).sort()
    .map(k => `${k}=${JSON.stringify(session.vars[k as never])}`).join('|');
  const items = page.questions
    .map(q => `${q.id}:${(evaluated.renderHooks.itemsFor?.(q.id, 'options') ?? []).join(',')}`)
    .join('|');
  const orders = Object.keys(evaluated.orders).sort()
    .map(k => `${k}:${evaluated.orders[k]?.join(',')}`).join('|');

  return {
    artifact_hash: session.artifact_hash,
    state_hash: hashString(sortedVars),
    shown_hash: hashString([...shown].sort().join('|')),
    items_hash: hashString(items),
    orders_hash: hashString(orders),
  };
}

function compareDigests(
  client: SubmitBody['client_trace'],
  server: Record<string, string>,
): string[] {
  if (!client) return [];
  const fields: string[] = [];
  for (const key of ['artifact_hash', 'state_hash', 'shown_hash', 'items_hash', 'orders_hash']) {
    const c = (client as Record<string, unknown>)[key];
    if (typeof c === 'string' && c !== server[key]) fields.push(key);
  }
  return fields;
}

/* ------------------------------------------------------------------ *
 * The submit
 * ------------------------------------------------------------------ */

export async function handleSubmitCore(
  session0: SessionState,
  body: SubmitBody,
  deps: SubmitDeps,
): Promise<SubmitOutcome> {
  const now = deps.now();

  // ---- 1. LOAD triage ---------------------------------------------------
  if (session0.machine_state.state === 'FINALIZED') {
    return { kind: 'final', session: session0, disposition: session0.disposition ?? 'TERMINATE' };
  }

  const idemKey =
    body.idempotency_key ??
    hashString(`${session0.session_id}|${body.page_id}|${JSON.stringify(body.values)}`);
  if (session0.last_submit && session0.last_submit.key === idemKey) {
    // E §3.4: a retried identical submit returns the identical response, no second event.
    return { kind: 'replay', response: session0.last_submit.response };
  }

  const isCurrent = session0.current_page_id === body.page_id;
  const isBehind =
    !isCurrent && session0.history.some(v => v.page_id === body.page_id && v.submitted_at !== null);
  if (!isCurrent && !isBehind) {
    // A page never visited, or ahead of the cursor: a stale tab or a crafted POST. 409.
    return { kind: 'stale', current_page_id: session0.current_page_id };
  }

  const page = await deps.loadPage(body.page_id);
  if (!page) return { kind: 'stale', current_page_id: session0.current_page_id };

  // ---- 2. RE-EVALUATE, authoritative, from STORED vars --------------------
  const before = evaluateWith(page, session0, deps.logic, session0.vars as never);
  const shown = shownSet(page, before);

  // ---- 3. ANTI-TAMPER FILTER ---------------------------------------------
  const pageQuestions = new Set(page.questions.map(q => q.id));
  const filter: FilterResult = filterSubmit({
    submitted: body.values,
    manifest: deps.head.manifest.variable_manifest,
    ownerQuestion: id => deps.logic.schema.ownerQuestion(id as never),
    pageQuestions,
    shown,
    itemsFor: qid => before.renderHooks.itemsFor?.(qid, 'options') ?? null,
    ...(before.renderHooks.optionState
      ? {
          optionSelectable: (qid: string, code: number) => {
            const q = page.questions.find(x => x.id === qid);
            const item = q?.options?.find(o => o.code === code);
            if (!item) return true;
            const state = before.renderHooks.optionState!(qid, 'options', item);
            return !state.hidden && !state.disabled;
          },
        }
      : {}),
  });

  // ---- 4/5. APPLY candidates, then VALIDATE over them ----------------------
  const candidateVars = { ...(session0.vars as Record<string, unknown>), ...filter.accepted };
  const after = evaluateWith(page, session0, deps.logic, candidateVars);

  const failures = [
    ...runValidations({
      questions: page.questions as never,
      shown,
      vars: candidateVars,
      written: new Set(filter.wrote),
      ...(after.evalCondition ? { evalCondition: after.evalCondition } : {}),
    }),
    // Rule-authored validations (kind: 'validation') surface through the engine's verdict.
    ...after.validations.map(v => ({
      rule_id: v.rule_id,
      question_id: v.target,
      type: 'expression',
      message_key: v.message_key,
      scope: v.scope,
    })),
  ];

  if (failures.length > 0) {
    // THE NO-OP. Only Redis-side counters may move (submits++, last_activity), which the
    // caller does; nothing here has written anything.
    return { kind: 'validation_failed', session: session0, page: rerender(page, session0, before), failures };
  }

  // Merge with provenance; stamp the visit's wrote/shown for invalidate-forward.
  const visitIndex = session0.history.length - 1;
  const attempt = session0.history[visitIndex]?.attempt ?? 1;
  let session: SessionState = {
    ...session0,
    vars: candidateVars as never,
    var_provenance: {
      ...session0.var_provenance,
      ...Object.fromEntries(
        filter.wrote.map(v => [v, { p: 'respondent', page_id: body.page_id, visit: attempt }]),
      ),
    } as never,
    history: session0.history.map((v, i) =>
      i === visitIndex && v.page_id === body.page_id
        ? { ...v, wrote: [...new Set([...v.wrote, ...filter.wrote])] as never,
            shown: [...shown] as never }
        : v,
    ),
    quality_flags:
      filter.rejected.length > 3 && !session0.quality_flags.includes('tamper_suspected')
        ? [...session0.quality_flags, 'tamper_suspected']
        : session0.quality_flags,
  };

  // ---- back-submit branch: E §7.2, before any advance ----------------------
  const events: Record<string, unknown>[] = [];
  if (isBehind) {
    const back = await applyBackSubmit(session, body.page_id, filter, deps);
    if (back.refused) return { kind: 'back_refused', reason: back.refused };
    session = back.session;
    if (back.event) events.push(back.event as never);
  }

  // ---- 7. ADVANCE -----------------------------------------------------------
  const machineCtx = makeCtx({
    now_ms: now,
    random: () => 0, // flow-level draws are counter-backed (E §8.5); nothing seeded remains here
    evalCondition: after.evalCondition ?? (() => null),
    isPageVisible: after.isPageVisible,
  });
  const input: Input = { i: 'submitted', page_id: body.page_id };
  const { next, cmds } = step(session, input, deps.head as unknown as MachineArtifact, machineCtx);
  session = next;

  // A rule-driven termination out of evaluation #2 overrides a page advance: the machine has
  // its own terminate input for exactly this.
  if (after.termination && session.machine_state.state !== 'FINALIZED') {
    const t = step(
      session,
      { i: 'terminate', disposition: after.termination.disposition as never,
        ...(after.termination.custom_key ? { custom_key: after.termination.custom_key } : {}) },
      deps.head as unknown as MachineArtifact,
      machineCtx,
    );
    session = t.next;
    cmds.push(...t.cmds);
  }

  // ---- 9. DIVERGENCE (before persist, so the event can carry it) -----------
  const digest = serverDigest(session0, page, before, shown);
  const divergentFields = compareDigests(body.client_trace, digest);
  if (divergentFields.length > 0) {
    events.push({
      kind: 'logic.divergence',
      fields: divergentFields,
      client: body.client_trace as never,
      server: digest,
    });
    log.warn('logic_divergence', {
      session_id: session.session_id,
      fields: divergentFields.join(','),
      artifact_hash: session.artifact_hash,
    });
  }

  // ---- 8. PERSIST — Postgres first, then the caller's Redis CAS ------------
  const finalized = session.machine_state.state === 'FINALIZED';
  const expectedSeq = session0.last_event_seq + 1;
  const rejectedRecord =
    filter.rejected.length === 0
      ? null
      : Object.fromEntries(filter.rejected.map(r => [r.variable, { reason: r.reason, claimed: r.claimed }]));

  session = {
    ...session,
    last_event_seq: expectedSeq,
    page_timings: {
      ...session.page_timings,
      [body.page_id]: {
        first_render_ms: session.page_timings[body.page_id as never]?.first_render_ms ?? 0,
        total_ms: body.timings?.total_ms ?? 0,
        submits: (session.page_timings[body.page_id as never]?.submits ?? 0) + 1,
        focus_loss_ms: body.timings?.focus_loss_ms ?? 0,
      },
    } as never,
  };

  if (deps.persist) {
    const stored = await deps.persist({
      expected_seq: expectedSeq,
      event_id: `evt_${generateULID()}`,
      event_type: 'page_submit',
      page_id: body.page_id,
      vars: session.vars as never,
      values: filter.accepted,
      rejected_values: rejectedRecord,
      payload: {
        shown: [...shown],
        ...(events.length > 0 ? { events } : {}),
        ...(divergentFields.length > 0 ? { divergence: divergentFields } : {}),
      },
      client_trace: (body.client_trace as never) ?? null,
      duration_ms: body.timings?.total_ms ?? null,
      status: finalized
        ? session.disposition === 'COMPLETE' ? 'completed' : 'terminated'
        : 'active',
      disposition: finalized ? session.disposition : null,
      current_page_id: session.current_page_id,
      page_timings: session.page_timings as never,
      revision: session.revision,
    });
    if (stored !== expectedSeq) {
      // The database's guard refused: a concurrent request already appended this seq. The
      // stored response for it lives on the OTHER request's session write; this one re-reads.
      return { kind: 'stale', current_page_id: session0.current_page_id };
    }
  }

  // ---- 10. RESPOND ----------------------------------------------------------
  if (finalized) {
    return withStoredResponse(
      { kind: 'final', session, disposition: session.disposition ?? 'TERMINATE' },
      idemKey,
    );
  }

  // The advance produced a render command; the caller interprets it — it owns fetching the
  // NEXT page and stamping the render digest onto the new visit.
  return withStoredResponse({ kind: 'advanced', session, cmds, events }, idemKey);
}

/**
 * Attach the idempotent-replay record to the outgoing session.
 *
 * The stored response is a SUMMARY (kind + destination), not the rendered body: the retried
 * client re-fetches the page it is told about, which re-renders from the same state and is
 * therefore identical — without Redis holding a rendered page per submit.
 */
function withStoredResponse<T extends SubmitOutcome & { session: SessionState }>(
  outcome: T,
  key: string,
): T {
  const summary =
    outcome.kind === 'final'
      ? { kind: 'final', disposition: (outcome as { disposition: string }).disposition }
      : { kind: 'next', page_id: outcome.session.current_page_id };
  return {
    ...outcome,
    session: { ...outcome.session, last_submit: { key, response: summary } },
  };
}

function rerender(
  page: RenderPage,
  session: SessionState,
  evaluated: EvaluatedPage,
): RenderedPage {
  return renderPage(page, session.random_seed, {
    vars: session.vars as never,
    escapeContext: 'html_text',
    ...evaluated.renderHooks,
  });
}

/* ------------------------------------------------------------------ *
 * Back-submit: E §7.2 wired to the tested algorithm
 * ------------------------------------------------------------------ */

async function applyBackSubmit(
  session: SessionState,
  pageId: string,
  filter: FilterResult,
  deps: SubmitDeps,
): Promise<{ session: SessionState; event?: unknown; refused?: string }> {
  if (session.history.length === 0) {
    // The post-rebuild case the durable store documents: without history, invalidate-forward
    // would have to guess what each visit wrote. Refusing is the safe direction.
    return { session, refused: 'history_unavailable_after_rebuild' };
  }

  const result = invalidateForward({
    trigger_page_id: pageId,
    history: session.history as never,
    vars: session.vars as never,
    writes: filter.accepted,
    artifact: deps.head as never,
    probe: {
      isPageVisible: () => true, // page-level rules are still fixture-only (no flow table)
      recomputeDigest: () => null, // conservatively drift: re-render support arrives with replay
    },
    now_ms: deps.now(),
  });

  const next: SessionState = {
    ...session,
    vars: result.vars as never,
    var_provenance: {
      ...session.var_provenance,
      ...(result.provenance as SessionState['var_provenance']),
    },
    history: result.history as never,
  };
  return { session: next, ...(result.event ? { event: result.event } : {}) };
}
