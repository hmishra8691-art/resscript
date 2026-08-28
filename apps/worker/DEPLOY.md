# Deploying `apps/worker`

The worker is the only thing that turns a queued job into an outcome. Nothing publishes without
it: the studio's Publish button writes a row to `ops.jobs` and returns, and if no worker claims
that row the survey stays a draft forever with no error anywhere. The same is true of exports and
webhook deliveries.

This document is the env contract, the ordering constraints, and what to check after a deploy.

---

## What has actually been verified, and what has not

Stated plainly, because the difference matters when something goes wrong at 2am.

**Verified against real Postgres 16 and Redis on this commit:**

- The worker boots, answers `/health` and `/ready`, and idles silently against an empty queue.
- A `compile` job goes in and comes out: loader → document → static gate → artifact → publish.
  A real artifact (9 content-addressed files) was written and `app.publish_version` moved the
  version to `staging`/`compiled` and repointed `runtime.survey_tokens`.
- Republishing unchanged content reuses all 9 objects and writes 0 — ADR-002's acceptance line.
- Compile *failure* records `compile_errors` on the job and diagnostics on the version, in one
  attempt, without stalling.
- `pnpm deploy --filter=@resscript/worker --prod <dir>` produces a self-contained tree, and
  `node dist/server.js` inside it boots, claims, completes, and exits 0 on SIGTERM.
- `tools/ci/worker-smoke.mjs` passes green against a running worker and exits non-zero, with
  actionable messages, when pointed at nothing.
- **The image builds and runs.** `docker build -f apps/worker/Dockerfile` succeeded first try on
  macOS/arm64 at `67db82a`, and the container booted through `worker_boot` → `worker_started` →
  `health_listening`, answered `/health` with the full `GIT_SHA`, and answered `/ready` with
  `{"job_store":"ok","consumer":"running","claim":"ok"}`.

  Two details from that run worth keeping. The reported `worker_id` was `worker-1-…`, i.e. **PID
  1** — which is what confirms the exec-form `CMD` put node directly as PID 1 with no shell to
  swallow `SIGTERM`, so the graceful drain runs on a rolling deploy. And with `DATABASE_URL`
  unset the container logged `worker_using_memory_store` with `durable: false` while still
  answering 200 on both probes, which is the fallback in §"`DATABASE_URL` unset is the dangerous
  configuration" demonstrating itself: a pod that looks entirely healthy and is losing every job.

**Not verified:**

- **The image is arm64 only.** It was built on Apple Silicon without `--platform`. Building for
  x86 hosts needs `--platform linux/amd64` (or a `buildx` multi-arch build); an arm64 image on an
  amd64 node fails to start with an exec-format error.
- **The container has not been run against a real database.** Everything above the image line was
  verified with a host-run worker against real Postgres 16; the containerised worker has only been
  run with no `DATABASE_URL`. Run `worker-smoke.mjs` against it once it has one — that is the step
  that proves the container can reach your queue, which is a network and credentials question the
  image cannot answer on its own.
- Nothing has been run on production-shaped infrastructure, so there are no latency numbers and
  ADR-008 stays Provisional.

---

## Environment contract

Read out of `apps/worker/src/server.ts`, not from memory. Everything is optional except
`DATABASE_URL`, and the defaults are what you get if you say nothing.

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | *(none)* | **Set this.** See the warning below. |
| `ARTIFACT_DIR` | `/var/lib/resscript/artifacts` | Must be shared with `apps/runtime`. See below. |
| `EXPORT_DIR` | `/var/lib/resscript/exports` | Where export CSVs land. |
| `PORT` | `8082` | Health server only; the worker serves no other traffic. |
| `GIT_SHA` | `unknown` | Stamped on spans, returned by `/health`. |
| `LOG_LEVEL` | `info` | |
| `WEBHOOK_TIMEOUT_MS` | *(job default)* | Per-delivery HTTP timeout. |
| `WORKER_CONCURRENCY` | `4` | Also sizes the pool: `max = concurrency * 2 + 2`. |
| `WORKER_POLL_INTERVAL_MS` | `200` | Sleep between empty claims. |
| `WORKER_HEARTBEAT_INTERVAL_MS` | `5000` | Must stay well under `STALLED_AFTER`. |
| `WORKER_STALLED_AFTER_MS` | `30000` | Silence after which a running job is considered dead. |
| `WORKER_SWEEP_INTERVAL_MS` | `10000` | How often this pod sweeps. `0` disables. |
| `WORKER_DRAIN_TIMEOUT_MS` | `25000` | **Sets your grace period.** See "Rolling deploys". |
| `WORKER_CLAIM_STALE_AFTER_MS` | `30000` | How long claims may fail before `/ready` goes 503. |
| `WORKER_NO_AUTOSTART` | *(unset)* | `1` imports the module without starting. Tests only. |
| `NODE_ENV` | | `test` also suppresses autostart. |

### `DATABASE_URL` unset is the dangerous configuration

`server.ts` falls back to an **in-memory** job store when it is missing. The pod boots, passes
both probes, and looks entirely healthy — while consuming a queue that no other process can see
and losing every job on restart. It logs `worker_using_memory_store` with `durable: false` at
`warn`, and that line is the only symptom. Alert on it.

### `ARTIFACT_DIR` must be shared storage

`FsArtifactStore` is a filesystem tree. The worker writes the artifact; `apps/runtime` reads it to
serve respondents. Point them at the same volume — a per-pod `emptyDir` produces the worst
possible failure mode: publish succeeds, the version says `staging`/`compiled`, and every
respondent gets a 404 for an artifact the database swears exists.

Object storage is the intended destination. `artifact-store.ts`'s header names the one line that
changes (construct the client, pass `client.storage.from(bucket)` to `SupabaseArtifactStore`);
until that happens, this is a shared-volume deployment.

