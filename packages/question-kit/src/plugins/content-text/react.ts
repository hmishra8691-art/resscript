/** `content_text`, assembled. See `../single-select/react.ts` for why the split exists. */

import { withComponents, type QuestionTypePlugin } from '../../contract/plugin.js';
import { contentTextCore, type ContentTextAnswer, type ContentTextConfig } from './core.js';
import { ContentTextEditor, ContentTextRenderer } from './view.js';

export const contentText: QuestionTypePlugin<ContentTextConfig, ContentTextAnswer> =
  withComponents(contentTextCore, {
    editor: ContentTextEditor,
    renderer: ContentTextRenderer,
  });

export { contentTextCore, CONTENT_TEXT_CONFIG_SCHEMA } from './core.js';
export type { ContentTextAnswer, ContentTextConfig } from './core.js';

export { ContentTextEditor, ContentTextRenderer } from './view.js';
