/** `text_list`, assembled. See `../single-select/react.ts` for why the split exists. */

import { withComponents, type QuestionTypePlugin } from '../../contract/plugin.js';
import { textListCore, type TextListAnswer, type TextListConfig } from './core.js';
import { TextListEditor, TextListRenderer } from './view.js';

export const textList: QuestionTypePlugin<TextListConfig, TextListAnswer> = withComponents(
  textListCore,
  { editor: TextListEditor, renderer: TextListRenderer },
);

export { textListCore, TEXT_LIST_CONFIG_SCHEMA, TEXT_LIST_MESSAGE_KEYS } from './core.js';
export type { TextListAnswer, TextListConfig } from './core.js';

export { TextListEditor, TextListRenderer } from './view.js';
