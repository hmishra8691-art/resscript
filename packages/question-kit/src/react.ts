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
export { binary, BinaryEditor, BinaryRenderer } from './plugins/binary/react.js';
export { rating, RatingEditor, RatingRenderer } from './plugins/rating/react.js';
export { text, TextEditor, TextRenderer } from './plugins/text/react.js';
export { textarea, TextareaEditor, TextareaRenderer } from './plugins/textarea/react.js';
export { textList, TextListEditor, TextListRenderer } from './plugins/text-list/react.js';
export { numeric, NumericEditor, NumericRenderer } from './plugins/numeric/react.js';
export { numericList, NumericListEditor, NumericListRenderer } from './plugins/numeric-list/react.js';
export { date, DateEditor, DateRenderer } from './plugins/date/react.js';
export { matrix, MatrixEditor, MatrixRenderer } from './plugins/matrix/react.js';
export { contentText, ContentTextEditor, ContentTextRenderer } from './plugins/content-text/react.js';
export { contentMedia, ContentMediaEditor, ContentMediaRenderer } from './plugins/content-media/react.js';
export { consent, ConsentEditor, ConsentRenderer } from './plugins/consent/react.js';

import type { AnyPlugin } from './contract/plugin.js';
import { binary } from './plugins/binary/react.js';
import { consent } from './plugins/consent/react.js';
import { contentMedia } from './plugins/content-media/react.js';
import { contentText } from './plugins/content-text/react.js';
import { date } from './plugins/date/react.js';
import { matrix } from './plugins/matrix/react.js';
import { multiSelect } from './plugins/multi-select/react.js';
import { nps } from './plugins/nps/react.js';
import { numeric } from './plugins/numeric/react.js';
import { numericList } from './plugins/numeric-list/react.js';
import { rating } from './plugins/rating/react.js';
import { singleSelect } from './plugins/single-select/react.js';
import { text } from './plugins/text/react.js';
import { textarea } from './plugins/textarea/react.js';
import { textList } from './plugins/text-list/react.js';

/**
 * The Phase-1 first-party plugins, with components.
 *
 * The studio's question-type picker is driven by registry metadata (P1-04's frontend line), so
 * adding a fourth plugin means adding it to this list and nothing else — no file in `apps/studio`
 * names a question type.
 */
export const FIRST_PARTY_PLUGINS: readonly AnyPlugin[] = [
  singleSelect, multiSelect, nps,
  binary, rating,
  text, textarea, textList,
  numeric, numericList, date,
  matrix,
  contentText, contentMedia, consent,
];
