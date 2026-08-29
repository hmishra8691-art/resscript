/**
 * Test suite for artifact loading.
 *
 * The property that matters most is the one C §17 promises and that is easiest to lose: rendering
 * page 40 of a 2,000-question survey must cost the same number of byte-reads as page 1 of a
 * 20-question one. That is a claim about *how many fetches happen*, so most of these tests count
 * fetches rather than checking return values.
 *
 * The module this replaced fetched only `manifest.json` and cast the result to a full
 * `CompiledArtifact` behind a TODO, so a *successful* load returned an artifact with no `graph`
 * and no `pages` — every session would have terminated with no error anywhere. The
 * validation tests below are the guard against that shape of failure returning.
 */

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { artifactKey } from '@resscript/schema';

import {
  ArtifactNotFound,
  createLoader,
  fileSource,
  httpSource,
  type ArtifactSource,
} from './loader.js';

/* ---------------------------------------------------------------- *
 * Fixtures
 * ---------------------------------------------------------------- */

const HASH = 'ab'.repeat(32);

const MANIFEST = {
  base_language: 'en',
  languages: ['en'],
  artifact_hash: '',
  // Present because `head()` now refuses a manifest without it: an empty variable world
  // evaluates every rule to UNKNOWN with no error anywhere, which is the failure the loader
  // already refuses for `graph.nodes`.
  variable_manifest: [],
};
const GRAPH = {
  page_order: ['pg_1', 'pg_2'],
  nodes: [
    { id: 'fn_start', type: 'start', next: 'fn_seq' },
    { id: 'fn_seq', type: 'sequence', target_id: 'blk', next: 'fn_end' },
    { id: 'fn_end', type: 'end', disposition: 'COMPLETE' },
  ],
  page_entry: { pg_1: 'fn_seq', pg_2: 'fn_seq' },
};
const LOGIC = { cells: [], rules: [], nodes: [] };
const PAGE_1 = { id: 'pg_1', ref: 'P1', questions: [] };

/** An in-memory source over a `path -> body` map, counting every fetch. */
function memSource(
  files: Record<string, unknown>,
  opts: { name?: string; fail?: boolean } = {},
): ArtifactSource & { fetches: string[] } {
  const fetches: string[] = [];
  return {
    name: opts.name ?? 'mem',
    fetches,
    async fetch(hash: string, path: string) {
      fetches.push(`${hash}/${path}`);
      if (opts.fail) throw new Error(`${opts.name ?? 'mem'} unreachable`);
      const body = files[path];
      return body === undefined ? null : JSON.stringify(body);
    },
  };
}

/** `quotas.json` as the compiler emits it — enough of a plan for the loader to carry. */
const QUOTAS = {
  policy: {
    count_at: 'reservation',
    reservation_ttl_s: 5400,
    on_store_unavailable: 'fail_closed',
    counter_scope: 'survey',
  },
  dimensions: [],
  plans: [],
};

/** `vendors.json` as the compiler emits it: refs and inbound params, `secret_ref` but no secret. */
const VENDORS = [
  {
    id: 'ven_01ABC',
    ref: 'V_A',
    name: 'Panel A',
    inbound_params: [{ param: 'pid', variable_ref: 'VENDOR_PID', required: true }],
  },
];

/**
 * A COMPLETE artifact, `quotas.json` and `vendors.json` included.
 *
 * Complete matters for the tier tests: an optional file the fixture omits is legitimately looked
 * for in every tier (it might be in a later one), so a fixture missing `quotas.json` would make
 * "the first source that answers serves the head" false for a reason that has nothing to do with
 * tiering. `filesWithout` builds the incomplete variants where that is the point.
 */
function fullFiles(): Record<string, unknown> {
  return {
    'manifest.json': MANIFEST,
    'graph.json': GRAPH,
    'logic.json': LOGIC,
    'quotas.json': QUOTAS,
    'vendors.json': VENDORS,
    'pages/en/pg_1.json': PAGE_1,
    'pages/en/pg_2.json': { id: 'pg_2', ref: 'P2', questions: [] },
  };
}

