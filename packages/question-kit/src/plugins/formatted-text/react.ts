/** `formatted_text`, assembled. See `../single-select/react.ts` for why the split exists. */

import { withComponents, type QuestionTypePlugin } from '../../contract/plugin.js';
import {
  formattedTextCore,
  type FormattedTextAnswer,
  type FormattedTextConfig,
} from './core.js';
import { FormattedTextEditor, FormattedTextRenderer } from './view.js';

export const formattedText: QuestionTypePlugin<FormattedTextConfig, FormattedTextAnswer> =
  withComponents(formattedTextCore, {
    editor: FormattedTextEditor,
    renderer: FormattedTextRenderer,
  });

export {
  formattedTextCore,
  FORMATTED_TEXT_CONFIG_SCHEMA,
  FORMAT_PATTERNS,
  TEXT_FORMATS,
  normalizeText,
  patternFor,
  patternProblem,
} from './core.js';
export type { FormattedTextAnswer, FormattedTextConfig, TextFormat, TextNormalize } from './core.js';

export { FormattedTextEditor, FormattedTextRenderer } from './view.js';
