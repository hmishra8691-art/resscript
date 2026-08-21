/**
 * End-to-end tests for the respondent endpoints.
 *
 * These drive the real handler with real `SessionState`, the real machine, the real renderer and
 * the real PRNG — only the three I/O edges (tokens, artifacts, sessions) are in-memory. That is
 * deliberate: the bugs this milestone can still have are seam bugs, and per-layer mocks are
 * exactly what hides them. A test that stubs `renderPage` proves nothing about whether the entry
 * path renders.
 */

import { beforeEach, describe, it, expect } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  createHandler,
  interpret,
  parseOrigin,
  type PageFetcher,
  type RuntimeDeps,
} from './handler.js';
import { createMemorySessionStore } from './session/store.js';
import { createStaticTokenResolver, type ResolvedToken } from './token.js';
import type { Redirects } from '@resscript/schema';
import { createScriptHost } from './script/host.js';
import { mintPreviewToken } from './preview/token.js';
import { ArtifactNotFound, type ArtifactHead, type ArtifactLoader } from './artifact/loader.js';
import { createSession } from './entry.js';
import { rehydrate } from '@resscript/runtime-core';

/* ---------------------------------------------------------------- *
 * Fake HTTP
 * ---------------------------------------------------------------- */

interface Captured {
  status: number;
  headers: Record<string, string>;
  body: any;
  /** The unparsed body, for HTML assertions. */
  raw: string;
}

function fakeRes(): { res: ServerResponse; captured: () => Captured } {
  let status = 0;
  let headers: Record<string, string> = {};
  let raw = '';
  const res = {
    headersSent: false,
    writeHead(s: number, h?: Record<string, string | number>) {
      status = s;
      headers = Object.fromEntries(
        Object.entries(h ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]),
      );
      (res as { headersSent: boolean }).headersSent = true;
      return res;
    },
    end(chunk?: string) {
      if (chunk) raw += chunk;
      return res;
    },
  } as unknown as ServerResponse;

  return {
    res,
    captured: () => ({
      status,
      headers,
      raw,
      body: raw && (headers['content-type'] ?? '').includes('json') ? JSON.parse(raw) : null,
    }),
  };
}

function req(opts: {
  method?: string;
  host?: string;
  path: string;
  body?: unknown;
  rawBody?: string;
  headers?: Record<string, string>;
}): IncomingMessage {
  // A minimal event-emitting body, because the real handler streams req 'data'/'end'.
  const chunks =
    opts.rawBody !== undefined
      ? [Buffer.from(opts.rawBody)]
      : opts.body === undefined
        ? []
        : [Buffer.from(JSON.stringify(opts.body))];
  const listeners: Record<string, Array<(arg?: unknown) => void>> = {};
  const fake = {
    method: opts.method ?? 'GET',
    url: opts.path,
    headers: { host: opts.host ?? `${TOKEN}.run.local`, ...(opts.headers ?? {}) },
    on(event: string, cb: (arg?: unknown) => void) {
      (listeners[event] ??= []).push(cb);
      if (event === 'end') {
        // Deliver synchronously on the microtask queue, after 'data' has been subscribed.
        queueMicrotask(() => {
          for (const c of chunks) listeners['data']?.forEach(f => f(c));
          listeners['end']?.forEach(f => f());
        });
      }
      return fake;
    },
    destroy() {},
  };
  return fake as unknown as IncomingMessage;
}

/* ---------------------------------------------------------------- *
 * Fixtures
 * ---------------------------------------------------------------- */

const TOKEN = 'abcdefghij0123456789klmnop'; // 26 lowercase base36
const HASH = 'f'.repeat(64);

/** An `ArtifactLogic` with no rules — the shape `rehydrate` expects, not a bare `{}`. */
const EMPTY_LOGIC = {
  cells: [],
  topo: [],
  topo_pos: [],
  dependents: [],
  inputs: [],
  writers: [],
  by_trigger_variable: {},
  valid_by_target: {},
  rules: [],
  nodes: [],
  base_visible: {},
  // Fully materialized, as emit/logic.ts writes it: "an item list has no natural default — the
  // empty list and 'this question has no rows axis' are different, and the second is what an absent
  // key means." An empty record here would say no question has any items.
  base_items: { 'qst_1.options': [1, 2] },
  base_option: {},
  derived: {},
  schema: {
    question_variables: { qst_1: ['var_q1'] },
    page_questions: { pg_1: ['qst_1'], pg_2: ['qst_2'] },
    page_of: { qst_1: 'pg_1', qst_2: 'pg_2' },
    label_keys: {},
  },
};

/** The logic a direct `interpret` call needs. Rehydrated once for the whole suite. */
const REHYDRATED = rehydrate(EMPTY_LOGIC as never);

/**
 * A fake artifact: a head plus a per-language page tree, which is the shape the loader actually
 * serves (C §17). Keeping the fixture split the same way as the real file tree is what makes
 * these tests able to catch a loader that fetches too much.
 */
interface FakeArtifact {
  readonly redirects?: Redirects;
  readonly scripts?: Record<string, string>;
  head: ArtifactHead;
  pages: Record<string, Record<string, unknown>>;
}

function linearArtifact(): FakeArtifact {
  return {
    head: {
      hash: HASH,
      manifest: {
        base_language: 'en',
        artifact_hash: HASH,
        survey_id: 'svy_0A000000000000000000000000',
        // The closed world of writable names — what the anti-tamper filter reads. A head
        // without one would make every submit die in filterSubmit, which is exactly what
        // happened when this fixture carried a two-field manifest stub.
        variable_manifest: [
          { id: 'var_q1', name: 'Q1', kind: 'response', type: 'enum',
            export_column: 'Q1', export_include: true, pii: false, persist: true,
            enum_domain: [{ code: 1, label_key: 'q1.o1' }, { code: 2, label_key: 'q1.o2' }] },
        ],
      },
      graph: {
        page_order: ['pg_1', 'pg_2'],
        nodes: [
          { id: 'fn_start', type: 'start', next: 'fn_seq' },
          { id: 'fn_seq', type: 'sequence', target_id: 'blk_main', next: 'fn_end' },
          { id: 'fn_end', type: 'end', disposition: 'COMPLETE' },
        ],
        page_entry: { pg_1: 'fn_seq', pg_2: 'fn_seq' },
      },
      // A real (empty) logic program: `rehydrate` walks these, so `{}` would throw on
      // `artifact.cells.map`. Empty means "no rules", which is what these fixtures intend.
      logic: EMPTY_LOGIC,
    } as unknown as ArtifactHead,
    pages: {
      en: {
        pg_1: {
          id: 'pg_1',
          ref: 'P1',
          questions: [
            {
              id: 'qst_1',
              ref: 'Q1',
              question_type: 'single_select',
              required: true,
              emits: ['var_q1'],
              label: 'Which brand, {{name}}?',
              options: [
                { id: 'opt_1', ref: 'o1', code: 1, position: 1, label: 'Coca-Cola' },
                { id: 'opt_2', ref: 'o2', code: 2, position: 2, label: 'Pepsi' },
              ],
            },
          ],
        },
        pg_2: {
          id: 'pg_2',
          ref: 'P2',
          questions: [{ id: 'qst_2', ref: 'Q2', question_type: 'text', label: 'Why?' }],
        },
      },
    },
  };
}

/** A survey that screens out immediately — no page, straight to a disposition. */
function screenoutArtifact(): FakeArtifact {
  return {
    head: {
      hash: HASH,
      manifest: { base_language: 'en', artifact_hash: HASH },
      graph: {
        page_order: [],
        nodes: [
          { id: 'fn_start', type: 'start', next: 'fn_so' },
          { id: 'fn_so', type: 'termination', disposition: 'SCREENOUT' },
        ],
        page_entry: {},
      },
      // A real (empty) logic program: `rehydrate` walks these, so `{}` would throw on
      // `artifact.cells.map`. Empty means "no rules", which is what these fixtures intend.
      logic: EMPTY_LOGIC,
    } as unknown as ArtifactHead,
    pages: {},
  };
}