function filesWithout(path: string): Record<string, unknown> {
  const files = fullFiles();
  delete files[path];
  return files;
}

/* ---------------------------------------------------------------- *
 * Head
 * ---------------------------------------------------------------- */

/**
 * How many files one head costs: manifest, graph, logic, quotas, vendors.
 *
 * Named rather than inlined because three separate tests assert it and what they are each really
 * asserting is "the head is a FIXED cost, independent of survey size / served by one tier" — not
 * the number itself. `quotas.json` made it four (roadmap P2-06) and `vendors.json` five (P2-04);
 * each was one edit here, and any test that has to change by more than this constant is asserting
 * something else and should say so.
 */
const HEAD_FILE_COUNT = 5;

describe('head', () => {
  it('loads manifest, graph and logic', async () => {
    const loader = createLoader({ sources: [memSource(fullFiles())] });
    const head = await loader.head(HASH);

    expect(head.hash).toBe(HASH);
    expect(head.manifest.base_language).toBe('en');
    expect(head.graph.nodes).toHaveLength(3);
    expect(head.logic).toBeDefined();
  });

  it('fetches exactly the head files — no pages', async () => {
    // The whole point of the split. A head that pulled pages would make entry cost scale with
    // survey size.
    //
    // `quotas.json` joined the head with the quota gate (roadmap P2-06): it is small, immutable
    // and needed at the one step that already has to talk to Redis, so fetching it here rather
    // than at the gate keeps storage latency off a respondent who is waiting on a decision. It is
    // optional — a survey with no quotas has no such file and the fetch answers null — which is
    // why the assertion is on the set of requests and not on a count.
    const src = memSource(fullFiles());
    await createLoader({ sources: [src] }).head(HASH);

    expect(src.fetches.sort()).toEqual([
      `${HASH}/graph.json`,
      `${HASH}/logic.json`,
      `${HASH}/manifest.json`,
      `${HASH}/quotas.json`,
      `${HASH}/vendors.json`,
    ]);
  });

  it('carries quotas.json when the survey has one', async () => {
    const head = await createLoader({ sources: [memSource(fullFiles())] }).head(HASH);

    expect(head.quotas?.policy.counter_scope).toBe('survey');
    expect(head.quotasIndeterminate).toBeUndefined();
  });

  it('a survey with no quotas.json loads with no quotas and no complaint', async () => {
    // The common case by far. Absence is a legitimate answer, not a degraded one.
    const head = await createLoader({
      sources: [memSource(filesWithout('quotas.json'))],
    }).head(HASH);

    expect(head.quotas).toBeUndefined();
    expect(head.quotasIndeterminate).toBeUndefined();
  });

  it('a quotas.json that could not be READ is marked indeterminate, not treated as absent', async () => {
    // The distinction the gate depends on. A broken tier plus no tier holding the file means the
    // plan may exist and be unreadable — and a gate that then admitted everyone would overshoot
    // the client's quota silently. The head still loads (the required files are all present);
    // it just refuses to claim the survey has no quotas.
    const down = memSource({}, { name: 'down', fail: true });
    const up = memSource(filesWithout('quotas.json'), { name: 'up' });

    const head = await createLoader({ sources: [down, up] }).head(HASH);

    expect(head.quotas).toBeUndefined();
    expect(head.quotasIndeterminate).toBe(true);
    // And the rest of the head is intact — an unreadable optional file must not break rendering.
    expect(head.graph.nodes).toHaveLength(3);
  });

  it('caches, so a second session on the same survey fetches nothing', async () => {
    const src = memSource(fullFiles());
    const loader = createLoader({ sources: [src] });
    await loader.head(HASH);
    src.fetches.length = 0;
    await loader.head(HASH);

    expect(src.fetches).toEqual([]);
  });

  it('returns the identical object from cache', async () => {
    // Artifacts are immutable (ADR-002), so sharing one object across sessions is safe and is
    // what keeps a hot survey's head out of the allocator.
    const loader = createLoader({ sources: [memSource(fullFiles())] });
    expect(await loader.head(HASH)).toBe(await loader.head(HASH));
  });

  it('throws ArtifactNotFound when the manifest is absent', async () => {
    const files = fullFiles();
    delete files['manifest.json'];
    const loader = createLoader({ sources: [memSource(files)] });

    await expect(loader.head(HASH)).rejects.toThrow(ArtifactNotFound);
  });

  it('throws when the graph is absent', async () => {
    const files = fullFiles();
    delete files['graph.json'];
    const loader = createLoader({ sources: [memSource(files)] });

    await expect(loader.head(HASH)).rejects.toThrow(ArtifactNotFound);
  });

  it('throws when the logic is absent', async () => {
    const files = fullFiles();
    delete files['logic.json'];
    const loader = createLoader({ sources: [memSource(files)] });

    await expect(loader.head(HASH)).rejects.toThrow(ArtifactNotFound);
  });

  it('rejects a graph with no flow nodes', async () => {
    // This is the shape the previous implementation produced on success. A head like this sends
    // every respondent to TERMINATE with nothing in the log explaining why, so it is refused here
    // where the hash is still in hand.
    const loader = createLoader({
      sources: [memSource({ ...fullFiles(), 'graph.json': { ...GRAPH, nodes: [] } })],
    });

    await expect(loader.head(HASH)).rejects.toThrow(/no flow nodes/);
  });

  it('rejects a graph with no page_entry index', async () => {
    const graph = { page_order: [], nodes: GRAPH.nodes };
    const loader = createLoader({ sources: [memSource({ ...fullFiles(), 'graph.json': graph })] });

    await expect(loader.head(HASH)).rejects.toThrow(/no page_entry/);
  });

  it('rejects a truncated file loudly rather than returning a partial object', async () => {
    const broken: ArtifactSource = {
      name: 'broken',
      async fetch(_h, path) {
        return path === 'graph.json' ? '{"nodes":[' : JSON.stringify(MANIFEST);
      },
    };
    const loader = createLoader({ sources: [broken] });

    await expect(loader.head(HASH)).rejects.toThrow(/not valid JSON/);
  });
});

