/** `textarea`, assembled. See `../single-select/react.ts` for why the split exists. */

import { withComponents, type QuestionTypePlugin } from '../../contract/plugin.js';
import { textareaCore, type TextareaAnswer, type TextareaConfig } from './core.js';
import { TextareaEditor, TextareaRenderer } from './view.js';

export const textarea: QuestionTypePlugin<TextareaConfig, TextareaAnswer> = withComponents(
  textareaCore,
  { editor: TextareaEditor, renderer: TextareaRenderer },
);

export { textareaCore, TEXTAREA_CONFIG_SCHEMA, TEXTAREA_MESSAGE_KEYS, countWords } from './core.js';
export type { TextareaAnswer, TextareaConfig } from './core.js';

export { TextareaEditor, TextareaRenderer } from './view.js';
