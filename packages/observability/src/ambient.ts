/**
 * The ambient-correlation seam.
 *
 * `runWithContext`/`getContext` are backed by `node:async_hooks`, which does not exist in a
 * browser or inside QuickJS-WASM. `@resscript/observability`'s root export is imported by
 * `apps/studio` client components and by `apps/runtime`'s page renderer, so the root export
 * must stay free of Node builtins — a bare `import { AsyncLocalStorage } from 'node:async_hooks'`
 * at the top of `logger.ts` would force every bundler downstream to polyfill it (or fail).
 *
 * WHY a provider slot rather than a lazy dynamic import: a lazy `await import('node:async_hooks')`
 * would make `logger.info()` async, which is unacceptable — logging must be callable from
 * synchronous code including `packages/logic`'s pure evaluator path. So instead:
 *
 *   - this module holds a synchronous provider function, defaulting to "no context";
 *   - `@resscript/observability/node` (src/node.ts) installs an AsyncLocalStorage-backed
 *     provider on import;
 *   - `logger.ts` and `trace.ts` only ever call the slot, so they compile for the browser.
 *
 * A Node service therefore does `import '@resscript/observability/node'` (or imports
 * `runWithContext` from it, which has the same effect) exactly once at startup. Forgetting to
 * degrades correlation to explicit-argument passing; it never breaks.
 */

/** The correlation facts that follow a request across studio → worker → runtime (M0.4). */
export interface CorrelationContext {
  /** `req_<ULID>`, the same value as `app.audit_log.request_id` and API §1.5's envelope. */
  readonly requestId?: string;
  /** W3C trace-context trace-id, 32 lowercase hex chars. */
  readonly traceId?: string;
  /** W3C trace-context span-id of the currently active span, 16 lowercase hex chars. */
  readonly spanId?: string;
  /** Trace flags; bit 0 is `sampled`. */
  readonly traceFlags?: number;
  /** Tenant, when known. Present on every authenticated path (RLS `current_org()`). */
  readonly orgId?: string;
  /** Structured fields every log line in this request should carry. */
  readonly bindings?: Readonly<Record<string, unknown>>;
}

export type ContextProvider = () => CorrelationContext | undefined;

const NO_CONTEXT: ContextProvider = () => undefined;

let provider: ContextProvider = NO_CONTEXT;

/**
 * Install the process-wide ambient context provider. Called by `./node`; also usable by a
 * test or an alternative host (an edge runtime with its own storage primitive).
 */
export function setContextProvider(next: ContextProvider): void {
  provider = next;
}

export function resetContextProvider(): void {
  provider = NO_CONTEXT;
}

/** Read the ambient correlation context, or `undefined` when none is installed/active. */
export function ambientContext(): CorrelationContext | undefined {
  return provider();
}
