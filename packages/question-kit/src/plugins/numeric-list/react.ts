/** `numeric_list`, assembled. See `../single-select/react.ts` for why the split exists. */

import { withComponents, type QuestionTypePlugin } from '../../contract/plugin.js';
import { numericListCore, type NumericListAnswer, type NumericListConfig } from './core.js';
import { NumericListEditor, NumericListRenderer } from './view.js';

export const numericList: QuestionTypePlugin<NumericListConfig, NumericListAnswer> =
  withComponents(numericListCore, {
    editor: NumericListEditor,
    renderer: NumericListRenderer,
  });

export { numericListCore, NUMERIC_LIST_CONFIG_SCHEMA } from './core.js';
export type { NumericListAnswer, NumericListConfig, NumericListSum } from './core.js';

export { NumericListEditor, NumericListRenderer } from './view.js';