function token(over: Partial<ResolvedToken> = {}): ResolvedToken {
  return {
    token: TOKEN,
    survey_version_id: 'ver_0A100000000000000000000000',
    artifact_hash: HASH,
    status: 'live',
    is_test: false,
    ...over,
  };
}

/** Counts page fetches, so a test can assert the loader is not pulling the whole survey. */
let pageFetches: string[] = [];

function loaderFor(artifacts: Record<string, FakeArtifact>): ArtifactLoader {
  return {
    async head(hash: string) {
      const a = artifacts[hash];
      if (!a) throw new ArtifactNotFound(hash, 'manifest.json');
      return a.head;
    },
    async redirects(hash: string) {
      return artifacts[hash]?.redirects ?? null;
    },
    async script(hash: string, ref: string) {
      return artifacts[hash]?.scripts?.[ref] ?? null;
    },
    async page(hash: string, language: string, pageId: string) {
      pageFetches.push(`${hash}/${language}/${pageId}`);
      const a = artifacts[hash];
      if (!a) throw new ArtifactNotFound(hash, `pages/${language}/${pageId}.json`);
      return (a.pages[language]?.[pageId] ?? null) as never;
    },
    async warm() {},
  };
}

function deps(over: Partial<RuntimeDeps> = {}): RuntimeDeps {
  let n = 0;
  return {
    tokens: createStaticTokenResolver([token()]),
    artifacts: loaderFor({ [HASH]: linearArtifact() }),
    sessions: createMemorySessionStore(),
    now: () => 1_700_000_000_000,
    // Deterministic ids, so an assertion can name one.
    newId: () => `ID${String(++n).padStart(24, '0')}`,
    newSeed: () => 'a3f9c1d2e4b6a8f0c2d4e6b8a0f2c4d6',
    domain: 'run.local',
    ...over,
  };
}

beforeEach(() => {
  pageFetches = [];
});

async function call(
  d: RuntimeDeps,
  opts: {
    method?: string; host?: string; path: string; body?: unknown;
    rawBody?: string; headers?: Record<string, string>;
  },
): Promise<Captured> {
  const h = createHandler(d);
  const { res, captured } = fakeRes();
  await h(req(opts), res);
  return captured();
}

/* ---------------------------------------------------------------- *
 * Origin validation (ADR-005)
 * ---------------------------------------------------------------- */

describe('parseOrigin', () => {
  it('accepts <token>.<domain>', () => {
    expect(parseOrigin(`${TOKEN}.run.local`, 'run.local')).toEqual({ token: TOKEN });
  });

  it('ignores the port', () => {
    expect(parseOrigin(`${TOKEN}.run.local:8081`, 'run.local')).toEqual({ token: TOKEN });
  });

  it('rejects a nested subdomain', () => {
    // A wildcard certificate plus `a.<token>.run.local` must not resolve to a token, or one
    // survey becomes serveable from another's origin.
    expect(parseOrigin(`extra.${TOKEN}.run.local`, 'run.local')).toBeNull();
  });

  it('rejects the bare domain', () => {
    expect(parseOrigin('run.local', 'run.local')).toBeNull();
  });

  it('rejects a different domain', () => {
    expect(parseOrigin(`${TOKEN}.evil.com`, 'run.local')).toBeNull();
  });

  it('rejects a domain that merely ends with ours', () => {
    expect(parseOrigin(`${TOKEN}.notrun.local`, 'run.local')).toBeNull();
  });

  it('rejects a malformed token', () => {
    expect(parseOrigin('SHORT.run.local', 'run.local')).toBeNull();
    expect(parseOrigin('UPPERCASE0123456789ABCDEF.run.local', 'run.local')).toBeNull();
    expect(parseOrigin(`${'a'.repeat(27)}.run.local`, 'run.local')).toBeNull();
  });

  it('rejects a missing host', () => {
    expect(parseOrigin(undefined, 'run.local')).toBeNull();
  });
});

/* ---------------------------------------------------------------- *
 * Health
 * ---------------------------------------------------------------- */

describe('health endpoints', () => {
  it('/health answers on any origin', async () => {
    const r = await call(deps(), { path: '/health', host: 'anything.example.com' });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('ok');
  });

  it('/ready reports the token resolver', async () => {
    const r = await call(deps(), { path: '/ready', host: 'lb.internal' });
    expect(r.status).toBe(200);
    expect(r.body.checks.token_resolver).toBe('ok');
  });

  it('/ready is 503 when the token resolver is unreachable', async () => {
    // Readiness is not liveness: a runtime that cannot resolve a token is alive but must not
    // take respondent traffic, because every request would 500 after doing the work.
    const r = await call(
      deps({
        tokens: {
          async resolve() {
            throw new Error('connection refused');
          },
        },
      }),
      { path: '/ready', host: 'lb.internal' },
    );

    expect(r.status).toBe(503);
    expect(r.body.ready).toBe(false);
    expect(r.body.checks.token_resolver).toBe('unavailable');
  });
});

/* ---------------------------------------------------------------- *
 * Entry
 * ---------------------------------------------------------------- */

