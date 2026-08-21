/**
 * Monaco's own editor worker, as a module webpack can turn into a chunk on our origin.
 *
 * This is NOT the ResScript compile worker (§7.4's debounced loop runs `@resscript/rescript-dsl`;
 * see `compile-loop.ts` for why that is on the main thread in this milestone). It exists only so
 * `MonacoEnvironment.getWorker` in `load.ts` has something same-origin to hand back: Monaco throws
 * if the hook is missing, and the alternative — a `blob:` worker from the AMD loader — would need
 * `worker-src blob:` added to the studio CSP for a feature we do not use.
 *
 * The side-effect import is the whole file, by Monaco's design: `editor.worker.js` calls
 * `initialize()` on itself when loaded in a worker scope.
 */

import 'monaco-editor/esm/vs/editor/editor.worker.js';
