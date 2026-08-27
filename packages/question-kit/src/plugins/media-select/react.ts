/** `media_select`, assembled. See `../single-select/react.ts` for why the split exists. */

import { withComponents, type QuestionTypePlugin } from '../../contract/plugin.js';
import { mediaSelectCore, type MediaSelectAnswer, type MediaSelectConfig } from './core.js';
import { MediaSelectEditor, MediaSelectRenderer } from './view.js';

export const mediaSelect: QuestionTypePlugin<MediaSelectConfig, MediaSelectAnswer> =
  withComponents(mediaSelectCore, {
    editor: MediaSelectEditor,
    renderer: MediaSelectRenderer,
  });

export { mediaSelectCore, MEDIA_SELECT_CONFIG_SCHEMA, hasAlt, hasMedia } from './core.js';
export type { MediaSelectAnswer, MediaSelectConfig, MediaSelectMode } from './core.js';

export { MediaSelectEditor, MediaSelectRenderer } from './view.js';
