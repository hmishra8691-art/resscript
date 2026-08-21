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
import { createSession } from './entry.js';
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
): { rendered: RenderedPage; evaluated: EvaluatedPage } {
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

  return { rendered, evaluated };
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
}

/** Fetch one page of the session's artifact in the session's language. */
export type PageFetcher = (pageId: string) => Promise<RenderPage | null>;

/** What the interpreter needs to evaluate logic while performing a `render` command. */
export interface RenderDeps {
  readonly logic: RehydratedLogic;
  readonly labels?: { readonly [key: string]: string };
  readonly escapeContext: EscapeContext;
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
  const events: { kind: string; [k: string]: unknown }[] = [];

  for (const cmd of cmds) {
    switch (cmd.c) {
      case 'render': {
        const source = await loadPage(cmd.page_id);
        if (!source) {
          events.push({ kind: 'render.missing_page', page_id: cmd.page_id });
          break;
        }
        const { rendered, evaluated } = evaluateAndRender(
          source,
          current,
          opts.logic,
          opts.labels,
          opts.escapeContext,
        );
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

      case 'reserve_quota':
      case 'commit_quota':
      case 'release_quota':
        events.push({ kind: `quota.${cmd.c}_deferred`, detail: 'P1-10' });
        break;

      case 'call_api':
        events.push({ kind: 'api_call.deferred', node_id: cmd.node_id, detail: 'P1-10' });
        break;

      case 'emit_event':
        events.push({ ...cmd.event });
        break;
    }
  }

  return { session: current, page, disposition, events };
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

function pageBody(rendered: RenderedPage, session: SessionState, requestId: string) {
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
    session_id: ctx.deps.newId(),
    respondent_id: ctx.deps.newId(),
    survey_id: resolved.survey_id,
    artifact_hash: resolved.artifact_hash,
    random_seed: ctx.deps.newSeed(),
    language,
  });

  const session: SessionState = {
    ...base,
    survey_version: resolved.survey_version,
    is_test: resolved.is_test || resolved.status === 'test',
    entry_params: captureEntryParams(ctx.url),
    started_at: now,
    last_activity_at: now,
    server_time_ms: now,
  };

  const { next, cmds } = step(
    session,
    { i: 'enter' },
    asMachineArtifact(head),
    machineCtx(session, now),
  );
  const out = await interpret(cmds, next, pageFetcher(ctx, head.hash, language), {
    logic: logicFor(head),
    escapeContext: 'html_text',
  });

  await ctx.deps.sessions.save(out.session);

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
  json(res, 200, pageBody(out.page, out.session, ctx.requestId));
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

  const session = await ctx.deps.sessions.load(sessionId);
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

  const { rendered } = evaluateAndRender(
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

  json(res, 200, pageBody(rendered, stamped, ctx.requestId));
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

    // The submit write path is P1-10 (arch §3.3's ten steps: the append-only event log,
    // server-authoritative re-evaluation, and divergence detection). The machine and
    // invalidate-forward that it drives are built and tested; only the write path is missing.
    if (req.method === 'POST' && url.pathname === `${prefix}/submit`) {
      json(res, 501, {
        error: { code: 'not_implemented', message: 'P1-10: POST /s/:token/submit' },
        request_id: requestId,
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === `${prefix}/event`) {
      json(res, 501, {
        error: { code: 'not_implemented', message: 'P1-10: POST /s/:token/event' },
        request_id: requestId,
      });
      return;
    }

    if (req.method === 'GET' && url.pathname.startsWith(`${prefix}/resume/`)) {
      json(res, 501, {
        error: { code: 'not_implemented', message: 'P1-09: resume' },
        request_id: requestId,
      });
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
