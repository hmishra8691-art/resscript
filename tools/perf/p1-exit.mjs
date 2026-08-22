#!/usr/bin/env node
/**
 * The Phase-1 exit performance gate: "page render p95 under 300 ms and submit p95 under 250 ms
 * against a 500-question fixture" (roadmap, Phase 1 exit criteria).
 *
 * Measured the way a respondent experiences it — over a real socket against the BUILT server
 * (`apps/runtime/dist/server.js`), with real Redis session storage and the real Postgres write
 * path on every submit — not as an in-process function benchmark, because E §16.5's budget
 * decomposition already covers compute and the exit criterion is about the assembled system.
 *
 * The fixture is the compiler's own `largeSurvey(500, ['en'])` (shared with the compile-budget
 * test, so both gates measure the same survey), compiled HERE at run time and written to a
 * temp artifact dir — the rig never depends on a stale pre-built artifact matching the current
 * emit format. The compiler is bundled from source with esbuild for this one-off script; the
 * production import graph is untouched (apps/runtime still never links the compiler).
 *
 * Usage: node tools/perf/p1-exit.mjs   (needs local Postgres + Redis, like the DB suite)
 * Exit code 0 iff both p95s meet budget. Numbers are printed either way — a perf gate that
 * hides its measurements teaches nobody anything.
 */

import { execSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PGURL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/resscript';
const PORT = 8097;
const SESSIONS = 30;               // interviews driven; 50 pages each
const RENDER_BUDGET_MS = 300;
const SUBMIT_BUDGET_MS = 250;

/* ---- 1. Compile the 500-question fixture, via an esbuild bundle ---------- */

const { buildSync } = await import('esbuild');
const stage = mkdtempSync(join(tmpdir(), 'p1exit-'));
const bundlePath = join(stage, 'builder.mjs');
buildSync({
  stdin: {
    contents: `
      import { compileSurvey } from ${JSON.stringify(join(ROOT, 'packages/compiler/src/pipeline.ts'))};
      import { largeSurvey, largeSurveyIds } from ${JSON.stringify(join(ROOT, 'packages/compiler/src/__fixtures__/large-survey.ts'))};
      export function build() {
        const survey = largeSurvey(500, ['en']);
        const result = compileSurvey({
          survey,
          surveyVersionId: 'ver_0A100000000000000000000000',
          compiledAt: '2026-03-01T12:00:00.000Z',
        });
        if (!result.ok) throw new Error('fixture failed to compile: ' + JSON.stringify(result.diagnostics.slice(0, 3)));
        return { bundle: result.bundle, ids: largeSurveyIds(survey) };
      }
    `,
    resolveDir: ROOT,
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'es2022',
  outfile: bundlePath,
  logLevel: 'silent',
});
const { build } = await import(pathToFileURL(bundlePath).href);
const { bundle, ids } = build();

const artifactDir = join(stage, 'artifacts');
const hashDir = join(artifactDir, bundle.hash);
for (const file of bundle.files) {
  const path = join(hashDir, file.path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, file.bytes);
}
console.log(`fixture: 500 questions, 50 pages, hash ${bundle.hash.slice(0, 12)}…`);

/* ---- 2. A live token for it ---------------------------------------------- */

const TOKEN = 'p1exitperf0000000000000000';
const psql = (sql) => execSync(`psql "${PGURL}" -tAc ${JSON.stringify(sql)}`).toString().trim();
// The rig rides the M0.2 seed fixture, applied on demand: an empty database (fresh reset) gets
// the two-org seed; a seeded one is left alone.
if (psql(`SELECT count(*) FROM app.survey_versions`) === '0') {
  psql(`SELECT ops.test_seed_two_orgs()`);
}
psql(`DELETE FROM runtime.survey_tokens WHERE token = '${TOKEN}'`);
psql(
  // One line: the SQL rides a shell argument, and a literal backslash-n inside double quotes
  // reaches psql as two characters, which is a syntax error two layers away from its cause.
  `INSERT INTO runtime.survey_tokens (token, org_id, survey_id, survey_version_id, artifact_hash, status, is_test) ` +
    `SELECT '${TOKEN}', v.org_id, v.survey_id, v.id, '${bundle.hash}', 'production', false ` +
    `FROM app.survey_versions v LIMIT 1`,
);

/* ---- 3. The built server -------------------------------------------------- */

const server = spawn('node', ['apps/runtime/dist/server.js'], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(PORT),
    RUNTIME_DOMAIN: 'run.local',
    NODE_ENV: 'development',
    ARTIFACT_DIR: artifactDir,
    REDIS_URL: 'redis://localhost:6379',
    RUNTIME_DATABASE_URL: PGURL,
    LOG_LEVEL: 'error',
  },
  stdio: ['ignore', 'inherit', 'inherit'],
});
await new Promise((r) => setTimeout(r, 1200));

