# syntax=docker/dockerfile:1.7
#
# apps/runtime — the respondent-facing server.
#
# Build from the REPOSITORY ROOT, not from this directory:
#
#   docker build -f apps/runtime/Dockerfile -t resscript-runtime:$(git rev-parse --short HEAD) \
#     --build-arg GIT_SHA=$(git rev-parse HEAD) .
#
# Same root-context reason as `apps/worker/Dockerfile`: this is a pnpm workspace and the runtime
# imports five sibling packages (`@resscript/{egress,logic,observability,runtime-core,schema}`) as
# `workspace:*`. A context of `apps/runtime` cannot see them and fails at install.
#
# ## What is different from the worker's image, and why
#
# 1. IT SERVES HTTP, so the port is exposed and readiness belongs to the orchestrator.
# 2. ITS BUILD HAS TWO HALVES. `pnpm build` here is `tsc -b && node scripts/build-client.mjs`, and
#    the second half esbuilds the browser bundle to `dist/client/client.js`. A server that ships
#    without it answers every page with HTML referencing a script that 404s — the survey renders
#    and then does nothing on click. `pnpm deploy` copies `dist` wholesale so the bundle comes
#    along, and the smoke check at the bottom of stage 1 asserts it exists rather than trusting
#    that.
# 3. THERE IS NO ARTIFACT VOLUME. The worker writes artifacts; this reads them, and in production
#    it reads them over HTTP. `createArtifactLoader()` throws on `ARTIFACT_DIR` when
#    `NODE_ENV=production` — deliberately, because a local directory cannot be shared between the
#    worker's pod and this one, and a deployment that mounted one per pod would serve 404 for
#    every survey compiled by a worker on another node. So no `ENV ARTIFACT_DIR` here, unlike the
#    worker's image: setting it would be a default that production refuses to boot with.
#
# ## Verified, and not
#
# Verified directly against this commit: `pnpm deploy --filter=@resscript/runtime --prod` produces
# a tree whose `node dist/server.js` boots, logs `quota_drain_started` and `runtime_listening`,
# answers `/health` 200 and `/ready` 200, serves a preview with a real artifact, answers `/ready`
# 503 once SIGTERM has been received, finishes an in-flight request, flushes the quota drain and
# exits 0 within ~120 ms. The IMAGE around it has not been built in CI — see DEPLOY.md.

# ---------------------------------------------------------------------------------------------
# Stage 1 — build the whole workspace, then prune to just the runtime
# ---------------------------------------------------------------------------------------------
FROM node:22-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

WORKDIR /repo

# Manifests first, source second, so the install layer caches on dependency changes alone. Every
# workspace package's package.json must be present for `--frozen-lockfile` to resolve, including
# the ones this app does not use.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json ./
COPY packages/schema/package.json           packages/schema/package.json
COPY packages/logic/package.json            packages/logic/package.json
COPY packages/rescript-dsl/package.json     packages/rescript-dsl/package.json
COPY packages/compiler/package.json         packages/compiler/package.json
COPY packages/runtime-core/package.json     packages/runtime-core/package.json
COPY packages/question-kit/package.json     packages/question-kit/package.json
COPY packages/observability/package.json    packages/observability/package.json
COPY packages/design/package.json           packages/design/package.json
COPY packages/logic-parity/package.json     packages/logic-parity/package.json
COPY packages/egress/package.json           packages/egress/package.json
COPY apps/studio/package.json               apps/studio/package.json
COPY apps/runtime/package.json              apps/runtime/package.json
COPY apps/worker/package.json               apps/worker/package.json

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

COPY . .

# turbo's `build` task already encodes the dependency order via `dependsOn: ["^build"]`; the `...`
# suffix selects the runtime and everything it depends on. Reproducing that ordering by hand here
# would be a second definition of the build graph.
RUN pnpm --filter=@resscript/runtime... build

# The client bundle is the half of the build that is easy to lose and silent when lost: the server
# boots, pages render, and nothing responds to input. Fail the BUILD instead.
RUN test -s apps/runtime/dist/client/client.js \
      || (echo "client bundle missing — scripts/build-client.mjs did not run" && exit 1)

# The pruned, production-only tree. `/out` is what ships.
RUN pnpm deploy --filter=@resscript/runtime --prod /out