---

## Order of operations

1. **Migrations first, worker second.** `tools/migrate/cli.mjs up`. The worker calls
   `ops.claim_job`, `ops.complete_job` and `app.publish_version` by name; against an older schema
   it fails at the first claim, loudly, which is the good case. The bad case is the reverse
   ordering with a migration that changes a function *signature* — see below.
2. **Worker before studio**, if you are deploying both. A studio that can enqueue while nothing
   consumes produces publishes that appear to hang.

### The failure mode worth knowing about

Every call from `PgJobStore` uses **named** parameters (`p_kinds => $1`), because positional calls
against a reordered signature bind silently and wrongly — a bug this codebase has already had
twice. Named parameters turn that into an immediate error instead. What they do **not** protect
against is a parameter count mismatch: `SQL.fail` once declared four placeholders while its caller
bound five, and Postgres rejected the bind on the failure path only. Every failing job then threw
while recording its own failure, sat at `running` until the stalled sweeper collected it, and had
`worker_stalled` written as its error instead of the real cause.

`pg-job-store.test.ts` now asserts placeholder count against bound-value count for every query in
the map, so a signature change that gets halfway in cannot ship. If you change a function
signature in a migration, run `pnpm --filter @resscript/worker test` before deploying either half.

---

## Rolling deploys

The worker handles `SIGTERM` by stopping claims immediately and letting in-flight jobs finish
(`worker_signal` → `worker_draining` → `worker_drained`), then exits 0. A second `SIGTERM` during
the drain is honoured immediately and exits 1.

**Set the termination grace period above `WORKER_DRAIN_TIMEOUT_MS`.** At the default 25s, use 40s.
If the platform kills the pod first, a `compile` in progress dies mid-flight; it is recovered by
the stalled sweeper 30s later and retried, so nothing is lost — but a publish that takes a minute
longer than it should, once per deploy, is a thing users notice and nobody can explain.

Do not run `SIGKILL`-only deploys.

### Probes

- **Liveness → `/health`.** Does not touch the database, deliberately: a database-checking
  liveness probe restarts every pod during a Postgres failover, turning a recoverable blip into a
  fleet-wide cold start with the in-flight jobs dropped. `health.test.ts` has a test named for
  this. Returns 200 even while draining.
- **Readiness → `/ready`.** 503 while stopped, draining, or when the store is unreachable — and
  now also when no claim has succeeded for `WORKER_CLAIM_STALE_AFTER_MS`. That last check exists
  because the other two were both green throughout a total claim outage: `SELECT 1` answered and
  the loops were looping while every `ops.claim_job` call threw, so `/ready` returned 200 for a
  worker that could not start a single job. Expect `{"job_store":"ok","consumer":"running",
  "claim":"ok"}`.

Multiple workers are safe and expected: `ops.claim_job` uses `FOR UPDATE SKIP LOCKED`, so N pods
polling one queue never block each other and never claim the same row.

---

## After deploying

```bash
DATABASE_URL=… ARTIFACT_DIR=… EXPORT_DIR=… \
  node tools/ci/worker-smoke.mjs --url http://worker:8082 --dirs
```

This enqueues a real `noop` job and waits for `succeeded`, which is the only unfakeable evidence
that the pod is consuming the queue you think it is. It exits non-zero on any failure and
distinguishes "the job sat in `queued`" (nothing is claiming — wrong `DATABASE_URL`, or the pod
is not running) from "stuck in `running`" (something claimed it and did not finish).

Run it with `--dirs` from inside the pod, or without them from outside.

### Log lines that mean something is wrong

| Line | Meaning |
|---|---|
| `worker_using_memory_store` | `DATABASE_URL` unset. Jobs are being lost. Page someone. |
| `claim_failed` (repeating) | Cannot reach or read the queue. `/ready` goes 503 after 30s. |
| `job_complete_write_failed` | The result could not be recorded. Job left for the sweeper. |
| `job_fail_write_failed` | The *failure* could not be recorded. Same fallback, worse cause. |
| `stalled_jobs_requeued` (steady, non-zero) | Jobs are dying mid-flight or heartbeats are not landing. |
| `worker_exit_dirty` | Drain timed out; in-flight jobs were aborted. |

A single `claim_failed` around a failover is normal and is why the readiness check is
time-based rather than a failure count.

---

## Rollback

The worker holds no state of its own, so rolling the image back is safe on its own terms. The
constraint is the schema:

- **Do not roll the worker back past a migration that is still applied** if that migration changed
  a function signature the older worker calls. It will fail every claim. `db/migrations/*/down.sql`
  exists; migrations come back first, worker second — the reverse of deploying.
- Artifacts are content-addressed and immutable (ADR-002), so nothing a rolled-back worker does
  can corrupt one. A republish either finds every key present and writes nothing, or writes a new
  hash beside the old.
- In-flight jobs at the moment of rollback are requeued by the sweeper within
  `WORKER_STALLED_AFTER_MS` and picked up by whichever version is running.

---

## Known gaps

- The image is arm64 only, and has not yet been run with a `DATABASE_URL` (see above).
- Object storage is not wired; `ARTIFACT_DIR`/`EXPORT_DIR` are local trees on a shared volume.
- No queue metrics are emitted. This is deliberate — `@resscript/observability`'s metric
  vocabulary is closed and contains no job-queue metric, and `consumer.ts` says inventing one
  locally is exactly what the fixed vocabulary prevents. Depth and age come from `ops.jobs`
  until they are added to the registry in review.
- The load rig (`tools/perf/p2-quota-load.mjs`) is reusable but not scheduled, and quota
  reconciliation drift is not yet asserted — both are Phase 2 exit criteria.