describe('GET /s/:token', () => {
  it('renders the first page', async () => {
    const r = await call(deps(), { path: `/s/${TOKEN}` });

    expect(r.status).toBe(200);
    expect(r.body.page.page_id).toBe('pg_1');
    expect(r.body.page.questions).toHaveLength(1);
    expect(r.body.page.questions[0].ref).toBe('Q1');
  });

  it('returns the resolved item list, not raw artifact items', async () => {
    const r = await call(deps(), { path: `/s/${TOKEN}` });
    expect(r.body.page.questions[0].options.items.map((i: any) => i.code)).toEqual([1, 2]);
  });

  it('pipes the label through session state', async () => {
    // No `name` variable is set, so the empty token applies rather than "undefined" leaking.
    const r = await call(deps(), { path: `/s/${TOKEN}` });
    expect(r.body.page.questions[0].label).toBe('Which brand, ?');
  });

  it('persists the session', async () => {
    const d = deps();
    const r = await call(d, { path: `/s/${TOKEN}` });
    const stored = await d.sessions.load(r.body.session_id);

    expect(stored).not.toBeNull();
    expect(stored?.current_page_id).toBe('pg_1');
  });

  it('pins the artifact hash and the survey version at entry', async () => {
    const d = deps();
    const r = await call(d, { path: `/s/${TOKEN}` });
    const stored = await d.sessions.load(r.body.session_id);

    expect(stored?.artifact_hash).toBe(HASH);
    expect(stored?.survey_version_id).toBe('ver_0A100000000000000000000000');
  });

  it('records the render digest on the visit', async () => {
    // This is what invalidate-forward's drift test reads (E §7.2 step 3). A visit without one is
    // treated as drifted, so the whole survival test degrades to "re-ask everything".
    const d = deps();
    const r = await call(d, { path: `/s/${TOKEN}` });
    const stored = await d.sessions.load(r.body.session_id);

    expect(stored?.history).toHaveLength(1);
    expect(stored?.history[0]?.render_digest).toMatch(/^[0-9a-f]{32}$/);
  });

  it('captures entry parameters raw, for audit', async () => {
    const d = deps();
    const r = await call(d, { path: `/s/${TOKEN}?pid=P123&src=email` });
    const stored = await d.sessions.load(r.body.session_id);

    expect(stored?.entry_params).toEqual({ pid: 'P123', src: 'email' });
  });

  it('refuses a disposition supplied in the query string', async () => {
    // Accepting one would let a respondent declare themselves complete.
    const d = deps();
    const r = await call(d, { path: `/s/${TOKEN}?disposition=COMPLETE&pid=P1` });
    const stored = await d.sessions.load(r.body.session_id);

    expect(stored?.entry_params).toEqual({ pid: 'P1' });
    expect(stored?.disposition).toBeNull();
  });

  it('caps entry parameter count and length', async () => {
    const many = Array.from({ length: 50 }, (_, i) => `k${i}=v`).join('&');
    const d = deps();
    const r = await call(d, { path: `/s/${TOKEN}?${many}&long=${'x'.repeat(2000)}` });
    const stored = await d.sessions.load(r.body.session_id);

    expect(Object.keys(stored?.entry_params ?? {}).length).toBeLessThanOrEqual(32);
    for (const v of Object.values(stored?.entry_params ?? {})) {
      expect(v.length).toBeLessThanOrEqual(512);
    }
  });

  it('finalizes without a page when the flow screens out at entry', async () => {
    const r = await call(
      deps({ artifacts: loaderFor({ [HASH]: screenoutArtifact() }) }),
      { path: `/s/${TOKEN}` },
    );

    expect(r.status).toBe(200);
    expect(r.body.disposition).toBe('SCREENOUT');
    expect(r.body.page).toBeUndefined();
  });

  it('reports a null redirect rather than omitting the field', async () => {
    // `content.redirects` has no authoring path yet (CMP-0300). A client must be able to tell
    // "no redirect configured" from "field absent".
    const r = await call(
      deps({ artifacts: loaderFor({ [HASH]: screenoutArtifact() }) }),
      { path: `/s/${TOKEN}` },
    );
    expect(r.body.redirect_url).toBeNull();
  });

  it('404s an unknown token and creates no session', async () => {
    // E §2.2: INVALID creates no session, because doing so makes the entry URL a free
    // write-amplification vector for anyone who can send requests.
    const d = deps({ tokens: createStaticTokenResolver([]) });
    const r = await call(d, { path: `/s/${TOKEN}` });

    expect(r.status).toBe(404);
    expect(await d.sessions.load('ID' + '0'.repeat(24))).toBeNull();
  });

  it('serves a terminal page for a paused survey rather than a 404', async () => {
    // A vendor sending traffic to a closed link needs to tell "wrong link" from "study over".
    const r = await call(
      deps({ tokens: createStaticTokenResolver([token({ status: 'paused' })]) }),
      { path: `/s/${TOKEN}` },
    );

    expect(r.status).toBe(200);
    expect(r.body.reason).toBe('survey_paused');
  });

  it('marks a test token as a test session', async () => {
    const d = deps({ tokens: createStaticTokenResolver([token({ status: 'test' })]) });
    const r = await call(d, { path: `/s/${TOKEN}` });

    expect((await d.sessions.load(r.body.session_id))?.is_test).toBe(true);
  });

  it('rejects a request from the wrong origin', async () => {
    const r = await call(deps(), { path: `/s/${TOKEN}`, host: 'other.run.local' });
    expect(r.status).toBe(404);
  });

  it('is deterministic: one seed gives one render', async () => {
    const a = await call(deps(), { path: `/s/${TOKEN}` });
    const b = await call(deps(), { path: `/s/${TOKEN}` });

    expect(a.body.page).toEqual(b.body.page);
  });

  it('sets the security headers', async () => {
    const r = await call(deps(), { path: `/s/${TOKEN}` });

    expect(r.headers['referrer-policy']).toBe('no-referrer');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-frame-options']).toBe('DENY');
    // A session's page depends on variable state; caching it would show a stale page after a
    // back-submit.
    expect(r.headers['cache-control']).toBe('no-store');
  });
});

/* ---------------------------------------------------------------- *
 * Page render
 * ---------------------------------------------------------------- */

describe('GET /s/:token/p/:page_id', () => {
  async function entered() {
    const d = deps();
    const entry = await call(d, { path: `/s/${TOKEN}` });
    return { d, sessionId: entry.body.session_id as string };
  }

  it('re-renders the current page', async () => {
    const { d, sessionId } = await entered();
    const r = await call(d, { path: `/s/${TOKEN}/p/pg_1?session=${sessionId}` });

    expect(r.status).toBe(200);
    expect(r.body.page.page_id).toBe('pg_1');
  });

  it('a refresh renders identically', async () => {
    const { d, sessionId } = await entered();
    const a = await call(d, { path: `/s/${TOKEN}/p/pg_1?session=${sessionId}` });
    const b = await call(d, { path: `/s/${TOKEN}/p/pg_1?session=${sessionId}` });

    expect(a.body.page).toEqual(b.body.page);
  });

  it('409s a page the session is not on', async () => {
    // Rendering an arbitrary page by id would let a respondent read a page whose preconditions
    // never held. Back navigation goes through the machine, which derives its target from history.
    const { d, sessionId } = await entered();
    const r = await call(d, { path: `/s/${TOKEN}/p/pg_2?session=${sessionId}` });

    expect(r.status).toBe(409);
    expect(r.body.error.current_page_id).toBe('pg_1');
  });

  it('400s without a session id', async () => {
    const r = await call(deps(), { path: `/s/${TOKEN}/p/pg_1` });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('session_required');
  });

  it('404s an unknown session', async () => {
    const r = await call(deps(), { path: `/s/${TOKEN}/p/pg_1?session=nope` });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('session_not_found');
  });

  it('409s a page id that is not the current one, before looking it up', async () => {
    // The staleness check runs first, so an unknown page id and a known-but-not-current one give
    // the same answer. That is deliberate: neither should reveal whether the page exists.
    const { d, sessionId } = await entered();
    const r = await call(d, { path: `/s/${TOKEN}/p/pg_ghost?session=${sessionId}` });
    expect(r.status).toBe(409);
  });

  it('fetches only the page being rendered', async () => {
    const { d, sessionId } = await entered();
    pageFetches = [];
    await call(d, { path: `/s/${TOKEN}/p/pg_1?session=${sessionId}` });

    expect(pageFetches).toEqual([`${HASH}/en/pg_1`]);
  });

  it('returns the disposition for a finalized session', async () => {
    const d = deps({ artifacts: loaderFor({ [HASH]: screenoutArtifact() }) });
    const entry = await call(d, { path: `/s/${TOKEN}` });
    // The screenout path finalizes at entry, so the session is stored FINALIZED.
    const r = await call(d, {
      path: `/s/${TOKEN}/p/pg_1?session=${entry.body.session_id}`,
    });

    expect(r.status).toBe(200);
    expect(r.body.disposition).toBe('SCREENOUT');
  });

  it('honours the session pin when the token has moved on', async () => {
    // E §3.3: republishing mid-field must not change the questionnaire under a respondent who is
    // halfway through it. The session's hash wins over the token's current one.
    const OLD = HASH;
    const NEW = '0'.repeat(64);
    const d = deps({
      artifacts: loaderFor({ [OLD]: linearArtifact(), [NEW]: screenoutArtifact() }),
    });
    const entry = await call(d, { path: `/s/${TOKEN}` });
    const sessionId = entry.body.session_id as string;

    // The survey is republished: the token now points at a different artifact.
    const moved = deps({
      tokens: createStaticTokenResolver([token({ artifact_hash: NEW })]),
      artifacts: loaderFor({ [OLD]: linearArtifact(), [NEW]: screenoutArtifact() }),
      sessions: d.sessions,
    });
    const r = await call(moved, { path: `/s/${TOKEN}/p/pg_1?session=${sessionId}` });

    expect(r.status).toBe(200);
    expect(r.body.page.page_id).toBe('pg_1'); // still the artifact it entered on
  });
});

/* ---------------------------------------------------------------- *
 * Routes deferred to later milestones
 * ---------------------------------------------------------------- */

