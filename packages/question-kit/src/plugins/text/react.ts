/** `text`, assembled. See `../single-select/react.ts` for why the split exists. */

import { withComponents, type QuestionTypePlugin } from '../../contract/plugin.js';
import { textCore, type TextAnswer, type TextConfig } from './core.js';
import { TextEditor, TextRenderer } from './view.js';

export const text: QuestionTypePlugin<TextConfig, TextAnswer> = withComponents(textCore, {
  editor: TextEditor,
  renderer: TextRenderer,
});

export { textCore, TEXT_CONFIG_SCHEMA } from './core.js';
export type { TextAnswer, TextConfig, TextInputMode } from './core.js';

export { TextEditor, TextRenderer } from './view.js';
