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
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createLogger, requestIdFrom } from '@resscript/observability';
import {
  deriveKey,
  tagVars,
  evaluatePage,
  invalidateForward,
  orderGroupResolver,
  randomAt,
  rehydrate,
  renderPage,
  type Cmd,
  type EvaluatedPage,
  type Input as MachineIn,
  type MachineArtifact,
  type OrderGroup,
  type RehydratedLogic,
  type RenderPage,
  type RenderedPage,
} from '@resscript/runtime-core';
import { NO_CELLS, evalCondition, evaluate, varStateOf } from '@resscript/logic';
import type { ArtifactManifest, QuotaConfig } from '@resscript/schema';
import { ArtifactNotFound, type ArtifactHead, type ArtifactLoader } from './artifact/loader.js';
import { createSession, generateULID } from './entry.js';
import { rebuildSession, type RuntimeWriter } from './session/durable.js';
import { gateDecision, type QuotaClient } from './quota/index.js';
import { planFor, resolveCells } from './quota/cells.js';
import { createTtlProvider, type TtlProvider } from './quota/ttl.js';
import type { Allocator, RotationCounter } from './rotation.js';
import { bindInboundParams } from './vendor/inbound.js';
import { vendorFromParams, verifyEntry } from './vendor/verify.js';
import { handleSubmitCore, type SubmitBody } from './submit.js';
import {
  renderHtmlPage,
  renderRedirectInterstitial,
  renderTerminalPage,
} from './render/html.js';
import { resolveRedirect, type RedirectOutcome } from './redirect/index.js';
import { makeHookRunner } from './script/hooks.js';
import { verifyPreviewToken } from './preview/token.js';
import {
  initialReplayState,
  piiVariableIds,
  redactValues,
  replayPage,
  submitBodyFor,
  type ReplayOutcome,
  type ReplayStep,
} from './preview/replay.js';
import type { ScriptHost } from './script/host.js';
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
  /**
   * The adaptive reservation-TTL provider (P2-07). Absent = always use the authored value, which is
   * the pre-P2-07 behaviour and the correct fallback for a deployment with no measurement path.
   */
  readonly ttl?: TtlProvider;
  /**
   * The shared rotation counter (P2-03). Absent = no counter, so `rotate` and `fixed_order_list`
   * report `randomize.needs_counter` and leave the declared order alone — which is the honest
   * degradation rather than a seeded shuffle wearing a rotation's name.
   */
  readonly rotation?: RotationCounter;
  /**
   * The least-filled allocator for `even_distribution` randomizers (E §8.5). Absent = no
   * allocation, so those nodes use the seeded permutation and a `randomizer.degraded` event is
   * recorded — which E §8.5 prescribes rather than treating as a failure.
   */
  readonly allocator?: Allocator;
  /**
   * True once the process has begun shutting down.
   *
   * `/ready` answers 503 while this is true, and that is the whole point of a graceful shutdown:
   * `server.close()` refuses NEW connections but a load balancer that has not been told to stop
   * routing keeps opening them, so without this the grace period is spent rejecting traffic
   * instead of finishing the requests already in flight.
   *
   * Optional, and absent means "not draining" — the in-memory and test paths have no shutdown.
   */
  readonly draining?: () => boolean;
  /** Injected so a replayed request produces identical timestamps (ADR-006). */
  readonly now: () => number;
  /** ULID generator. */
  readonly newId: () => string;
  /** 128-bit hex seed generator. */
  readonly newSeed: () => string;
  /** The public domain survey origins live under, for ADR-005 hostname validation. */
  readonly domain: string;
  /**
   * The org redirect-host allowlist (security §12.3 check 7). Empty or absent skips the host
   * check (structural checks still run) until the control-plane inventory exists.
   */
  readonly redirectHosts?: readonly string[];
  /** Vendor HMAC secret lookup (E §11.2), injected so the secret source stays out of here. */
  readonly vendorSecret?: (vendorRef: string) => string | null;
  /**
   * The vendor's PREVIOUS secret, during a rotation. Security §10 requires two active secrets so a
   * rotation does not break links already in the field.
   */
  readonly vendorSecretPrevious?: (vendorRef: string) => string | null;
  /**
   * Consume an entry nonce, returning `true` if it was unused — `SET NX` with a TTL, in Redis.
   *
   * Optional because replay protection needs shared state and a single-node dev deployment has
   * none. Absent means nonces are not checked, which `verifyEntry` treats as exactly that rather
   * than as a pass on a replayed link it never looked at.
   */
  readonly consumeNonce?: (key: string, ttlSeconds: number) => boolean | Promise<boolean>;
  /** The QuickJS host (E §13). Absent = artifacts with server scripts skip their hooks. */
  readonly scriptHost?: ScriptHost;
  /**
   * HMAC key for signed preview tokens (P1-11). Absent = the preview surface 404s — an
   * ungated preview endpoint would render unpublished surveys to anyone holding a hash.
   */
  readonly previewSecret?: string;
  /** The studio origin allowed to FRAME preview pages (frame-ancestors). */
  readonly studioOrigin?: string;
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

/**
 * The policy for a page served WITHOUT an artifact in scope.
 *
 * Terminal pages, redirect interstitials and error pages are rendered by the runtime itself and
 * contain no author content, so there is no manifest to read and no script hash to permit. Named
 * rather than repeated inline so the two policies in this file are visibly the same base, and so
 * the difference between them is exactly the artifact-derived part.
 */
const BASE_CSP_DIRECTIVES: Readonly<Record<string, readonly string[]>> = {
  'default-src': ["'none'"],
  'style-src': ["'unsafe-inline'"],
  'script-src': ["'self'"],
  'form-action': ["'self'"],
  'frame-ancestors': ["'none'"],
};

/**
 * Serialize a CSP directive map, applying runtime-owned overrides.
 *
 * ## Why this exists
 *
 * `packages/compiler` computed `manifest.csp_directives` — including a `'sha256-…'` source per
 * custom script — and this file emitted a hard-coded string literal that read neither it nor
 * `manifest.script_hashes`. So ADR-005's hash-pinning was computed, hashed into the artifact id,
 * and thrown away at the moment it would have done something: `script-src 'self'` permits any
 * same-origin script and pins nothing. It is the twelfth instance in this codebase of a computed
 * value with no consumer, and the one with the worst consequence, since P2-11's entire premise is
 * that a custom script is sandboxed and integrity-pinned.
 *
 * ## The split, and why it is not "just emit the manifest"
 *
 * The manifest owns what the ARTIFACT implies: which script hashes may execute, where images may
 * come from, where XHR may go. The runtime owns what the TRANSPORT implies, and there is exactly
 * one such directive that differs per response — `frame-ancestors`. A survey page is never a
 * legitimate frame target; a preview page exists to be framed by one origin. The compiler cannot
 * know which of the two it is compiling for, and encoding "or the studio, if this happens to be a
 * preview" into the artifact would put a studio origin inside content-addressed bytes.
 *
 * So: the manifest is the base, `overrides` replace whole directives, and a directive present in
 * neither is absent from the header rather than defaulted — `default-src 'none'` is what catches
 * anything unenumerated, which is the reason it is first in the compiler's map too.
 */
function serializeCsp(
  directives: Readonly<Record<string, readonly string[]>>,
  overrides: Readonly<Record<string, readonly string[]>> = {},
): string {
  const merged: Record<string, readonly string[]> = { ...directives, ...overrides };
  return Object.entries(merged)
    .filter(([, sources]) => sources.length > 0)
    .map(([directive, sources]) => `${directive} ${sources.join(' ')}`)
    .join('; ');
}

/**
 * The artifact's own policy, or the base one when the manifest carries none.
 *
 * An older artifact compiled before `csp_directives` existed has no such field, and an artifact
 * with an empty map is indistinguishable from that in JSON. Falling back to `BASE_CSP_DIRECTIVES`
 * keeps such a page served under the policy this file used to hard-code — strictly better than
 * serving it with no CSP at all, which is what a naive read of a missing field would produce.
 */
function cspFor(manifest: Pick<ArtifactManifest, 'csp_directives'>): Readonly<
  Record<string, readonly string[]>
> {
  const declared = manifest.csp_directives;
  if (declared === undefined || Object.keys(declared).length === 0) return BASE_CSP_DIRECTIVES;
  return declared;
}

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
 * Preview HTML: identical to `html()` except the frame policy. A survey page is never a
 * legitimate frame target (frame-ancestors 'none'); a PREVIEW page exists to be framed — by
 * exactly one origin, the studio's. `sandbox="allow-scripts allow-forms"` on the studio side
 * (security §3.2) is the other half; this header is the half the runtime controls.
 */