/* ---------------------------------------------------------------- *
 * Pages
 * ---------------------------------------------------------------- */

describe('page', () => {
  it('loads one page', async () => {
    const loader = createLoader({ sources: [memSource(fullFiles())] });
    const page = await loader.page(HASH, 'en', 'pg_1');

    expect(page?.id).toBe('pg_1');
  });

  it('fetches only the page asked for', async () => {
    const src = memSource(fullFiles());
    const loader = createLoader({ sources: [src] });
    await loader.head(HASH);
    src.fetches.length = 0;
    await loader.page(HASH, 'en', 'pg_1');

    expect(src.fetches).toEqual([`${HASH}/pages/en/pg_1.json`]);
  });

  it('per-page cost does not scale with survey size', async () => {
    // The roadmap's acceptance criterion, stated as a test: a 500-page survey and a 2-page one
    // must cost the same number of reads to render one page.
    const big: Record<string, unknown> = { ...fullFiles() };
    for (let i = 0; i < 500; i++) {
      big[`pages/en/pg_big_${i}.json`] = { id: `pg_big_${i}`, ref: `B${i}`, questions: [] };
    }
    const src = memSource(big);
    const loader = createLoader({ sources: [src] });

    await loader.head(HASH);
    const afterHead = src.fetches.length;
    await loader.page(HASH, 'en', 'pg_big_499');

    expect(afterHead).toBe(HEAD_FILE_COUNT);
    expect(src.fetches.length - afterHead).toBe(1);
  });

  it('returns null for a page the artifact does not have', async () => {
    const loader = createLoader({ sources: [memSource(fullFiles())] });
    expect(await loader.page(HASH, 'en', 'pg_ghost')).toBeNull();
  });

  it('caches a known-missing page, so a retry costs nothing', async () => {
    // Re-fetching a 404 on every render is a per-page cost C §17 does not allow.
    const src = memSource(fullFiles());
    const loader = createLoader({ sources: [src] });
    await loader.page(HASH, 'en', 'pg_ghost');
    src.fetches.length = 0;
    await loader.page(HASH, 'en', 'pg_ghost');

    expect(src.fetches).toEqual([]);
  });

  it('keys the cache by language', async () => {
    // Pages are per-language in the compiler's tree, so `en` and `de` are different files and a
    // language-blind cache would serve a respondent the wrong translation.
    const src = memSource({
      ...fullFiles(),
      'pages/de/pg_1.json': { id: 'pg_1', ref: 'P1-de', questions: [] },
    });
    const loader = createLoader({ sources: [src] });

    expect((await loader.page(HASH, 'en', 'pg_1'))?.ref).toBe('P1');
    expect((await loader.page(HASH, 'de', 'pg_1'))?.ref).toBe('P1-de');
  });

  it('keys the cache by hash', async () => {
    const OTHER = 'cd'.repeat(32);
    const src: ArtifactSource = {
      name: 'per-hash',
      async fetch(hash, path) {
        if (path !== 'pages/en/pg_1.json') return null;
        return JSON.stringify({ id: 'pg_1', ref: hash.slice(0, 2), questions: [] });
      },
    };
    const loader = createLoader({ sources: [src] });

    expect((await loader.page(HASH, 'en', 'pg_1'))?.ref).toBe('ab');
    expect((await loader.page(OTHER, 'en', 'pg_1'))?.ref).toBe('cd');
  });

  it('evicts least-recently-used pages past the cap', async () => {
    const files: Record<string, unknown> = { ...fullFiles() };
    for (let i = 0; i < 5; i++) {
      files[`pages/en/p${i}.json`] = { id: `p${i}`, ref: `R${i}`, questions: [] };
    }
    const src = memSource(files);
    const loader = createLoader({ sources: [src], maxPages: 2 });

    await loader.page(HASH, 'en', 'p0');
    await loader.page(HASH, 'en', 'p1');
    await loader.page(HASH, 'en', 'p2'); // evicts p0
    src.fetches.length = 0;
    await loader.page(HASH, 'en', 'p0');

    expect(src.fetches).toEqual([`${HASH}/pages/en/p0.json`]);
  });

  it('a cache hit refreshes recency', async () => {
    const files: Record<string, unknown> = { ...fullFiles() };
    for (let i = 0; i < 4; i++) {
      files[`pages/en/p${i}.json`] = { id: `p${i}`, ref: `R${i}`, questions: [] };
    }
    const src = memSource(files);
    const loader = createLoader({ sources: [src], maxPages: 2 });

    await loader.page(HASH, 'en', 'p0');
    await loader.page(HASH, 'en', 'p1');
    await loader.page(HASH, 'en', 'p0'); // p0 is now most recent
    await loader.page(HASH, 'en', 'p2'); // so p1 is evicted, not p0
    src.fetches.length = 0;
    await loader.page(HASH, 'en', 'p0');

    expect(src.fetches).toEqual([]);
  });
});

