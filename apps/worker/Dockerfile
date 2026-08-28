# syntax=docker/dockerfile:1.7
#
# apps/worker — the job consumer.
#
# Build from the REPOSITORY ROOT, not from this directory:
#
#   docker build -f apps/worker/Dockerfile -t resscript-worker:$(git rev-parse --short HEAD) \
#     --build-arg GIT_SHA=$(git rev-parse HEAD) .
#
# The context has to be the root because this is a pnpm workspace and the worker imports four
# sibling packages (`@resscript/{compiler,egress,observability,schema}`) as `workspace:*`. A build
# context of `apps/worker` cannot see them and fails at install, not at runtime, which is at least
# the good direction to fail in.
#
# ## Why `pnpm deploy` and not "copy node_modules"
#
# `pnpm deploy --filter=@resscript/worker --prod` resolves the workspace graph and writes a
# self-contained tree with the four sibling packages materialised inside `node_modules/@resscript/`
# and devDependencies dropped. Copying a workspace `node_modules` instead gives you a directory of
# symlinks pointing outside the tree, which survives `docker build` and breaks at `docker run`.
#
# This is the one part of this file that has been verified directly: the same
# `pnpm deploy --filter=@resscript/worker --prod <dir>` invocation was run against this commit,
# and `node dist/server.js` inside the resulting tree booted against real Postgres, answered
# `/ready` with `{"job_store":"ok","consumer":"running","claim":"ok"}`, claimed and completed a
# job, and exited 0 on SIGTERM. The image around it has not been built in CI yet — see
# `apps/worker/DEPLOY.md`.
#
# ## Why the runtime resolves to `dist` and `src` is still copied
#
# Every workspace package's `exports` has three conditions — `types` → `src/*.ts`, `node` →
# `dist/*.js`, `default` → `src/*.ts`. Under Node the `node` condition always wins, so the image
# runs compiled JavaScript and never parses TypeScript. `pnpm deploy` brings `src` along anyway
# (it copies the package as published); it is a few hundred KB and deleting it would leave the
# `default` condition dangling for any tool that resolves without the `node` condition. Left in
# deliberately rather than trimmed for a saving that does not matter.

# ---------------------------------------------------------------------------------------------
# Stage 1 — build the whole workspace, then prune to just the worker
# ---------------------------------------------------------------------------------------------
FROM node:22-bookworm-slim AS build

# Corepack pins pnpm from the root package.json's `packageManager` field (pnpm@9.12.0), so the
# image and a developer's machine cannot drift onto different resolvers.
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

WORKDIR /repo

# Manifests first, source second: the install layer then caches on dependency changes alone, and
# an ordinary code edit does not re-download the world. Every workspace package's package.json
# must be listed for `--frozen-lockfile` to resolve.
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

# `tsc -b` across the graph. Only the worker and its four transitive dependencies are needed, but
# turbo's `build` task already encodes the correct order via `dependsOn: ["^build"]`, and
# reproducing that ordering here by hand would be a second definition of the build graph.
RUN pnpm --filter=@resscript/worker... build

# The pruned, production-only tree. `/out` is what ships.
RUN pnpm deploy --filter=@resscript/worker --prod /out

# ---------------------------------------------------------------------------------------------
# Stage 2 — the runtime image
# ---------------------------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

# Stamped onto every span and returned by `/health`, which is how a log line is tied back to a
# commit. Passed as a build arg because the worker reads it from the environment at boot and
# there is nothing in the image to derive it from.
ARG GIT_SHA=unknown
ENV GIT_SHA=$GIT_SHA
ENV NODE_ENV=production

# The queue's identity has no default on purpose. `server.ts` falls back to an IN-MEMORY store
# when DATABASE_URL is unset — it logs `worker_using_memory_store` with `durable: false` — which
# would give a pod that boots, passes both probes, claims nothing real and loses every job on
# restart. Leaving it unset here means the deployment must supply it.
#
# These two, by contrast, DO get defaults, and they are the paths the volumes must be mounted at.
# `server.ts` would otherwise fall back to `/var/lib/resscript/…`; naming them here keeps the
# image and the deployment manifest agreeing about where the data lives.
ENV ARTIFACT_DIR=/var/lib/resscript/artifacts
ENV EXPORT_DIR=/var/lib/resscript/exports

WORKDIR /app
COPY --from=build /out ./

# `node` (uid 1000) ships with the base image. The directories are created and chowned here so an
# emptyDir or a fresh PVC mounted over them is usable without an initContainer; a volume with its
# own ownership overrides this, which is the normal case and is fine.
RUN mkdir -p "$ARTIFACT_DIR" "$EXPORT_DIR" && chown -R node:node "$ARTIFACT_DIR" "$EXPORT_DIR" /app
USER node

EXPOSE 8082

# Liveness only. `/health` deliberately does NOT touch the database — `health.test.ts` has a test
# named "stays 200 while draining — liveness is not readiness" and a comment explaining that a
# database-checking liveness probe restarts every pod during a Postgres failover, turning a
# recoverable blip into a fleet-wide cold start with the in-flight jobs dropped. Readiness is
# `/ready`, and it belongs in the orchestrator's manifest, not in a HEALTHCHECK.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8082)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Exec form, and no shell wrapper or `npm start`: SIGTERM has to reach node itself. The worker
# installs its own SIGTERM handler and drains in-flight jobs before exiting (see `server.ts`), so
# a shell as PID 1 that swallows the signal would convert every rolling deploy into a batch of
# jobs killed mid-compile and requeued by the stalled sweeper.
#
# No `--init`: the worker spawns no child processes, so there is nothing to reap, and PID 1 node
# handles signals correctly as long as handlers are registered — which they are.
CMD ["node", "dist/server.js"]
