/**
 * The respondent-facing request handler — P1-09's entry and page-render endpoints.
 *
 * Every dependency arrives by injection through `RuntimeDeps`, including the clock and the id
 * generator. That is not ceremony: it is what lets the entry path be tested end to end with
 * in-memory fakes, and an end-to-end test of "URL in, rendered page out" catches the seam bugs
 * that per-layer mocks hide. It is also what lets P1-10 swap the stub session store for Redis
 * without touching this file.
 *
 * The `Cmd` interpreter lives here. `packages/runtime-core`'s machine decides *what* should happen
 * and never awaits; this module is the only place that performs it (E §2.3).
 *
 * Artifact access follows C §17: the head (manifest + graph + logic) is fetched once per session
 * and the machine routes on the graph alone, so a page is fetched only when it is rendered.
 */

import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createLogger, requestIdFrom } from '@resscript/observability';
import {
  deriveKey,
  evaluatePage,
  invalidateForward,
  randomAt,
  rehydrate,
  renderPage,
  type Cmd,
  type EvaluatedPage,
  type MachineArtifact,
  type RehydratedLogic,
  type RenderPage,
  type RenderedPage,
} from '@resscript/runtime-core';
import { evalCondition, evaluate, varStateOf } from '@resscript/logic';
import { ArtifactNotFound, type ArtifactHead, type ArtifactLoader } from './artifact/loader.js';
import { createSession, generateULID } from './entry.js';
import { rebuildSession, type RuntimeWriter } from './session/durable.js';
import type { QuotaClient } from './quota/index.js';
import { handleSubmitCore, type SubmitBody } from './submit.js';
import { makeCtx, step } from './machine/index.js';
import type { SessionStore } from './session/store.js';
import type { PageVisit, SessionState } from './session/types.js';
import type { ResolvedToken, TokenResolver } from './token.js';

const log = createLogger({ service: 'runtime' });

/* ------------------------------------------------------------------ *
 * Dependencies
 * ------------------------------------------------------------------ */

export interface RuntimeDeps {
  readonly tokens: TokenResolver;
  readonly artifacts: ArtifactLoader;
  readonly sessions: SessionStore;
  /**
   * The Postgres record, through 0011's RPCs. Optional so the in-memory mode (tests, local
   * dev without Postgres) still exercises the full request path — the seq counter advances
   * either way, so behaviour cannot silently differ between the two modes.
   */
  readonly writer?: RuntimeWriter;
  /** The Redis quota arbiter. Optional for the same reason the writer is. */
  readonly quota?: QuotaClient;
  /** Injected so a replayed request produces identical timestamps (ADR-006). */
  readonly now: () => number;
  /** ULID generator. */
  readonly newId: () => string;
  /** 128-bit hex seed generator. */
  readonly newSeed: () => string;
  /** The public domain survey origins live under, for ADR-005 hostname validation. */
  readonly domain: string;
}

/* ------------------------------------------------------------------ *
 * HTTP plumbing
 * ------------------------------------------------------------------ */

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  // ADR-005: the runtime origin is cookieless and must not leak the survey token in a referer.
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  // A survey page is never a legitimate frame target except in studio preview, which uses a
  // separate origin and postMessage (P1-11).
  'x-frame-options': 'DENY',
  // Artifacts are content-addressed and immutable, but a *session's* page is not: it depends on
  // variable state, so caching it would show a respondent a stale page after a back-submit.
  'cache-control': 'no-store',
};

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * Validate the request origin and extract the survey token (ADR-005).
 *
 * The host must be exactly `<token>.<domain>`. A survey served from the wrong origin gets a 404
 * rather than a redirect: a redirect would confirm the token exists, and per-survey origin
 * isolation is the mechanism that stops one survey's script reaching another's storage.
 */
export function parseOrigin(host: string | undefined, domain: string): { token: string } | null {
  if (!host) return null;

  const hostname = host.split(':')[0];
  if (!hostname) return null;

  const suffix = `.${domain}`;
  if (!hostname.endsWith(suffix)) return null;

  const token = hostname.slice(0, -suffix.length);
  // Exactly one label. `a.b.run.local` must not resolve token `a.b`, or a wildcard certificate
  // plus a nested subdomain becomes a way to serve one survey from another's origin.
  if (token.length === 0 || token.includes('.')) return null;

  // 26 lowercase base36 characters — the shape `app.publish_version` mints.
  if (!/^[0-9a-z]{26}$/.test(token)) return null;

  return { token };
}

/** Entry parameters, captured raw for audit (E §3.1) with the reserved keys stripped. */
function captureEntryParams(url: URL): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of url.searchParams) {
    // `disposition` and friends are ours; accepting one from the query string would let a
    // respondent declare themselves complete.
    if (k === 'disposition' || k === 'session' || k === 'seq') continue;
    // Cap both count and length: entry params are stored on every session and an unbounded query
    // string is a cheap way to inflate every row.
    if (Object.keys(out).length >= 32) break;
    out[k] = v.slice(0, 512);
  }
  return out;
}

/**
 * Read and parse a JSON body, capped.
 *
 * The cap is a request-level defence: a 2,000-variable page of long open-ends fits in well
 * under 1 MB, and an unbounded body is memory a hostile client controls.
 */