/* ---------------------------------------------------------------- *
 * Tier fallthrough
 * ---------------------------------------------------------------- */

describe('source tiers', () => {
  it('uses the first source that answers', async () => {
    const first = memSource(fullFiles(), { name: 'first' });
    const second = memSource(fullFiles(), { name: 'second' });
    await createLoader({ sources: [first, second] }).head(HASH);

    expect(first.fetches).toHaveLength(HEAD_FILE_COUNT);
    expect(second.fetches).toHaveLength(0);
  });

  it('falls through when a tier is unreachable', async () => {
    const down = memSource({}, { name: 'down', fail: true });
    const up = memSource(fullFiles(), { name: 'up' });
    const head = await createLoader({ sources: [down, up] }).head(HASH);

    expect(head.graph.nodes).toHaveLength(3);
    expect(up.fetches).toHaveLength(HEAD_FILE_COUNT);
  });

  it('falls through when a tier reports absence', async () => {
    const empty = memSource({}, { name: 'empty' });
    const full = memSource(fullFiles(), { name: 'full' });
    const head = await createLoader({ sources: [empty, full] }).head(HASH);

    expect(head.manifest.base_language).toBe('en');
  });

  it('surfaces the error when every tier is unreachable', async () => {
    // Distinct from "the file does not exist": an unreachable store must not be reported as a
    // missing artifact, or a network partition looks like a bad survey token.
    const loader = createLoader({
      sources: [memSource({}, { name: 'a', fail: true }), memSource({}, { name: 'b', fail: true })],
    });

    await expect(loader.head(HASH)).rejects.toThrow(/unreachable/);
  });

  it('reports absence when tiers agree the file is missing', async () => {
    const loader = createLoader({ sources: [memSource({}), memSource({})] });
    await expect(loader.head(HASH)).rejects.toThrow(ArtifactNotFound);
  });

  it('refuses to build with no sources', async () => {
    // A loader with nowhere to load from would look healthy and fail on the first respondent.
    expect(() => createLoader({ sources: [] })).toThrow(/at least one artifact source/);
  });
});

