/**
 * `@resscript/observability/node` — the Node-only surface.
 *
 * Everything here needs `node:async_hooks`. That is why it is a SEPARATE ENTRY POINT rather
 * than part of `./index`:
 *
 *  - `apps/studio` is Next.js. Its client components import the logger (a Client Component that
 *    logs a failed mutation is normal). If `index.ts` transitively imported `node:async_hooks`,
 *    every consumer's bundler would need a polyfill or an alias, and the failure mode is a
 *    build error in an unrelated app.
 *  - `packages/logic` must run inside QuickJS-WASM (ADR-004), which has no Node builtins at all.
 *
 * The alternative considered and rejected was a lazy `await import('node:async_hooks')` inside
 * the logger. That makes every log call async, and logging has to work from synchronous code
 * (the evaluator, a `finally` block, a signal handler). See ambient.ts for the provider seam
 * this module fills.
 *
 * Importing this module has ONE side effect, on purpose: it installs the AsyncLocalStorage-backed
 * context provider. A Node service does `import '@resscript/observability/node'` once at
 * startup (or simply imports `runWithContext` from here, which is the same thing).
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import { setContextProvider, type CorrelationContext } from './ambient.js';
import { correlationFrom, type HeaderBag } from './request-id.js';
import { startSpan, type Span, type StartSpanOptions } from './trace.js';

const storage = new AsyncLocalStorage<CorrelationContext>();

// The side effect. Registering at module scope (rather than exporting an `install()` the caller
// must remember) means a stray `import { getContext } from '.../node'` deep in a module tree
// still works, which is the behaviour people expect from an ambient-context library.
setContextProvider(() => storage.getStore());

/**
 * Run `fn` with `context` as the ambient correlation context.
 *
 * Every log line, span and error raised inside `fn` — including inside promises it awaits and
 * callbacks it schedules — picks up the request id and trace id without being handed them.
 * This is what makes M0.4's "one request id across studio → worker → runtime" affordable:
 * without it, every function signature in the codebase grows a `ctx` parameter, and the ones
 * that are forgotten are exactly the error paths where correlation matters most.
 */
export function runWithContext<T>(context: CorrelationContext, fn: () => T): T {
  return storage.run(context, fn);
}

/** The ambient context, or `undefined` outside any `runWithContext`. */
export function getContext(): CorrelationContext | undefined {
  return storage.getStore();
}

/**
 * Merge fields into the ambient context for the duration of `fn`.
 *
 * AsyncLocalStorage stores are immutable from the outside by design, so "add the org id once we
 * have authenticated" is a nested `run`, not a mutation. Modelling it explicitly keeps the
 * context a value rather than a mutable bag whose contents depend on await ordering.
 */
export function withContext<T>(patch: Partial<CorrelationContext>, fn: () => T): T {
  const current = storage.getStore();
  const next: CorrelationContext = {
    ...current,
    ...patch,
    bindings: { ...current?.bindings, ...patch.bindings },
  };
  return storage.run(next, fn);
}

/**
 * The standard server entry point: derive correlation from inbound headers, then run the
 * handler inside it. Returns the correlation so the caller can echo `x-request-id` on the
 * response — API §1.5's envelope requires the same value the log line carries.
 */
export function runWithHeaders<T>(
  headers: HeaderBag | undefined,
  fn: (context: CorrelationContext) => T,
): { readonly context: CorrelationContext; readonly result: T } {
  const c = correlationFrom(headers);
  const context: CorrelationContext = {
    requestId: c.requestId,
    traceId: c.traceId,
    traceFlags: c.traceFlags,
    ...(c.parentSpanId === undefined ? {} : { spanId: c.parentSpanId }),
  };
  const result = storage.run(context, () => fn(context));
  return { context, result };
}

/**
 * Start a span and make it the AMBIENT parent for everything inside `fn`.
 *
 * The browser-safe `inSpan` in trace.ts cannot do this — it requires children to pass
 * `{ parent: span }` explicitly. On the server we can do better, and the difference shows up
 * as a flat list of sibling spans versus an actual tree (the M0.4 acceptance criterion is a
 * "span tree", not a span list).
 */
export async function withActiveSpan<T>(
  name: string,
  options: StartSpanOptions,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const current = storage.getStore();
  const span = startSpan(name, options);
  const next: CorrelationContext = {
    ...current,
    traceId: span.context.traceId,
    spanId: span.context.spanId,
    traceFlags: span.context.traceFlags,
  };
  return storage.run(next, async () => {
    try {
      const result = await fn(span);
      if (span.isRecording()) span.setStatus({ code: 'ok' });
      return result;
    } catch (err: unknown) {
      span.recordException(err);
      throw err;
    } finally {
      span.end();
    }
  });
}

export type { CorrelationContext } from './ambient.js';
