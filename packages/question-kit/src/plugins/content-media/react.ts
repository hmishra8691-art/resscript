/** `content_media`, assembled. See `../single-select/react.ts` for why the split exists. */

import { withComponents, type QuestionTypePlugin } from '../../contract/plugin.js';
import { contentMediaCore, type ContentMediaAnswer, type ContentMediaConfig } from './core.js';
import { ContentMediaEditor, ContentMediaRenderer } from './view.js';

export const contentMedia: QuestionTypePlugin<ContentMediaConfig, ContentMediaAnswer> =
  withComponents(contentMediaCore, {
    editor: ContentMediaEditor,
    renderer: ContentMediaRenderer,
  });

export { contentMediaCore, CONTENT_MEDIA_CONFIG_SCHEMA } from './core.js';
export type { ContentMediaAnswer, ContentMediaConfig } from './core.js';

export { ContentMediaEditor, ContentMediaRenderer } from './view.js';