/* ---------------------------------------------------------------- *
 * The filesystem source
 * ---------------------------------------------------------------- */

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('httpSource', () => {
  /*
   * These are new. `httpSource` had NO tests, which is exactly why it kept the path bug after the
   * ARTIFACT_DIR source was fixed — and it is the source production uses, because
   * `createArtifactLoader` refuses ARTIFACT_DIR when NODE_ENV=production.
   */
  it('requests the key the writer wrote, prefix included', async () => {
    const seen: string[] = [];
    const fake = vi.fn(async (input: string | URL | Request) => {
      seen.push(String(input));
      return new Response(JSON.stringify(MANIFEST), { status: 200 });
    });
    vi.stubGlobal('fetch', fake);

    const src = httpSource('cdn', 'https://cdn.example');
    await src.fetch(HASH, 'manifest.json');

    // The bucket root plus the shared key — NOT `<base>/<hash>/manifest.json`.
    expect(seen[0]).toBe(`https://cdn.example/${artifactKey(HASH, 'manifest.json')}`);
    expect(seen[0]).toContain('/artifact/');
  });

  it('reports 404 as absence rather than an error', async () => {
    // Load-bearing: a definite absence must not fall through to the next tier as a failure, and a
    // whole-artifact 404 caused by a WRONG PATH is indistinguishable from a genuinely missing
    // page at this layer. That is why the test above asserts the URL and not just the behaviour.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 404 })),
    );
    await expect(httpSource('cdn', 'https://cdn.example').fetch(HASH, 'graph.json')).resolves.toBe(
      null,
    );
  });

  it('raises anything that is not a 404', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 503 })),
    );
    await expect(
      httpSource('storage', 'https://s3.example/bucket').fetch(HASH, 'graph.json'),
    ).rejects.toThrow('storage returned 503');
  });
});