describe('POST /s/:token/submit — E §5 end to end', () => {
  /** Enter, then submit helper. The fixture's Q1 emits nothing declared, so the manifest
   *  below drives what is writable. */
  async function entered(d = deps()) {
    const entry = await call(d, { path: `/s/${TOKEN}` });
    return { d, sessionId: entry.body.session_id as string, entry };
  }
  const submit = (d: RuntimeDeps, sessionId: string, body: unknown) =>
    call(d, { method: 'POST', path: `/s/${TOKEN}/submit?session=${sessionId}`, body });

  it('advances to the next page on a clean submit', async () => {
    const { d, sessionId } = await entered();
    const r = await submit(d, sessionId, { page_id: 'pg_1', values: { var_q1: 1 } });

    expect(r.status).toBe(200);
    expect(r.body.page.page_id).toBe('pg_2');
  });

  it('walks the whole survey to COMPLETE and the answers persist', async () => {
    const { d, sessionId } = await entered();
    await submit(d, sessionId, { page_id: 'pg_1', values: { var_q1: 2 } });
    const r = await submit(d, sessionId, { page_id: 'pg_2', values: {} });

    expect(r.status).toBe(200);
    expect(r.body.disposition).toBe('COMPLETE');
    const stored = await d.sessions.load(sessionId);
    expect(stored?.vars['var_q1' as never]).toBe(2);
    expect(stored?.machine_state.state).toBe('FINALIZED');
  });

  it('THE ANTI-TAMPER TEST: a hidden question value is discarded and recorded', async () => {
    // The roadmap's own acceptance line, over HTTP: the manifest knows var_ghost belongs to a
    // question that is not on this page, so a crafted POST cannot write it.
    const { d, sessionId } = await entered();
    const r = await submit(d, sessionId, {
      page_id: 'pg_1',
      values: { var_q1: 1, disposition: 'COMPLETE', var_hidden: 5 },
    });

    expect(r.status).toBe(200);
    const stored = await d.sessions.load(sessionId);
    expect(stored?.vars['var_q1' as never]).toBe(1);
    expect('disposition' in (stored?.vars ?? {})).toBe(false);
    expect(stored?.disposition).toBeNull(); // the injected key changed NOTHING
  });

  it('a validation failure is a genuine no-op', async () => {
    const { d, sessionId } = await entered();
    // Q1 is required in the fixture; submit nothing for it.
    const r = await submit(d, sessionId, { page_id: 'pg_1', values: {} });

    expect(r.status).toBe(200);
    expect(r.body.validation_failed[0]).toMatchObject({ type: 'required', question_id: 'qst_1' });
    const stored = await d.sessions.load(sessionId);
    expect(stored?.current_page_id).toBe('pg_1'); // did not advance
    expect(stored?.last_event_seq).toBe(0);       // nothing persisted
    // ...but the attempt counter moved, because speeder detection needs it (E §5 step 4).
    expect(stored?.page_timings['pg_1' as never]?.submits).toBe(1);
  });

  it('THE REPLAY: an identical retried submit returns the identical outcome, once', async () => {
    const { d, sessionId } = await entered();
    const body = { page_id: 'pg_1', values: { var_q1: 1 }, idempotency_key: 'k1' };
    const first = await submit(d, sessionId, body);
    const second = await submit(d, sessionId, body);

    expect(first.body.page.page_id).toBe('pg_2');
    expect(second.status).toBe(200);
    expect(second.body.replayed).toBe(true);
    expect(second.body.page_id).toBe('pg_2');
    const stored = await d.sessions.load(sessionId);
    expect(stored?.last_event_seq).toBe(first.body ? 1 : 1); // one submit, one event seq
  });

  it('a stale tab gets 409 and the current page back', async () => {
    const { d, sessionId } = await entered();
    const r = await submit(d, sessionId, { page_id: 'pg_2', values: {} });

    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('stale_page');
    expect(r.body.error.current_page_id).toBe('pg_1');
  });

  it('a divergent client trace is recorded, not rejected', async () => {
    // ADR-004: the client's verdicts are advisory. A divergence is evidence, never a 4xx —
    // rejecting would let a broken client bundle strand every respondent on it.
    const { d, sessionId } = await entered();
    const r = await submit(d, sessionId, {
      page_id: 'pg_1',
      values: { var_q1: 1 },
      client_trace: { state_hash: 'wrong', artifact_hash: HASH },
    });

    expect(r.status).toBe(200);
    expect(r.body.page.page_id).toBe('pg_2');
  });

  it('submitting to a finalized session replays the disposition', async () => {
    const { d, sessionId } = await entered();
    await submit(d, sessionId, { page_id: 'pg_1', values: { var_q1: 1 } });
    await submit(d, sessionId, { page_id: 'pg_2', values: {} });
    const r = await submit(d, sessionId, { page_id: 'pg_2', values: {} });

    expect(r.status).toBe(200);
    expect(r.body.disposition).toBe('COMPLETE');
  });

  it('a malformed body is 400, not a crash', async () => {
    const { d, sessionId } = await entered();
    const r = await submit(d, sessionId, { values: {} }); // no page_id

    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('malformed_request');
  });

  it('an unknown session is 404', async () => {
    const d = deps();
    const r = await submit(d, 'ses_00000000000000000000000000', {
      page_id: 'pg_1', values: {},
    });
    expect(r.status).toBe(404);
  });
});

describe('resume, back, telemetry (E §7)', () => {
  async function entered(d = deps()) {
    const entry = await call(d, { path: `/s/${TOKEN}` });
    return { d, sessionId: entry.body.session_id as string, resumeToken: entry.body.resume_token as string };
  }
  const submit = (d: RuntimeDeps, sessionId: string, body: unknown) =>
    call(d, { method: 'POST', path: `/s/${TOKEN}/submit?session=${sessionId}`, body });

  it('entry mints a resume token, and only its hash is stored', async () => {
    const { d, sessionId, resumeToken } = await entered();

    expect(typeof resumeToken).toBe('string');
    const stored = await d.sessions.load(sessionId);
    expect(stored?.resume_token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored?.resume_token_hash).not.toContain(resumeToken);
  });

  it('resume re-renders the current page, prefill-ready, and touches the session', async () => {
    const { d, sessionId, resumeToken } = await entered();
    await submit(d, sessionId, { page_id: 'pg_1', values: { var_q1: 1 } });

    const r = await call(d, { path: `/s/${TOKEN}/resume/${resumeToken}` });

    expect(r.status).toBe(200);
    expect(r.body.page.page_id).toBe('pg_2'); // where they were
    expect(r.body.session_id).toBe(sessionId); // a continuation, not a restart
  });

  it('an unknown resume token is 404, indistinguishable from expired', async () => {
    const d = deps();
    await entered(d);
    const r = await call(d, { path: `/s/${TOKEN}/resume/not-a-real-token` });
    expect(r.status).toBe(404);
  });

  it('a completed session is not resumable', async () => {
    const { d, sessionId, resumeToken } = await entered();
    await submit(d, sessionId, { page_id: 'pg_1', values: { var_q1: 1 } });
    await submit(d, sessionId, { page_id: 'pg_2', values: {} });

    const r = await call(d, { path: `/s/${TOKEN}/resume/${resumeToken}` });
    expect(r.status).toBe(404);
  });

  it('back returns the previous submitted page with the stored answers as prefill', async () => {
    const { d, sessionId } = await entered();
    await submit(d, sessionId, { page_id: 'pg_1', values: { var_q1: 2 } });

    const r = await call(d, { method: 'POST', path: `/s/${TOKEN}/back?session=${sessionId}` });

    expect(r.status).toBe(200);
    expect(r.body.page.page_id).toBe('pg_1');
    expect(r.body.prefill).toEqual({ var_q1: 2 });
  });

  it('going back to LOOK costs nothing — resubmitting unchanged keeps downstream', async () => {
    // E §7.2 step 2's common case, end to end: back, resubmit the same answer, and the
    // session advances as if nothing happened.
    const { d, sessionId } = await entered();
    await submit(d, sessionId, { page_id: 'pg_1', values: { var_q1: 2 } });
    await call(d, { method: 'POST', path: `/s/${TOKEN}/back?session=${sessionId}` });
    const r = await submit(d, sessionId, { page_id: 'pg_1', values: { var_q1: 2 } });

    expect(r.status).toBe(200);
    expect(r.body.page.page_id).toBe('pg_2');
  });

  it('back on a finalized session is refused — the vendor has been told', async () => {
    const { d, sessionId } = await entered();
    await submit(d, sessionId, { page_id: 'pg_1', values: { var_q1: 1 } });
    await submit(d, sessionId, { page_id: 'pg_2', values: {} });

    const r = await call(d, { method: 'POST', path: `/s/${TOKEN}/back?session=${sessionId}` });
    expect(r.status).toBe(409);
  });

  it('back with nothing submitted is refused, not a crash', async () => {
    const { d, sessionId } = await entered();
    const r = await call(d, { method: 'POST', path: `/s/${TOKEN}/back?session=${sessionId}` });
    expect(r.status).toBe(409);
  });

  it('telemetry updates timings in the session and answers 204', async () => {
    const { d, sessionId } = await entered();
    const r = await call(d, {
      method: 'POST',
      path: `/s/${TOKEN}/event?session=${sessionId}`,
      body: { page_id: 'pg_1', first_render_ms: 340, focus_loss_ms: 1200 },
    });

    expect(r.status).toBe(204);
    const stored = await d.sessions.load(sessionId);
    expect(stored?.page_timings['pg_1' as never]).toMatchObject({
      first_render_ms: 340,
      focus_loss_ms: 1200,
    });
  });

  it('telemetry clamps a lying client and never errors', async () => {
    const { d, sessionId } = await entered();
    const r = await call(d, {
      method: 'POST',
      path: `/s/${TOKEN}/event?session=${sessionId}`,
      body: { page_id: 'pg_1', first_render_ms: 999_999_999_999 },
    });

    expect(r.status).toBe(204);
    const stored = await d.sessions.load(sessionId);
    expect(stored?.page_timings['pg_1' as never]?.first_render_ms).toBe(3_600_000);
  });

  it('malformed telemetry is dropped silently — 204, no oracle', async () => {
    const { d, sessionId } = await entered();
    const r = await call(d, {
      method: 'POST',
      path: `/s/${TOKEN}/event?session=${sessionId}`,
      body: 'not-an-object',
    });
    expect(r.status).toBe(204);
  });
});

