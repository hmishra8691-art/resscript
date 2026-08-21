/**
 * Loading Monaco — 09-ui §7.4's "Loading" paragraph and §12's "Monaco first open ≤ 800 ms,
 * prefetched on toggle hover".
 *
 * ```ts
 * <button onMouseEnter={prefetchMonaco} onFocus={prefetchMonaco} onClick={openCodeMode}>code</button>
 * ```
 *
 * `loadMonaco()` memoises the `import()`, so hover-then-click resolves an already-settled promise
 * and the first open feels instant. Nothing else in the app may import `monaco-editor` at runtime:
 * this file is the single seam, which is what keeps the editor out of every route's entry graph
 * (§12: dashboard routes ≤ 180 KB gz, and Monaco alone is ~330 KB).
 *
 * ## Two deviations from §7.4, recorded rather than settled quietly
 *
 * 1. **Self-hosted, but from the app's own chunks rather than `/monaco/vs`.** §7.4 says "Self-hosted
 *    from `/monaco/vs` (no CDN — the studio's CSP is `script-src 'self'`)". The CSP claim is
 *    confirmed by security §3.3 ("The studio origin gets its own, stricter CSP: `script-src 'self'
 *    'nonce-…'`"), and it is satisfied either way: a webpack-emitted chunk under
 *    `/_next/static/chunks/` is as much `'self'` as a copied `vs/` directory is. Bundling is chosen
 *    because it gives content-hashed immutable chunk URLs for free, keeps ~9 MB of vendored editor
 *    files out of git, and needs no postinstall copy step that a future dependency bump could
 *    silently skip. What §7.4 is actually asking for — no CDN, one origin — holds.
 * 2. **`editor.api`, not `editor.main`.** §7.4 wants two chunks: `monaco-core` (editor + our
 *    language) and `monaco-langs` (the TS/HTML/CSS workers, "loaded only when editing a code
 *    asset"), with `basic-languages` excluded entirely. Importing `monaco-editor/esm/vs/editor/
 *    editor.api` is exactly that split at its source: it pulls the editor API and no language
 *    contributions at all. `monaco-langs` will be a second module beside this one when P2 adds the
 *    custom-JS/CSS asset editors; there is nothing for it to load today.
 */

import type * as Monaco from 'monaco-editor';
import { registerResScript, type LanguageServices } from './register';

export type MonacoApi = typeof Monaco;

let pending: Promise<MonacoApi> | undefined;

/**
 * Warm the chunk without mounting an editor. Safe to call repeatedly and from an event handler:
 * it never throws (a rejected import is retried by the next `loadMonaco`).
 */
export function prefetchMonaco(): void {
  void loadMonaco().catch(() => {
    pending = undefined;
  });
}

export function loadMonaco(): Promise<MonacoApi> {
  pending ??= importMonaco();
  return pending;
}

async function importMonaco(): Promise<MonacoApi> {
  configureWorkerEnvironment();
  // The one dynamic import of the editor in the whole app.
  const monaco = (await import('monaco-editor/esm/vs/editor/editor.api')) as unknown as MonacoApi;
  return monaco;
}

/** Register the language against an already-loaded namespace. Idempotent (see `register.ts`). */
export async function loadResScriptEditor(services: LanguageServices): Promise<MonacoApi> {
  const monaco = await loadMonaco();
  registerResScript(monaco, services);
  return monaco;
}

interface MonacoEnvironmentHost {
  MonacoEnvironment?: { getWorker(moduleId: string, label: string): Worker };
}

/**
 * Monaco asks `MonacoEnvironment.getWorker` for its editor worker (word-based suggestions, link
 * detection, diffing). We register no language worker at all — diagnostics come from
 * `@resscript/rescript-dsl` on the main thread (see `compile-loop.ts`) — but Monaco throws rather
 * than degrading if the hook is missing, so it is provided.
 *
 * `new Worker(new URL('./editor.worker', import.meta.url))` is the form webpack (and therefore
 * Next) understands: a *relative* specifier, which it turns into its own chunk on our origin. A
 * bare specifier is not supported, and a `blob:` worker would need `worker-src blob:` in the
 * studio CSP — a CSP relaxation for a feature we do not use is a bad trade.
 */
function configureWorkerEnvironment(): void {
  const host = globalThis as unknown as MonacoEnvironmentHost;
  if (host.MonacoEnvironment !== undefined) return;
  host.MonacoEnvironment = {
    getWorker: (): Worker => new Worker(new URL('./editor.worker', import.meta.url)),
  };
}