describe('fileSource', () => {
  /*
   * Laid out with `artifactKey`, which is what the WRITER uses.
   *
   * This test was called "reads an artifact laid out as the compiler emits it" and laid the files
   * out at `<root>/<hash>/…` — without the `artifact/` prefix that `apps/worker` actually writes.
   * So it agreed with the loader's own mistake and both were wrong together: on any deployment
   * sharing a directory, the runtime answered 404 for every published survey while the artifact sat
   * one level deeper, exactly where the database said it was.
   *
   * Using the shared key builder rather than hand-writing the path is the fix that outlives this
   * test: if the layout ever moves, the writer, the reader and this fixture move with it, because
   * all three now name one function.
   */
  it('reads an artifact laid out as the WORKER writes it (artifactKey)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'resscript-artifacts-'));
    const at = (path: string): string => join(root, artifactKey(HASH, path));
    await mkdir(dirname(at('pages/en/pg_1.json')), { recursive: true });
    await writeFile(at('manifest.json'), JSON.stringify(MANIFEST));
    await writeFile(at('graph.json'), JSON.stringify(GRAPH));
    await writeFile(at('logic.json'), JSON.stringify(LOGIC));
    await writeFile(at('pages/en/pg_1.json'), JSON.stringify(PAGE_1));

    const loader = createLoader({ sources: [fileSource(root)] });

    const head = await loader.head(HASH);
    expect(head.graph.page_entry).toEqual({ pg_1: 'fn_seq', pg_2: 'fn_seq' });
    expect((await loader.page(HASH, 'en', 'pg_1'))?.id).toBe('pg_1');
  });

  it('does NOT find an artifact written without the prefix', async () => {
    // The old layout, asserted as absent so the two can never quietly swap back. A loader that
    // accepted both would hide the next disagreement instead of failing on it.
    const root = await mkdtemp(join(tmpdir(), 'resscript-artifacts-'));
    await mkdir(join(root, HASH), { recursive: true });
    await writeFile(join(root, HASH, 'manifest.json'), JSON.stringify(MANIFEST));

    const loader = createLoader({ sources: [fileSource(root)] });
    await expect(loader.head(HASH)).rejects.toThrow(ArtifactNotFound);
  });

  it('reports a missing file as absence, not as an error', async () => {
    const root = await mkdtemp(join(tmpdir(), 'resscript-artifacts-'));
    const loader = createLoader({ sources: [fileSource(root)] });

    await expect(loader.head(HASH)).rejects.toThrow(ArtifactNotFound);
  });
});

/* ---------------------------------------------------------------- *
 * Warm
 * ---------------------------------------------------------------- */

describe('warm', () => {
  it('populates the head cache', async () => {
    const src = memSource(fullFiles());
    const loader = createLoader({ sources: [src] });
    await loader.warm(HASH);
    src.fetches.length = 0;
    await loader.head(HASH);

    expect(src.fetches).toEqual([]);
  });

  it('never throws', async () => {
    // Best-effort by definition: a failed warm must not fail the request that triggered it.
    const loader = createLoader({ sources: [memSource({}, { fail: true })] });
    await expect(loader.warm(HASH)).resolves.toBeUndefined();
  });
});

/* ---------------------------------------------------------------- *
 * i18n bundles (open decision 5, closed here)
 * ---------------------------------------------------------------- */

describe('i18n', () => {
  it('fetches one language bundle lazily and caches it, nulls included', async () => {
    const source = memSource({
      ...fullFiles(),
      'i18n/de.json': { 'q1.label': 'Welche Marke?' },
    });
    const loader = createLoader({ sources: [source] });

    const de = await loader.i18n(HASH, 'de');
    expect(de).toEqual({ 'q1.label': 'Welche Marke?' });

    const fr = await loader.i18n(HASH, 'fr'); // absent language: null, and CACHED null
    expect(fr).toBeNull();
    const before = source.fetches.length;
    await loader.i18n(HASH, 'de');
    await loader.i18n(HASH, 'fr');
    expect(source.fetches.length).toBe(before); // both answers came from cache
  });

  it('refuses a language that could traverse the URL path', async () => {
    const loader = createLoader({ sources: [memSource(fullFiles())] });
    expect(await loader.i18n(HASH, '../manifest')).toBeNull();
    expect(await loader.i18n(HASH, 'en/../../x')).toBeNull();
  });
});

/* ---------------------------------------------------------------- *
 * The head's own validation
 * ---------------------------------------------------------------- */

describe('a truncated head is refused, not served', () => {
  it('refuses a manifest with no variable_manifest', async () => {
    // The variable manifest is the closed world the anti-tamper filter reads and the types
    // `tagVars` needs. Without it every rule evaluates against no variables — no error, every
    // condition UNKNOWN — so the loader treats its absence the way it treats a missing graph.
    const files = { ...fullFiles(), 'manifest.json': { base_language: 'en', artifact_hash: '' } };
    const loader = createLoader({ sources: [memSource(files)] });
    await expect(loader.head(HASH)).rejects.toThrow(/variable_manifest/);
  });
});