const agent = new http.Agent({ keepAlive: true });
function request(method, path, body) {
  return new Promise((resolveReq, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const started = process.hrtime.bigint();
    const req = http.request(
      {
        host: '127.0.0.1', port: PORT, path, method, agent,
        headers: {
          Host: `${TOKEN}.run.local`,
          ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          const ms = Number(process.hrtime.bigint() - started) / 1e6;
          resolveReq({ status: res.statusCode, body: raw === '' ? null : JSON.parse(raw), ms });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function p95(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
}

/* ---- 4. Drive it ----------------------------------------------------------- */

const renders = [];
const submits = [];
try {
  // Warm: one full page load so the artifact head and first page are cached (E §16.2 warms in
  // production too; a cold-cache p95 would measure the CDN, which is not what the budget is).
  await request('GET', `/s/${TOKEN}`);

  for (let s = 0; s < SESSIONS; s += 1) {
    const entry = await request('GET', `/s/${TOKEN}`);
    if (entry.status !== 200) throw new Error(`entry ${entry.status}: ${JSON.stringify(entry.body)}`);
    const sessionId = entry.body.session_id;

    let pageIndex = 0;
    let currentPage = entry.body.page.page_id;
    while (currentPage) {
      // Page render: the GET a respondent's browser makes after each PRG hop.
      const get = await request('GET', `/s/${TOKEN}/p/${currentPage}?session=${sessionId}`);
      if (get.status !== 200) throw new Error(`render ${get.status} on ${currentPage}`);
      renders.push(get.ms);

      // Submit an answer for each of this page's ten questions, keyed by variable ref.
      const values = {};
      for (let i = 0; i < 10; i += 1) {
        const ref = ids.questionRefs[pageIndex * 10 + i];
        if (ref) values[ref] = (i * 7) % 100;
      }
      const post = await request('POST', `/s/${TOKEN}/submit?session=${sessionId}`, {
        page_id: currentPage,
        values,
      });
      if (post.status !== 200) throw new Error(`submit ${post.status} on ${currentPage}: ${JSON.stringify(post.body).slice(0, 200)}`);
      submits.push(post.ms);
      currentPage = post.body.page?.page_id ?? null;
      pageIndex += 1;
    }
  }
} finally {
  server.kill('SIGTERM');
  psql(`DELETE FROM runtime.survey_tokens WHERE token = '${TOKEN}'`);
}

/* ---- 5. The verdict --------------------------------------------------------- */

const renderP95 = p95(renders);
const submitP95 = p95(submits);
const median = (samples) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};
const line = (name, samples, p, budget) =>
  console.log(
    `${name}: n=${samples.length} p50=${median(samples).toFixed(1)}ms ` +
      `p95=${p.toFixed(1)}ms budget=${budget}ms ${p < budget ? 'PASS' : 'FAIL'}`,
  );
line('page render', renders, renderP95, RENDER_BUDGET_MS);
line('submit     ', submits, submitP95, SUBMIT_BUDGET_MS);

process.exit(renderP95 < RENDER_BUDGET_MS && submitP95 < SUBMIT_BUDGET_MS ? 0 : 1);
