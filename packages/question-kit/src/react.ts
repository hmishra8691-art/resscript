/**
 * The React entry point: components, and the plugins that carry them.
 *
 * Everything importable from here pulls React into the importing bundle. That is fine for
 * `apps/studio` (the editor) and for the runtime's renderer bundle, and it is not fine for
 * `apps/worker`, the compiler or the exporter — which is why the split exists at all and why
 * `entrypoints.test.ts` asserts that `./index.ts` never reaches these modules.
 *
 * Studio consumes this through the package's `./react` subpath, so a worker import of
 * `@resscript/question-kit` cannot reach a component even by accident.
 */

export { singleSelect, SingleSelectEditor, SingleSelectRenderer } from './plugins/single-select/react.js';
export { multiSelect, MultiSelectEditor, MultiSelectRenderer } from './plugins/multi-select/react.js';
export { nps, NpsEditor, NpsRenderer } from './plugins/nps/react.js';

import type { AnyPlugin } from './contract/plugin.js';
import { multiSelect } from './plugins/multi-select/react.js';
import { nps } from './plugins/nps/react.js';
import { singleSelect } from './plugins/single-select/react.js';

/**
 * The Phase-1 first-party plugins, with components.
 *
 * The studio's question-type picker is driven by registry metadata (P1-04's frontend line), so
 * adding a fourth plugin means adding it to this list and nothing else — no file in `apps/studio`
 * names a question type.
 */
export const FIRST_PARTY_PLUGINS: readonly AnyPlugin[] = [singleSelect, multiSelect, nps];
