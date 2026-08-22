/**
 * The one place every job kind is registered.
 *
 * A single builder function rather than a module with import side effects: import-order-dependent
 * registration is how a kind silently goes missing in one entry point (a test, a one-shot CLI)
 * and is present in another. `buildRegistry()` returns a registry whose TYPE lists every kind,
 * so `WorkerPayloads` is a compile-time map of kind → payload type that the studio's enqueue
 * helpers can use.
 *
 * P1-08 added `compile`; P1-12 added `export` (which DID come with a migration — 0012 — but for
 * `app.exports` and its read RPC, not for the kind string). `design` (P1-13) and `reconcile`
 * (P2 quotas) each add one line here plus one file next to `noop.ts` — the kinds enumerated in
 * DB §10.1's `kind` comment. Nothing on the database side is needed for the kind itself: 0003
 * made `ops.jobs.kind` free text with a format CHECK on purpose, "because job kinds are an
 * implementation detail of apps/worker and adding one must not require a migration", and
 * 0009 §0 restates it.
 *
 * ## Why `compile` takes an argument and `noop` does not
 *
 * `noop` needs nothing but its payload. `compile` needs a database session factory and an
 * artifact store, and `JobContext` deliberately hands a handler neither (see `registry.ts`: a
 * handler that can reach the store can complete a job it no longer owns). So the environment
 * arrives here, at registration, and `server.ts` builds it from `DATABASE_URL`.
 *
 * The kind is registered UNCONDITIONALLY, even when no environment was supplied, and that is the
 * decision this file makes rather than a convenience. `registry.kinds()` is what the consumer
 * passes to `ops.claim_job`, so a `compile` that were registered only when configured would leave
 * publish jobs sitting `queued` on a misconfigured worker — visible as a spinner that never
 * finishes and as nothing at all in the logs. `unconfiguredCompileEnvironment()` instead makes the
 * job fail on its first statement with a message naming the missing variable, which the stalled
 * sweeper and the studio's job view both surface. A queue that drains into a clear error beats a
 * queue that silently does not drain.
 */

import { JobRegistry } from '../registry.js';
import { noopJob, NOOP_KIND, type NoopPayload } from './noop.js';
import {
  compileJob,
  COMPILE_KIND,
  unconfiguredCompileEnvironment,
  type CompileEnvironment,
  type CompilePayload,
} from './compile.js';
import {
  exportJob,
  EXPORT_KIND,
  unconfiguredExportEnvironment,
  type ExportEnvironment,
  type ExportPayload,
} from './export.js';

/** What the kinds that need more than a payload are given. One field per such kind. */
export interface WorkerDependencies {
  readonly compile?: CompileEnvironment;
  readonly export?: ExportEnvironment;
}

export function buildRegistry(
  deps: WorkerDependencies = {},
): JobRegistry<{ noop: NoopPayload; compile: CompilePayload; export: ExportPayload }> {
  return JobRegistry.create()
    .register(NOOP_KIND, noopJob)
    .register(COMPILE_KIND, compileJob(deps.compile ?? unconfiguredCompileEnvironment()))
    .register(EXPORT_KIND, exportJob(deps.export ?? unconfiguredExportEnvironment()));
}

/** kind → parsed payload type, derived from the registry rather than restated. */
export type WorkerPayloads = { noop: NoopPayload; compile: CompilePayload; export: ExportPayload };
