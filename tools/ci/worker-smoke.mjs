#!/usr/bin/env node
/**
 * Post-deploy smoke test for `apps/worker`.
 *
 * Answers one question — "is this worker actually doing work?" — from OUTSIDE the process, the
 * way an operator has to. `pnpm test` proves the code is right; this proves the deployment is
 * wired up: the pod can reach the queue it was pointed at, it claims and completes a real job,
 * and the directories it was configured with are writable by the user it runs as.
 *
 * ## Why this exists rather than "check /ready and move on"
 *
 * `/ready` was, until recently, incapable of reporting the most likely deployment failure. It
 * checked `store.ping()` (a `SELECT 1`) and "is the consumer loop running", and both stayed true
 * while EVERY claim failed: `ops.claim_job` returns an all-NULL composite row for an empty
 * queue, `PgJobStore.claim` did not recognise that shape, and so a worker against a real
 * database threw on every poll from boot — four slots, five times a second — while answering 200
 * on `/ready`. `/ready` now has a `claim` check and would catch it, but the general lesson holds:
 * a probe reports what it was told to look at, and the only unfakeable evidence that a queue
 * consumer works is a job that went in and came out.
 *
 * So the centre of this script is a round trip. It enqueues `noop` — which exists, per its own
 * file header, precisely so that "the first `compile` job is not the first time the harness is
 * tested end to end" — and waits for `succeeded`.
 *
 * ## Why it does NOT compile a survey
 *
 * Deliberately. A publish smoke test would have to seed an org, a project, a survey version and
 * a complete i18n bundle, and this script is meant to be safe to run against production, where
 * writing fake survey content is not acceptable. The publish path is covered where it belongs,
 * against a real database, by `apps/worker/src/kinds/compile.test.ts` ("the publish transaction
 * against a real database"). What is left for a deployment to get wrong — credentials, network,
 * volumes, the queue's identity — is exactly what a `noop` round trip exercises.
 *
 * ## The directory checks are not padding
 *
 * `FsArtifactStore` is a filesystem tree, so `ARTIFACT_DIR` must be a volume that the worker can
 * write AND that `apps/runtime` can read — a per-pod emptyDir gives you a worker that publishes
 * successfully and a runtime that serves 404s for the artifact it just wrote. This script cannot
 * check the sharing (it sees one side), so it writes a probe file and PRINTS its path, which is
 * the thing to go look for from the runtime's side. Everything it can check on its own — exists,
 * writable, survives a read-back — it checks.
 *
 * Usage:
 *   DATABASE_URL=… node tools/ci/worker-smoke.mjs --url http://worker:8082
 *   DATABASE_URL=… ARTIFACT_DIR=… EXPORT_DIR=… node tools/ci/worker-smoke.mjs --url … --dirs
 *
 * Exit code is 0 only if every check passed. Each failure prints one line beginning "FAIL".
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};

const BASE = value('url', process.env['WORKER_URL'] ?? 'http://127.0.0.1:8082');
const TIMEOUT_MS = Number(value('timeout-ms', '60000'));
const CHECK_DIRS = flag('dirs');

let failures = 0;
const fail = (what, detail) => {
  failures += 1;
  console.error(`FAIL ${what}: ${detail}`);
};
const ok = (what, detail) => console.log(`ok   ${what}${detail === undefined ? '' : ` — ${detail}`}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* -------------------------------------------------------------------------- */
/* 1. The HTTP probes                                                          */
/* -------------------------------------------------------------------------- */

async function getJson(path) {
  const res = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(10_000) });
  const body = await res.json();
  return { status: res.status, body };
}

async function checkHealth() {
  try {
    const { status, body } = await getJson('/health');
    if (status !== 200) return fail('/health', `expected 200, got ${status}`);
    ok('/health', `version=${String(body.version)} worker_id=${String(body.worker_id)}`);
  } catch (err) {
    fail('/health', `unreachable at ${BASE} (${err instanceof Error ? err.message : 'unknown'})`);
  }
}

async function checkReady() {
  try {
    const { status, body } = await getJson('/ready');
    const checks = JSON.stringify(body.checks);
    if (status !== 200 || body.ready !== true) return fail('/ready', `${status} ${checks}`);
    // Named explicitly: a build predating the claim check answers 200 with no `claim` key, and
    // silently accepting that would report a green smoke test for the exact blindness this
    // script's header is about.
    if (body.checks?.claim === undefined) {
      fail('/ready', `no "claim" check present — worker predates the claim-staleness probe: ${checks}`);
      return;
    }
    ok('/ready', checks);
  } catch (err) {
    fail('/ready', err instanceof Error ? err.message : 'unknown');
  }
}

/* -------------------------------------------------------------------------- */
/* 2. The round trip — the only unfakeable check                               */
/* -------------------------------------------------------------------------- */