function readJsonBody(req: IncomingMessage, maxBytes = 1_048_576): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new BodyTooLarge());
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new MalformedBody());
      }
    });
    req.on('error', reject);
  });
}

class BodyTooLarge extends Error {}
class MalformedBody extends Error {}

/**
 * Load a session: Redis (or the in-memory store) first, then the Postgres rebuild.
 *
 * The rebuild is written back to the fast store so the NEXT request is a cache hit again —
 * without that, a session Redis evicted pays the Postgres round trip on every remaining page.
 */
async function loadSessionState(
  deps: RuntimeDeps,
  sessionId: string,
): Promise<SessionState | null> {
  const cached = await deps.sessions.load(sessionId);
  if (cached) return cached;
  if (!deps.writer) return null;
  const doc = await deps.writer.loadSession(sessionId);
  if (!doc) return null;
  const rebuilt = rebuildSession(doc);
  await deps.sessions.save(rebuilt);
  log.warn('session_rebuilt_from_postgres', { session_id: sessionId });
  return rebuilt;
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

export type EscapeContext = 'html_text' | 'none';

/**
 * Rehydrated logic, cached per artifact hash.
 *
 * Rehydration walks every cell, rule and AST node, so doing it per request would put a full pass
 * over the program on the respondent hot path. The artifact is immutable (ADR-002), so the hash is a
 * safe cache key with no invalidation — the same argument the artifact loader's cache rests on.
 */
const logicCache = new Map<string, RehydratedLogic>();

function logicFor(head: ArtifactHead): RehydratedLogic {
  const cached = logicCache.get(head.hash);
  if (cached) return cached;
  const rehydrated = rehydrate(head.logic);
  logicCache.set(head.hash, rehydrated);
  return rehydrated;
}

/**
 * Evaluate a page's logic and render it.
 *
 * The order matters and is the reason these two are one function: `evaluatePage` computes the
 * display orders, hands them to the engine, and returns them alongside the verdict — and
 * `renderPage` must then receive *those* orders rather than computing its own, or the position a
 * rule reasons about is not the position the respondent sees.
 *
 * `pageSubmitted` reads the session's own history, which is what separates `asked` from `shown`:
 * a page that was rendered but not submitted has been shown, not asked.
 */
function evaluateAndRender(
  page: RenderPage,
  session: SessionState,
  logic: RehydratedLogic,
  labels: { readonly [key: string]: string } | undefined,
  escapeContext: EscapeContext,
): { rendered: RenderedPage; evaluated: EvaluatedPage; debug?: Record<string, unknown> } {
  const submitted = new Set(
    session.history.filter(v => v.submitted_at !== null).map(v => String(v.page_id)),
  );

  const evaluated = evaluatePage({
    page,
    logic,
    seed: session.random_seed,
    vars: session.vars as Record<string, unknown>,
    ...(labels ? { labels } : {}),
    pageSubmitted: pageId => submitted.has(pageId),
    evaluate: evaluate as never,
    varStateOf: varStateOf as never,
    evalCondition: evalCondition as never,
  });

  const rendered = renderPage(page, session.random_seed, {
    vars: session.vars as Record<string, unknown>,
    escapeContext,
    ...evaluated.renderHooks,
  });

  if (!session.is_test) return { rendered, evaluated };

  // TEST MODE: the full node-level trace, E §14.1's rightmost column. Same code path, same
  // artifact, same machine — the trace is CAPTURED here, never branched on, because divergent
  // code paths for test are how "works in test, breaks in production" ships. The engine
  // produces the trace on every evaluation either way (D §5.3's changes list drives it); test
  // mode is merely allowed to see it.
  const verdict = evaluated.verdict as { trace?: unknown; cells?: unknown[] };
  return {
    rendered,
    evaluated,
    debug: {
      seed: session.random_seed,
      artifact_hash: session.artifact_hash,
      orders: evaluated.orders,
      digest: rendered.digest,
      cells_evaluated: Array.isArray(verdict.cells) ? verdict.cells.length : 0,
      trace: verdict.trace ?? [],
      validations: evaluated.validations,
      termination: evaluated.termination ?? null,
    },
  };
}

/**
 * Stamp a render digest onto the visit the machine just created.
 *
 * The machine emits `{c:'render'}` without knowing what the render produced; only this side can
 * compute the digest. Invalidate-forward reads it later to decide whether a page drifted
 * (E §7.2 step 3), so a visit that never gets one is treated as drifted and re-asked.
 */
function stampDigest(session: SessionState, pageId: string, digest: string): SessionState {
  const history: PageVisit[] = session.history.map((v, i) =>
    i === session.history.length - 1 && v.page_id === pageId
      ? { ...v, render_digest: digest }
      : v,
  );
  return { ...session, history };
}

/* ------------------------------------------------------------------ *
 * Cmd interpretation
 * ------------------------------------------------------------------ */

export interface Interpreted {
  readonly session: SessionState;
  readonly page: RenderedPage | null;
  readonly disposition: string | null;
  readonly events: readonly { kind: string; [k: string]: unknown }[];
  /** Present only for test sessions: the E §14.2 trace for the page that was rendered. */
  readonly debug?: Record<string, unknown>;
}

/** Fetch one page of the session's artifact in the session's language. */
export type PageFetcher = (pageId: string) => Promise<RenderPage | null>;

/** What the interpreter needs to evaluate logic while performing a `render` command. */
export interface RenderDeps {
  readonly logic: RehydratedLogic;
  readonly labels?: { readonly [key: string]: string };
  readonly escapeContext: EscapeContext;
  readonly quota?: QuotaClient;
}

/**
 * Perform a `Cmd[]`.
 *
 * Quota commands are recorded as events rather than executed: reserve-all-or-none needs Redis
 * (E §10) and belongs to P1-10. Recording them means a session that should have taken a
 * reservation is visible in the log rather than silently unreserved — the failure mode that would
 * otherwise show up as an over-filled cell weeks later.
 */
export async function interpret(
  cmds: readonly Cmd[],
  session: SessionState,
  loadPage: PageFetcher,
  opts: RenderDeps,
): Promise<Interpreted> {
  let current = session;
  let page: RenderedPage | null = null;
  let disposition: string | null = null;
  let lastDebug: Record<string, unknown> | undefined;
  const events: { kind: string; [k: string]: unknown }[] = [];

  for (const cmd of cmds) {
    switch (cmd.c) {
      case 'render': {
        const source = await loadPage(cmd.page_id);
        if (!source) {
          events.push({ kind: 'render.missing_page', page_id: cmd.page_id });
          break;
        }
        const { rendered, evaluated, debug } = evaluateAndRender(
          source,
          current,
          opts.logic,
          opts.labels,
          opts.escapeContext,
        );
        if (debug) lastDebug = debug;
        page = rendered;
        current = stampDigest(current, cmd.page_id, rendered.digest);
        for (const e of rendered.events) events.push({ ...e });
        // A rule-driven termination is surfaced rather than acted on here: finalizing means
        // releasing a reservation and appending an event, which the machine and P1-10's write path
        // own. Recording it keeps a session that a rule wanted to screen out visible in the log.
        if (evaluated.termination) {
          events.push({
            kind: 'logic.termination',
            rule_id: evaluated.termination.rule_id,
            disposition: evaluated.termination.disposition,
          });
        }
        break;
      }

      case 'finalize': {
        disposition = cmd.disposition;
        events.push({
          kind: 'session.finalized',
          disposition: cmd.disposition,
          ...(cmd.custom_key ? { custom_key: cmd.custom_key } : {}),
        });
        current = { ...current, finalized_at: current.server_time_ms };
        break;
      }

      case 'commit_quota': {
        // COMPLETING converts every held reservation, exactly once (E §10.3). Idempotent by
        // construction: the res: set is deleted by the first commit, so a replayed finalize
        // converts nothing.
        if (opts.quota) {
          const n = await opts.quota.commit(current.session_id).catch(err => {
            // A commit that cannot reach Redis is NOT a respondent-facing failure: the event
            // log records the COMPLETE, and reconciliation (ADR-008) recomputes committed
            // from it. The respondent finished; the counter catches up.
            events.push({ kind: 'quota.commit_unavailable', err: String(err) });
            return 0;
          });
          events.push({ kind: 'quota.committed', cells: n });
        } else {
          events.push({ kind: 'quota.commit_quota_deferred', detail: 'no quota client' });
        }
        break;
      }

      case 'release_quota': {
        if (opts.quota) {
          const n = await opts.quota.release(current.session_id).catch(err => {
            // Same shape as commit: the sweep and reconciliation repair a missed release.
            events.push({ kind: 'quota.release_unavailable', err: String(err) });
            return 0;
          });
          if (n > 0) events.push({ kind: 'quota.released', cells: n });
        }
        break;
      }

      case 'reserve_quota':
        // The reserve needs the PLAN — which dimensions, which cells this respondent's
        // answers put them in — and plans ship in quotas.json, which nothing can author yet
        // (the quotas tables have no columns; roadmap blocker #4). The client, the Lua
        // scripts and the gate decision are built and tested (quota/); this event is the
        // honest record that a gate node was reached before plans exist to resolve.
        events.push({ kind: 'quota.reserve_deferred', detail: 'no quota plan in artifact' });
        break;

      case 'call_api':
        events.push({ kind: 'api_call.deferred', node_id: cmd.node_id, detail: 'P1-10' });
        break;

      case 'emit_event':
        events.push({ ...cmd.event });
        break;
    }
  }

  return { session: current, page, disposition, events, ...(lastDebug ? { debug: lastDebug } : {}) };
}

/* ------------------------------------------------------------------ *
 * Endpoints
 * ------------------------------------------------------------------ */

interface Ctx {
  readonly deps: RuntimeDeps;
  readonly requestId: string;
  readonly url: URL;
  readonly token: string;
}

/**
 * The head IS the machine's artifact.
 *
 * `MachineArtifact` needs only `graph`, which is the point: the machine routes without a single
 * page object, so per-page cost stays independent of survey size (C §17).
 */
function asMachineArtifact(head: ArtifactHead): MachineArtifact {
  return head as unknown as MachineArtifact;
}

/** The context the machine gets: injected clock, seeded PRNG, no rule evaluation yet. */
function machineCtx(session: SessionState, now: number) {
  return makeCtx({
    now_ms: now,
    random: salt => randomAt(deriveKey(session.random_seed, salt), 0),
    // UNKNOWN at entry, deliberately: a branch condition is evaluated against a page verdict, and
    // at entry no page has been evaluated yet — there is nothing for `SHOWN(Q5)` to read. The
    // machine answers UNKNOWN by taking the else arm, which is the safe direction. Threading a
    // verdict from the *previous* page into the machine is P1-10's, where the submit path already
    // has one in hand.
    evalCondition: () => null,
  });
}

function pageFetcher(ctx: Ctx, hash: string, language: string): PageFetcher {
  return async pageId => {
    const page = await ctx.deps.artifacts.page(hash, language, pageId);
    return page === null ? null : (page as unknown as RenderPage);
  };
}

function pageBody(
  rendered: RenderedPage,
  session: SessionState,
  requestId: string,
  debug?: Record<string, unknown>,
) {
  return {
    session_id: session.session_id,
    page: {
      page_id: rendered.page_id,
      questions: rendered.questions,
      skipped: rendered.skipped,
    },
    progress: {
      visited: session.history.length,
      revision: session.revision,
    },
    // Test sessions only (E §14.1): the full trace, retained in the response rather than a
    // store — 30-day trace retention is the studio's concern, not the data plane's.
    ...(debug ? { debug } : {}),
    request_id: requestId,
  };
}

function finalBody(session: SessionState, disposition: string, requestId: string) {
  return {
    session_id: session.session_id,
    disposition,
    ...(session.custom_key ? { custom_key: session.custom_key } : {}),
    // The redirect target is resolved from `content.redirects` (E §11), which has no authoring
    // path yet — see the P1-08 note about `CMP-0300`. Reported as null rather than omitted so a
    // client can tell "no redirect configured" from "field absent".
    redirect_url: null,
    request_id: requestId,
  };
}

/**
 * Load the artifact head a token pins.
 *
 * `null` means the token does not exist. An unavailable artifact throws, and the router turns
 * that into a 503 rather than a 404: "this link is wrong" and "we cannot reach the survey right
 * now" need different answers, for the respondent and for whoever is on call.
 */
async function loadPinned(
  ctx: Ctx,
): Promise<{ resolved: ResolvedToken; head: ArtifactHead } | null> {
  const resolved = await ctx.deps.tokens.resolve(ctx.token);
  if (!resolved) return null;
  const head = await ctx.deps.artifacts.head(resolved.artifact_hash);
  return { resolved, head };
}

/**
 * `GET /s/{token}` — survey entry (E §2.1).
 *
 * Resolves the token, pins the artifact hash, mints ids and the session seed, then runs the
 * machine from the graph's start node.
 *
 * A bad token creates NO session (E §2.2: `INVALID`). Creating one would make the entry URL a
 * free write-amplification vector for anyone who can send requests.
 */
async function handleEntry(res: ServerResponse, ctx: Ctx): Promise<void> {
  const pinned = await loadPinned(ctx);
  if (!pinned) {
    json(res, 404, { error: { code: 'not_found' }, request_id: ctx.requestId });
    return;
  }
  const { resolved, head } = pinned;

  if (resolved.status === 'paused' || resolved.status === 'closed') {
    json(res, 200, {
      disposition: 'TERMINATE',
      reason: `survey_${resolved.status}`,
      request_id: ctx.requestId,
    });
    return;
  }

  const now = ctx.deps.now();
  const language = head.manifest.base_language;
  const base = createSession({
    // ses_-prefixed: the app.ulid domain requires a kind prefix, and minting it here means
    // the DB can hold the id unmodified — one identity everywhere, no mapping table.
    session_id: `ses_${ctx.deps.newId()}`,
    respondent_id: `rsp_${ctx.deps.newId()}`,
    // The token deliberately resolves to no survey_id (a leak surface); the manifest, which
    // the pinned hash already authorizes, carries it.
    survey_id: head.manifest.survey_id,
    artifact_hash: resolved.artifact_hash,
    random_seed: ctx.deps.newSeed(),
    language,
  });

  let session: SessionState = {
    ...base,
    survey_version_id: resolved.survey_version_id,
    is_test: resolved.is_test || resolved.status === 'test',
    entry_params: captureEntryParams(ctx.url),
    started_at: now,
    last_activity_at: now,
    server_time_ms: now,
  };

  // Resume token: minted at entry (E §7.3), carried in the page URL by the client. Only its
  // HASH is ever stored or queried — the raw token exists in the respondent's URL and nowhere
  // else, so a database read or a log line cannot leak a resumable session.
  const resumeToken = randomBytes(32).toString('base64url');
  const resumeHash = createHash('sha256').update(resumeToken).digest();
  session = { ...session, resume_token_hash: resumeHash.toString('hex') };

  // The durable birth FIRST (E §5 step 8's order, applied at entry too): session row +
  // document + session_start event, one transaction. If the Redis write after it fails, the
  // session rebuilds from this; the reverse order can lose the birth.
  if (ctx.deps.writer) {
    await ctx.deps.writer.startSession({
      token: ctx.token,
      session_id: session.session_id,
      random_seed: session.random_seed,
      language,
      is_test: session.is_test,
      resume_token_hash: resumeHash,
      entry_payload: { entry_params: session.entry_params },
    });
    session = { ...session, last_event_seq: 1 };
  }

  const { next, cmds } = step(
    session,
    { i: 'enter' },
    asMachineArtifact(head),
    machineCtx(session, now),
  );
  const out = await interpret(cmds, next, pageFetcher(ctx, head.hash, language), {
    logic: logicFor(head),
    escapeContext: 'html_text',
    ...(ctx.deps.quota ? { quota: ctx.deps.quota } : {}),
  });

  await ctx.deps.sessions.save(out.session);
  // Redis fast path for the resume lookup; the sessions row is the durable one.
  await ctx.deps.sessions.saveResumeToken(
    out.session.session_id, resumeHash.toString('hex'), 7 * 24 * 3600,
  );

  log.info('session_entered', {
    request_id: ctx.requestId,
    session_id: out.session.session_id,
    artifact_hash: resolved.artifact_hash,
    page_id: out.page?.page_id ?? null,
    disposition: out.disposition,
  });

  if (out.disposition) {
    json(res, 200, finalBody(out.session, out.disposition, ctx.requestId));
    return;
  }
  if (!out.page) {
    // The machine neither rendered nor finalized. Every path through a published graph does one
    // or the other (the compiler enforces it), so this is a compiler escape, not a bad request.
    json(res, 500, { error: { code: 'no_page' }, request_id: ctx.requestId });
    return;
  }
  json(res, 200, {
    ...pageBody(out.page, out.session, ctx.requestId, out.debug),
    // For the client to carry in the page URL. The server keeps only the hash.
    resume_token: resumeToken,
  });
}

/**
 * `GET /s/{token}/p/{page_id}` — re-render the page the session is on.
 *
 * The requested `page_id` must match `current_page_id`. It is not a navigation primitive: a
 * respondent who could render any page by id could read a page whose preconditions never held,
 * and the server would then have to decide whether answers submitted against it count. Back
 * navigation goes through the machine's `back` input, which derives its target from history.
 */
async function handlePageRender(
  res: ServerResponse,
  ctx: Ctx,
  pageId: string,
  sessionId: string | null,
): Promise<void> {
  if (!sessionId) {
    json(res, 400, { error: { code: 'session_required' }, request_id: ctx.requestId });
    return;
  }

  const pinned = await loadPinned(ctx);
  if (!pinned) {
    json(res, 404, { error: { code: 'not_found' }, request_id: ctx.requestId });
    return;
  }

  // Through the rebuild path, not the store directly: a session Redis evicted mid-interview
  // must render from the Postgres record, or every eviction strands a respondent (E §3.2).
  const session = await loadSessionState(ctx.deps, sessionId);
  if (!session) {
    json(res, 404, { error: { code: 'session_not_found' }, request_id: ctx.requestId });
    return;
  }

  if (session.machine_state.state === 'FINALIZED') {
    json(res, 200, finalBody(session, session.disposition ?? 'TERMINATE', ctx.requestId));
    return;
  }

  if (session.current_page_id !== pageId) {
    json(res, 409, {
      error: { code: 'stale_page', current_page_id: session.current_page_id },
      request_id: ctx.requestId,
    });
    return;
  }

  // The session is pinned to the hash it entered on, which may differ from the token's current
  // hash if the survey was republished mid-field. The session's hash wins (E §3.3): republishing
  // must not change the questionnaire under a respondent who is halfway through it.
  const source = await ctx.deps.artifacts.page(session.artifact_hash, session.language, pageId);
  if (!source) {
    json(res, 404, { error: { code: 'page_not_found' }, request_id: ctx.requestId });
    return;
  }

  const { rendered, debug } = evaluateAndRender(
    source as unknown as RenderPage,
    session,
    logicFor(pinned.head),
    undefined,
    'html_text',
  );
  // Re-rendering re-stamps the digest. It must, or a mask that moved between the first render and
  // a refresh would leave a digest describing a page the respondent is no longer looking at.
  const stamped = stampDigest(session, pageId, rendered.digest);
  await ctx.deps.sessions.save(stamped);

  json(res, 200, pageBody(rendered, stamped, ctx.requestId, debug));
}

/**
 * `POST /s/{token}/submit` — the endpoint shell around `handleSubmitCore` (E §5).
 *
 * The core is pure given its deps; this shell owns everything with a side effect: body
 * parsing, session loading, the Postgres persist closure, the Redis save, rendering the NEXT
 * page out of the machine's commands, and mapping each outcome to a status code.
 */
async function handleSubmit(res: ServerResponse, ctx: Ctx, req: IncomingMessage): Promise<void> {
  let raw: unknown;
  try {
    raw = await readJsonBody(req);
  } catch {
    json(res, 400, { error: { code: 'malformed_request' }, request_id: ctx.requestId });
    return;
  }
  const body = raw as Partial<SubmitBody>;
  if (typeof body.page_id !== 'string' || typeof body.values !== 'object' || body.values === null) {
    json(res, 400, { error: { code: 'malformed_request' }, request_id: ctx.requestId });
    return;
  }
  const sessionId = ctx.url.searchParams.get('session');
  if (!sessionId) {
    json(res, 400, { error: { code: 'session_required' }, request_id: ctx.requestId });
    return;
  }

  const session = await loadSessionState(ctx.deps, sessionId);
  if (!session) {
    json(res, 404, { error: { code: 'session_not_found' }, request_id: ctx.requestId });
    return;
  }

  // The PINNED artifact, not the token's current one (E §3.3).
  const head = await ctx.deps.artifacts.head(session.artifact_hash);
  const logic = logicFor(head);
  const language = session.language;
  const loadPage = async (pageId: string) => {
    const page = await ctx.deps.artifacts.page(session.artifact_hash, language, pageId);
    return page === null ? null : (page as unknown as RenderPage);
  };

  const writer = ctx.deps.writer;
  const outcome = await handleSubmitCore(session, body as SubmitBody, {
    head,
    logic,
    loadPage,
    now: ctx.deps.now,
    ...(writer
      ? {
          persist: async w =>
            writer.submitPage({
              session_id: session.session_id,
              ...w,
              // page ids in a real artifact are pg_-prefixed app.ulids; a fixture id that is
              // not one cannot be stored in the typed column, so it rides in the payload.
              page_id: /^pg_[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(w.page_id ?? '')
                ? w.page_id
                : null,
            }),
        }
      : {}),
  });

  switch (outcome.kind) {
    case 'replay':
      json(res, 200, { replayed: true, ...(outcome.response as object), request_id: ctx.requestId });
      return;

    case 'stale':
      json(res, 409, {
        error: { code: 'stale_page', current_page_id: outcome.current_page_id },
        request_id: ctx.requestId,
      });
      return;

    case 'back_refused':
      json(res, 409, {
        error: { code: 'back_refused', reason: outcome.reason },
        request_id: ctx.requestId,
      });
      return;

    case 'validation_failed': {
      // THE NO-OP: nothing durable moved. Only the Redis-side attempt counter may advance,
      // because attempt counts feed speeder detection (E §5 step 4) — done with a plain save
      // (not CAS) since revision is unchanged by design.
      const bumped: SessionState = {
        ...outcome.session,
        last_activity_at: ctx.deps.now(),
        page_timings: {
          ...outcome.session.page_timings,
          [body.page_id]: {
            first_render_ms:
              outcome.session.page_timings[body.page_id as never]?.first_render_ms ?? 0,
            total_ms: outcome.session.page_timings[body.page_id as never]?.total_ms ?? 0,
            submits: (outcome.session.page_timings[body.page_id as never]?.submits ?? 0) + 1,
            focus_loss_ms:
              outcome.session.page_timings[body.page_id as never]?.focus_loss_ms ?? 0,
          },
        } as never,
      };
      await ctx.deps.sessions.save(bumped);
      json(res, 200, {
        validation_failed: outcome.failures,
        page: { page_id: outcome.page.page_id, questions: outcome.page.questions,
                skipped: outcome.page.skipped },
        session_id: session.session_id,
        request_id: ctx.requestId,
      });
      return;
    }

    case 'final': {
      // The machine's settle commands (commit or release, per E §2.2's table) run here — the
      // interpreter is where quota I/O lives, and skipping it would leak the reservation
      // until the sweep.
      if (outcome.cmds && outcome.cmds.length > 0) {
        await interpret(outcome.cmds, outcome.session, loadPage, {
          logic,
          escapeContext: 'html_text',
          ...(ctx.deps.quota ? { quota: ctx.deps.quota } : {}),
        });
      }
      await ctx.deps.sessions.save(outcome.session);
      json(res, 200, finalBody(outcome.session, outcome.disposition, ctx.requestId));
      return;
    }

    case 'advanced': {
      // Interpret the machine's commands: render the next page (stamping its digest), or a
      // late finalize out of the flow walk.
      const out = await interpret(outcome.cmds, outcome.session, loadPage, {
        logic,
        escapeContext: 'html_text',
        ...(ctx.deps.quota ? { quota: ctx.deps.quota } : {}),
      });
      await ctx.deps.sessions.save(out.session);
      if (out.disposition) {
        json(res, 200, finalBody(out.session, out.disposition, ctx.requestId));
        return;
      }
      if (!out.page) {
        json(res, 500, { error: { code: 'no_page' }, request_id: ctx.requestId });
        return;
      }
      json(res, 200, pageBody(out.page, out.session, ctx.requestId, out.debug));
      return;
    }
  }
}

/**
 * `GET /s/{token}/resume/{resume_token}` — E §7.3.
 *
 * The raw token is hashed IMMEDIATELY and only the hash travels further: Redis key, Postgres
 * function argument, log lines. Rejections are all the same 404 — telling a token-guesser
 * whether they hit an expired session versus a nonexistent one is a probe oracle.
 */
async function handleResume(res: ServerResponse, ctx: Ctx, resumeToken: string): Promise<void> {
  const hashHex = createHash('sha256').update(resumeToken).digest('hex');

  let sessionId = await ctx.deps.sessions.resolveResumeToken(hashHex);
  if (!sessionId && ctx.deps.writer) {
    sessionId = await ctx.deps.writer.findByResume(Buffer.from(hashHex, 'hex'));
  }
  if (!sessionId) {
    json(res, 404, { error: { code: 'not_found' }, request_id: ctx.requestId });
    return;
  }

  const session = await loadSessionState(ctx.deps, sessionId);
  if (!session) {
    json(res, 404, { error: { code: 'not_found' }, request_id: ctx.requestId });
    return;
  }

  // E §7.3 step 2: a completed session is not resumable. ABANDONED would be — but the sweeper
  // that sets it does not exist yet, so in practice this gate today means "finalized = no".
  if (session.disposition !== null && session.disposition !== 'ABANDONED') {
    json(res, 404, { error: { code: 'not_found' }, request_id: ctx.requestId });
    return;
  }

  // Step 3: the resume window. 7 days default until settings land (E §7.3's own default).
  const WINDOW_MS = 7 * 24 * 3600 * 1000;
  if (ctx.deps.now() - session.last_activity_at > WINDOW_MS) {
    json(res, 404, { error: { code: 'not_found' }, request_id: ctx.requestId });
    return;
  }

  if (!session.current_page_id) {
    json(res, 404, { error: { code: 'not_found' }, request_id: ctx.requestId });
    return;
  }

  // Steps 5–7: pinned artifact, resume at 'last_page' (the default position), prefilled by
  // rendering from the stored vars. Quota re-acquisition (step 6) joins when reserves do.
  const source = await ctx.deps.artifacts.page(
    session.artifact_hash, session.language, session.current_page_id,
  );
  if (!source) {
    json(res, 404, { error: { code: 'page_not_found' }, request_id: ctx.requestId });
    return;
  }
  const head = await ctx.deps.artifacts.head(session.artifact_hash);

  const resumed: SessionState = {
    ...session,
    last_activity_at: ctx.deps.now(),
    last_event_seq: session.last_event_seq + 1,
  };

  // Step 8: the resume event, durable. `respondent_id` is preserved (it lives on the session);
  // the session id is unchanged — a resume is a continuation, not a restart.
  if (ctx.deps.writer) {
    await ctx.deps.writer.submitPage({
      session_id: session.session_id,
      expected_seq: resumed.last_event_seq,
      event_id: `evt_${generateULID()}`,
      event_type: 'resume',
      page_id: null,
      vars: session.vars as never,
      values: null,
      rejected_values: null,
      payload: { at_page: session.current_page_id },
      client_trace: null,
      duration_ms: null,
      status: 'active',
      disposition: null,
      current_page_id: session.current_page_id,
      page_timings: session.page_timings as never,
      revision: session.revision,
    });
  }

  const { rendered } = evaluateAndRender(
    source as unknown as RenderPage, resumed, logicFor(head), undefined, 'html_text',
  );
  const stamped = stampDigest(resumed, session.current_page_id, rendered.digest);
  await ctx.deps.sessions.save(stamped);

  json(res, 200, pageBody(rendered, stamped, ctx.requestId));
}

/**
 * `POST /s/{token}/back?session=` — the navigation half of back (E §7).
 *
 * Moves the cursor to the previous SUBMITTED page and re-renders it prefilled. The DATA half
 * — invalidate-forward — runs when the respondent re-submits that page with a change; going
 * back to look costs nothing (E §7.2 step 2's common case).
 */
async function handleBack(res: ServerResponse, ctx: Ctx): Promise<void> {
  const sessionId = ctx.url.searchParams.get('session');
  if (!sessionId) {
    json(res, 400, { error: { code: 'session_required' }, request_id: ctx.requestId });
    return;
  }
  const session = await loadSessionState(ctx.deps, sessionId);
  if (!session) {
    json(res, 404, { error: { code: 'session_not_found' }, request_id: ctx.requestId });
    return;
  }
  if (session.machine_state.state === 'FINALIZED') {
    // Once COMPLETE you cannot go back; the redirect has fired and the vendor was told (E §7.4).
    json(res, 409, { error: { code: 'finalized' }, request_id: ctx.requestId });
    return;
  }

  const head = await ctx.deps.artifacts.head(session.artifact_hash);
  const { next, cmds } = step(
    session,
    { i: 'back' },
    asMachineArtifact(head),
    machineCtx(session, ctx.deps.now()),
  );

  if (next === session) {
    // The machine refused: nothing submitted yet, or history is gone after a rebuild.
    json(res, 409, { error: { code: 'back_refused' }, request_id: ctx.requestId });
    return;
  }

  const out = await interpret(cmds, next, pageFetcher(ctx, session.artifact_hash, session.language), {
    logic: logicFor(head),
    escapeContext: 'html_text',
    ...(ctx.deps.quota ? { quota: ctx.deps.quota } : {}),
  });
  await ctx.deps.sessions.save(out.session);

  if (!out.page) {
    json(res, 500, { error: { code: 'no_page' }, request_id: ctx.requestId });
    return;
  }
  // Prefill: the client re-renders the form with the stored answers for this page's variables.
  const prefill = Object.fromEntries(
    out.session.history
      .filter(v => v.page_id === out.page!.page_id)
      .flatMap(v => v.wrote)
      .map(v => [v, (out.session.vars as Record<string, unknown>)[v]]),
  );
  json(res, 200, { ...pageBody(out.page, out.session, ctx.requestId), prefill });
}

/**
 * `POST /s/{token}/event?session=` — client telemetry (timings, focus loss).
 *
 * Redis-only by design: E §3.2 keeps page timings out of the event log (they ride along on
 * the next submit's payload), and a telemetry endpoint that wrote durable rows would hand
 * anonymous clients a write amplifier. 204 whatever happens — the client must never retry
 * telemetry.
 */
async function handleTelemetry(res: ServerResponse, ctx: Ctx, req: IncomingMessage): Promise<void> {
  const done = () => {
    res.writeHead(204, SECURITY_HEADERS);
    res.end();
  };
  try {
    const raw = (await readJsonBody(req, 16_384)) as {
      page_id?: string; first_render_ms?: number; focus_loss_ms?: number;
    };
    const sessionId = ctx.url.searchParams.get('session');
    if (!sessionId || typeof raw.page_id !== 'string') return done();

    const session = await ctx.deps.sessions.load(sessionId);
    if (!session || session.machine_state.state === 'FINALIZED') return done();

    const prev = session.page_timings[raw.page_id as never];
    const updated: SessionState = {
      ...session,
      last_activity_at: ctx.deps.now(),
      page_timings: {
        ...session.page_timings,
        [raw.page_id]: {
          first_render_ms: clampMs(raw.first_render_ms) ?? prev?.first_render_ms ?? 0,
          total_ms: prev?.total_ms ?? 0,
          submits: prev?.submits ?? 0,
          focus_loss_ms: clampMs(raw.focus_loss_ms) ?? prev?.focus_loss_ms ?? 0,
        },
      } as never,
    };
    await ctx.deps.sessions.save(updated);
  } catch {
    // Malformed telemetry is dropped, not reported: an error response would teach a probing
    // client which payloads parse.
  }
  done();
}

/** Telemetry numbers are clamped: a client claiming a 12-day render is lying or broken. */
function clampMs(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
  return Math.min(v, 3_600_000);
}

/* ------------------------------------------------------------------ *
 * Router
 * ------------------------------------------------------------------ */

async function readiness(deps: RuntimeDeps): Promise<{
  ready: boolean;
  checks: Record<string, string>;
}> {
  // Readiness is distinct from liveness: a runtime that cannot reach its dependencies is alive
  // but must not receive respondent traffic, because every request would fail after doing work.
  const checks: Record<string, string> = {};
  let ready = true;

  try {
    await deps.tokens.resolve('0'.repeat(26));
    checks['token_resolver'] = 'ok';
  } catch {
    checks['token_resolver'] = 'unavailable';
    ready = false;
  }

  return { ready, checks };
}

/**
 * Build the request handler.
 *
 * Returns a plain `(req, res)` function so it can be driven directly from a test without a
 * listening socket.
 */
export function createHandler(deps: RuntimeDeps) {
  return async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestId = requestIdFrom(req.headers);
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    // Health endpoints answer on any origin: a load balancer probing them does not know a token.
    if (url.pathname === '/health') {
      json(res, 200, { status: 'ok', service: 'runtime', request_id: requestId });
      return;
    }
    if (url.pathname === '/ready') {
      const { ready, checks } = await readiness(deps);
      json(res, ready ? 200 : 503, { ready, checks, request_id: requestId });
      return;
    }

    const origin = parseOrigin(req.headers.host, deps.domain);
    if (!origin) {
      json(res, 404, { error: { code: 'not_found' }, request_id: requestId });
      return;
    }

    const ctx: Ctx = { deps, requestId, url, token: origin.token };
    const prefix = `/s/${origin.token}`;

    try {
      if (req.method === 'GET' && url.pathname === prefix) {
        await handleEntry(res, ctx);
        return;
      }

      if (req.method === 'GET' && url.pathname.startsWith(`${prefix}/p/`)) {
        const pageId = decodeURIComponent(url.pathname.slice(`${prefix}/p/`.length));
        await handlePageRender(res, ctx, pageId, url.searchParams.get('session'));
        return;
      }
    } catch (err) {
      // A token that resolves but whose artifact cannot be loaded is an operational failure, not
      // a bad request: 503 so a load balancer and an on-call engineer both read it correctly,
      // and never a 404, which would look like a wrong link.
      if (err instanceof ArtifactNotFound) {
        log.error('artifact_unavailable', {
          request_id: requestId,
          token: origin.token,
          err: String(err),
        });
        json(res, 503, { error: { code: 'artifact_unavailable' }, request_id: requestId });
        return;
      }
      throw err;
    }

    if (req.method === 'POST' && url.pathname === `${prefix}/submit`) {
      try {
        await handleSubmit(res, ctx, req);
      } catch (err) {
        if (err instanceof ArtifactNotFound) throw err; // the outer catch owns 503s
        log.error('submit_failed', { request_id: requestId, err: String(err) });
        json(res, 500, { error: { code: 'internal' }, request_id: requestId });
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === `${prefix}/event`) {
      await handleTelemetry(res, ctx, req);
      return;
    }

    if (req.method === 'POST' && url.pathname === `${prefix}/back`) {
      await handleBack(res, ctx);
      return;
    }

    if (req.method === 'GET' && url.pathname.startsWith(`${prefix}/resume/`)) {
      const resumeToken = decodeURIComponent(url.pathname.slice(`${prefix}/resume/`.length));
      try {
        await handleResume(res, ctx, resumeToken);
      } catch (err) {
        if (err instanceof ArtifactNotFound) throw err;
        log.error('resume_failed', { request_id: requestId, err: String(err) });
        json(res, 500, { error: { code: 'internal' }, request_id: requestId });
      }
      return;
    }

    if (url.pathname.startsWith('/preview/')) {
      json(res, 501, {
        error: { code: 'not_implemented', message: 'P1-11: preview' },
        request_id: requestId,
      });
      return;
    }

    json(res, 404, { error: { code: 'not_found' }, request_id: requestId });
  };
}

/** Re-exported so the back-navigation write path in P1-10 has one import site. */
export { invalidateForward };
