/** `matrix`, assembled. See `../single-select/index.ts` for why the split exists. */

import { withComponents, type QuestionTypePlugin } from '../../contract/plugin.js';
import { matrixCore, type MatrixAnswer, type MatrixConfig } from './core.js';
import { MatrixEditor, MatrixRenderer } from './view.js';

export const matrix: QuestionTypePlugin<MatrixConfig, MatrixAnswer> = withComponents(matrixCore, {
  editor: MatrixEditor,
  renderer: MatrixRenderer,
});

export { matrixCore, MATRIX_CONFIG_SCHEMA, controlForRow, rowScope } from './core.js';
export type { MatrixAnswer, MatrixConfig } from './core.js';

export { MatrixEditor, MatrixRenderer } from './view.js';
