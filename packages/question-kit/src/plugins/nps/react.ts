/** `nps`, assembled. See `../single-select/index.ts` for why the split exists. */

import { withComponents, type QuestionTypePlugin } from '../../contract/plugin.js';
import { npsCore, type NpsAnswer, type NpsConfig } from './core.js';
import { NpsEditor, NpsRenderer } from './view.js';

export const nps: QuestionTypePlugin<NpsConfig, NpsAnswer> = withComponents(npsCore, {
  editor: NpsEditor,
  renderer: NpsRenderer,
});

export { npsCore, NPS_BANDS, NPS_CONFIG_SCHEMA, NPS_MAX_SCORE, NPS_MIN_SCORE } from './core.js';
export type { NpsAnswer, NpsConfig } from './core.js';

export { NpsEditor, NpsRenderer } from './view.js';