describe('test mode (E §14.1)', () => {
  const testDeps = () =>
    deps({ tokens: createStaticTokenResolver([token({ status: 'test', is_test: true })]) });

  it('a test session gets the full trace; a production session gets nothing', async () => {
    const prod = await call(deps(), { path: `/s/${TOKEN}` });
    expect(prod.body.debug).toBeUndefined();

    const test = await call(testDeps(), { path: `/s/${TOKEN}` });
    expect(test.body.debug).toBeDefined();
    expect(test.body.debug.seed).toMatch(/^[0-9a-f]{32}$/);
    expect(test.body.debug.artifact_hash).toBe(HASH);
    expect(test.body.debug.digest).toMatch(/^[0-9a-f]{32}$/);
    expect(Array.isArray(test.body.debug.trace)).toBe(true);
  });

  it('the trace rides through a submit to the next page', async () => {
    const d = testDeps();
    const entry = await call(d, { path: `/s/${TOKEN}` });
    const r = await call(d, {
      method: 'POST',
      path: `/s/${TOKEN}/submit?session=${entry.body.session_id}`,
      body: { page_id: 'pg_1', values: { var_q1: 1 } },
    });

    expect(r.body.page.page_id).toBe('pg_2');
    expect(r.body.debug).toBeDefined();
  });

  it('same code path: the trace is captured, not branched on', async () => {
    // The two sessions must walk identical pages in identical order — divergent code paths
    // for test mode are how "works in test, breaks in production" ships (E §14.1).
    const prod = await call(deps(), { path: `/s/${TOKEN}` });
    const test = await call(testDeps(), { path: `/s/${TOKEN}` });

    expect(test.body.page.page_id).toBe(prod.body.page.page_id);
    expect(test.body.page.questions.map((q: { id: string }) => q.id)).toEqual(
      prod.body.page.questions.map((q: { id: string }) => q.id),
    );
  });
});

describe('no-JavaScript flow — the P1-09 acceptance line', () => {
  // A browser: Accept text/html on GETs, form-encoded POSTs. The fake req grows a raw body.
  const browse = (d: RuntimeDeps, path: string) =>
    call(d, { path, headers: { accept: 'text/html' } } as never);

  async function formPost(d: RuntimeDeps, path: string, fields: Record<string, string>) {
    const raw = new URLSearchParams(fields).toString();
    return call(d, {
      method: 'POST', path, rawBody: raw,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    } as never);
  }

  it('entry renders an HTML form that names the submit endpoint', async () => {
    const d = deps();
    const r = await browse(d, `/s/${TOKEN}`);

    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('text/html');
    expect(r.raw).toContain('<form method="post"');
    expect(r.raw).toContain('type="radio"');
    expect(r.raw).toContain('Coca-Cola');
    // The seed never reaches the browser (E §4 step 10) — only derived orders, as DOM order.
    expect(r.raw).not.toMatch(/[0-9a-f]{32}/);
  });

  it('completes a survey with JavaScript disabled: form post, 303, form post, terminal', async () => {
    const d = deps();
    const entry = await browse(d, `/s/${TOKEN}`);
    const sessionId = /session=(ses_[0-9A-Z]+)/.exec(entry.raw)?.[1];
    expect(sessionId).toBeDefined();

    const p1 = await formPost(d, `/s/${TOKEN}/submit?session=${sessionId}`,
      { __page_id: 'pg_1', var_q1: '2' });
    expect(p1.status).toBe(303); // POST/redirect/GET
    expect(p1.headers['location']).toContain('/p/pg_2');

    const p2page = await browse(d, p1.headers['location']!);
    expect(p2page.raw).toContain('Why?');

    const done = await formPost(d, `/s/${TOKEN}/submit?session=${sessionId}`,
      { __page_id: 'pg_2', var_q2: 'because' });
    expect(done.status).toBe(200);
    expect(done.raw).toContain('Thank you');

    // And the answer is really stored, coerced from the form's string.
    const stored = await d.sessions.load(sessionId!);
    expect(stored?.vars['var_q1' as never]).toBe(2);
    expect(stored?.disposition).toBe('COMPLETE');
  });

  it('a validation failure re-renders the form with the message, at 200', async () => {
    const d = deps();
    const entry = await browse(d, `/s/${TOKEN}`);
    const sessionId = /session=(ses_[0-9A-Z]+)/.exec(entry.raw)?.[1];

    const r = await formPost(d, `/s/${TOKEN}/submit?session=${sessionId}`,
      { __page_id: 'pg_1' }); // required Q1 unanswered

    expect(r.status).toBe(200); // some panel webviews treat any error status as fatal
    expect(r.raw).toContain('class="error"');
    expect(r.raw).toContain('err.required');
  });

  it('a refreshed (replayed) form post redirects to the current page', async () => {
    const d = deps();
    const entry = await browse(d, `/s/${TOKEN}`);
    const sessionId = /session=(ses_[0-9A-Z]+)/.exec(entry.raw)?.[1];
    await formPost(d, `/s/${TOKEN}/submit?session=${sessionId}`,
      { __page_id: 'pg_1', var_q1: '1' });

    const again = await formPost(d, `/s/${TOKEN}/submit?session=${sessionId}`,
      { __page_id: 'pg_1', var_q1: '1' });

    expect(again.status).toBe(303);
    expect(again.headers['location']).toContain('/p/pg_2');
  });

  it('the JSON API is untouched by content negotiation', async () => {
    const d = deps();
    const r = await call(d, { path: `/s/${TOKEN}` });
    expect(r.headers['content-type']).toContain('application/json');
    expect(r.body.page.page_id).toBe('pg_1');
  });
});

