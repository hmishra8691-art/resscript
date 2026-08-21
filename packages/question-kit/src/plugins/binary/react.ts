/** `binary`, assembled. See `../single-select/react.ts` for why the split exists. */

import { withComponents, type QuestionTypePlugin } from '../../contract/plugin.js';
import { binaryCore, type BinaryAnswer, type BinaryConfig } from './core.js';
import { BinaryEditor, BinaryRenderer } from './view.js';

export const binary: QuestionTypePlugin<BinaryConfig, BinaryAnswer> = withComponents(binaryCore, {
  editor: BinaryEditor,
  renderer: BinaryRenderer,
});

export { binaryCore, BINARY_CONFIG_SCHEMA } from './core.js';
export type { BinaryAnswer, BinaryConfig } from './core.js';

export { BinaryEditor, BinaryRenderer } from './view.js';
