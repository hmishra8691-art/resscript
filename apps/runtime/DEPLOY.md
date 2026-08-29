# Deploying `apps/runtime`

The respondent-facing server. It serves every survey page, accepts every answer, and hosts the
preview surface. Nothing a respondent touches works until this is running.

`apps/worker` compiles and publishes; this reads what the worker wrote. **They must agree about
where artifacts live**, and until recently they did not — see [Artifacts](#artifacts-the-part-most-likely-to-bite),
which is the section to read first if a published survey answers 404.

---

## 1. Build

From the repository root, never from this directory:

```sh
docker build -f apps/runtime/Dockerfile \
  -t resscript-runtime:$(git rev-parse --short HEAD) \
  --build-arg GIT_SHA=$(git rev-parse HEAD) .
```

The root context is required because this is a pnpm workspace and the runtime imports five sibling
packages as `workspace:*`.

`GIT_SHA` is stamped on spans and returned by `/health`; without it you cannot tie a log line back
to a commit.

### What is verified, and what is not

Verified directly against this commit, by running `pnpm deploy --filter=@resscript/runtime --prod`
and booting the resulting tree:

- the five sibling packages resolve to paths **inside** the pruned tree;
- `dist/client/client.js` is present (24,226 bytes raw, 8,412 gzipped);
- `node dist/server.js` boots, logging `quota_drain_started` and `runtime_listening`;
- `/health` and `/ready` both answer 200;
- a preview request with a valid signed token returns 200 and rendered HTML;
- on SIGTERM: `/ready` answers 503 with `{"checks":{"draining":"shutting_down"}}` while `/health`
  stays 200, the listener stays open for the delay, then closes, the quota drain makes a final
  flush, and the process exits 0.

**Not verified:** the image itself has not been built or run in CI. The build stage's assertions
(client bundle present, siblings resolving inside the tree) are the guards standing in for that.

---

## 2. Configuration

### Required — the process will not start without these

| Variable | Why |
|---|---|
| `RUNTIME_DOMAIN` | Survey origins are `<token>.<domain>`. Requests whose Host does not parse against it are 404'd. |
| `RUNTIME_DATABASE_URL` | The runtime plane's connection (ADR-001). `server.ts` throws in production without it: responses must be durable. |
| `CDN_URL` and/or `ARTIFACT_STORAGE_URL` | Where artifacts are read from. `createArtifactLoader()` throws when no source is configured, rather than defaulting to a hostname and 404ing every respondent. |

### Required in practice

| Variable | Why |
|---|---|
| `REDIS_URL` | The quota arbiter (ADR-008) and the session store. Without it the quota drain logs `quota_drain_not_started` with `durable: false` and **serves correctly anyway** — the damage is invisible until the day Redis is lost. |
| `PREVIEW_SIGNING_SECRET` | Must be **byte-identical** to the studio's. Preview tokens are HMAC-SHA256 over `<hash>|<expires_at_ms>`; a mismatch is `403 bad_signature` on every preview. |
| `STUDIO_ORIGIN` | The origin allowed to frame a preview (`frame-ancestors`). Note that `frame-ancestors` has no `default-src` fallback, so an unset value is not "inherit", it is "no framing". |

### Optional

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `8081` | |
| `SHUTDOWN_READY_DELAY_MS` | `5000` | How long `/ready` answers 503 with the listener still open. Set to **at least one readiness-probe interval**. |
| `SHUTDOWN_GRACE_MS` | `10000` | Hard deadline for the whole shutdown. Must exceed the delay above, and stay below the orchestrator's termination grace period. |
| `QUOTA_DRAIN_INTERVAL_MS` | `30000` | Write-behind period for quota counters. |
| `REDIRECT_HOST_ALLOWLIST` | — | Hosts a completion redirect may target. |
| `SCRIPT_EGRESS_ALLOWLIST`, `SCRIPT_EGRESS_TIMEOUT_MS` | — | Custom-script egress (ADR-005). |
| `RUNTIME_VENDOR_SECRETS` | — | Vendor callback signing. |

### Development only

`ARTIFACT_DIR` and `RUNTIME_STATIC_TOKENS` exist for local runs. `ARTIFACT_DIR` **throws when
`NODE_ENV=production`** — see the next section for why that is not an inconvenience to work around.

---

## 3. Artifacts — the part most likely to bite

The worker writes each artifact file at the key `artifact/<hash>/<path>`. The runtime reads at the
same key, via the shared `artifactKey()` in `@resscript/schema`.

That sharing is new. Both sides used to derive the key independently and **disagreed**: the runtime
read `<hash>/<path>` with no prefix, so every published survey answered 404 for every respondent
and every preview, with a correct artifact on disk and a correct row in the database. The bug
existed on both the `ARTIFACT_DIR` path and the HTTP path; the HTTP path is the one production
uses, and it had no tests at all.

**Therefore:**

- `CDN_URL` and `ARTIFACT_STORAGE_URL` must be the **bucket or CDN root**. Do not append
  `/artifact` — `artifactKey()` adds it. A base that already ends in `/artifact` yields
  `…/artifact/artifact/<hash>/…` and 404s everything.
- Sources are tried in order: `ARTIFACT_DIR` (dev only), then `CDN_URL`, then
  `ARTIFACT_STORAGE_URL`. A 404 from one is treated as a definite absence and does **not** fall
  through as an error, which is correct for a missing page and indistinguishable from a wrong
  base URL. If every survey 404s, suspect the base URL before suspecting the worker.
- `ARTIFACT_DIR` is refused in production because a local directory cannot be shared between the
  worker's pod and this one. A per-pod directory would serve 404 for every survey compiled
  anywhere else — the same failure, reintroduced by configuration.

**Smoke test after any change to these:**

```sh
curl -sI "$CDN_URL/artifact/<some-published-hash>/manifest.json"   # expect 200
```

If that is 404 and the worker's logs show the artifact was written, the base URL is wrong.

---

## 4. Probes

| Probe | Path | Expectation |
|---|---|---|
| Liveness | `/health` | 200 whenever the process is alive — **including during shutdown**. |
| Readiness | `/ready` | 200 when the token resolver is reachable; 503 while draining or when it is not. |

`/health` deliberately touches no dependency. A liveness probe that checks the database restarts
every pod during a Postgres failover, turning a recoverable blip into a fleet-wide cold start; a
liveness probe that fails during a graceful shutdown gets the pod SIGKILLed partway through its own
drain. `handler.test.ts` holds both properties with named tests.

Kubernetes sketch:

```yaml
livenessProbe:
  httpGet: { path: /health, port: 8081 }
  periodSeconds: 10
readinessProbe:
  httpGet: { path: /ready, port: 8081 }
  periodSeconds: 5          # SHUTDOWN_READY_DELAY_MS should be >= this
terminationGracePeriodSeconds: 30   # must exceed SHUTDOWN_GRACE_MS
```

---

## 5. Shutdown

On SIGTERM or SIGINT, in order:

1. `/ready` starts answering 503 — **the listener stays open** for `SHUTDOWN_READY_DELAY_MS`.
2. The periodic quota drain stops.
3. The listener closes; in-flight responses are allowed to finish.
4. One final quota flush (best-effort; Redis remains the arbiter, so a failure is durable-record
   lag, not a quota error).
5. Exit 0 — or a logged `runtime_shutdown_forced` at `SHUTDOWN_GRACE_MS`.

Step 1's delay is the part that is easy to omit and useless to omit. `server.close()` refuses new
connections immediately, and a readiness probe arrives on a new connection — so without the delay
the probe gets a connection error rather than the 503, and the load balancer keeps routing
respondents here until it notices. The failure moves from "killed in flight" to "refused at
connect"; it does not go away.

Measured on Node 22: with an idle keep-alive socket held open across SIGTERM and the delay set to
0, shutdown completes in ~117 ms.

---

## 6. Scaling

Stateless. Session state is in Redis, the durable record in Postgres, artifacts are read-only and
content-addressed. Run as many replicas as you need behind a load balancer.

Two things are shared rather than per-replica:

- **The quota drain runs in every replica.** That is safe — the epoch guard makes a duplicate
  flush a no-op and an overlapping pass is skipped rather than queued — but N replicas means N
  times the drain load on Postgres. If that shows up, raise `QUOTA_DRAIN_INTERVAL_MS` rather than
  trying to elect a single drainer.
- **Artifact caches are per-process** (LRU, 64 heads / pages). A cold replica does more reads from
  `CDN_URL` until it warms.

---

## 7. First deploy, in order

1. Run migrations (`tools/migrate/cli.mjs up`). The runtime calls SECURITY DEFINER functions that
   must exist first.
2. Deploy `apps/worker` and publish one survey. There is nothing to serve otherwise.
3. Confirm the artifact is readable at `$CDN_URL/artifact/<hash>/manifest.json`.
4. Deploy this, with `PREVIEW_SIGNING_SECRET` matching the studio's.
5. Check `/ready` is 200, then load the survey's own origin.
6. Set the studio's `RUNTIME_PREVIEW_ORIGIN` to this deployment's URL, and confirm preview opens
   from the studio.

Step 3 before step 4 is the ordering that matters: it separates "the artifact is not there" from
"the runtime cannot find it", which are the same 404 to a respondent and have different fixes.
