/** `multi_select`, assembled. See `../single-select/index.ts` for why the split exists. */

import { withComponents, type QuestionTypePlugin } from '../../contract/plugin.js';
import { multiSelectCore, type MultiSelectAnswer, type MultiSelectConfig } from './core.js';
import { MultiSelectEditor, MultiSelectRenderer } from './view.js';

export const multiSelect: QuestionTypePlugin<MultiSelectConfig, MultiSelectAnswer> = withComponents(
  multiSelectCore,
  { editor: MultiSelectEditor, renderer: MultiSelectRenderer },
);

export { multiSelectCore, MULTI_SELECT_CONFIG_SCHEMA } from './core.js';
export type { MultiSelectAnswer, MultiSelectConfig } from './core.js';

export { MultiSelectEditor, MultiSelectRenderer } from './view.js';
