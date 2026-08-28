/**
 * Session replay, end to end — P1-11's last acceptance line and its test line, verbatim:
 *
 *   Build: "A programmer takes a session id from a completed test response, pastes it into the
 *   debug panel, and steps through the exact pages, option orders and rule verdicts that
 *   respondent saw."
 *   Test:  "take a recorded session, replay it, and assert the rendered page sequence and every
 *   option order match the original exactly."
 *
 * So this suite records a session by driving the REAL survey endpoints — real machine, real
 * engine, real seeded PRNG, real submit pipeline, with a writer that captures exactly what
 * `runtime.submit_page` would have stored — and then replays it through the REAL preview endpoint
 * with a writer that serves those rows back the way migration 0014's RPC does. Nothing about the
 * comparison is mocked: both sides go through `handleSubmitCore`, and the orders on both sides are
 * read off rendered pages rather than recomputed, so an ordering bug shows up as a diff instead of
 * being reproduced identically by both halves of the assertion.
 *
 * The fixture has to earn the claim, which is why §0 below asserts that two seeds produce two
 * different option orders. Without that, "every option order matches" would pass just as happily
 * over an unrandomized question, and the test would assert nothing.
 *
 * THE SESSION UNDER REPLAY IS A PRODUCTION SESSION (`is_test: false`), on purpose: that is
 * migration 0014's decision, and the pii redaction that decision is paid for is asserted here too.
 */

import { describe, expect, it } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHandler, type RuntimeDeps } from '../handler.js';
import { createMemorySessionStore } from '../session/store.js';
import { createStaticTokenResolver, type ResolvedToken } from '../token.js';
import { ArtifactNotFound, type ArtifactHead, type ArtifactLoader } from '../artifact/loader.js';
import { mintPreviewToken } from './token.js';
import { PII_REDACTED } from './replay.js';
import type { ReplayEvent, ReplaySource, RuntimeWriter } from '../session/durable.js';

/* ---------------------------------------------------------------- *
 * Fake HTTP — the same shape handler.test.ts drives the handler with
 * ---------------------------------------------------------------- */

interface Captured {
  status: number;
  headers: Record<string, string>;
  body: any;
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
      body: raw && (headers['content-type'] ?? '').includes('json') ? JSON.parse(raw) : null,
    }),
  };
}