function htmlFramed(
  res: ServerResponse,
  status: number,
  body: string,
  studioOrigin: string,
  directives: Readonly<Record<string, readonly string[]>> = BASE_CSP_DIRECTIVES,
): void {
  const headers: Record<string, string | number> = {
    ...SECURITY_HEADERS,
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    // `frame-ancestors` is the ONE directive the artifact cannot decide: the compiler does not
    // know whether it is compiling a page that will be framed by the studio. Everything else —
    // the script hashes above all — comes from the manifest.
    'content-security-policy': serializeCsp(directives, { 'frame-ancestors': [studioOrigin] }),
  };
  delete (headers as Record<string, unknown>)['x-frame-options']; // CSP's frame-ancestors is the policy here
  res.writeHead(status, headers);
  res.end(body);
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

/** Browsers say text/html; the JSON API (the client bundle, tests, integrations) does not. */
function wantsHtml(req: IncomingMessage): boolean {
  return (req.headers.accept ?? '').includes('text/html');
}

/**
 * ADR-005: no inline script except by hash, no external origins.
 *
 * `directives` is the artifact's `csp_directives` when a page was compiled from one, so a custom
 * script executes because its sha256 is in the header and any other script does not. Omitted for
 * the pages the runtime renders itself (terminal, redirect interstitial, errors), which contain no
 * author content and get `BASE_CSP_DIRECTIVES`.
 */
function html(
  res: ServerResponse,
  status: number,
  body: string,
  directives: Readonly<Record<string, readonly string[]>> = BASE_CSP_DIRECTIVES,
): void {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'content-security-policy': serializeCsp(directives),
  });
  res.end(body);
}

/**
 * Parse a form POST into a submit body. Repeated names become arrays (checkbox groups), and
 * `__page_id` is the form's own routing field. The values stay strings — the anti-tamper
 * filter's type coercion is the ONE place transport repair happens, for both encodings.
 */
