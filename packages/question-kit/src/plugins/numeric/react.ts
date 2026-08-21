/** `numeric`, assembled. See `../single-select/react.ts` for why the split exists. */

import { withComponents, type QuestionTypePlugin } from '../../contract/plugin.js';
import { numericCore, type NumericAnswer, type NumericConfig } from './core.js';
import { NumericEditor, NumericRenderer } from './view.js';

export const numeric: QuestionTypePlugin<NumericConfig, NumericAnswer> = withComponents(
  numericCore,
  {
    editor: NumericEditor,
    renderer: NumericRenderer,
  },
);

export {
  numericCore,
  MAX_NUMERIC_MAGNITUDE,
  NUMERIC_CONFIG_SCHEMA,
  onDecimalGrid,
  readGridNumber,
} from './core.js';
export type { NumericAnswer, NumericConfig, NumericUnit } from './core.js';

export { NumericEditor, NumericRenderer } from './view.js';