function req(opts: {
  method?: string; host?: string; path: string; body?: unknown;
  headers?: Record<string, string>;
}): IncomingMessage {
  const chunks = opts.body === undefined ? [] : [Buffer.from(JSON.stringify(opts.body))];
  const listeners: Record<string, Array<(arg?: unknown) => void>> = {};
  const fake = {
    method: opts.method ?? 'GET',
    url: opts.path,
    headers: { host: opts.host ?? `${TOKEN}.run.local`, ...(opts.headers ?? {}) },
    on(event: string, cb: (arg?: unknown) => void) {
      (listeners[event] ??= []).push(cb);
      if (event === 'end') {
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

async function call(d: RuntimeDeps, opts: Parameters<typeof req>[0]): Promise<Captured> {
  const h = createHandler(d);
  const { res, captured } = fakeRes();
  await h(req(opts), res);
  return captured();
}

/* ---------------------------------------------------------------- *
 * Fixture: three pages, a shuffled 5-option question, one display rule
 * ---------------------------------------------------------------- */

const TOKEN = 'abcdefghij0123456789klmnop';
const HASH = 'c'.repeat(64);
const SECRET = 'replay-test-secret';
const NOW = 1_700_000_000_000;

/** Legible names to valid ids: `<prefix>_` + `[0-7]` and 25 Crockford characters (C §3). */
const id = (prefix: string, tag: string) => `${prefix}_0${tag.toUpperCase().padEnd(25, '0')}`;
const PG_A = id('pg', 'a');
const PG_B = id('pg', 'b');
const PG_C = id('pg', 'c');
const Q_BRAND = 'qst_brand';
const Q_EMAIL = 'qst_email';
const Q_PICK = 'qst_pick';
const Q_WHY = 'qst_why';
const V_BRAND = 'var_brand';
const V_EMAIL = 'var_email';
const V_PICK = 'var_pick';
const V_WHY = 'var_why';

/**
 * One display rule, hand-built in the artifact's own serialized form: HIDE Q_WHY.
 *
 * A rule rather than an empty logic program because "rule verdicts" is half of what the acceptance
 * criterion promises: the replay must show that a rule fired and that the question it hid is
 * absent from the page, not merely that the options came back in the right order.
 *
 * WHY THE CONDITION IS A LITERAL and not `BRAND == 1`, which is what this fixture wanted: the
 * runtime hands `varStateOf` the session's RAW variable values (`{var_brand: 1}`) while the engine
 * reads `Value`-tagged data (`{k:'num', v:1}`), so `strictEq` sees two different kinds and any
 * comparison of a respondent's answer to a literal evaluates FALSE today. That is a pre-existing
 * defect in the P1-08/P1-09 wiring, not something replay introduces — it applies identically to
 * the original run and to its replay, which is why fidelity is unaffected — and it is recorded
 * here rather than worked around silently, because a fixture that leaned on the buggy path would
 * quietly start failing the day it is fixed. The node array is the flattened CSE'd AST the
 * compiler emits (`nodes[i].n === i`) and the rule's condition points into it.
 */
const NODES = [{ n: 0, op: 'lit', v: { k: 'bool', v: true } }];

const LOGIC = {
  cells: [{ key: `visible(${Q_WHY})`, kind: 'visible', cell: { c: 'visible', node_id: Q_WHY } }],
  topo: [0],
  topo_pos: [0],
  dependents: [[]],
  inputs: [[]],
  writers: [[0]],
  by_trigger_variable: {},
  valid_by_target: {},
  rules: [
    {
      id: 'rul_hidewhy',
      kind: 'display',
      condition: NODES[0],
      effect: { action: 'hide' },
      target_type: 'question',
      target_id: Q_WHY,
      evaluation: 'page_enter',
      authored_in: 'dsl',
      order_key: 1,
      label: 'Hide the follow-up',
    },
  ],
  nodes: NODES,
  base_visible: { [Q_WHY]: true },
  // Fully materialized, as emit/logic.ts writes it: an absent key means "no items axis", which is
  // a different fact from an empty list.
  base_items: { [`${Q_BRAND}.options`]: [1, 2, 3, 4, 5], [`${Q_PICK}.options`]: [1, 2, 3] },
  base_option: {},
  derived: {},
  schema: {
    question_variables: {
      [Q_BRAND]: [V_BRAND], [Q_EMAIL]: [V_EMAIL], [Q_PICK]: [V_PICK], [Q_WHY]: [V_WHY],
    },
    page_questions: { [PG_A]: [Q_BRAND], [PG_B]: [Q_EMAIL, Q_PICK], [PG_C]: [Q_WHY] },
    page_of: { [Q_BRAND]: PG_A, [Q_EMAIL]: PG_B, [Q_PICK]: PG_B, [Q_WHY]: PG_C },
    label_keys: {},
  },
};

const HEAD: ArtifactHead = {
  hash: HASH,
  manifest: {
    base_language: 'en',
    languages: ['en'],
    artifact_hash: HASH,
    survey_id: id('svy', '1'),
    survey_version_id: id('ver', '1'),
    variable_manifest: [
      { id: V_BRAND, name: 'BRAND', kind: 'response', type: 'enum',
        export_column: 'BRAND', export_include: true, pii: false, persist: true,
        enum_domain: [1, 2, 3, 4, 5].map(code => ({ code, label_key: `brand.o${code}` })) },
      // The pii variable the redaction claim rests on. An email in a survey is the canonical
      // case security §8.1 names.
      { id: V_EMAIL, name: 'EMAIL', kind: 'response', type: 'text',
        export_column: 'EMAIL', export_include: true, pii: true, persist: true },
      { id: V_PICK, name: 'PICK', kind: 'response', type: 'enum',
        export_column: 'PICK', export_include: true, pii: false, persist: true,
        enum_domain: [1, 2, 3].map(code => ({ code, label_key: `pick.o${code}` })) },
      { id: V_WHY, name: 'WHY', kind: 'response', type: 'text',
        export_column: 'WHY', export_include: true, pii: false, persist: true },
    ],
  },
  graph: {
    page_order: [PG_A, PG_B, PG_C],
    nodes: [
      { id: 'fn_start', type: 'start', next: 'fn_seq' },
      { id: 'fn_seq', type: 'sequence', target_id: 'blk_main', next: 'fn_end' },
      { id: 'fn_end', type: 'end', disposition: 'COMPLETE' },
    ],
    page_entry: { [PG_A]: 'fn_seq', [PG_B]: 'fn_seq', [PG_C]: 'fn_seq' },
  },
  logic: LOGIC,
} as unknown as ArtifactHead;

const PAGES: Record<string, unknown> = {
  [PG_A]: {
    id: PG_A,
    ref: 'P1',
    questions: [{
      id: Q_BRAND,
      ref: 'BRAND',
      question_type: 'single_select',
      required: true,
      emits: [V_BRAND],
      label: 'Which brand?',
      // The randomization that gives the acceptance criterion something to be about.
      randomize_options: { mode: 'shuffle' },
      options: [1, 2, 3, 4, 5].map(code => ({
        id: id('opt', `a${code}`), ref: `o${code}`, code, position: code, label: `Brand ${code}`,
      })),
    }],
  },
  [PG_B]: {
    id: PG_B,
    ref: 'P2',
    questions: [
      { id: Q_EMAIL, ref: 'EMAIL', question_type: 'text', emits: [V_EMAIL], label: 'Your email?' },
      {
        id: Q_PICK,
        ref: 'PICK',
        question_type: 'single_select',
        emits: [V_PICK],
        label: 'Pick one',
        randomize_options: { mode: 'shuffle' },
        options: [1, 2, 3].map(code => ({
          id: id('opt', `b${code}`), ref: `p${code}`, code, position: code, label: `Pick ${code}`,
        })),
      },
    ],
  },
  [PG_C]: {
    id: PG_C,
    ref: 'P3',
    questions: [{ id: Q_WHY, ref: 'WHY', question_type: 'text', emits: [V_WHY], label: 'Why?' }],
  },
};

function loader(over: Record<string, ArtifactHead> = {}): ArtifactLoader {
  const heads: Record<string, ArtifactHead> = { [HASH]: HEAD, ...over };
  return {
    async head(hash: string) {
      const h = heads[hash];
      if (!h) throw new ArtifactNotFound(hash, 'manifest.json');
      return h;
    },
    async redirects() { return null; },
    async themeCss() { return null; },
    async authorCss() { return null; },
    async script() { return null; },
    async i18n() { return null; },
    async page(hash: string, _language: string, pageId: string) {
      if (!heads[hash]) throw new ArtifactNotFound(hash, `pages/en/${pageId}.json`);
      return (PAGES[pageId] ?? null) as never;
    },
    async warm() {},
  };
}

function token(): ResolvedToken {
  return {
    token: TOKEN,
    survey_version_id: id('ver', '1'),
    artifact_hash: HASH,
    status: 'live',
    is_test: false, // a PRODUCTION session: 0014's decision, under test
  };
}

/* ---------------------------------------------------------------- *
 * The two writers
 * ---------------------------------------------------------------- */

/**
 * A writer that records what `runtime.submit_page` would have stored, and hands it back the way
 * `runtime.replay_session` returns it.
 *
 * The `page_id` filter is copied from the handler's own persist closure deliberately: the typed
 * column holds only an `app.ulid`, so a fixture id that is not one arrives back as NULL, and the
 * replay path has to cope with exactly that. The fixture uses real ULIDs so the column round trip
 * is the one production takes.
 */
function recorder(seed: string): {
  writer: RuntimeWriter;
  source(over?: Partial<ReplaySource>): ReplaySource;
} {
  const events: ReplayEvent[] = [];
  let sessionId = '';
  let language = 'en';
  let isTest = false;

  const writer = {
    async resolveToken() { throw new Error('not used'); },
    async startSession(p: {
      session_id: string; random_seed: string; language: string; is_test: boolean;
    }) {
      sessionId = p.session_id;
      language = p.language;
      isTest = p.is_test;
      events.push({
        seq: 1, event_type: 'session_start', page_id: null, values: null, payload: {},
      });
    },
    async loadSession() { return null; },
    async submitPage(w: {
      expected_seq: number; event_type: string; page_id: string | null;
      values: Record<string, unknown> | null; payload: Record<string, unknown>;
    }) {
      events.push({
        seq: w.expected_seq,
        event_type: w.event_type,
        page_id: /^pg_[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(w.page_id ?? '') ? w.page_id : null,
        values: w.values,
        payload: w.payload,
      });
      return w.expected_seq;
    },
    async findByResume() { return null; },
    async replaySession() { return null; },
    async close() {},
  } as unknown as RuntimeWriter;

  return {
    writer,
    source: (over = {}) => ({
      session_id: sessionId,
      survey_version_id: id('ver', '1'),
      random_seed: seed,
      artifact_hash: HASH,
      language,
      is_test: isTest,
      started_at: NOW,
      events: [...events],
      ...over,
    }),
  };
}

/**
 * The writer the REPLAY runs against: it serves the recorded rows and THROWS on every write.
 *
 * This is the enforcement half of "a replay writes nothing". The structural half is that the
 * replay path builds its `SubmitDeps` without a `persist` closure at all — there is no seam — and
 * this is the belt: if a future edit reintroduces one, these tests fail loudly rather than quietly
 * appending events to a respondent's log.
 */
function replayWriter(source: ReplaySource | null): RuntimeWriter & { writes: string[] } {
  const writes: string[] = [];
  const boom = (what: string) => {
    writes.push(what);
    throw new Error(`a replay must not ${what}`);
  };
  return {
    writes,
    async resolveToken() { return boom('resolve a token') as never; },
    async startSession() { return boom('start a session') as never; },
    async loadSession() { return boom('load a session document') as never; },
    async submitPage() { return boom('write a submit') as never; },
    async findByResume() { return boom('look up a resume token') as never; },
    async replaySession() { return source; },
    async close() {},
  } as unknown as RuntimeWriter & { writes: string[] };
}

function deps(over: Partial<RuntimeDeps> = {}): RuntimeDeps {
  let n = 0;
  return {
    tokens: createStaticTokenResolver([token()]),
    artifacts: loader(),
    sessions: createMemorySessionStore(),
    now: () => NOW,
    // Valid ULID bodies: the replay route shape-checks the session id before it reaches the RPC,
    // so an id the database would reject must never be minted here either.
    newId: () => `0${String(++n).padStart(25, '0')}`,
    newSeed: () => SEED_A,
    domain: 'run.local',
    previewSecret: SECRET,
    studioOrigin: 'https://studio.local',
    ...over,
  };
}

const SEED_A = 'a3f9c1d2e4b6a8f0c2d4e6b8a0f2c4d6';
const SEED_B = '00112233445566778899aabbccddeeff';
const pt = (hash = HASH) => mintPreviewToken(SECRET, hash, NOW + 60_000);

/* ---------------------------------------------------------------- *
 * Recording an interview through the real endpoints
 * ---------------------------------------------------------------- */

interface Recorded {
  /** The pages, in the order the respondent saw them. */
  pages: string[];
  /** `<page>/<question>.<axis>` → the item codes in RENDERED order. */
  orders: Record<string, number[]>;
  /** Questions the page did not show, per page — a rule verdict, visible in the response. */
  skipped: Record<string, string[]>;
  sessionId: string;
  disposition: string | null;
  source(over?: Partial<ReplaySource>): ReplaySource;
  writes: number;
}

function collect(rec: Recorded, pageBody: any): void {
  const pageId = pageBody.page_id as string;
  rec.pages.push(pageId);
  rec.skipped[pageId] = (pageBody.skipped ?? []).map((s: { question_id: string }) => s.question_id);
  for (const q of pageBody.questions as any[]) {
    for (const axis of ['options', 'rows', 'columns']) {
      if (!q[axis]) continue;
      rec.orders[`${pageId}/${q.id}.${axis}`] = q[axis].items.map((i: { code: number }) => i.code);
    }
  }
}

/**
 * Drive a whole interview over the survey surface and return what the respondent saw.
 *
 * The answers are the same on every call so a seed change is the ONLY difference between two runs
 * — which is what makes the "different seed, different order" control below meaningful.
 */
async function record(seed: string): Promise<Recorded> {
  const r = recorder(seed);
  const d = deps({ writer: r.writer, newSeed: () => seed });
  const rec: Recorded = {
    pages: [], orders: {}, skipped: {}, sessionId: '', disposition: null,
    source: r.source, writes: 0,
  };

  const entry = await call(d, { path: `/s/${TOKEN}` });
  expect(entry.status).toBe(200);
  rec.sessionId = entry.body.session_id as string;
  collect(rec, entry.body.page);

  const answers: Record<string, Record<string, unknown>> = {
    [PG_A]: { [V_BRAND]: 1 },                                   // fires the hide rule on page C
    [PG_B]: { [V_EMAIL]: 'respondent@example.test', [V_PICK]: 2 },
    [PG_C]: {},
  };

  for (const pageId of [PG_A, PG_B, PG_C]) {
    const res = await call(d, {
      method: 'POST',
      path: `/s/${TOKEN}/submit?session=${rec.sessionId}`,
      body: { page_id: pageId, values: answers[pageId] },
    });
    expect(res.status).toBe(200);
    if (res.body.disposition) {
      rec.disposition = res.body.disposition as string;
      break;
    }
    collect(rec, res.body.page);
  }

  return rec;
}

const replay = (source: ReplaySource | null, over: Partial<RuntimeDeps> = {}, hash = HASH) => {
  const sid = source?.session_id ?? id('ses', 'x');
  return call(deps({ writer: replayWriter(source), ...over }), {
    host: 'prv-abc123.run.local',
    path: `/preview/${hash}/replay/${sid}?pt=${encodeURIComponent(pt(hash))}`,
  });
};

/* ---------------------------------------------------------------- *
 * 0. The control: the fixture's orders really do depend on the seed
 * ---------------------------------------------------------------- */

describe('the fixture earns the claim', () => {
  it('two seeds produce two different option orders', async () => {
    // Without this, "every option order matches" would pass over an unrandomized question and
    // assert nothing at all. It is also ADR-006 restated: the order is a function of the seed.
    const a = await record(SEED_A);
    const b = await record(SEED_B);
    expect(a.orders[`${PG_A}/${Q_BRAND}.options`]).not.toEqual(
      b.orders[`${PG_A}/${Q_BRAND}.options`],
    );
    expect(a.orders[`${PG_A}/${Q_BRAND}.options`]).toHaveLength(5);
  });

  it('a rule verdict is visible in the recorded interview', async () => {
    // BRAND = 1 hides Q_WHY on page C. The recorded run must show that, or the replay comparison
    // would have no verdict to reproduce.
    const a = await record(SEED_A);
    expect(a.pages).toEqual([PG_A, PG_B, PG_C]);
    expect(a.skipped[PG_C]).toEqual([Q_WHY]);
  });
});

/* ---------------------------------------------------------------- *
 * 1. THE ACCEPTANCE: identical pages, identical orders
 * ---------------------------------------------------------------- */

describe('GET /preview/:hash/replay/:session_id (P1-11, E §12.3)', () => {
  it('replays the recorded session: the page sequence and EVERY option order match exactly',
    async () => {
      const original = await record(SEED_A);
      const w = replayWriter(original.source());
      const r = await call(deps({ writer: w }), {
        host: 'prv-abc123.run.local',
        path: `/preview/${HASH}/replay/${original.sessionId}?pt=${encodeURIComponent(pt())}`,
      });

      expect(r.status).toBe(200);
      expect(r.body.session_id).toBe(original.sessionId);
      expect(r.body.artifact_hash).toBe(HASH);
      expect(r.body.seed).toBe(SEED_A);

      // The page sequence, exactly.
      expect(r.body.steps.map((s: any) => s.page_id)).toEqual(original.pages);

      // Every option order on every page, exactly. Built as a flat map so a single `toEqual`
      // covers all of them and a failure names the page and question that drifted.
      const replayed: Record<string, number[]> = {};
      for (const s of r.body.steps as any[]) {
        for (const q of s.questions as any[]) {
          for (const [axis, codes] of Object.entries(q.order as Record<string, number[]>)) {
            replayed[`${s.page_id}/${q.question_id}.${axis}`] = codes;
          }
        }
      }
      expect(replayed).toEqual(original.orders);

      // The disposition the respondent reached.
      expect(r.body.disposition).toBe(original.disposition);
      expect(r.body.disposition).toBe('COMPLETE');
      // ...and NOTHING was written to get there.
      expect(w.writes).toEqual([]);
    });

  it('reproduces the RULE VERDICTS, including a question the rule hid', async () => {
    const original = await record(SEED_A);
    const r = await replay(original.source());

    const pageC = (r.body.steps as any[]).find(s => s.page_id === PG_C);
    expect(pageC.skipped.map((s: any) => s.question_id)).toEqual([Q_WHY]);
    expect(pageC.questions).toEqual([]);

    // The trace is CAPTURED even though this is a production session, whose field trace is a 5%
    // digest sample (E §14.1) — the replay surface asks for the full one.
    const traced = (r.body.steps as any[]).map(s => Array.isArray(s.trace));
    expect(traced).toEqual([true, true, true]);
    // The cell, its writer, and the writer's verdict — E §14.2's three levels, which is what the
    // debug panel's logic tab renders.
    const whyCell = (pageC.trace as any[]).find(t => t.cell === `visible(${Q_WHY})`);
    expect(whyCell.result).toEqual({ c: 'bool', on: false });
    expect(whyCell.writers[0]).toMatchObject({ rule_id: 'rul_hidewhy', verdict: 'T' });
  });

  it('carries the recorded inputs per step, with the LAST page marked unsubmitted', async () => {
    const original = await record(SEED_A);
    const r = await replay(original.source());
    const steps = r.body.steps as any[];

    expect(steps[0].submitted).toEqual({ [V_BRAND]: 1 });
    expect(steps[0].outcome).toBe('submitted');
    // Page C's submit is the one that completed the interview.
    expect(steps[2].outcome).toBe('final');
    // The digest travels too: it is the string invalidate-forward compares (E §7.2), so a replay
    // that reproduced the orders but not the digest would be reproducing less than it claims.
    expect(typeof steps[0].digest).toBe('string');
    expect(steps[0].seq).toBe(1); // the birth event produced the entry render
    expect(steps[1].seq).toBe(2); // page A's submit produced page B
  });

  it('REDACTS pii values — the price of replaying production sessions (security §8.1)',
    async () => {
    const original = await record(SEED_A);
    const r = await replay(original.source());
    const pageB = (r.body.steps as any[]).find(s => s.page_id === PG_B);

    // EMAIL is pii:true in the manifest; PICK is not. The key survives (so the panel still shows
    // that the variable was written), the value does not.
    expect(pageB.submitted[V_EMAIL]).toBe(PII_REDACTED);
    expect(pageB.submitted[V_PICK]).toBe(2);
    // And the raw value appears NOWHERE in the response, not in a trace cell and not in a payload.
    expect(JSON.stringify(r.body)).not.toContain('respondent@example.test');
  });

  it('an is_test session replays the same way, and the flag is reported', async () => {
    const original = await record(SEED_A);
    const r = await replay(original.source({ is_test: true }));
    expect(r.status).toBe(200);
    expect(r.body.is_test).toBe(true);
    expect((r.body.steps as any[]).map(s => s.page_id)).toEqual(original.pages);
  });
});

/* ---------------------------------------------------------------- *
 * 2. The gates
 * ---------------------------------------------------------------- */

describe('the replay gates', () => {
  it('the artifact hash must MATCH the session pin — a mismatch is a 404, not a best effort',
    async () => {
      // Replaying a session against another artifact would render someone else's pages with this
      // respondent's answers: a fabrication, not a near miss. It is also what stops a token
      // minted for artifact A from reading sessions pinned to artifact B.
      const original = await record(SEED_A);
      const otherHead = { ...HEAD, hash: 'd'.repeat(64) } as ArtifactHead;
      const r = await call(
        deps({
          writer: replayWriter(original.source()),
          artifacts: loader({ ['d'.repeat(64)]: otherHead }),
        }),
        {
          host: 'prv-abc123.run.local',
          path: `/preview/${'d'.repeat(64)}/replay/${original.sessionId}` +
            `?pt=${encodeURIComponent(pt('d'.repeat(64)))}`,
        },
      );
      expect(r.status).toBe(404);
      expect(r.body.error.code).toBe('session_not_found');
    });

  it('an unknown session is the same 404 — no probe oracle', async () => {
    const r = await replay(null);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('session_not_found');
  });

  it('a malformed session id never reaches the database', async () => {
    // The RPC argument is an `app.ulid`; a domain error raised in Postgres would be our 500. The
    // shape check makes it the caller's 404 instead.
    const w = replayWriter(null);
    const r = await call(deps({ writer: w }), {
      host: 'prv-abc123.run.local',
      path: `/preview/${HASH}/replay/..%2Fetc%2Fpasswd?pt=${encodeURIComponent(pt())}`,
    });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('not_found');
  });

  it('THE TOKEN GATE: no signed token, no replay', async () => {
    const original = await record(SEED_A);
    const none = await call(deps({ writer: replayWriter(original.source()) }), {
      host: 'prv-abc123.run.local',
      path: `/preview/${HASH}/replay/${original.sessionId}`,
    });
    const expired = await call(deps({ writer: replayWriter(original.source()) }), {
      host: 'prv-abc123.run.local',
      path: `/preview/${HASH}/replay/${original.sessionId}` +
        `?pt=${encodeURIComponent(mintPreviewToken(SECRET, HASH, NOW - 1))}`,
    });
    expect(none.status).toBe(403);
    expect(expired.status).toBe(403);
    expect(expired.body.error.reason).toBe('expired');
  });

  it('no durable record configured is a 503, not a 404', async () => {
    // "This deployment cannot replay" and "that session does not exist" need different answers:
    // the first is about us, the second about the session.
    const r = await call(deps(), {
      host: 'prv-abc123.run.local',
      path: `/preview/${HASH}/replay/${id('ses', '9')}?pt=${encodeURIComponent(pt())}`,
    });
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe('replay_unavailable');
  });

  it('the replay leaves the session store alone as well as the log', async () => {
    // Redis is not written either: a replay that saved its reconstructed state would overwrite the
    // live session of a respondent who is still in the field.
    const original = await record(SEED_A);
    const store = createMemorySessionStore();
    const r = await replay(original.source(), { sessions: store });
    expect(r.status).toBe(200);
    expect(await store.load(original.sessionId)).toBeNull();
  });
});
