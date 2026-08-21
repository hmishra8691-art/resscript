/** `consent`, assembled. See `../single-select/react.ts` for why the split exists. */

import { withComponents, type QuestionTypePlugin } from '../../contract/plugin.js';
import { consentCore, type ConsentAnswer, type ConsentConfig } from './core.js';
import { ConsentEditor, ConsentRenderer } from './view.js';

export const consent: QuestionTypePlugin<ConsentConfig, ConsentAnswer> = withComponents(consentCore, {
  editor: ConsentEditor,
  renderer: ConsentRenderer,
});

export { consentCore, CONSENT_CONFIG_SCHEMA } from './core.js';
export type { ConsentAnswer, ConsentConfig } from './core.js';

export { ConsentEditor, ConsentRenderer } from './view.js';