async function readFormBody(req: IncomingMessage, maxBytes = 1_048_576): Promise<SubmitBody> {
  const raw = await new Promise<string>((resolve, reject) => {
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
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
  const params = new URLSearchParams(raw);
  const values: Record<string, unknown> = {};
  for (const key of new Set(params.keys())) {
    if (key === '__page_id') continue;
    const all = params.getAll(key);
    values[key] = all.length > 1 ? all : all[0];
  }
  return { page_id: params.get('__page_id') ?? '', values };
}

/** question id -> the variable its input posts as: the first emit, per the logic schema. */
function variableOfFactory(logic: RehydratedLogic): (questionId: string) => string | undefined {
  return questionId => logic.schema.questionVariables(questionId as never)[0] as
    | string
    | undefined;
}

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
 * The shared-order group resolver, cached per artifact hash on the same terms as `logicFor`.
 *
 * Supplying this is what makes E §8.3 — one shared random order across a battery — actually
 * happen. `randomize` has always implemented the algorithm and taken the group as an argument, but
 * until `graph.order_groups` existed there was nothing to pass, so every call in this file omitted
 * it and each question in a battery shuffled independently while `randomize` recorded
 * `randomize.group_missing` into the event stream. The registry now ships in `graph.json`; this is
 * the per-head adapter.
 *
 * A version-1 artifact has no `order_groups`, and `orderGroupResolver` returns a
 * resolver that answers `undefined` for every ref — the previous behaviour, unchanged, for an
 * artifact compiled before the field existed.
 */
const orderGroupCache = new Map<string, (group_ref: string) => OrderGroup | undefined>();

function groupsFor(head: ArtifactHead): (group_ref: string) => OrderGroup | undefined {
  const cached = orderGroupCache.get(head.hash);
  if (cached) return cached;
  const resolver = orderGroupResolver(head.graph);
  orderGroupCache.set(head.hash, resolver);
  return resolver;
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
 *
 * `alwaysTrace` is the one caller-driven part of the debug decision, and it exists for replay
 * (P1-11): a PRODUCTION session's trace capture is a 5% digest sample in the field (E §14.1), but
 * a replay of that session must still show the verdicts, or the debug panel cannot answer the
 * question it was opened for. It widens what is CAPTURED, never what is computed — the engine
 * produces the trace on every evaluation regardless — and the surface that sets it sits behind a
 * signed preview token and redacts pii before responding.
 */
function evaluateAndRender(
  page: RenderPage,
  session: SessionState,
  logic: RehydratedLogic,
  labels: { readonly [key: string]: string } | undefined,
  escapeContext: EscapeContext,
  // The variable manifest, for `tagVars` — the declared TYPE of each variable is the fact the
  // engine cannot guess and must not (see `var-values.ts`).
  manifest: Pick<ArtifactManifest, 'variable_manifest'>,
  // The shared-order group resolver (E §8.3). Threaded in rather than reached for, because the
  // orders it influences must be computed ONCE and shared by the engine and the renderer — see the
  // note above on why those two are one function.
  groupFor: ((group_ref: string) => OrderGroup | undefined) | undefined,
  alwaysTrace = false,
): { rendered: RenderedPage; evaluated: EvaluatedPage; debug?: Record<string, unknown> } {
  const submitted = new Set(
    session.history.filter(v => v.submitted_at !== null).map(v => String(v.page_id)),
  );

  const evaluated = evaluatePage({
    page,
    logic,
    seed: session.random_seed,
    // The counter ticket (P2-03). From the SESSION, never re-read from Redis here: it was issued
    // once at entry and persisted, because a replay that re-read the counter would get a different
    // number and reconstruct a different survey.
    ...(session.rotation_index === null ? {} : { respondentIndex: session.rotation_index }),
    vars: session.vars as Record<string, unknown>,
    // Tagged for the engine, raw for the renderer. `tagVars`' header explains why the two maps
    // are separate and why this one is not optional.
    taggedVars: tagVars(
      session.vars as Record<string, unknown>,
      manifest,
      // The engine's own variable→question inverse, so the domain id a value is tagged with is
      // the one the engine will compare it against.
      id => logic.schema.ownerQuestion(id as never) as string | undefined,
    ),
    ...(labels ? { labels } : {}),
    ...(groupFor ? { groupFor } : {}),
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

  if (!session.is_test && !alwaysTrace) return { rendered, evaluated };

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
 * The TTL provider used when none is injected: NO measurement, so every survey gets its authored
 * value.
 *
 * A provider rather than a bare `config.policy.reservation_ttl_s` read, so the one code path in
 * `resolveQuotaGate` is the same whether measurement is configured or not. A branch there would be
 * a second place for the absolute bounds to be forgotten.
 */
const DEFAULT_TTL_PROVIDER: TtlProvider = createTtlProvider();

/**
 * Allocations for every `even_distribution` randomizer in the graph (E §8.5).
 *
 * Returns `{}` when there are none, and OMITS a node whose allocation failed rather than inventing
 * one — a fabricated arm would be an allocation that no counter agrees with, which is worse than the
 * seeded fallback E §8.5 prescribes.
 */
async function resolveAllocations(
  ctx: Ctx,
  head: { readonly graph?: { readonly nodes?: readonly unknown[] } },
): Promise<Record<string, readonly string[]>> {
  const allocator = ctx.deps.allocator;
  const nodes = head.graph?.nodes ?? [];
  const out: Record<string, readonly string[]> = {};
  if (allocator === undefined) return out;

  for (const raw of nodes) {
    const node = raw as {
      id?: string;
      type?: string;
      targets?: readonly string[];
      mode?: string;
      n?: number | null;
      even_distribution?: boolean;
    };
    if (node.type !== 'randomizer' || node.even_distribution !== true) continue;
    const targets = node.targets ?? [];
    if (targets.length === 0 || node.id === undefined) continue;
    // `subset` takes n arms; every other mode takes all of them in least-filled order, which is
    // what makes "even distribution" a statement about ORDER as well as selection.
    const n = node.mode === 'subset' && typeof node.n === 'number' && node.n > 0
      ? Math.min(node.n, targets.length)
      : targets.length;
    const chosen = await allocator.assignLeastFilled(node.id, targets, n);
    if (chosen !== null && chosen.length > 0) out[node.id] = chosen;
  }
  return out;
}

/**
 * The author's page-shell HTML for this page, or null.
 *
 * Resolved HERE rather than inside `renderHtmlPage` because that function is synchronous and pure,
 * which is what makes the render unit-testable and replayable. The ref lives in
 * `CompiledPage.settings`, which the compiler passes through as opaque JSON — so this is also the
 * first code anywhere to read `page.settings`, the last of the three chains P2-12's audit found
 * dead-ended (declared, validated, sanitized, and consumed by nothing).
 *
 * A MISSING template renders the default shell rather than failing. The publish path guarantees the
 * file exists — `CMP-0502` refuses a dangling asset id and the emitter writes every template — so
 * reaching null means a hand-edited artifact or an unreachable storage tier, and a respondent
 * seeing an unstyled but working survey beats one seeing an error page.
 */
async function templateFor(
  ctx: Ctx,
  session: { readonly artifact_hash: string; readonly language: string },
  pageId: string,
): Promise<string | null> {
  try {
    // Re-read the COMPILED page for its settings. `RenderedPage` does not carry them — it is the
    // rendered result, not the authored shape — and the loader's page LRU has just served this
    // exact key to the render, so this costs a map lookup rather than a fetch. Threading the ref
    // through `evaluateAndRender`'s return instead would touch four call sites to move a field the
    // loader already holds.
    const compiled = await ctx.deps.artifacts.page(session.artifact_hash, session.language, pageId);
    const settings = (compiled as { settings?: unknown } | null)?.settings;
    if (settings === null || settings === undefined || typeof settings !== 'object') return null;
    const ref = (settings as { html_template_ref?: unknown }).html_template_ref;
    if (typeof ref !== 'string' || ref === '') return null;
    return await ctx.deps.artifacts.htmlTemplate(session.artifact_hash, ref);
  } catch {
    // Same reasoning as the null case: the shell is presentation, and losing it must not lose the
    // interview.
    return null;
  }
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
  /** The pinned artifact's variable manifest, for tagging vars before evaluation. */
  readonly manifest: Pick<ArtifactManifest, 'variable_manifest'>;
  readonly labels?: { readonly [key: string]: string };
  readonly escapeContext: EscapeContext;
  /** The pinned artifact's shared-order group resolver (E §8.3), from `groupsFor`. */
  readonly groupFor?: (group_ref: string) => OrderGroup | undefined;
  readonly quota?: QuotaClient;
  /**
   * The adaptive reservation-TTL provider (P2-07). Absent = always use the authored value, which is
   * the pre-P2-07 behaviour and the correct fallback for a deployment with no measurement path.
   */
  readonly ttl?: TtlProvider;
  /**
   * The shared rotation counter (P2-03). Absent = no counter, so `rotate` and `fixed_order_list`
   * report `randomize.needs_counter` and leave the declared order alone — which is the honest
   * degradation rather than a seeded shuffle wearing a rotation's name.
   */
  readonly rotation?: RotationCounter;
  /**
   * The least-filled allocator for `even_distribution` randomizers (E §8.5). Absent = no
   * allocation, so those nodes use the seeded permutation and a `randomizer.degraded` event is
   * recorded — which E §8.5 prescribes rather than treating as a failure.
   */
  readonly allocator?: Allocator;
  /**
   * Everything a `quota_gate` needs to reach a verdict and let the machine continue.
   *
   * Optional as a whole rather than field by field: without it a gate cannot be resolved at all,
   * and the honest response is the deferred event, not a partial reserve. Present, and the gate
   * runs — resolve the respondent's cells, decide, and step the machine with `quota_result`.
   */
  readonly quotaGate?: {
    /** `quotas.json` off the pinned head. Absent means the survey declares no plans. */
    readonly config?: QuotaConfig;
    /** The head could not read `quotas.json` — see `ArtifactHead.quotasIndeterminate`. */
    readonly indeterminate?: boolean;
    /** `policy.counter_scope` resolved to a concrete id — survey id or version id. */
    readonly scope: string;
    /** Step the machine so a resolved gate can continue to the next node. */
    readonly step: (session: SessionState, input: MachineIn) => { next: SessionState; cmds: readonly Cmd[] };
  };
  /**
   * Capture the E §14.2 trace even for a non-test session. Replay only — see `evaluateAndRender`.
   */
  readonly trace?: boolean;
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
          opts.manifest,
          opts.groupFor,
          opts.trace ?? false,
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
        // A mask whose `when_empty` is `terminate`, surfaced the same way and for the same reason:
        // finalizing releases a reservation and appends an event, which the machine and P1-10's
        // write path own, so this records the fact rather than acting on it.
        //
        // Recorded at ALL is the P2-02 fix. `renderPage` has always set `rendered.terminate` and
        // its comment said "the caller owns the disposition" — and no caller read it, so an author
        // who wrote `when_empty: 'terminate'` got a skipped question, silently, with nothing in the
        // event log to say why. Two halves were missing and each hid the other: the fallback never
        // reached the renderer (evaluate-page.ts) and the renderer's answer was never read (here).
        if (rendered.terminate) {
          events.push({
            kind: 'mask.terminate',
            question_id: rendered.terminate.question_id,
            detail: rendered.terminate.axis ?? '',
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

      case 'reserve_quota': {
        // The gate, resolved. The machine emitted this command and RETURNED, parking the session
        // in `QUOTA_GATE` until a `quota_result` input arrives — so anything that fails to feed one
        // back leaves the respondent on a blank step indefinitely. Every path below therefore ends
        // in exactly one `resume` call.
        const resolved = await resolveQuotaGate(cmd.quota_ref, current, opts);
        for (const e of resolved.events) events.push(e);
        const resumed = await resumeAfterQuota(resolved.passed, current, opts, loadPage);
        current = resumed.session;
        if (resumed.page) page = resumed.page;
        if (resumed.disposition !== null) disposition = resumed.disposition;
        if (resumed.debug) lastDebug = resumed.debug;
        for (const e of resumed.events) events.push(e);
        break;
      }

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
  readonly wantsHtml: boolean;
  /**
   * Where this surface's URLs live: `/s/<token>` for a survey origin, `/preview/<hash>?pt=…`
   * for the preview surface (P1-11). Every URL the handler builds — form actions, PRG
   * Location headers — derives from it, which is what lets one handler serve both surfaces.
   */
  readonly basePath: string;
  /**
   * Preview sessions live in the session store only (see handlePreview's header): they have
   * no durable birth row, so their submits must not reach `runtime.submit_page` — its
   * `last_event_seq` guard would read the missing row as a replay and 409 every submit.
   */
  readonly ephemeral?: boolean;
}

/** `<base>/p/<page>?…session=…`, folding any query the base itself carries. */
function pageUrl(ctx: Ctx, pageId: string, sessionId: string): string {
  const [path, query] = ctx.basePath.split('?');
  return `${path}/p/${encodeURIComponent(pageId)}?${query ? `${query}&` : ''}session=${encodeURIComponent(sessionId)}`;
}

/**
 * The head IS the machine's artifact.
 *
 * `MachineArtifact` needs only `graph`, which is the point: the machine routes without a single
 * page object, so per-page cost stays independent of survey size (C §17).
 */
/* ------------------------------------------------------------------ *
 * The quota gate (E §10, roadmap P2-06)
 * ------------------------------------------------------------------ */

interface QuotaGateOutcome {
  readonly passed: boolean;
  readonly events: readonly { kind: string; [k: string]: unknown }[];
}

/**
 * Reach a verdict for one `quota_gate`.
 *
 * The pieces this composes were all built and tested before it existed — `resolveCells` (which
 * respondent, which cells), `gateDecision` (reserve or evaluate-only, with ADR-008's
 * fail-open/fail-closed), and the Lua-backed client. What was missing was anything that called
 * them, so the gate emitted a deferred event and the machine never got a `quota_result`.
 *
 * **Passing is the answer to every case that is not a proven full cell**, and each of those cases
 * is a deliberate direction rather than a fallback:
 *
 *  - no quota client, or no plan in the artifact — nothing can be full, and holding a respondent on
 *    a gate whose plan does not exist is a worse failure than not counting them. Recorded.
 *  - the respondent resolves into no cell — see `cells.ts`: they cannot fill a cell they are not
 *    in, and `LGC-Q003` already blocks a plan that reads a variable no path writes before the gate.
 *  - `fail_open` when Redis is unreachable — the survey owner's own choice, and the session is
 *    flagged `quota_unverified` because overshoot nobody can identify afterwards is worse than
 *    overshoot that is labelled.
 *  - `soft_full` — a soft cell keeps counting and only reports the overshoot (schema
 *    `QUOTA_CELL_MODES`), so it passes and says so.
 *
 * Only `full` and `unavailable_fail_closed` fail, and both are named in the event stream.
 */
async function resolveQuotaGate(
  quotaRef: string,
  session: SessionState,
  opts: RenderDeps,
): Promise<QuotaGateOutcome> {
  const events: { kind: string; [k: string]: unknown }[] = [];
  const gate = opts.quotaGate;
  const config = gate?.config;

  if (!opts.quota || gate === undefined || config === undefined) {
    // Two shapes of "cannot decide", kept apart on purpose. `quotas.json` genuinely absent (or no
    // client configured) is benign — there are no plans, so nothing can be full. But a
    // `quotas.json` that could not be READ (`quotasIndeterminate`) may well contain the plan this
    // gate names, and admitting everyone then overshoots the client's quota silently. Both pass —
    // holding a respondent on a gate we cannot evaluate is the worse failure — but the second says
    // so loudly enough for an operator to find it.
    events.push(
      gate?.indeterminate === true
        ? { kind: 'quota.config_unavailable', quota_ref: quotaRef }
        : {
            kind: 'quota.reserve_deferred',
            quota_ref: quotaRef,
            detail: opts.quota ? 'no quota plan in artifact' : 'no quota client',
          },
    );
    return { passed: true, events };
  }

  const plan = planFor(config, quotaRef);
  if (plan === undefined) {
    // A gate naming a plan the artifact does not carry. `SCH-1004` rejects this at publish, so
    // reaching it means a hand-edited artifact; a respondent is not the right place to fail.
    events.push({ kind: 'quota.plan_missing', quota_ref: quotaRef });
    return { passed: true, events };
  }

  const resolved = resolveCells({
    config,
    planRef: quotaRef,
    scope: gate.scope,
    // The bucket ASTs are evaluated against the respondent's current variable state through the
    // same three-valued engine as every other condition, so UNKNOWN is "not this bucket" — the
    // safe direction argued in `cells.ts`.
    evalCondition: condition =>
      quotaConditionVerdict(condition, session, opts),
  });

  if (resolved.cells.length === 0) {
    events.push({
      kind: 'quota.no_cell',
      quota_ref: quotaRef,
      ...(resolved.unresolved.length > 0 ? { unresolved: [...resolved.unresolved] } : {}),
    });
    return { passed: true, events };
  }

  // The ADAPTIVE TTL (E §10.3, P2-07). `config.policy.reservation_ttl_s` is the AUTHORED estimate
  // and used to be the whole story, which left both failure modes E §10.3 names live: too short and
  // a slow respondent's reservation vanishes and the cell overfills, too long and abandons hold
  // cells for hours. Below 50 completes the authored value is still what is used — see ttl.ts for
  // why an unstable measurement is worse than a deliberate guess.
  const ttl = await (opts.ttl ?? DEFAULT_TTL_PROVIDER).decide(
    session.survey_version_id,
    config.policy.reservation_ttl_s,
  );

  const decision = await gateDecision(opts.quota, session.session_id, resolved.cells, {
    isTest: session.is_test,
    ttlSeconds: ttl.ttlSeconds,
    onUnavailable: config.policy.on_store_unavailable,
  });

  events.push({
    kind: 'quota.decision',
    quota_ref: quotaRef,
    decision: decision.decision,
    cells: resolved.cells.map(c => c.key),
    buckets: { ...resolved.buckets },
    ...(decision.soft_full.length > 0 ? { soft_full: [...decision.soft_full] } : {}),
    ...(decision.blocked.length > 0 ? { blocked: [...decision.blocked] } : {}),
  });

  if (decision.decision === 'unavailable_fail_open') {
    // The caller's duty per `gateDecision`'s own contract: overshoot that cannot be identified
    // afterwards is indistinguishable from data.
    events.push({ kind: 'quota.unverified', quota_ref: quotaRef });
  }

  const passed =
    decision.decision !== 'full' &&
    decision.decision !== 'would_be_full' &&
    decision.decision !== 'unavailable_fail_closed';

  return { passed, events };
}

/**
 * Evaluate one bucket `match` AST against the session's variables.
 *
 * Uses the engine's own `evalCondition` over the rehydrated program, so a bucket predicate is
 * decided by exactly the code that decides a display rule — including the Kleene semantics and the
 * variable tagging (`tagVars`) that makes an enum comparison compare against the right domain. A
 * second evaluator here would be a second answer to "is this respondent 18-24", and the one in the
 * compiler's `LGC-Q001` solver already has to agree with it.
 */
function quotaConditionVerdict(
  condition: unknown,
  session: SessionState,
  opts: RenderDeps,
): boolean | null {
  const tagged = tagVars(
    session.vars as Record<string, unknown>,
    opts.manifest,
    id => opts.logic.schema.ownerQuestion(id as never) as string | undefined,
  );
  const tri = evalCondition(condition as never, {
    vars: varStateOf(tagged as never),
    ctx: {},
    cells: NO_CELLS,
    schema: opts.logic.schema as never,
  } as never);
  return tri === 'T' ? true : tri === 'F' ? false : null;
}

interface QuotaResumed {
  readonly session: SessionState;
  readonly page: RenderedPage | null;
  readonly disposition: string | null;
  readonly events: readonly { kind: string; [k: string]: unknown }[];
  readonly debug?: Record<string, unknown>;
}

/**
 * Feed the verdict back into the machine and carry out whatever it asks for next.
 *
 * A gate's `on_pass`/`on_full` edge leads to more flow — a page to render, a termination to
 * finalize, or another gate — so the commands the machine returns here have to be interpreted, not
 * discarded. That is a recursive `interpret`, and it is bounded: `depth` caps the chain so a
 * pathological artifact (gate -> gate -> gate) cannot spin a respondent request forever. The cap is
 * generous relative to any real survey and, when hit, the session is left parked with an event
 * rather than silently advanced.
 */
async function resumeAfterQuota(
  passed: boolean,
  session: SessionState,
  opts: RenderDeps,
  loadPage: PageFetcher,
  depth = 0,
): Promise<QuotaResumed> {
  const gate = opts.quotaGate;
  if (gate === undefined) {
    return { session, page: null, disposition: null, events: [] };
  }
  if (depth >= MAX_QUOTA_GATE_CHAIN) {
    return {
      session,
      page: null,
      disposition: null,
      events: [{ kind: 'quota.gate_chain_exhausted', depth }],
    };
  }

  const stepped = gate.step(session, { i: 'quota_result', passed });
  const out = await interpret(stepped.cmds, stepped.next, loadPage, opts);
  return {
    session: out.session,
    page: out.page,
    disposition: out.disposition,
    events: out.events,
    ...(out.debug ? { debug: out.debug } : {}),
  };
}

/**
 * How many quota gates one request may resolve in a chain.
 *
 * Interlocked designs legitimately place two or three gates in sequence (a main plan, then a
 * vendor limit). Ten is far above anything real and far below anything that would tie up a
 * request; the point is that the bound EXISTS, because the resume path is recursive and an
 * artifact is not required to be sensible.
 */
const MAX_QUOTA_GATE_CHAIN = 10;

/**
 * The `quotaGate` dependency for one session, or `undefined` when the survey declares no quotas.
 *
 * `counter_scope` is resolved here, and it is the whole reason this is a function rather than a
 * literal: schema's `QuotaPolicy` states the field has no safe default because it decides whether
 * counters carry over when a live survey is republished mid-field. `'survey'` keys counters to the
 * survey id (correct for a tracker fixing a typo on day three); `'version'` keys them to the
 * version id (correct when the new version asks a different question). Guessing either would
 * silently reset or silently merge a client's quotas.
 */
function quotaGateFor(head: ArtifactHead, session: SessionState, now: number): RenderDeps['quotaGate'] {
  const config = head.quotas;
  // Built even when the config is absent-but-indeterminate: the gate needs to know the difference
  // to pick its event, and it cannot know if this returns undefined.
  if (config === undefined && head.quotasIndeterminate !== true) return undefined;
  return {
    ...(config ? { config } : {}),
    ...(head.quotasIndeterminate === true ? { indeterminate: true } : {}),
    // With no readable config there is no `counter_scope` to honour and no cell to key; the gate
    // will short-circuit on `config === undefined` before `scope` is used. The version id is the
    // narrower of the two, so an indeterminate head cannot accidentally address survey-wide
    // counters.
    scope:
      config?.policy.counter_scope === 'survey' ? session.survey_id : session.survey_version_id,
    step: (state, input) => {
      const out = step(state, input, asMachineArtifact(head), machineCtx(state, now));
      return { next: out.next, cmds: out.cmds };
    },
  };
}

/**
 * The vendor `verifyEntry` is given when the link names none.
 *
 * A link with no `src` (direct traffic, a QR code, a test link) is unsigned by definition, and
 * `verifyEntry` answers `{ ok: true, signed: false }` for a vendor with no `security` block — so
 * passing this stand-in gets the right answer through the one code path rather than adding a
 * branch that skips verification entirely. Skipping is how an "unsigned means fine" shortcut later
 * grows into "unrecognized `src` means fine".
 */
const UNSIGNED_VENDOR = {
  id: 'ven_unsigned' as never,
  ref: '',
  name: '',
  inbound_params: [],
} as const;

/**
 * The HMAC secrets to verify this vendor's links against: current first, then any previous still
 * inside its rotation window.
 *
 * Sourced from the deployment (`vendorSecret`), never from the artifact — security §10 calls an
 * HMAC secret in a CDN-served artifact "the single worst bug available in this design", and
 * `emit/bundle.ts`'s `assertNoSecrets` enforces the other half of that.
 */
function vendorSecretsFor(ctx: Ctx, vendor: { readonly ref: string } | undefined): readonly string[] {
  if (vendor === undefined || !ctx.deps.vendorSecret) return [];
  const current = ctx.deps.vendorSecret(vendor.ref);
  const previous = ctx.deps.vendorSecretPrevious?.(vendor.ref) ?? null;
  return [current, previous].filter((s): s is string => typeof s === 'string' && s.length > 0);
}

function asMachineArtifact(head: ArtifactHead): MachineArtifact {
  return head as unknown as MachineArtifact;
}

/** The context the machine gets: injected clock, seeded PRNG, no rule evaluation yet. */
function machineCtx(session: SessionState, now: number) {
  return makeCtx({
    now_ms: now,
    random: salt => randomAt(deriveKey(session.random_seed, salt), 0),
    // From the SESSION, never re-resolved: the allocation was made once at entry and persisted,
    // because it depends on global fill state and a replay that re-ran the allocator would
    // reconstruct a different survey (E §8.5).
    randomizerAssignment: (nodeId: string) => session.randomizer_assignments[nodeId],
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

function finalBody(
  session: SessionState,
  disposition: string,
  requestId: string,
  redirectUrl: string | null = null,
) {
  return {
    session_id: session.session_id,
    disposition,
    ...(session.custom_key ? { custom_key: session.custom_key } : {}),
    // Reported as null rather than omitted when no redirect is configured, so a client can
    // tell "no redirect configured" from "field absent".
    redirect_url: redirectUrl,
    request_id: requestId,
  };
}

/**
 * The one exit door: every finalized response — entry that terminated immediately, submit
 * that completed, a GET of an already-finalized session — goes through here, so E §11's
 * behaviour cannot drift between paths.
 *
 * Ordering per E §11.3: by the time this runs the disposition is already durable (the submit
 * pipeline persisted before responding) — this function only decides what the respondent
 * *sees*. Which is also why every failure here fails SOFT to the terminal page: an
 * unreachable redirects.json or a rejected URL must not turn a recorded COMPLETE into a 500;
 * the interview is done and safe, only the hand-off degraded.
 *
 * Production HTML gets the 302/303 with `Referrer-Policy: no-referrer` (security §12.3 — the
 * vendor learns the parameters we chose to send, never the session URL). Test sessions get
 * the E §14.1 interstitial: the resolved URL and every interpolated parameter, with a
 * follow-it-anyway link and no auto-redirect, because QA's job is to look at it.
 */
async function respondFinal(
  ctx: Ctx,
  res: ServerResponse,
  session: SessionState,
  disposition: string,
  opts: { htmlMode: boolean; redirectStatus: 302 | 303 },
): Promise<void> {
  let outcome: RedirectOutcome = { kind: 'none' };
  try {
    const [redirects, head] = await Promise.all([
      ctx.deps.artifacts.redirects(session.artifact_hash),
      ctx.deps.artifacts.head(session.artifact_hash),
    ]);
    outcome = resolveRedirect({
      redirects,
      manifest: head.manifest,
      vars: session.vars,
      disposition,
      customKey: session.custom_key,
      vendorRef: session.vendor_ref,
      language: session.language,
      hostAllowlist: ctx.deps.redirectHosts ?? [],
      ...(ctx.deps.vendorSecret ? { vendorSecret: ctx.deps.vendorSecret } : {}),
    });
  } catch (err) {
    log.warn('redirect_resolution_failed', {
      request_id: ctx.requestId, session_id: session.session_id, err: String(err),
    });
  }

  if (outcome.kind === 'rejected') {
    // The template pointed somewhere the runtime refuses to send a respondent. Loud in the
    // log (this is an authoring or allowlist defect someone must fix), terminal page for the
    // respondent — never the URL.
    log.warn('redirect_rejected', {
      request_id: ctx.requestId, session_id: session.session_id,
      reason: outcome.reason, template: outcome.template,
    });
    outcome = { kind: 'none' };
  }

  if (outcome.kind === 'none') {
    if (opts.htmlMode) {
      html(res, 200, renderTerminalPage(disposition));
      return;
    }
    json(res, 200, finalBody(session, disposition, ctx.requestId));
    return;
  }

  if (outcome.blockedPii.length > 0 || outcome.hmacUnavailable) {
    log.warn('redirect_degraded', {
      request_id: ctx.requestId, session_id: session.session_id,
      blocked_pii: outcome.blockedPii, hmac_unavailable: outcome.hmacUnavailable,
    });
  }

  if (session.is_test) {
    if (opts.htmlMode) {
      html(res, 200, renderRedirectInterstitial({
        url: outcome.url, disposition, params: outcome.params,
      }));
      return;
    }
    json(res, 200, {
      ...finalBody(session, disposition, ctx.requestId, outcome.url),
      redirect_params: outcome.params,
      test_interstitial: true,
    });
    return;
  }

  if (opts.htmlMode) {
    res.writeHead(opts.redirectStatus, {
      ...SECURITY_HEADERS,
      location: outcome.url,
      'referrer-policy': 'no-referrer',
      'cache-control': 'no-store',
    });
    res.end();
    return;
  }
  json(res, 200, finalBody(session, disposition, ctx.requestId, outcome.url));
}

/**
 * The language's string bundle, fail-soft: a missing or unreachable bundle renders label KEYS
 * instead of translations, which is visibly wrong and harmless — the alternative (failing the
 * render) turns a CDN blip on one i18n file into a down survey. Open decision 3 (mid-survey
 * language switch) is untouched: the language is fixed at entry, so one bundle per session.
 */
async function labelsFor(
  ctx: Ctx,
  hash: string,
  language: string,
): Promise<Record<string, string> | undefined> {
  try {
    return (await ctx.deps.artifacts.i18n(hash, language)) ?? undefined;
  } catch (err) {
    log.warn('i18n_bundle_unavailable', {
      request_id: ctx.requestId, artifact_hash: hash, language, err: String(err),
    });
    return undefined;
  }
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

  // ---- vendor identification and entry-signature verification (security §10) --------
  //
  // BEFORE any session is minted, because the acceptance criterion is that a link with one
  // character of `pid` changed "returns an error page and creates no session row" — and security §9
  // puts every terminating fraud check ahead of session creation and quota reservation for the same
  // reason: admitting a bad respondent and screening them out later still burns a reservation and
  // skews field pace.
  //
  // Identification precedes verification and is not mistaken for it: which vendor the link CLAIMS
  // to be from is what selects the secret and the signed-parameter list, so it has to be resolved
  // first, and it stays a claim until `verifyEntry` checks it.
  const vendor = vendorFromParams(ctx.url.searchParams, head.vendors);
  const verification = await verifyEntry({
    params: ctx.url.searchParams,
    vendor: vendor ?? UNSIGNED_VENDOR,
    secrets: vendorSecretsFor(ctx, vendor),
    nowMs: now,
    ...(ctx.deps.consumeNonce ? { consumeNonce: ctx.deps.consumeNonce } : {}),
  });
  if (!verification.ok) {
    // The reason is logged, not returned: telling a caller *which* check failed turns the error
    // page into an oracle for forging a link. `INVALID_LINK` is what the respondent sees.
    log.warn('entry_signature_refused', {
      request_id: ctx.requestId,
      vendor_ref: vendor?.ref ?? null,
      reason: verification.reason,
    });
    json(res, 403, {
      disposition: 'TERMINATE',
      reason: 'INVALID_LINK',
      request_id: ctx.requestId,
    });
    return;
  }

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

  // Declared inbound parameters become hidden variables. Only DECLARED ones: the query string is
  // the one input a respondent types freely, so binding anything else would let them set any hidden
  // variable in the survey — including one a quota dimension reads.
  const inbound = bindInboundParams({
    params: ctx.url.searchParams,
    vendor,
    manifest: head.manifest,
  });

  let session: SessionState = {
    ...base,
    survey_version_id: resolved.survey_version_id,
    is_test: resolved.is_test || resolved.status === 'test',
    entry_params: captureEntryParams(ctx.url),
    // `vendor_ref` was declared on the session and read at redirect time (E §11.1's
    // vendor-specific-beats-language-specific precedence) but never SET, so `by_vendor` could not
    // fire for any respondent. It is set here, from the identification above.
    vendor_ref: vendor?.ref ?? null,
    // The counter ticket, issued ONCE for the whole session (P2-03). Every rotating axis derives
    // its offset from this one number — see rotation.ts on why one ticket per session beats one per
    // axis — and it is persisted with the session because it is not recoverable from the seed.
    //
    // A null here means no counter was reachable, and `randomize()` then reports
    // `randomize.needs_counter` and leaves the declared order alone. An unrotated survey is
    // visibly unrotated; a seeded shuffle standing in for a rotation is an unbalanced design
    // nobody notices until fieldwork ends.
    rotation_index: ctx.deps.rotation
      ? await ctx.deps.rotation.next(resolved.survey_version_id)
      : null,
    // Allocations for every `even_distribution` randomizer, resolved ONCE at entry. Resolved here
    // rather than when the machine reaches the node, because `step` is a pure reducer with no way
    // to await — and there are few such nodes, so doing them together costs one round trip.
    randomizer_assignments: await resolveAllocations(ctx, head),
    vars: { ...base.vars, ...inbound.vars },
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
      // From the session, which the entry path set from `?src=` a few lines above. Passing it at
      // all is P2-04: this call put a literal NULL in the RPC's `p_vendor_ref` slot, so
      // `runtime.sessions.vendor_ref` was always null and a session rebuilt from Postgres came back
      // as direct traffic — resolving its redirect through `default` instead of `by_vendor`.
      vendor_ref: session.vendor_ref,
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
  const labels = await labelsFor(ctx, head.hash, language);
  const quotaGate = quotaGateFor(head, session, now);
  const out = await interpret(cmds, next, pageFetcher(ctx, head.hash, language), {
    logic: logicFor(head),
    manifest: head.manifest,
    escapeContext: 'html_text',
    groupFor: groupsFor(head),
    ...(quotaGate ? { quotaGate } : {}),
    ...(labels ? { labels } : {}),
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
    await respondFinal(ctx, res, out.session, out.disposition, {
      htmlMode: ctx.wantsHtml, redirectStatus: 302,
    });
    return;
  }
  if (!out.page) {
    // The machine neither rendered nor finalized. Every path through a published graph does one
    // or the other (the compiler enforces it), so this is a compiler escape, not a bad request.
    json(res, 500, { error: { code: 'no_page' }, request_id: ctx.requestId });
    return;
  }
  if (ctx.wantsHtml) {
    const pageTemplate = await templateFor(ctx, out.session, out.page.page_id);
    html(res, 200, renderHtmlPage({
      page: out.page,
      sessionId: out.session.session_id,
      token: ctx.token,
      actionBase: ctx.basePath,
      variableOf: variableOfFactory(logicFor(head)),
      clientScriptUrl: '/client.js',
      themeCssUrl: `/theme/${out.session.artifact_hash}.css`,
      authorCssUrl: `/author/${out.session.artifact_hash}.css`,
      ...(pageTemplate === null ? {} : { pageTemplate }),
    }), cspFor(head.manifest));
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
    await respondFinal(ctx, res, session, session.disposition ?? 'TERMINATE', {
      htmlMode: ctx.wantsHtml, redirectStatus: 302,
    });
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
    pinned.head.manifest,
    groupsFor(pinned.head),
  );
  // Re-rendering re-stamps the digest. It must, or a mask that moved between the first render and
  // a refresh would leave a digest describing a page the respondent is no longer looking at.
  const stamped = stampDigest(session, pageId, rendered.digest);
  await ctx.deps.sessions.save(stamped);

  if (ctx.wantsHtml) {
    // Prefill from stored answers, so a PRG landing or a resume shows what they entered.
    const prefill = Object.fromEntries(
      stamped.history
        .filter(v => v.page_id === pageId)
        .flatMap(v => v.wrote)
        .map(v => [v, (stamped.vars as Record<string, unknown>)[v]]),
    );
    const pageTemplate = await templateFor(ctx, stamped, rendered.page_id);
    html(res, 200, renderHtmlPage({
      page: rendered,
      sessionId: stamped.session_id,
      token: ctx.token,
      actionBase: ctx.basePath,
      prefill,
      variableOf: variableOfFactory(logicFor(pinned.head)),
      clientScriptUrl: '/client.js',
      themeCssUrl: `/theme/${stamped.artifact_hash}.css`,
      authorCssUrl: `/author/${stamped.artifact_hash}.css`,
      ...(pageTemplate === null ? {} : { pageTemplate }),
    }), cspFor(pinned.head.manifest));
    return;
  }
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
  // A form POST (no JavaScript) and a JSON POST (the client bundle) share EVERYTHING past
  // parsing: same filter, same validation, same machine, same write. Progressive enhancement
  // that forked the pipeline would validate two different surveys.
  const isForm = (req.headers['content-type'] ?? '').includes('application/x-www-form-urlencoded');
  const htmlMode = isForm || ctx.url.searchParams.get('html') === '1';
  let raw: unknown;
  try {
    raw = isForm ? await readFormBody(req) : await readJsonBody(req);
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
  const labels = await labelsFor(ctx, session.artifact_hash, language);

  const writer = ctx.ephemeral ? undefined : ctx.deps.writer;
  const runHooks = ctx.deps.scriptHost
    ? makeHookRunner(ctx.deps.scriptHost, ctx.deps.artifacts, head)
    : undefined;
  const outcome = await handleSubmitCore(session, body as SubmitBody, {
    head,
    logic,
    loadPage,
    now: ctx.deps.now,
    ...(runHooks ? { runHooks } : {}),
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
    case 'replay': {
      if (htmlMode) {
        const dest = (outcome.response as { page_id?: string } | undefined)?.page_id;
        res.writeHead(303, {
          ...SECURITY_HEADERS,
          location: dest
            ? pageUrl(ctx, dest, sessionId)
            : ctx.basePath,
        });
        res.end();
        return;
      }
      json(res, 200, { replayed: true, ...(outcome.response as object), request_id: ctx.requestId });
      return;
    }

    case 'stale': {
      if (htmlMode && outcome.current_page_id) {
        // A no-JS double-navigation lands on whatever page the session is really on.
        res.writeHead(303, {
          ...SECURITY_HEADERS,
          location: pageUrl(ctx, outcome.current_page_id, sessionId),
        });
        res.end();
        return;
      }
      json(res, 409, {
        error: { code: 'stale_page', current_page_id: outcome.current_page_id },
        request_id: ctx.requestId,
      });
      return;
    }

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
      if (htmlMode) {
        // Re-render the form with the messages attached to their questions — 200, not 4xx:
        // the respondent's next action is on this page, and some panel webviews treat any
        // error status as fatal.
        const errors = new Map<string, string[]>();
        for (const f of outcome.failures) {
          errors.set(f.question_id, [...(errors.get(f.question_id) ?? []), f.message_key]);
        }
        html(res, 200, renderHtmlPage({
          page: outcome.page,
          sessionId: session.session_id,
          token: ctx.token,
          actionBase: ctx.basePath,
          errors,
          prefill: body.values as Record<string, unknown>,
          variableOf: variableOfFactory(logic),
          clientScriptUrl: '/client.js',
        }), cspFor(head.manifest));
        return;
      }
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
          manifest: head.manifest,
          escapeContext: 'html_text',
          ...(ctx.deps.quota ? { quota: ctx.deps.quota } : {}),
        });
      }
      await ctx.deps.sessions.save(outcome.session);
      // 303, not 302: this is the response to a POST, and PRG demands the follow-up be a GET.
      await respondFinal(ctx, res, outcome.session, outcome.disposition, {
        htmlMode, redirectStatus: 303,
      });
      return;
    }

    case 'advanced': {
      // Interpret the machine's commands: render the next page (stamping its digest), or a
      // late finalize out of the flow walk.
      const out = await interpret(outcome.cmds, outcome.session, loadPage, {
        logic,
        manifest: head.manifest,
        escapeContext: 'html_text',
        ...(labels ? { labels } : {}),
        ...(ctx.deps.quota ? { quota: ctx.deps.quota } : {}),
      });
      await ctx.deps.sessions.save(out.session);
      if (out.disposition) {
        await respondFinal(ctx, res, out.session, out.disposition, {
          htmlMode, redirectStatus: 303,
        });
        return;
      }
      if (!out.page) {
        json(res, 500, { error: { code: 'no_page' }, request_id: ctx.requestId });
        return;
      }
      if (htmlMode) {
        // POST/redirect/GET: the browser lands on the next page's URL, so refresh re-renders
        // instead of re-submitting, and the back button is the browser's own.
        res.writeHead(303, {
          ...SECURITY_HEADERS,
          location: pageUrl(ctx, String(out.session.current_page_id), sessionId),
        });
        res.end();
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
    head.manifest, groupsFor(head),
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

  const backLabels = await labelsFor(ctx, session.artifact_hash, session.language);
  const backQuotaGate = quotaGateFor(head, session, ctx.deps.now());
  const out = await interpret(cmds, next, pageFetcher(ctx, session.artifact_hash, session.language), {
    ...(backLabels ? { labels: backLabels } : {}),
    logic: logicFor(head),
    manifest: head.manifest,
    escapeContext: 'html_text',
    groupFor: groupsFor(head),
    ...(backQuotaGate ? { quotaGate: backQuotaGate } : {}),
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

/** The built enhancement bundle, read once. Null when the build has not produced it (tests). */
let clientBundle: Buffer | null | undefined;
async function loadClientBundle(): Promise<Buffer | null> {
  if (clientBundle !== undefined) return clientBundle;
  try {
    clientBundle = await readFile(
      join(dirname(fileURLToPath(import.meta.url)), 'client', 'client.js'),
    );
  } catch {
    clientBundle = null;
  }
  return clientBundle;
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

  // Draining is checked FIRST and short-circuits: during shutdown the dependencies are still
  // perfectly healthy, so every check below would pass and the probe would keep this pod in the
  // load balancer's pool right up to the moment it stops answering. Reporting not-ready here is
  // what converts `server.close()` from "reject new connections" into an actual drain.
  if (deps.draining?.() === true) {
    checks['draining'] = 'shutting_down';
    return { ready: false, checks };
  }

  try {
    await deps.tokens.resolve('0'.repeat(26));
    checks['token_resolver'] = 'ok';
  } catch {
    checks['token_resolver'] = 'unavailable';
    ready = false;
  }

  return { ready, checks };
}


/* ------------------------------------------------------------------ *
 * The preview surface (P1-11, E §12, security §3.2)
 * ------------------------------------------------------------------ */

/**
 * `/preview/:artifact_hash[...]` — render an artifact BY HASH, before any survey token
 * exists. Gated per request on a signed preview token (`?pt=`), verified statelessly; the
 * hash is inside the signature so a token minted for one artifact opens no other.
 *
 * Sessions minted here are `is_test: true` with everything E §14.1 attaches to that (the
 * full trace in responses, the redirect interstitial, read-only quota evaluation), pinned to
 * the requested hash, and deliberately NOT written through the durable writer: a preview
 * session belongs to an artifact that may never be published, and `runtime.sessions` rows
 * reference survey versions the authoring plane owns. Redis/memory only — a preview that
 * outlives its store is a preview someone left open for a week, and restarting it costs one
 * click. Recorded as a P1-11 scope decision.
 */
async function handlePreview(
  res: ServerResponse,
  deps: RuntimeDeps,
  req: IncomingMessage,
  requestId: string,
  url: URL,
): Promise<void> {
  const secret = deps.previewSecret;
  if (!secret) {
    // Indistinguishable from "no such route": an ungated deployment does not advertise that
    // previews would exist if only a secret were set.
    json(res, 404, { error: { code: 'not_found' }, request_id: requestId });
    return;
  }

  // /preview/<hash>[/<sub...>]
  const parts = url.pathname.slice('/preview/'.length).split('/');
  const hash = parts[0] ?? '';
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    json(res, 404, { error: { code: 'not_found' }, request_id: requestId });
    return;
  }
  const pt = url.searchParams.get('pt') ?? '';
  const verdict = verifyPreviewToken(secret, hash, pt, deps.now());
  if (!verdict.ok) {
    json(res, 403, {
      error: { code: 'preview_denied', reason: verdict.reason }, request_id: requestId,
    });
    return;
  }

  const ctx: Ctx = {
    deps, requestId, url, token: '', wantsHtml: wantsHtml(req),
    basePath: `/preview/${hash}?pt=${encodeURIComponent(pt)}`,
    ephemeral: true,
  };
  const sub = parts.slice(1).join('/');

  try {
    if (req.method === 'GET' && sub === '') {
      await handlePreviewEntry(res, ctx, hash);
      return;
    }
    if (req.method === 'GET' && sub.startsWith('p/')) {
      await handlePageRender(res, ctx, decodeURIComponent(sub.slice(2)), url.searchParams.get('session'));
      return;
    }
    if (req.method === 'POST' && sub === 'submit') {
      await handleSubmit(res, ctx, req);
      return;
    }
    if (req.method === 'POST' && sub === 'setvars') {
      await handlePreviewSetVars(res, ctx, req, hash);
      return;
    }
    if (req.method === 'GET' && sub.startsWith('replay/')) {
      await handlePreviewReplay(res, ctx, hash, decodeURIComponent(sub.slice('replay/'.length)));
      return;
    }
    if (req.method === 'POST' && sub === 'event') {
      await handleTelemetry(res, ctx, req);
      return;
    }
  } catch (err) {
    if (err instanceof ArtifactNotFound) {
      // On the preview surface the hash IS the resource the caller named, so a missing
      // artifact is their 404, not our 503.
      json(res, 404, { error: { code: 'artifact_not_found' }, request_id: requestId });
      return;
    }
    throw err;
  }

  json(res, 404, { error: { code: 'not_found' }, request_id: requestId });
}

async function handlePreviewEntry(res: ServerResponse, ctx: Ctx, hash: string): Promise<void> {
  const head = await ctx.deps.artifacts.head(hash);
  const now = ctx.deps.now();

  const seedParam = ctx.url.searchParams.get('seed');
  const langParam = ctx.url.searchParams.get('lang');
  const language =
    langParam && head.manifest.languages.includes(langParam)
      ? langParam
      : head.manifest.base_language;

  const base = createSession({
    session_id: `ses_${ctx.deps.newId()}`,
    respondent_id: `rsp_${ctx.deps.newId()}`,
    survey_id: head.manifest.survey_id,
    artifact_hash: hash,
    // E §14.1: the seed is overridable in test mode, so a reported bug is reproducible.
    random_seed: seedParam && /^[0-9a-f]{32}$/.test(seedParam) ? seedParam : ctx.deps.newSeed(),
    language,
  });
  const session: SessionState = {
    ...base,
    survey_version_id: head.manifest.survey_version_id,
    is_test: true,
    entry_params: captureEntryParams(ctx.url),
    started_at: now,
    last_activity_at: now,
    server_time_ms: now,
  };

  const entered = step(session, { i: 'enter' }, asMachineArtifact(head), machineCtx(session, now));
  const labels = await labelsFor(ctx, hash, language);
  const entryQuotaGate = quotaGateFor(head, session, now);
  const out = await interpret(entered.cmds, entered.next, pageFetcher(ctx, hash, language), {
    logic: logicFor(head),
    manifest: head.manifest,
    escapeContext: 'html_text',
    groupFor: groupsFor(head),
    ...(entryQuotaGate ? { quotaGate: entryQuotaGate } : {}),
    ...(labels ? { labels } : {}),
    ...(ctx.deps.quota ? { quota: ctx.deps.quota } : {}),
  });
  await ctx.deps.sessions.save(out.session);

  log.info('preview_entered', {
    request_id: ctx.requestId, session_id: out.session.session_id, artifact_hash: hash,
  });

  if (out.disposition) {
    await respondFinal(ctx, res, out.session, out.disposition, {
      htmlMode: ctx.wantsHtml, redirectStatus: 302,
    });
    return;
  }
  if (!out.page) {
    json(res, 500, { error: { code: 'no_page' }, request_id: ctx.requestId });
    return;
  }
  if (ctx.wantsHtml) {
    const studioOrigin = ctx.deps.studioOrigin ?? "'none'";
    // The preview surface gets the author's shell too. A preview that rendered the default shell
    // would show the programmer a page their respondents will not see, which is the one thing a
    // preview must not do.
    const pageTemplate = await templateFor(ctx, out.session, out.page.page_id);
    htmlFramed(res, 200, renderHtmlPage({
      page: out.page,
      sessionId: out.session.session_id,
      token: '',
      actionBase: ctx.basePath,
      variableOf: variableOfFactory(logicFor(head)),
      clientScriptUrl: '/client.js',
      themeCssUrl: `/theme/${out.session.artifact_hash}.css`,
      authorCssUrl: `/author/${out.session.artifact_hash}.css`,
      ...(pageTemplate === null ? {} : { pageTemplate }),
      ...(ctx.deps.studioOrigin
        ? { preview: { studioOrigin: ctx.deps.studioOrigin, artifactHash: hash } }
        : {}),
    }), studioOrigin, cspFor(head.manifest));
    return;
  }
  json(res, 200, pageBody(out.page, out.session, ctx.requestId, out.debug));
}

/**
 * `preview:setVars`, server side (security §3.2): jump the session into a variable state.
 * Accepted ONLY for `is_test` sessions and re-validated against the variable manifest, so the
 * same message on a production session is inert and an invented ref writes nothing.
 */
async function handlePreviewSetVars(
  res: ServerResponse,
  ctx: Ctx,
  req: IncomingMessage,
  hash: string,
): Promise<void> {
  let raw: unknown;
  try {
    raw = await readJsonBody(req);
  } catch {
    json(res, 400, { error: { code: 'malformed_request' }, request_id: ctx.requestId });
    return;
  }
  const vars = (raw as { vars?: unknown }).vars;
  const sessionId = ctx.url.searchParams.get('session');
  if (!sessionId || typeof vars !== 'object' || vars === null || Array.isArray(vars)) {
    json(res, 400, { error: { code: 'malformed_request' }, request_id: ctx.requestId });
    return;
  }
  const session = await loadSessionState(ctx.deps, sessionId);
  if (!session || session.artifact_hash !== hash || !session.is_test) {
    // One answer for "no such session", "someone else's artifact" and "not a test session":
    // distinguishing them would let a caller probe which sessions exist.
    json(res, 404, { error: { code: 'session_not_found' }, request_id: ctx.requestId });
    return;
  }

  const head = await ctx.deps.artifacts.head(hash);
  const byRef = new Map(head.manifest.variable_manifest.map(e => [e.name, e]));
  const accepted: Record<string, unknown> = {};
  const rejected: string[] = [];
  for (const [ref, value] of Object.entries(vars as Record<string, unknown>)) {
    const entry = byRef.get(ref);
    if (!entry) {
      rejected.push(ref);
      continue;
    }
    accepted[entry.id] = value;
  }

  const next: SessionState = {
    ...session,
    vars: { ...(session.vars as Record<string, unknown>), ...accepted } as never,
    var_provenance: {
      ...session.var_provenance,
      ...Object.fromEntries(Object.keys(accepted).map(id => [id, { p: 'system' }])),
    } as never,
    last_activity_at: ctx.deps.now(),
  };
  await ctx.deps.sessions.save(next);
  json(res, 200, {
    ok: true,
    set: Object.keys(accepted).length,
    rejected,
    page_id: next.current_page_id,
    request_id: ctx.requestId,
  });
}

/**
 * `GET /preview/:hash/replay/:session_id?pt=…` — E §12.3's `preview.replay`, server side
 * (P1-11's last acceptance line).
 *
 * Load the session's seed and its recorded inputs (migration 0014's `runtime.replay_session`),
 * then re-drive the SAME pipeline the respondent's submits ran — `handleSubmitCore` with NO
 * `persist` — and report each page with its resolved option orders and its rule verdicts. That
 * turns "the client says the rotation is wrong" (ADR-006) into a five-minute investigation.
 *
 * Three gates, each for a different mistake:
 *   * the signed preview token, which this route inherits from `handlePreview` — the same gate
 *     the rest of the surface sits behind, and the reason a production session's answers are
 *     reachable here at all is that the control plane mints the token only for PRG+ (API §2.14's
 *     `POST /v1/sessions/{id}/replay-token`);
 *   * the session id's SHAPE, checked before the RPC — the argument is an `app.ulid` and a
 *     malformed one should be our 404, not a domain error raised in the database;
 *   * the artifact hash must EQUAL the session's pin. Replaying a session against a different
 *     artifact is a category error, not a near miss: the pages, the option lists and the rules
 *     would all be someone else's, and the resulting "replay" would be a fabrication. It is also
 *     what keeps a token minted for artifact A from reading sessions pinned to artifact B.
 *
 * Nothing is written and nothing is reserved: no `persist` closure is built (the absent seam is
 * the mechanism), no session is saved to the store, and no quota client is passed to the
 * interpreter — a replay that committed a reservation would burn a real quota cell to answer a
 * question about the past (E §14.1's rule, which applies with more force here than to test mode).
 */
async function handlePreviewReplay(
  res: ServerResponse,
  ctx: Ctx,
  hash: string,
  sessionId: string,
): Promise<void> {
  if (!ctx.deps.writer) {
    // 503, not 404: "this deployment has no record to replay from" is an operational fact about
    // us, not a statement about the session, and a programmer chasing a rotation dispute needs
    // to know which of the two they are looking at.
    json(res, 503, { error: { code: 'replay_unavailable' }, request_id: ctx.requestId });
    return;
  }
  if (!/^ses_[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(sessionId)) {
    json(res, 404, { error: { code: 'not_found' }, request_id: ctx.requestId });
    return;
  }

  const source = await ctx.deps.writer.replaySession(sessionId);
  // One answer for "no such session" and "pinned to another artifact", the same reason setvars
  // collapses its three cases: distinguishing them lets a token holder probe which sessions exist.
  if (!source || source.artifact_hash !== hash) {
    json(res, 404, { error: { code: 'session_not_found' }, request_id: ctx.requestId });
    return;
  }

  const head = await ctx.deps.artifacts.head(hash);
  const logic = logicFor(head);
  const labels = await labelsFor(ctx, hash, source.language);
  const pii = piiVariableIds(head.manifest.variable_manifest);
  const loadPage = pageFetcher(ctx, hash, source.language);
  // The session's own start time, frozen: every timestamp the replay produces comes from it, so
  // replaying twice yields identical bytes and a diff is always a real change (ADR-006's reason
  // for injecting the clock in the first place).
  const clock = () => source.started_at;
  const runHooks = ctx.deps.scriptHost
    ? makeHookRunner(ctx.deps.scriptHost, ctx.deps.artifacts, head)
    : undefined;
  // Hooks DO run: a page's `onPageSubmit` script writes variables, and skipping it would drop
  // those writes from the replayed state and change every verdict downstream of them. Re-running
  // is safe because the QuickJS host is caged with no egress (E §13) — the same property that
  // makes customer code auditable makes it replayable.
  const renderOpts: RenderDeps = {
    logic,
    manifest: head.manifest,
    escapeContext: 'html_text',
    // The verdicts are the point of the panel; a production session's field trace is a 5% digest
    // sample (E §14.1), so replay asks for the full one explicitly.
    trace: true,
    ...(labels ? { labels } : {}),
  };

  let session = initialReplayState(source, head.manifest.survey_id);
  const entered = step(
    session, { i: 'enter' }, asMachineArtifact(head), machineCtx(session, source.started_at),
  );
  let out = await interpret(entered.cmds, entered.next, loadPage, renderOpts);
  session = out.session;

  const steps: ReplayStep[] = [];
  let disposition: string | null = out.disposition;
  // The page rendered but not yet accounted for. Every iteration pushes it with the input that
  // was submitted against it, so the step the respondent stopped on is pushed after the loop with
  // `unsubmitted` — a replay must never end by silently dropping the last page they saw.
  let pending = out.page ? replayPage(1, out.page, out.debug, pii) : null;

  for (const ev of source.events) {
    if (ev.event_type !== 'page_submit') continue; // resume / invalidation / disposition: context
    if (!pending || disposition !== null) break;

    const body = submitBodyFor(ev, session.current_page_id);
    const outcome = await handleSubmitCore(session, body as SubmitBody, {
      head,
      logic,
      loadPage,
      now: clock,
      ...(runHooks ? { runHooks } : {}),
      // NO persist. This is the structural half of "a replay writes nothing": there is no seam.
    });

    const record = (
      result: ReplayOutcome,
      failures?: readonly { question_id: string; message_key: string }[],
    ): void => {
      steps.push({
        ...pending!,
        submitted: redactValues(ev.values, pii),
        outcome: result,
        ...(failures ? { failures } : {}),
      });
    };

    switch (outcome.kind) {
      case 'advanced': {
        session = outcome.session;
        out = await interpret(outcome.cmds, outcome.session, loadPage, renderOpts);
        session = out.session;
        if (out.disposition) {
          disposition = out.disposition;
          record('final');
          pending = null;
          break;
        }
        record('submitted');
        pending = out.page ? replayPage(ev.seq, out.page, out.debug, pii) : null;
        break;
      }
      case 'final':
        disposition = outcome.disposition;
        session = outcome.session;
        record('final');
        pending = null;
        break;
      case 'validation_failed':
        // The pipeline refused a value the ORIGINAL run accepted. On a pinned artifact that is a
        // real finding — a validation whose verdict depends on something outside seed and inputs
        // — so it is reported with its failures rather than smoothed over, and the replay stops:
        // every later step would be a fiction.
        record('validation_failed', outcome.failures.map(f => ({
          question_id: f.question_id, message_key: f.message_key,
        })));
        pending = null;
        break;
      case 'replay':
        record('replayed');
        pending = null;
        break;
      case 'stale':
        record('stale');
        pending = null;
        break;
      case 'back_refused':
        record('back_refused');
        pending = null;
        break;
    }
  }

  if (pending) steps.push({ ...pending, submitted: null, outcome: 'unsubmitted' });

  log.info('replay_served', {
    request_id: ctx.requestId,
    session_id: source.session_id,
    artifact_hash: hash,
    is_test: source.is_test,
    steps: steps.length,
    disposition,
  });

  json(res, 200, {
    session_id: source.session_id,
    artifact_hash: source.artifact_hash,
    seed: source.random_seed,
    language: source.language,
    is_test: source.is_test,
    steps,
    disposition,
    request_id: ctx.requestId,
  });
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

    // The enhancement bundle. Served from every survey origin (the CSP is script-src 'self',
    // so it MUST come from the page's own origin — ADR-005's isolation applies to our own
    // script too). Immutable-cached: the file only changes with a deploy, which changes the
    // process serving it.
    if (req.method === 'GET' && url.pathname === '/client.js') {
      const bundle = await loadClientBundle();
      if (!bundle) {
        json(res, 404, { error: { code: 'not_found' }, request_id: requestId });
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'content-length': bundle.length,
        'cache-control': 'public, max-age=3600',
        'x-content-type-options': 'nosniff',
      });
      res.end(bundle);
      return;
    }

    // `GET /theme/{hash}.css` — the compiled stylesheet, content-addressed.
    //
    // The hash in the PATH is what makes this immutably cacheable: an artifact's bytes never change
    // (ADR-002), so `immutable` is a statement of fact rather than a hope, and a client that has
    // seen this artifact never asks again. A single `/theme.css` would have to be revalidated on
    // every page of every session, and would serve one survey's theme to another.
    // `theme` and `author` share one route: same caching, same headers, same 404 behaviour, and
    // the only difference is which file is read. Two near-identical handlers would be two places to
    // forget `nosniff`.
    const themeMatch = /^\/(theme|author)\/([0-9a-f]{64})\.css$/.exec(url.pathname);
    if (req.method === 'GET' && themeMatch) {
      const which = themeMatch[1] as string;
      const hash = themeMatch[2] as string;
      // Read through the loader, so a 64-hex path that names no artifact is a 404 rather than a
      // reflected fetch of an arbitrary key.
      const css =
        which === 'theme'
          ? await deps.artifacts.themeCss(hash)
          : await deps.artifacts.authorCss(hash);
      if (css === null) {
        json(res, 404, { error: { code: 'not_found' }, request_id: requestId });
        return;
      }
      const body = Buffer.from(css, 'utf8');
      res.writeHead(200, {
        'content-type': 'text/css; charset=utf-8',
        'content-length': body.length,
        'cache-control': 'public, max-age=31536000, immutable',
        'x-content-type-options': 'nosniff',
      });
      res.end(body);
      return;
    }

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

    // The preview surface rides its own opaque host labels (`prv-…`, security §3.2), not
    // survey-token origins, so it is routed before token-origin validation. Its own gate is
    // the signed preview token, checked per request inside.
    if (url.pathname.startsWith('/preview/')) {
      await handlePreview(res, deps, req, requestId, url);
      return;
    }

    const origin = parseOrigin(req.headers.host, deps.domain);
    if (!origin) {
      json(res, 404, { error: { code: 'not_found' }, request_id: requestId });
      return;
    }

    const prefix = `/s/${origin.token}`;
    const ctx: Ctx = {
      deps, requestId, url, token: origin.token, wantsHtml: wantsHtml(req), basePath: prefix,
    };

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

    json(res, 404, { error: { code: 'not_found' }, request_id: requestId });
  };
}

/** Re-exported so the back-navigation write path in P1-10 has one import site. */
export { invalidateForward };