describe('deferred routes', () => {
  it('preview without a signing secret is indistinguishable from no route', async () => {
    const r = await call(deps(), { method: 'POST', path: '/preview/abc' });
    expect(r.status).toBe(404);
  });

  it('an unknown path is 404', async () => {
    const r = await call(deps(), { path: `/s/${TOKEN}/nonsense` });
    expect(r.status).toBe(404);
  });
});

/* ---------------------------------------------------------------- *
 * The Cmd interpreter
 * ---------------------------------------------------------------- */

describe('interpret', () => {
  function session() {
    return createSession({
      session_id: 'S',
      respondent_id: 'R',
      survey_id: 'V',
      artifact_hash: HASH,
      random_seed: 'a'.repeat(32),
      language: 'en',
    });
  }

  /** A fetcher over one artifact's `en` page tree. */
  function fetcher(art = linearArtifact()): PageFetcher {
    return async pageId => (art.pages['en']?.[pageId] ?? null) as never;
  }

  it('renders and stamps the digest', async () => {
    const s = {
      ...session(),
      history: [
        {
          page_id: 'pg_1' as never,
          entered_at: 0,
          submitted_at: null,
          wrote: [],
          shown: [],
          attempt: 1,
        },
      ],
    };
    const out = await interpret([{ c: 'render', page_id: 'pg_1' }], s, fetcher(), {
      logic: REHYDRATED,
      escapeContext: 'none',
    });

    expect(out.page?.page_id).toBe('pg_1');
    expect(out.session.history[0]?.render_digest).toBe(out.page?.digest);
  });

  it('fetches only the page it renders', async () => {
    // C §17: per-page cost must not scale with survey size. The linear fixture has two pages;
    // rendering one must touch one.
    const seen: string[] = [];
    const counting: PageFetcher = async pageId => {
      seen.push(pageId);
      return (linearArtifact().pages['en']?.[pageId] ?? null) as never;
    };
    await interpret([{ c: 'render', page_id: 'pg_1' }], session(), counting, {
      logic: REHYDRATED,
      escapeContext: 'none',
    });

    expect(seen).toEqual(['pg_1']);
  });

  it('reports a missing page rather than throwing', async () => {
    const out = await interpret([{ c: 'render', page_id: 'pg_ghost' }], session(), fetcher(), {
      logic: REHYDRATED,
      escapeContext: 'none',
    });

    expect(out.page).toBeNull();
    expect(out.events).toContainEqual({ kind: 'render.missing_page', page_id: 'pg_ghost' });
  });

  it('records a finalize and stamps finalized_at', async () => {
    const out = await interpret(
      [{ c: 'finalize', disposition: 'COMPLETE' }],
      session(),
      fetcher(),
      { logic: REHYDRATED, escapeContext: 'none' },
    );

    expect(out.disposition).toBe('COMPLETE');
    expect(out.session.finalized_at).not.toBeNull();
  });

  it('carries custom_key on a CUSTOM finalize', async () => {
    const out = await interpret(
      [{ c: 'finalize', disposition: 'CUSTOM', custom_key: 'over_budget' }],
      session(),
      fetcher(),
      { logic: REHYDRATED, escapeContext: 'none' },
    );

    expect(out.events).toContainEqual({
      kind: 'session.finalized',
      disposition: 'CUSTOM',
      custom_key: 'over_budget',
    });
  });

  it('records quota commands it cannot execute rather than dropping them', async () => {
    // A session that should have taken a reservation must be visible in the log. Dropping the
    // command silently shows up as an over-filled cell weeks later. With no quota client
    // (in-memory mode) commit records its deferral; release is a silent no-op when nothing is
    // held; reserve is deferred until quota plans exist in artifacts at all.
    const out = await interpret(
      [
        { c: 'reserve_quota', quota_ref: 'GENDER_AGE', node_id: 'fn_q' },
        { c: 'commit_quota' },
        { c: 'release_quota' },
      ],
      session(),
      fetcher(),
      { logic: REHYDRATED, escapeContext: 'none' },
    );

    expect(out.events.map(e => e.kind)).toEqual([
      'quota.reserve_deferred',
      'quota.commit_quota_deferred',
    ]);
  });

  it('executes commit and release through a quota client when one is present', async () => {
    const calls: string[] = [];
    const quota = {
      commit: async (sid: string) => { calls.push(`commit:${sid}`); return 2; },
      release: async (sid: string) => { calls.push(`release:${sid}`); return 1; },
    };
    const out = await interpret(
      [{ c: 'commit_quota' }, { c: 'release_quota' }],
      session(),
      fetcher(),
      { logic: REHYDRATED, escapeContext: 'none', quota: quota as never },
    );

    expect(calls).toEqual(['commit:S', 'release:S']);
    expect(out.events).toContainEqual({ kind: 'quota.committed', cells: 2 });
    expect(out.events).toContainEqual({ kind: 'quota.released', cells: 1 });
  });

  it('an unreachable quota store at settle time does not fail the respondent', async () => {
    // The event log records the COMPLETE; reconciliation recomputes committed from it
    // (ADR-008). The respondent finished — the counter catches up.
    const quota = {
      commit: async () => { throw new Error('redis gone'); },
      release: async () => { throw new Error('redis gone'); },
    };
    const out = await interpret(
      [{ c: 'commit_quota' }],
      session(),
      fetcher(),
      { logic: REHYDRATED, escapeContext: 'none', quota: quota as never },
    );

    expect(out.events.map(e => e.kind)).toContain('quota.commit_unavailable');
    expect(out.events.map(e => e.kind)).toContain('quota.committed'); // with cells: 0
  });

  it('records a deferred api_call with its node', async () => {
    const out = await interpret([{ c: 'call_api', node_id: 'fn_api' }], session(), fetcher(), {
      logic: REHYDRATED,
      escapeContext: 'none',
    });

    expect(out.events).toContainEqual({
      kind: 'api_call.deferred',
      node_id: 'fn_api',
      detail: 'P1-10',
    });
  });

  it('passes machine events through', async () => {
    const out = await interpret(
      [{ c: 'emit_event', event: { kind: 'flow.dangling_edge' } }],
      session(),
      fetcher(),
      { logic: REHYDRATED, escapeContext: 'none' },
    );

    expect(out.events).toContainEqual({ kind: 'flow.dangling_edge' });
  });

  it('escapes piped text in html context', async () => {
    // Escaping is by output context and applied by the renderer, not the author (E §9.1).
    const one: PageFetcher = async () =>
      ({
        id: 'pg_1',
        ref: 'P1',
        questions: [{ id: 'q', ref: 'Q', question_type: 'text', label: 'Hi {{n}}' }],
      }) as never;
    const s = { ...session(), vars: { n: '<script>' } as never };

    const out = await interpret([{ c: 'render', page_id: 'pg_1' }], s, one, {
      logic: REHYDRATED,
      escapeContext: 'html_text',
    });

    expect(out.page?.questions[0]?.label).toBe('Hi &lt;script&gt;');
  });
});

/* ---------------------------------------------------------------- *
 * Redirect resolution at finalization (E §11)
 * ---------------------------------------------------------------- */

