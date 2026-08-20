/**
 * The one place every job kind is registered.
 *
 * A single builder function rather than a module with import side effects: import-order-dependent
 * registration is how a kind silently goes missing in one entry point (a test, a one-shot CLI)
 * and is present in another. `buildRegistry()` returns a registry whose TYPE lists every kind,
 * so `WorkerPayloads` is a compile-time map of kind → payload type that the studio's enqueue
 * helpers can use.
 *
 * M0.4 registers only `noop`. `compile` (P1-08), `export` (P1-16), `design` (P1-13) and
 * `reconcile` (P2 quotas) each add one line here plus one file next to `noop.ts` — the kinds
 * enumerated in DB §10.1's `kind` comment.
 */

import { JobRegistry } from '../registry.js';
import { noopJob, NOOP_KIND, type NoopPayload } from './noop.js';

export function buildRegistry(): JobRegistry<{ noop: NoopPayload }> {
  return JobRegistry.create().register(NOOP_KIND, noopJob);
}

/** kind → parsed payload type, derived from the registry rather than restated. */
export type WorkerPayloads = { noop: NoopPayload };
