/**
 * `single_select`, assembled.
 *
 * The split between `core.ts` and `view.tsx` is the seam `contract/plugin.ts` documents: the
 * compiler, the exporter and the server-side validation pass import the core and never pull React
 * into their process. This module is the only one that joins them, so importing it is the explicit
 * statement "I am a rendering surface".
 */

import { withComponents, type QuestionTypePlugin } from '../../contract/plugin.js';
import { singleSelectCore, type SingleSelectAnswer, type SingleSelectConfig } from './core.js';
import { SingleSelectEditor, SingleSelectRenderer } from './view.js';

export const singleSelect: QuestionTypePlugin<SingleSelectConfig, SingleSelectAnswer> =
  withComponents(singleSelectCore, {
    editor: SingleSelectEditor,
    renderer: SingleSelectRenderer,
  });

export { singleSelectCore, SINGLE_SELECT_CONFIG_SCHEMA } from './core.js';
export type { SingleSelectAnswer, SingleSelectConfig, SingleSelectOtherConfig } from './core.js';

export { SingleSelectEditor, SingleSelectRenderer } from './view.js';