# `pnpm deploy` resolves the workspace graph itself, so this asserts the result rather than the
# intent.
#
# The five siblings ARE symlinks in the pruned tree — I checked, having first written this comment
# claiming they were real directories. What matters is not symlink-versus-directory but where the
# link POINTS: `pnpm deploy` writes links into the tree's own `.pnpm/` store, which is
# self-contained and survives a `COPY --from`, whereas copying a workspace `node_modules` gives
# links that escape to `/repo/packages/…`, still resolve during `docker build`, and break at
# `docker run` with a module-not-found for a package that appears to be right there.
#
# So the assertion is that every link resolves to a path still under /out, AND that something is
# actually there — `readlink -f` happily resolves a final component that does not exist, so the
# path check alone passes for a package that is simply absent.
#
# `set -e` with `{ …; exit 1; }`, not `( … && exit 1 )`. I wrote the subshell form first and it is
# quietly useless inside a loop: `exit 1` leaves the SUBSHELL, the loop keeps going, and the RUN's
# status is whatever the last iteration returned — so a missing package that is not last in the
# list passes the build. Verified by running both forms; the subshell version printed its error
# and exited 0.
RUN set -e; \
    for p in egress logic observability runtime-core schema; do \
      target="$(readlink -f "/out/node_modules/@resscript/$p" || true)"; \
      case "$target" in \
        /out/*) ;; \
        *) echo "@resscript/$p resolves outside the pruned tree: ${target:-unresolved}"; exit 1 ;; \
      esac; \
      if [ ! -f "$target/package.json" ]; then \
        echo "@resscript/$p is absent from the pruned tree"; exit 1; \
      fi; \
    done; \
    if [ ! -s /out/dist/client/client.js ]; then \
      echo "client bundle missing from pruned tree"; exit 1; \
    fi

# ---------------------------------------------------------------------------------------------
# Stage 2 — the runtime image
# ---------------------------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

# Stamped onto every span and returned by `/health`, which is how a log line is tied back to a
# commit. A build arg because there is nothing in the image to derive it from.
ARG GIT_SHA=unknown
ENV GIT_SHA=$GIT_SHA
ENV NODE_ENV=production
ENV PORT=8081

# The shutdown budget. Both must stay BELOW the orchestrator's termination grace period
# (Kubernetes' default is 30s) or the process is SIGKILLed mid-drain and the graceful path is
# decoration. See the shutdown block in `src/server.ts`.
#
#   SHUTDOWN_READY_DELAY_MS — how long `/ready` answers 503 while the listener is STILL OPEN, so
#     the load balancer can observe a failed probe and stop routing here before the socket goes
#     away. Set this to at least one readiness-probe interval; 5s suits a 5s period. Without it
#     the 503 is unobservable, because closing the listener makes every probe a connection error
#     instead — which the balancer notices just as late, after sending respondents here.
#   SHUTDOWN_GRACE_MS — the hard deadline for the whole shutdown, after which the process exits
#     regardless. Must exceed SHUTDOWN_READY_DELAY_MS with room for in-flight requests to finish.
ENV SHUTDOWN_READY_DELAY_MS=5000
ENV SHUTDOWN_GRACE_MS=10000

# No defaults for RUNTIME_DOMAIN, RUNTIME_DATABASE_URL, REDIS_URL, CDN_URL / ARTIFACT_STORAGE_URL
# or PREVIEW_SIGNING_SECRET, and that is deliberate in each case — `server.ts` and
# `createArtifactLoader()` refuse to boot without the ones that matter, which is the behaviour a
# deployment wants. A default here would convert "this pod will not start" into "this pod starts
# and serves the wrong thing", and for the token source and the artifact source specifically that
# means serving 404 to every respondent. DEPLOY.md lists them.

WORKDIR /app
COPY --from=build /out ./

# `node` (uid 1000) ships with the base image. Nothing here is written at runtime — no artifact
# directory, no export directory — so this only fixes ownership of the app tree.
RUN chown -R node:node /app
USER node

EXPOSE 8081

# Liveness only, and it must stay that way. `/health` does not touch Postgres, Redis or the
# artifact source, and `handler.test.ts` has a test named "/health stays 200 while draining —
# liveness is not readiness" holding it there. A liveness probe that fails during a graceful
# shutdown gets the pod SIGKILLed partway through its own drain; a liveness probe that checks the
# database restarts every pod during a failover. Readiness is `/ready` — it answers 503 while
# draining and when the token resolver is unreachable — and it belongs in the orchestrator's
# manifest, not in a HEALTHCHECK.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8081)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Exec form, no shell wrapper, no `npm start`: SIGTERM has to reach node itself. The server
# installs SIGTERM and SIGINT handlers that flip `/ready` to 503, close the listener, let in-flight
# responses finish, flush the quota write-behind and exit — a shell as PID 1 would swallow the
# signal and every rolling deploy would drop the requests in flight, which for this app means
# respondents losing a page of answers they had already submitted.
#
# No `--init`: QuickJS runs as WASM in-process (ADR-005) and the server spawns no children, so
# there is nothing to reap, and PID 1 node handles signals correctly with handlers registered.
CMD ["node", "dist/server.js"]