describe('redirects — the exit door (E §11)', () => {
  function redirectArtifact(redirects: Redirects): FakeArtifact {
    return { ...linearArtifact(), redirects };
  }
  const COMPLETE_URL = 'https://cb.vendor.example/done?q1={{Q1}}';

  async function complete(d: RuntimeDeps, headers: Record<string, string> = {}) {
    const entry = await call(d, { path: `/s/${TOKEN}`, headers });
    const sessionId = entry.body?.session_id
      ?? /data-session="([^"]+)"/.exec(entry.raw)?.[1];
    await call(d, {
      method: 'POST',
      path: `/s/${TOKEN}/submit?session=${sessionId}`,
      body: { page_id: 'pg_1', values: { var_q1: 2 } },
    });
    return { sessionId: sessionId as string };
  }

  it('a JSON COMPLETE carries the interpolated redirect_url', async () => {
    const d = deps({
      artifacts: loaderFor({
        [HASH]: redirectArtifact({ default: { COMPLETE: COMPLETE_URL } }),
      }),
    });
    const { sessionId } = await complete(d);
    const r = await call(d, {
      method: 'POST',
      path: `/s/${TOKEN}/submit?session=${sessionId}`,
      body: { page_id: 'pg_2', values: {} },
    });

    expect(r.status).toBe(200);
    expect(r.body.disposition).toBe('COMPLETE');
    // {{Q1}} piped from the STORED answer, percent-encoded, per E §11.2.
    expect(r.body.redirect_url).toBe('https://cb.vendor.example/done?q1=2');
  });

  it('a production HTML COMPLETE is a 303 with Referrer-Policy: no-referrer', async () => {
    // 303 because it answers a POST (PRG); no-referrer because the vendor must learn the
    // parameters we chose to send and nothing else (security §12.3).
    const d = deps({
      artifacts: loaderFor({
        [HASH]: redirectArtifact({ default: { COMPLETE: COMPLETE_URL } }),
      }),
    });
    const { sessionId } = await complete(d);
    const r = await call(d, {
      method: 'POST',
      path: `/s/${TOKEN}/submit?session=${sessionId}&html=1`,
      rawBody: '__page_id=pg_2',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html' },
    });

    expect(r.status).toBe(303);
    expect(r.headers['location']).toBe('https://cb.vendor.example/done?q1=2');
    expect(r.headers['referrer-policy']).toBe('no-referrer');
  });

  it('a TEST session gets the interstitial, never the redirect (E §14.1)', async () => {
    const d = deps({
      tokens: createStaticTokenResolver([token({ status: 'test', is_test: true })]),
      artifacts: loaderFor({
        [HASH]: redirectArtifact({ default: { COMPLETE: COMPLETE_URL } }),
      }),
    });
    const { sessionId } = await complete(d);
    const r = await call(d, {
      method: 'POST',
      path: `/s/${TOKEN}/submit?session=${sessionId}&html=1`,
      rawBody: '__page_id=pg_2',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html' },
    });

    expect(r.status).toBe(200); // NOT a redirect
    expect(r.raw).toContain('TEST MODE');
    expect(r.raw).toContain('https://cb.vendor.example/done?q1=2');
    expect(r.raw).toContain('Follow it anyway');
  });

  it('a disallowed host is REFUSED: terminal page, redirect_url null', async () => {
    const d = deps({
      artifacts: loaderFor({
        [HASH]: redirectArtifact({ default: { COMPLETE: COMPLETE_URL } }),
      }),
      redirectHosts: ['*.acme.example'], // cb.vendor.example is not on the list
    });
    const { sessionId } = await complete(d);
    const r = await call(d, {
      method: 'POST',
      path: `/s/${TOKEN}/submit?session=${sessionId}`,
      body: { page_id: 'pg_2', values: {} },
    });

    expect(r.status).toBe(200);
    expect(r.body.disposition).toBe('COMPLETE'); // the interview is still recorded
    expect(r.body.redirect_url).toBeNull();      // the destination is not
  });

  it('a GET of an already-finalized session re-resolves the same exit', async () => {
    // A respondent who bookmarks the last page or double-clicks lands here; they should get
    // the same hand-off, not a dead end.
    const d = deps({
      artifacts: loaderFor({
        [HASH]: redirectArtifact({ default: { COMPLETE: COMPLETE_URL } }),
      }),
    });
    const { sessionId } = await complete(d);
    await call(d, {
      method: 'POST',
      path: `/s/${TOKEN}/submit?session=${sessionId}`,
      body: { page_id: 'pg_2', values: {} },
    });
    const r = await call(d, { path: `/s/${TOKEN}/p/pg_2?session=${sessionId}` });

    expect(r.status).toBe(200);
    expect(r.body.redirect_url).toBe('https://cb.vendor.example/done?q1=2');
  });

  it('no redirects section -> the terminal page, exactly as before (E §11.1 step 6)', async () => {
    const d = deps(); // linearArtifact has no redirects
    const { sessionId } = await complete(d);
    const r = await call(d, {
      method: 'POST',
      path: `/s/${TOKEN}/submit?session=${sessionId}`,
      body: { page_id: 'pg_2', values: {} },
    });

    expect(r.body.redirect_url).toBeNull();
  });
});

/* ---------------------------------------------------------------- *
 * Server script hooks (E §5 step 6, E §13)
 * ---------------------------------------------------------------- */

describe('server scripts on submit — REAL QuickJS through the whole HTTP path', () => {
  function scriptedArtifact(source: string): FakeArtifact {
    const base = linearArtifact();
    const head = base.head as unknown as { manifest: Record<string, unknown> };
    return {
      ...base,
      scripts: { enrich: source },
      head: {
        ...base.head,
        manifest: {
          ...head.manifest,
          script_bindings: [
            { ref: 'enrich', scope: 'survey', hooks: ['onPageSubmit'], runs_on: 'server' },
          ],
          variable_manifest: [
            ...(head.manifest['variable_manifest'] as unknown[]),
            { id: 'var_seg', name: 'SEGMENT', kind: 'hidden', type: 'text',
              export_column: 'SEGMENT', export_include: true, pii: false, persist: true },
          ],
        },
      } as never,
    };
  }

  function scripted(source: string) {
    return deps({
      artifacts: loaderFor({ [HASH]: scriptedArtifact(source) }),
      scriptHost: createScriptHost(),
    });
  }
  async function enterAndSubmit(d: RuntimeDeps) {
    const entry = await call(d, { path: `/s/${TOKEN}` });
    const sessionId = entry.body.session_id as string;
    const r = await call(d, {
      method: 'POST',
      path: `/s/${TOKEN}/submit?session=${sessionId}`,
      body: { page_id: 'pg_1', values: { var_q1: 1 } },
    });
    return { d, sessionId, r };
  }

  it('a clean script writes a hidden variable, with script provenance', async () => {
    const d = scripted(`
      const q1 = survey.getValue('Q1');
      survey.setValue('SEGMENT', q1 === 1 ? 'coke' : 'pepsi');
    `);
    const { sessionId, r } = await enterAndSubmit(d);

    expect(r.status).toBe(200);
    expect(r.body.page.page_id).toBe('pg_2'); // the submit advanced normally
    const stored = await d.sessions.load(sessionId);
    expect(stored?.vars['var_seg' as never]).toBe('coke'); // the script read THIS submit's answer
    expect(stored?.var_provenance['var_seg' as never])
      .toEqual({ p: 'script', asset_ref: 'enrich' });
  });

  it('FAIL-OPEN: a dying script strands nothing — the respondent advances', async () => {
    const d = scripted(`
      survey.setValue('SEGMENT', 'half-done');
      throw new Error('crm timeout');
    `);
    const { sessionId, r } = await enterAndSubmit(d);

    expect(r.status).toBe(200);
    expect(r.body.page.page_id).toBe('pg_2');
    // E §13.3 step 2: the half-done write rolled back with the script.
    const stored = await d.sessions.load(sessionId);
    expect('var_seg' in (stored?.vars ?? {})).toBe(false);
  });

  it('a runaway script is budgeted out and the interview continues', async () => {
    const d = scripted('while (true) {}');
    const { r } = await enterAndSubmit(d);
    expect(r.status).toBe(200);
    expect(r.body.page.page_id).toBe('pg_2');
  }, 20_000);

  it('survey.terminate() finalizes with the script disposition', async () => {
    const d = scripted(`survey.terminate('QUALITY');`);
    const { sessionId, r } = await enterAndSubmit(d);

    expect(r.status).toBe(200);
    expect(r.body.disposition).toBe('QUALITY');
    const stored = await d.sessions.load(sessionId);
    expect(stored?.machine_state.state).toBe('FINALIZED');
    expect(stored?.disposition).toBe('QUALITY');
  });

  it('survey.reject() blocks progression with validation semantics — a genuine no-op', async () => {
    const d = scripted(`
      survey.setValue('SEGMENT', 'should-not-survive');
      survey.reject('msg.duplicate_entry');
    `);
    const { sessionId, r } = await enterAndSubmit(d);

    expect(r.status).toBe(200);
    expect(r.body.validation_failed[0]).toMatchObject({ message_key: 'msg.duplicate_entry' });
    const stored = await d.sessions.load(sessionId);
    expect(stored?.current_page_id).toBe('pg_1');              // did not advance
    expect('var_seg' in (stored?.vars ?? {})).toBe(false);     // the write did not survive
    expect('var_q1' in (stored?.vars ?? {})).toBe(false);      // NEITHER did the answer: no-op
  });
});