async function checkRoundTrip() {
  const url = process.env['DATABASE_URL'];
  if (url === undefined || url === '') {
    fail('job round trip', 'DATABASE_URL is unset, so the queue cannot be reached from here');
    return;
  }

  // `pg` is resolved at RUN time, not imported at the top, and the failure is spelled out
  // because of where this script gets used. It lives in `tools/`, which is NOT in the worker
  // image — this is an EXTERNAL prober by design, so an operator typically runs it from a fresh
  // clone where `pnpm install` has not happened yet, and Node's bare "Cannot find package 'pg'"
  // gives no hint that the fix is an install in the repo rather than something wrong with the
  // deployment being tested. The HTTP checks above need no dependencies at all and have already
  // run by this point, so a missing `pg` costs you the round trip and nothing else.
  let pg;
  try {
    ({ default: pg } = await import('pg'));
  } catch {
    fail(
      'job round trip',
      "cannot resolve the 'pg' package. This script runs from the REPO (it is not in the worker " +
        'image); run `pnpm install` in the repo root first. The /health and /ready checks above ' +
        'did run and need no dependencies.',
    );
    return;
  }
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  // A dedicated kind, so this never collides with real work and is trivially greppable in
  // `ops.jobs`. `jobs_kind_fmt` is `^[a-z][a-z0-9_]{1,63}$` — no hyphens, no leading digit.
  const kind = 'noop';
  const key = `smoke_${String(Date.now())}_${String(Math.floor(Math.random() * 1e6))}`;

  try {
    const enq = await pool.query(
      'SELECT * FROM ops.enqueue_job(p_kind => $1::text, p_payload => $2::jsonb, ' +
        'p_idempotency_key => $3::text)',
      [kind, JSON.stringify({ steps: 1, smoke: key }), key],
    );
    const id = enq.rows[0]?.id;
    if (typeof id !== 'string') {
      fail('job round trip', 'ops.enqueue_job returned no id');
      return;
    }
    ok('enqueue', `${kind} ${id}`);

    const deadline = Date.now() + TIMEOUT_MS;
    let last = 'queued';
    while (Date.now() < deadline) {
      const { rows } = await pool.query(
        'SELECT status, attempts, locked_by, error FROM ops.jobs WHERE id = $1::app.ulid',
        [id],
      );
      const row = rows[0];
      if (row === undefined) {
        fail('job round trip', `job ${id} vanished from ops.jobs`);
        return;
      }
      last = row.status;
      if (row.status === 'succeeded') {
        // NOT `locked_by`: `ops.complete_job` sets it back to NULL, so reading it here always
        // printed "claimed by ?" — a smoke test that reports a field it cannot have is worse
        // than one that stays quiet. `attempts` is the useful number anyway: 1 means it was
        // claimed and finished first time, >1 means something retried and is worth a look.
        ok('job round trip', `succeeded after ${String(row.attempts)} attempt(s)`);
        return;
      }
      if (row.status === 'failed') {
        fail('job round trip', `job failed: ${JSON.stringify(row.error)}`);
        return;
      }
      await sleep(500);
    }
    // The message names the two causes worth distinguishing, because they need different fixes.
    fail(
      'job round trip',
      last === 'queued'
        ? `job sat in 'queued' for ${String(TIMEOUT_MS)}ms — no worker is claiming this queue ` +
            '(wrong DATABASE_URL, or the pod is not running)'
        : `job stuck in '${last}' after ${String(TIMEOUT_MS)}ms — a worker claimed it and did not finish`,
    );
  } catch (err) {
    fail('job round trip', err instanceof Error ? err.message : String(err));
  } finally {
    await pool.end();
  }
}

/* -------------------------------------------------------------------------- */
/* 3. The directories                                                          */
/* -------------------------------------------------------------------------- */

function checkDir(label, dir, shared) {
  if (dir === undefined || dir === '') {
    fail(label, 'unset — the worker will fall back to /var/lib/resscript/… which is usually not the volume');
    return;
  }
  if (!existsSync(dir)) {
    fail(label, `${dir} does not exist`);
    return;
  }
  // Write AND read back: a directory can be writable while the volume behind it is not what the
  // other side of the deployment is reading.
  let probe;
  try {
    probe = join(mkdtempSync(join(dir, '.smoke-')), 'probe');
    const payload = `resscript worker smoke ${new Date().toISOString()}`;
    writeFileSync(probe, payload, 'utf8');
    if (readFileSync(probe, 'utf8') !== payload) {
      fail(label, `${dir} read back different bytes than were written`);
      return;
    }
    ok(label, `${dir} writable (probe: ${probe})`);
    if (shared) {
      console.log(
        `     ^ confirm apps/runtime can read that exact path; a per-pod volume produces a\n` +
          `       successful publish and a runtime that 404s the artifact it just wrote.`,
      );
    }
  } catch (err) {
    fail(label, `${dir} not writable: ${err instanceof Error ? err.message : 'unknown'}`);
  } finally {
    if (probe !== undefined) {
      try {
        rmSync(join(probe, '..'), { recursive: true, force: true });
      } catch {
        // A leftover probe directory is untidy, not a failure of the thing being tested.
      }
    }
  }
}

/* -------------------------------------------------------------------------- */

console.log(`worker smoke test → ${BASE}`);
await checkHealth();
await checkReady();
await checkRoundTrip();
if (CHECK_DIRS) {
  // Only ARTIFACT_DIR has to be shared with another service: apps/runtime serves the artifact
  // the worker wrote. EXPORT_DIR is read back by the studio's download endpoint, which is a
  // separate concern and not one a per-pod volume breaks silently.
  checkDir('ARTIFACT_DIR', process.env['ARTIFACT_DIR'], true);
  checkDir('EXPORT_DIR', process.env['EXPORT_DIR'], false);
}

if (failures > 0) {
  console.error(`\n${String(failures)} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
