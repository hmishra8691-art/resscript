/** `rating`, assembled. See `../single-select/react.ts` for why the split exists. */

import { withComponents, type QuestionTypePlugin } from '../../contract/plugin.js';
import { ratingCore, type RatingAnswer, type RatingConfig } from './core.js';
import { RatingEditor, RatingRenderer } from './view.js';

export const rating: QuestionTypePlugin<RatingConfig, RatingAnswer> = withComponents(ratingCore, {
  editor: RatingEditor,
  renderer: RatingRenderer,
});

export { ratingCore, RATING_CONFIG_SCHEMA } from './core.js';
export type { RatingAnswer, RatingConfig } from './core.js';

export { RatingEditor, RatingRenderer } from './view.js';
