/** `constant_sum`, assembled. See `../single-select/react.ts` for why the split exists. */

import { withComponents, type QuestionTypePlugin } from '../../contract/plugin.js';
import { constantSumCore, type ConstantSumAnswer, type ConstantSumConfig } from './core.js';
import { ConstantSumEditor, ConstantSumRenderer } from './view.js';

export const constantSum: QuestionTypePlugin<ConstantSumConfig, ConstantSumAnswer> =
  withComponents(constantSumCore, {
    editor: ConstantSumEditor,
    renderer: ConstantSumRenderer,
  });

export { constantSumCore, CONSTANT_SUM_CONFIG_SCHEMA, allocation } from './core.js';
export type { ConstantSumAnswer, ConstantSumConfig } from './core.js';

export { ConstantSumEditor, ConstantSumRenderer } from './view.js';
