/** `matrix_side_by_side`, assembled. See `../single-select/react.ts` for why the split exists. */

import { withComponents, type QuestionTypePlugin } from '../../contract/plugin.js';
import {
  matrixSideBySideCore,
  type MatrixSideBySideAnswer,
  type MatrixSideBySideConfig,
} from './core.js';
import { MatrixSideBySideEditor, MatrixSideBySideRenderer } from './view.js';

export const matrixSideBySide: QuestionTypePlugin<
  MatrixSideBySideConfig,
  MatrixSideBySideAnswer
> = withComponents(matrixSideBySideCore, {
  editor: MatrixSideBySideEditor,
  renderer: MatrixSideBySideRenderer,
});

export {
  matrixSideBySideCore,
  MATRIX_SIDE_BY_SIDE_CONFIG_SCHEMA,
  blockScope,
} from './core.js';
export type {
  MatrixSideBySideAnswer,
  MatrixSideBySideConfig,
  SideBySideBlock,
} from './core.js';

export { MatrixSideBySideEditor, MatrixSideBySideRenderer } from './view.js';
