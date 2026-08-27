/** `slider`, assembled. See `../single-select/react.ts` for why the split exists. */

import { withComponents, type QuestionTypePlugin } from '../../contract/plugin.js';
import { sliderCore, type SliderAnswer, type SliderConfig } from './core.js';
import { SliderEditor, SliderRenderer } from './view.js';

export const slider: QuestionTypePlugin<SliderConfig, SliderAnswer> = withComponents(sliderCore, {
  editor: SliderEditor,
  renderer: SliderRenderer,
});

export { sliderCore, SLIDER_CONFIG_SCHEMA, gridUnit, restingValue } from './core.js';
export type { SliderAnswer, SliderConfig, SliderRestingPosition, SliderTick } from './core.js';

export { SliderEditor, SliderRenderer } from './view.js';
