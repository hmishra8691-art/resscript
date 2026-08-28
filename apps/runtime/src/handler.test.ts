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
import { canonicalString, signCanonical } from './vendor/verify.js';
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
 * The manifest a direct `interpret` call needs, for `tagVars`: the declared type of each
 * variable, which is what turns a stored `1` into the `{k:'enum',v:1,d:…}` the engine compares.
 */
const INTERPRET_MANIFEST = {
  variable_manifest: [
    {
      id: 'var_q1', name: 'Q1', kind: 'response', type: 'enum',
      export_column: 'Q1', export_include: true, pii: false, persist: true,
      enum_domain: [{ code: 1, label_key: 'q1.o1' }, { code: 2, label_key: 'q1.o2' }],
    },
  ],
} as never;

/**
 * A fake artifact: a head plus a per-language page tree, which is the shape the loader actually
 * serves (C §17). Keeping the fixture split the same way as the real file tree is what makes
 * these tests able to catch a loader that fetches too much.
 */
interface FakeArtifact {
  readonly redirects?: Redirects;
  readonly scripts?: Record<string, string>;
  /** Author HTML templates, by asset id — what PageSettings.html_template_ref holds. */
  readonly templates?: Record<string, string>;
  readonly i18n?: Record<string, Record<string, string>>;
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
      // A real artifact ALWAYS carries a variable manifest (the compiler emits it and the loader
      // now refuses a head without one). A two-field stub here was the same unrealistic-fixture
      // trap that once made `filterSubmit` crash — see the status doc's defect list.
      manifest: {
        base_language: 'en',
        artifact_hash: HASH,
        survey_id: 'svy_0A000000000000000000000000',
        variable_manifest: [],
      },
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
    async themeCss(hash: string) {
      return artifacts[hash] === undefined ? null : ':root{--rs-color-bg:#fff}.rs-target{min-height:44px}';
    },
    async authorCss(hash: string) {
      return artifacts[hash] === undefined ? null : '/* MAIN */\nbody{color:#111}';
    },
    async htmlTemplate(hash: string, assetId: string) {
      return artifacts[hash]?.templates?.[assetId] ?? null;
    },
    async i18n(hash: string, language: string) {
      return artifacts[hash]?.i18n?.[language] ?? null;
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

  it('renders the AUTHOR page shell around the form (P2-12)', async () => {
    // The end of the last dead-ended chain P2-12's audit found. `PageSettings.html_template_ref`
    // was declared, its id resolved by validateStructural, its source scanned by CMP-0500 — and no
    // emitter put it in the artifact and no renderer read it, so an author who selected a page
    // template got the default shell with no indication otherwise.
    const TEMPLATE_ID = 'ast_0SHE11000000000000000000000'.slice(0, 30);
    const art = linearArtifact();
    const d = deps({
      artifacts: loaderFor({
        [HASH]: {
          ...art,
          templates: { [TEMPLATE_ID]: '<section class="brandwrap">{{questions}}</section>' },
          // `pages` is keyed BY LANGUAGE first, then by page id — so the settings go on the inner
          // level. Spreading the outer level put `settings` on the language map, where nothing
          // reads it.
          pages: Object.fromEntries(
            Object.entries(art.pages).map(([lang, byId]) => [
              lang,
              Object.fromEntries(
                Object.entries(byId as Record<string, unknown>).map(([id, p]) => [
                  id,
                  {
                    ...(p as Record<string, unknown>),
                    settings: { html_template_ref: TEMPLATE_ID },
                  },
                ]),
              ),
            ]),
          ),
        },
      }),
    });
    const r = await browse(d, `/s/${TOKEN}`);

    expect(r.status).toBe(200);
    expect(r.raw).toContain('<section class="brandwrap">');
    // The form is INSIDE the author's shell, which is what the slot means.
    const wrapAt = r.raw.indexOf('<section class="brandwrap">');
    const formAt = r.raw.indexOf('<form method="post"');
    expect(wrapAt).toBeGreaterThan(-1);
    expect(formAt).toBeGreaterThan(wrapAt);
    // And the slot itself is gone — a respondent must never read their own template syntax.
    expect(r.raw).not.toContain('{{questions}}');
  });

  it('keeps the document head OURS, whatever the template says', async () => {
    // A page template overrides the page SHELL (schema §11), not the head. Letting it replace the
    // document would let a template drop `robots: noindex` and put a live survey in a search index,
    // which is not a styling decision.
    const TEMPLATE_ID = 'ast_0SHE12000000000000000000000'.slice(0, 30);
    const art = linearArtifact();
    const d = deps({
      artifacts: loaderFor({
        [HASH]: {
          ...art,
          templates: { [TEMPLATE_ID]: '<div>{{questions}}</div>' },
          // `pages` is keyed BY LANGUAGE first, then by page id — so the settings go on the inner
          // level. Spreading the outer level put `settings` on the language map, where nothing
          // reads it.
          pages: Object.fromEntries(
            Object.entries(art.pages).map(([lang, byId]) => [
              lang,
              Object.fromEntries(
                Object.entries(byId as Record<string, unknown>).map(([id, p]) => [
                  id,
                  {
                    ...(p as Record<string, unknown>),
                    settings: { html_template_ref: TEMPLATE_ID },
                  },
                ]),
              ),
            ]),
          ),
        },
      }),
    });
    const r = await browse(d, `/s/${TOKEN}`);

    expect(r.raw).toContain('name="robots" content="noindex"');
    expect(r.raw).toContain('<meta charset="utf-8">');
    // Still exactly one document.
    expect(r.raw.match(/<!doctype html>/gi)?.length).toBe(1);
  });

  it('falls back to the default shell when the template is missing', async () => {
    // The publish path guarantees the file exists (CMP-0502 refuses a dangling id, the emitter
    // writes every template), so reaching this means a hand-edited artifact or an unreachable
    // storage tier — and a respondent seeing an unstyled but WORKING survey beats an error page.
    const art = linearArtifact();
    const d = deps({
      artifacts: loaderFor({
        [HASH]: {
          ...art,
          // No `templates` entry at all.
          pages: Object.fromEntries(
            Object.entries(art.pages).map(([lang, byId]) => [
              lang,
              Object.fromEntries(
                Object.entries(byId as Record<string, unknown>).map(([id, p]) => [
                  id,
                  { ...(p as Record<string, unknown>), settings: { html_template_ref: 'ast_0GONE' } },
                ]),
              ),
            ]),
          ),
        },
      }),
    });
    const r = await browse(d, `/s/${TOKEN}`);

    expect(r.status).toBe(200);
    expect(r.raw).toContain('<form method="post"');
    expect(r.raw).toContain('<main>');
  });

  it('renders the default shell for a page with no template', async () => {
    const d = deps();
    const r = await browse(d, `/s/${TOKEN}`);
    expect(r.raw).toContain('<main>');
    expect(r.raw).toContain('<form method="post"');
  });

  it('links the content-addressed stylesheet, so the theme actually reaches the browser', async () => {
    // The end of the chain P2-12 built. Before it, `themeCss` was a compiler input nothing supplied,
    // no artifact carried a stylesheet, and `.rs-target` — the class question-kit asserts on 6,601
    // times to satisfy the WCAG 2.2 AA touch-target floor — was defined in no stylesheet anywhere.
    // Every link in that chain is now tested; this is the one that says a browser receives it.
    const d = deps();
    const r = await browse(d, `/s/${TOKEN}`);

    expect(r.raw).toContain(`<link rel="stylesheet" href="/theme/${HASH}.css">`);
    // And the pre-P2-12 inline fallback is NOT also emitted — two stylesheets would mean the
    // fallback's `body{font:16px…}` fighting the theme's tokens, with the winner decided by order.
    expect(r.raw).not.toContain('font:16px/1.5 system-ui');
  });

  it('serves that stylesheet, immutably cacheable', async () => {
    const d = deps();
    const r = await browse(d, `/theme/${HASH}.css`);

    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('text/css');
    expect(r.raw).toContain('.rs-target');
    // `immutable` is a statement of fact, not a hope: an artifact's bytes never change (ADR-002),
    // which is exactly why the hash is in the path rather than a single /theme.css being
    // revalidated on every page of every session.
    expect(r.headers['cache-control']).toContain('immutable');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
  });

  it('links the author stylesheet AFTER the theme, which is the cascade an author expects', async () => {
    // Author CSS reaching the browser at all is P2-12's second half: these stylesheets were
    // declared in the schema, resolved by validateStructural, scanned by CMP-0503 — and emitted by
    // nothing, so an author's CSS was stored, checked, and silently dropped.
    //
    // Second in the order is safe because CMP-0503 refuses selectors on the reserved `rs-` prefix,
    // so author CSS cannot restyle the touch-target contract the theme defines however late it
    // loads. Author rules override platform defaults; they cannot override the accessibility floor.
    const d = deps();
    const r = await browse(d, `/s/${TOKEN}`);

    const themeAt = r.raw.indexOf(`/theme/${HASH}.css`);
    const authorAt = r.raw.indexOf(`/author/${HASH}.css`);
    expect(themeAt).toBeGreaterThan(-1);
    expect(authorAt).toBeGreaterThan(themeAt);
  });

  it('serves the author stylesheet on its own content-addressed route', async () => {
    const d = deps();
    const r = await browse(d, `/author/${HASH}.css`);

    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('text/css');
    expect(r.raw).toContain('MAIN');
    expect(r.headers['cache-control']).toContain('immutable');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
  });

  it('404s a theme path that names no artifact, rather than reflecting the fetch', async () => {
    // Read through the loader, so a well-formed 64-hex path cannot be used to probe arbitrary keys
    // in the artifact store.
    const d = deps();
    // Not `'f'.repeat(64)` — that is HASH in this file, so the first version of this test asked for
    // the artifact that DOES exist and asserted it was missing.
    for (const kind of ['theme', 'author']) {
      const r = await browse(d, `/${kind}/${'a'.repeat(64)}.css`);
      expect(r.status).toBe(404);
    }
  });

  it('does not answer a malformed theme path at all', async () => {
    const d = deps();
    for (const path of ['/theme/../secret.css', '/theme/abc.css', '/theme/.css']) {
      const r = await browse(d, path);
      expect(r.status).not.toBe(200);
    }
  });

  it('entry renders an HTML form that names the submit endpoint', async () => {
    const d = deps();
    const r = await browse(d, `/s/${TOKEN}`);

    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('text/html');
    expect(r.raw).toContain('<form method="post"');
    expect(r.raw).toContain('type="radio"');
    expect(r.raw).toContain('Coca-Cola');
    // The seed never reaches the browser (E §4 step 10) — only derived orders, as DOM order.
    //
    // Asserted against the SESSION'S ACTUAL SEED rather than "no 32-hex run anywhere", which is
    // what this line used to say. That broader form fired when P2-12 added the content-addressed
    // stylesheet link (`/theme/<64-hex>.css`) — a false positive, since the artifact hash is not a
    // secret: it identifies compiled survey content the respondent is already reading, and the
    // preview surface has always put it in the DOM as `data-artifact`. Naming the seed keeps the
    // assertion testing the property it was written for instead of a proxy for it.
    // The session id is in the rendered page rather than a JSON body on this surface.
    const sessionId = /data-session="([^"]+)"/.exec(r.raw)?.[1] ?? '';
    expect(sessionId).not.toBe('');
    const seeded = await d.sessions.load(sessionId);
    expect(seeded?.random_seed).toMatch(/^[0-9a-f]{32}$/);
    expect(r.raw).not.toContain(seeded?.random_seed ?? '<no seed>');
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
      manifest: INTERPRET_MANIFEST,
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
      manifest: INTERPRET_MANIFEST,
      escapeContext: 'none',
    });

    expect(seen).toEqual(['pg_1']);
  });

  it('reports a missing page rather than throwing', async () => {
    const out = await interpret([{ c: 'render', page_id: 'pg_ghost' }], session(), fetcher(), {
      logic: REHYDRATED,
      manifest: INTERPRET_MANIFEST,
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
      { logic: REHYDRATED, manifest: INTERPRET_MANIFEST, escapeContext: 'none' },
    );

    expect(out.disposition).toBe('COMPLETE');
    expect(out.session.finalized_at).not.toBeNull();
  });

  it('carries custom_key on a CUSTOM finalize', async () => {
    const out = await interpret(
      [{ c: 'finalize', disposition: 'CUSTOM', custom_key: 'over_budget' }],
      session(),
      fetcher(),
      { logic: REHYDRATED, manifest: INTERPRET_MANIFEST, escapeContext: 'none' },
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
      { logic: REHYDRATED, manifest: INTERPRET_MANIFEST, escapeContext: 'none' },
    );

    expect(out.events.map(e => e.kind)).toEqual([
      'quota.reserve_deferred',
      'quota.commit_quota_deferred',
    ]);
  });

  /**
   * A one-dimension, one-cell marginal plan whose bucket condition is the literal `TRUE`.
   *
   * A literal rather than a variable comparison because these tests are about the GATE — resolve,
   * decide, resume — and a bucket predicate that depended on session vars would make each of them
   * also a test of variable tagging and enum domains. `cells.test.ts` covers bucket selection
   * itself, including the UNKNOWN case, against a stubbed evaluator; here the predicate just needs
   * to be decidable by the real engine, which a literal is.
   */
  const GATE_CONFIG = {
    policy: {
      count_at: 'reservation',
      reservation_ttl_s: 5400,
      on_store_unavailable: 'fail_closed',
      counter_scope: 'survey',
    },
    dimensions: [
      {
        id: 'qd_gender',
        ref: 'GENDER',
        variable_id: 'var_s2',
        buckets: [{ ref: 'M', match: { n: 0, op: 'lit', v: { k: 'bool', v: true } } }],
      },
    ],
    plans: [
      {
        id: 'qp_main',
        ref: 'MAIN',
        type: 'marginal',
        dimension_ids: ['qd_gender'],
        cells: [{ key: ['M'], target: 100, mode: 'hard' }],
      },
    ],
  };

  /** The same plan with a bucket nothing can satisfy, so the respondent occupies no cell. */
  const UNMATCHABLE_GATE_CONFIG = {
    ...GATE_CONFIG,
    dimensions: [
      {
        ...GATE_CONFIG.dimensions[0],
        buckets: [{ ref: 'M', match: { n: 0, op: 'lit', v: { k: 'bool', v: false } } }],
      },
    ],
  };

  it('resolves a quota gate through the client and RESUMES the machine', async () => {
    // The defect this closes. The machine emits `reserve_quota` and RETURNS, parking the session in
    // `QUOTA_GATE` until a `quota_result` input arrives — and nothing ever fed one back, so any
    // session that reached a gate node stalled on a blank step forever. The assertion that matters
    // is not the reserve call; it is that `step` was invoked with the verdict.
    const reserved: { cells: string[]; ttl: number }[] = [];
    const stepped: { passed: boolean }[] = [];
    const quota = {
      reserve: async (_sid: string, cells: { key: string }[], ttl: number) => {
        reserved.push({ cells: cells.map(c => c.key), ttl });
        return { ok: true, soft_full: [], blocked: [] };
      },
      evaluateOnly: async () => ({ ok: true, soft_full: [], blocked: [] }),
    };

    const out = await interpret(
      [{ c: 'reserve_quota', quota_ref: 'MAIN', node_id: 'fn_q' }],
      session(),
      fetcher(),
      {
        logic: REHYDRATED,
        manifest: INTERPRET_MANIFEST,
        escapeContext: 'none',
        quota: quota as never,
        quotaGate: {
          config: GATE_CONFIG as never,
          scope: 'srv_1',
          step: (state, input) => {
            stepped.push({ passed: (input as { passed: boolean }).passed });
            return { next: state, cmds: [] };
          },
        },
      },
    );

    // 5400 is GATE_CONFIG's AUTHORED reservation_ttl_s, and with no TTL provider injected that is
    // still what reaches Redis — the pre-P2-07 behaviour, kept as the fallback for a deployment
    // with no measurement path.
    expect(reserved).toEqual([{ cells: ['q:srv_1:qp_main:M'], ttl: 5400 }]);
    // Fed back, which is the whole point — without this the respondent never leaves the gate.
    expect(stepped).toEqual([{ passed: true }]);
    expect(out.events.map(e => e.kind)).toContain('quota.decision');
  });

  it('reserves with the MEASURED ttl when a provider is injected (P2-07)', async () => {
    // The policy is unit-tested in quota/ttl.test.ts; this asserts the number ARRIVES. A decided
    // TTL that nothing passes to `reserve` is the same bug in a different place — and it is the
    // shape of bug this codebase keeps finding (a computed value with no consumer).
    const reserved: { ttl: number }[] = [];
    const quota = {
      reserve: async (_sid: string, _cells: unknown, ttl: number) => {
        reserved.push({ ttl });
        return { ok: true, soft_full: [], blocked: [] };
      },
      evaluateOnly: async () => ({ ok: true, soft_full: [], blocked: [] }),
    };

    await interpret(
      [{ c: 'reserve_quota', quota_ref: 'MAIN', node_id: 'fn_q' }],
      session(),
      fetcher(),
      {
        logic: REHYDRATED,
        manifest: INTERPRET_MANIFEST,
        escapeContext: 'none',
        quota: quota as never,
        // 3 x a measured 900s median, which is nothing like the authored 5400.
        ttl: {
          decide: async () => ({ ttlSeconds: 2700, basis: 'measured' as const, completes: 200 }),
        },
        quotaGate: {
          config: GATE_CONFIG as never,
          scope: 'srv_1',
          step: (state: never) => ({ next: state, cmds: [] }),
        },
      } as never,
    );

    expect(reserved).toEqual([{ ttl: 2700 }]);
  });

  it('routes a FULL cell to on_full by stepping with passed:false', async () => {
    const stepped: { passed: boolean }[] = [];
    const quota = {
      reserve: async () => ({ ok: false, soft_full: [], blocked: ['q:srv_1:qp_main:M'] }),
      evaluateOnly: async () => ({ ok: false, soft_full: [], blocked: [] }),
    };

    await interpret(
      [{ c: 'reserve_quota', quota_ref: 'MAIN', node_id: 'fn_q' }],
      session(),
      fetcher(),
      {
        logic: REHYDRATED,
        manifest: INTERPRET_MANIFEST,
        escapeContext: 'none',
        quota: quota as never,
        quotaGate: {
          config: GATE_CONFIG as never,
          scope: 'srv_1',
          step: (state, input) => {
            stepped.push({ passed: (input as { passed: boolean }).passed });
            return { next: state, cmds: [] };
          },
        },
      },
    );

    expect(stepped).toEqual([{ passed: false }]);
  });

  it('a soft-full cell PASSES, because a soft cell only reports its overshoot', async () => {
    const stepped: { passed: boolean }[] = [];
    const quota = {
      reserve: async () => ({ ok: true, soft_full: ['q:srv_1:qp_main:M'], blocked: [] }),
      evaluateOnly: async () => ({ ok: true, soft_full: [], blocked: [] }),
    };

    const out = await interpret(
      [{ c: 'reserve_quota', quota_ref: 'MAIN', node_id: 'fn_q' }],
      session(),
      fetcher(),
      {
        logic: REHYDRATED,
        manifest: INTERPRET_MANIFEST,
        escapeContext: 'none',
        quota: quota as never,
        quotaGate: {
          config: GATE_CONFIG as never,
          scope: 'srv_1',
          step: (state, input) => {
            stepped.push({ passed: (input as { passed: boolean }).passed });
            return { next: state, cmds: [] };
          },
        },
      },
    );

    expect(stepped).toEqual([{ passed: true }]);
    expect(out.events.find(e => e.kind === 'quota.decision')?.['decision']).toBe('soft_full');
  });

  it('a test session evaluates without moving a counter, and still resumes', async () => {
    // E §14.1: test mode must never mutate. `gateDecision` routes to `evaluateOnly`; the point
    // here is that the gate still produces a verdict and the machine still continues.
    const calls: string[] = [];
    const quota = {
      reserve: async () => { calls.push('reserve'); return { ok: true, soft_full: [], blocked: [] }; },
      evaluateOnly: async () => { calls.push('evaluateOnly'); return { ok: true, soft_full: [], blocked: [] }; },
    };
    const stepped: { passed: boolean }[] = [];

    await interpret(
      [{ c: 'reserve_quota', quota_ref: 'MAIN', node_id: 'fn_q' }],
      { ...session(), is_test: true },
      fetcher(),
      {
        logic: REHYDRATED,
        manifest: INTERPRET_MANIFEST,
        escapeContext: 'none',
        quota: quota as never,
        quotaGate: {
          config: GATE_CONFIG as never,
          scope: 'srv_1',
          step: (state, input) => {
            stepped.push({ passed: (input as { passed: boolean }).passed });
            return { next: state, cmds: [] };
          },
        },
      },
    );

    expect(calls).toEqual(['evaluateOnly']);
    expect(stepped).toEqual([{ passed: true }]);
  });

  it('a respondent in no cell passes without touching the store', async () => {
    // `cells.ts`' argument: you cannot fill a cell you are not in. The bucket condition here is
    // never true, so no cell resolves and the store is not consulted at all.
    const calls: string[] = [];
    const quota = {
      reserve: async () => { calls.push('reserve'); return { ok: true, soft_full: [], blocked: [] }; },
      evaluateOnly: async () => { calls.push('evaluateOnly'); return { ok: true, soft_full: [], blocked: [] }; },
    };
    const stepped: { passed: boolean }[] = [];

    const out = await interpret(
      [{ c: 'reserve_quota', quota_ref: 'MAIN', node_id: 'fn_q' }],
      session(),
      fetcher(),
      {
        logic: REHYDRATED,
        manifest: INTERPRET_MANIFEST,
        escapeContext: 'none',
        quota: quota as never,
        quotaGate: {
          // A plan whose one bucket matches nothing this session can satisfy.
          config: UNMATCHABLE_GATE_CONFIG as never,
          scope: 'srv_1',
          step: (state, input) => {
            stepped.push({ passed: (input as { passed: boolean }).passed });
            return { next: state, cmds: [] };
          },
        },
      },
    );

    expect(calls).toEqual([]);
    expect(stepped).toEqual([{ passed: true }]);
    expect(out.events.map(e => e.kind)).toContain('quota.no_cell');
  });

  it('an unreadable quotas.json is reported distinctly from an absent one', async () => {
    // Absent means "no plans, nothing can be full" — benign. Unreadable means the plan may exist
    // and admitting everyone silently overshoots the client's quota. Both pass (parking a
    // respondent on a gate we cannot evaluate is worse), but the second must be findable.
    const stepped: { passed: boolean }[] = [];
    const deps = (indeterminate: boolean) => ({
      logic: REHYDRATED,
      manifest: INTERPRET_MANIFEST,
      escapeContext: 'none' as const,
      quota: { reserve: async () => ({ ok: true, soft_full: [], blocked: [] }) } as never,
      quotaGate: {
        ...(indeterminate ? { indeterminate: true } : {}),
        scope: 'srv_1',
        step: (state: never, input: never) => {
          stepped.push({ passed: (input as unknown as { passed: boolean }).passed });
          return { next: state, cmds: [] };
        },
      } as never,
    });

    const absent = await interpret(
      [{ c: 'reserve_quota', quota_ref: 'MAIN', node_id: 'fn_q' }],
      session(),
      fetcher(),
      deps(false),
    );
    const unreadable = await interpret(
      [{ c: 'reserve_quota', quota_ref: 'MAIN', node_id: 'fn_q' }],
      session(),
      fetcher(),
      deps(true),
    );

    expect(absent.events.map(e => e.kind)).toContain('quota.reserve_deferred');
    expect(unreadable.events.map(e => e.kind)).toContain('quota.config_unavailable');
    // Both let the respondent continue.
    expect(stepped).toEqual([{ passed: true }, { passed: true }]);
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
      { logic: REHYDRATED, manifest: INTERPRET_MANIFEST, escapeContext: 'none', quota: quota as never },
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
      { logic: REHYDRATED, manifest: INTERPRET_MANIFEST, escapeContext: 'none', quota: quota as never },
    );

    expect(out.events.map(e => e.kind)).toContain('quota.commit_unavailable');
    expect(out.events.map(e => e.kind)).toContain('quota.committed'); // with cells: 0
  });

  it('records a deferred api_call with its node', async () => {
    const out = await interpret([{ c: 'call_api', node_id: 'fn_api' }], session(), fetcher(), {
      logic: REHYDRATED,
      manifest: INTERPRET_MANIFEST,
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
      { logic: REHYDRATED, manifest: INTERPRET_MANIFEST, escapeContext: 'none' },
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
      manifest: INTERPRET_MANIFEST,
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

/* ---------------------------------------------------------------- *
 * Entry security and inbound parameter binding (P2-04)
 * ---------------------------------------------------------------- */

describe('entry signature verification', () => {
  const SIGNING_SECRET = 'vendor-shared-secret';

  /** The signed vendor, plus the hidden variable its `pid` binds to. */
  function signedVendorArtifact(): FakeArtifact {
    const base = linearArtifact();
    const head = base.head as unknown as {
      manifest: { variable_manifest: unknown[] };
      vendors?: unknown;
    };
    return {
      ...base,
      head: {
        ...(base.head as object),
        manifest: {
          ...(head.manifest as object),
          variable_manifest: [
            ...head.manifest.variable_manifest,
            {
              id: 'var_pid', name: 'VENDOR_PID', kind: 'hidden', type: 'text',
              export_column: 'VENDOR_PID', export_include: true, pii: false, persist: true,
            },
          ],
        },
        vendors: [
          {
            id: 'ven_01', ref: 'V_A', name: 'Panel A',
            inbound_params: [{ param: 'pid', variable_ref: 'VENDOR_PID', required: true }],
            security: {
              hash_param: 'hash', algorithm: 'sha256', secret_ref: 'vault://v_a',
              signed_params: ['pid', 'ts'],
            },
          },
        ],
      } as unknown as ArtifactHead,
    };
  }

  function entryUrl(over: Record<string, string> = {}): string {
    const ts = String(Math.floor(1_700_000_000_000 / 1000));
    const params = new URLSearchParams({ src: 'V_A', pid: 'P12345', ts, ...over });
    const canonical = canonicalString(params, ['pid', 'ts']);
    params.set('hash', signCanonical(SIGNING_SECRET, canonical, 'sha256').toString('hex'));
    return `/s/${TOKEN}?${params.toString()}`;
  }

  function signedDeps(over: Partial<RuntimeDeps> = {}): RuntimeDeps {
    return deps({
      artifacts: loaderFor({ [HASH]: signedVendorArtifact() }),
      vendorSecret: () => SIGNING_SECRET,
      ...over,
    });
  }

  it('a valid HMAC creates a session with the vendor pid populated', async () => {
    const sessions = createMemorySessionStore();
    const d = signedDeps({ sessions });

    const r = await call(d, { path: entryUrl() });

    expect(r.status).toBe(200);
    const saved = await sessions.load(String(r.body.session_id));
    expect(saved?.vars['var_pid' as never]).toBe('P12345');
    // `vendor_ref` was declared and read at redirect time but never SET, so `by_vendor` redirect
    // precedence could not fire for any respondent.
    expect(saved?.vendor_ref).toBe('V_A');
  });

  it('one character of pid changed creates NO session row — the acceptance criterion', async () => {
    const sessions = createMemorySessionStore();
    const d = signedDeps({ sessions });
    const tampered = entryUrl().replace('pid=P12345', 'pid=P12346');

    const r = await call(d, { path: tampered });

    expect(r.status).toBe(403);
    expect(r.body.reason).toBe('INVALID_LINK');
    // Nothing was written. A check that ran after session creation would already have burned a
    // session id, an entry-params row and possibly a quota reservation (security §9).
    expect(await sessions.load('ID000000000000000000000001')).toBeNull();
  });

  it('does not tell the caller WHICH check failed', async () => {
    // The reason is logged, never returned: naming it turns the error page into an oracle for
    // forging a link.
    const d = signedDeps();
    const r = await call(d, { path: entryUrl().replace('pid=P12345', 'pid=X') });

    expect(JSON.stringify(r.body)).not.toContain('sig_');
    expect(JSON.stringify(r.body)).not.toContain('mismatch');
  });

  it('refuses when the deployment has no secret for a vendor that declares signing', async () => {
    const d = signedDeps({ vendorSecret: () => null });

    const r = await call(d, { path: entryUrl() });

    expect(r.status).toBe(403);
  });

  it('a link naming no vendor is unsigned and still admitted', async () => {
    // Direct traffic and QR codes have no `src`. Unsigned is a recorded state, not a refusal.
    const sessions = createMemorySessionStore();
    const d = signedDeps({ sessions });

    const r = await call(d, { path: `/s/${TOKEN}` });

    expect(r.status).toBe(200);
    const saved = await sessions.load(String(r.body.session_id));
    expect(saved?.vendor_ref).toBeNull();
  });

  it('an undeclared query parameter binds to no variable', async () => {
    // The query string is the one input a respondent types freely.
    const sessions = createMemorySessionStore();
    const d = signedDeps({ sessions });

    const r = await call(d, { path: `${entryUrl()}&var_q1=2` });

    expect(r.status).toBe(200);
    const saved = await sessions.load(String(r.body.session_id));
    expect(saved?.vars['var_q1' as never]).toBeUndefined();
  });

  it('a replayed nonce is refused and creates no session', async () => {
    const sessions = createMemorySessionStore();
    const seen = new Set<string>();
    const d = signedDeps({
      sessions,
      consumeNonce: (key: string) => {
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      },
    });
    const url = `${entryUrl()}&n=abc123`;

    expect((await call(d, { path: url })).status).toBe(200);
    const second = await call(d, { path: url });
    expect(second.status).toBe(403);
    expect(second.body.reason).toBe('INVALID_LINK');
  });
});