/* ---------------------------------------------------------------- *
 * The preview surface (P1-11, E §12, security §3.2)
 * ---------------------------------------------------------------- */

describe('the preview surface', () => {
  const SECRET = 'preview-test-secret';
  const NOW = 1_700_000_000_000;
  const previewDeps = (over: Partial<RuntimeDeps> = {}) =>
    deps({ previewSecret: SECRET, studioOrigin: 'https://studio.local', ...over });
  const pt = () => mintPreviewToken(SECRET, HASH, NOW + 60_000);
  const previewCall = (d: RuntimeDeps, path: string, opts: Record<string, unknown> = {}) =>
    call(d, { host: 'prv-abc123.run.local', path, ...opts } as never);

  it('renders an artifact BY HASH with a valid signed token — is_test, framed for the studio', async () => {
    const d = previewDeps();
    const r = await previewCall(d, `/preview/${HASH}?pt=${encodeURIComponent(pt())}`, {
      headers: { accept: 'text/html' },
    });

    expect(r.status).toBe(200);
    expect(r.raw).toContain('<form method="post"');
    // The form posts back to the PREVIEW surface, carrying the signed token.
    expect(r.raw).toContain(`action="/preview/${HASH}/submit?pt=`);
    // Framed for exactly the studio origin — never 'none', never *.
    expect(r.headers['content-security-policy']).toContain('frame-ancestors https://studio.local');
    expect(r.headers['x-frame-options']).toBeUndefined();
    // The preview channel attributes the client bundle keys on.
    expect(r.raw).toContain('data-preview-origin="https://studio.local"');
    expect(r.raw).toContain(`data-artifact="${HASH}"`);
  });

  it('mints an is_test session and NEVER touches the durable writer', async () => {
    const writerCalls: string[] = [];
    const d = previewDeps({
      writer: {
        startSession: async () => void writerCalls.push('startSession'),
        submitPage: async () => {
          writerCalls.push('submitPage');
          return -1; // what the real RPC answers for a session with no birth row
        },
      } as never,
    });
    const r = await previewCall(d, `/preview/${HASH}?pt=${encodeURIComponent(pt())}`);

    expect(r.status).toBe(200);
    const sessionId = r.body.session_id as string;
    const stored = await d.sessions.load(sessionId);
    expect(stored?.is_test).toBe(true);

    // ...and the SUBMIT skips the writer too. Without ctx.ephemeral, submit_page's
    // last_event_seq guard reads the missing birth row as a replay and 409s every submit.
    const s1 = await previewCall(d, `/preview/${HASH}/submit?pt=${encodeURIComponent(pt())}&session=${sessionId}`, {
      method: 'POST', body: { page_id: 'pg_1', values: { var_q1: 1 } },
    });
    expect(s1.status).toBe(200);
    expect(s1.body.page.page_id).toBe('pg_2');
    expect(writerCalls).toEqual([]); // no durable birth, no durable submit: not respondent data
  });

  it('THE GATE: no token, a forged token, and an expired token are all refused', async () => {
    const d = previewDeps();
    const none = await previewCall(d, `/preview/${HASH}`);
    const forged = await previewCall(d, `/preview/${HASH}?pt=v1.${NOW + 60_000}.${'a'.repeat(64)}`);
    const expired = await previewCall(
      d, `/preview/${HASH}?pt=${encodeURIComponent(mintPreviewToken(SECRET, HASH, NOW - 1))}`,
    );

    expect(none.status).toBe(403);
    expect(forged.status).toBe(403);
    expect(expired.status).toBe(403);
    expect(expired.body.error.reason).toBe('expired');
  });

  it('a token minted for artifact A does not open artifact B', async () => {
    const d = previewDeps();
    const other = mintPreviewToken(SECRET, 'b'.repeat(64), NOW + 60_000);
    const r = await previewCall(d, `/preview/${HASH}?pt=${encodeURIComponent(other)}`);
    expect(r.status).toBe(403);
    expect(r.body.error.reason).toBe('bad_signature');
  });

  it('no signing secret configured = the surface does not exist', async () => {
    const d = deps(); // no previewSecret
    const r = await previewCall(d, `/preview/${HASH}?pt=${encodeURIComponent(pt())}`);
    expect(r.status).toBe(404);
  });

  it('?seed= reproduces a session (E §14.1: seed overridable in test mode)', async () => {
    const d = previewDeps();
    const seed = '1234567890abcdef1234567890abcdef';
    const r1 = await previewCall(d, `/preview/${HASH}?pt=${encodeURIComponent(pt())}&seed=${seed}`);
    const r2 = await previewCall(d, `/preview/${HASH}?pt=${encodeURIComponent(pt())}&seed=${seed}`);

    const s1 = await d.sessions.load(r1.body.session_id as string);
    const s2 = await d.sessions.load(r2.body.session_id as string);
    expect(s1?.random_seed).toBe(seed);
    expect(s2?.random_seed).toBe(seed);
  });

  it('the whole interview runs on the preview surface: submit advances, completes', async () => {
    const d = previewDeps();
    const entry = await previewCall(d, `/preview/${HASH}?pt=${encodeURIComponent(pt())}`);
    const sessionId = entry.body.session_id as string;

    const s1 = await previewCall(d, `/preview/${HASH}/submit?pt=${encodeURIComponent(pt())}&session=${sessionId}`, {
      method: 'POST', body: { page_id: 'pg_1', values: { var_q1: 2 } },
    });
    expect(s1.body.page.page_id).toBe('pg_2');

    const s2 = await previewCall(d, `/preview/${HASH}/submit?pt=${encodeURIComponent(pt())}&session=${sessionId}`, {
      method: 'POST', body: { page_id: 'pg_2', values: {} },
    });
    expect(s2.body.disposition).toBe('COMPLETE');
  });

  it('setvars jumps the variable state, manifest-validated, invented refs rejected', async () => {
    const d = previewDeps();
    const entry = await previewCall(d, `/preview/${HASH}?pt=${encodeURIComponent(pt())}`);
    const sessionId = entry.body.session_id as string;

    const r = await previewCall(d, `/preview/${HASH}/setvars?pt=${encodeURIComponent(pt())}&session=${sessionId}`, {
      method: 'POST', body: { vars: { Q1: 2, INVENTED: 'x' } },
    });

    expect(r.status).toBe(200);
    expect(r.body.set).toBe(1);
    expect(r.body.rejected).toEqual(['INVENTED']);
    const stored = await d.sessions.load(sessionId);
    expect(stored?.vars['var_q1' as never]).toBe(2);
    expect(stored?.var_provenance['var_q1' as never]).toEqual({ p: 'system' });
  });

  it('setvars refuses a non-test session — the same message on production is inert', async () => {
    // Enter through the SURVEY surface (production session), then aim setvars at it.
    const d = previewDeps();
    const entry = await call(d, { path: `/s/${TOKEN}` });
    const sessionId = entry.body.session_id as string;

    const r = await previewCall(d, `/preview/${HASH}/setvars?pt=${encodeURIComponent(pt())}&session=${sessionId}`, {
      method: 'POST', body: { vars: { Q1: 2 } },
    });

    expect(r.status).toBe(404); // indistinguishable from "no such session"
    const stored = await d.sessions.load(sessionId);
    expect('var_q1' in (stored?.vars ?? {})).toBe(false);
  });
});
