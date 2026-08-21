/** `date`, assembled. See `../single-select/react.ts` for why the split exists. */

import { withComponents, type QuestionTypePlugin } from '../../contract/plugin.js';
import { dateCore, type DateAnswer, type DateConfig } from './core.js';
import { DateEditor, DateRenderer } from './view.js';

export const date: QuestionTypePlugin<DateConfig, DateAnswer> = withComponents(dateCore, {
  editor: DateEditor,
  renderer: DateRenderer,
});

export { dateCore, DATE_CONFIG_SCHEMA, ISO_DATE_PATTERN, isCalendarDate } from './core.js';
export type { DateAnswer, DateConfig } from './core.js';

export { DateEditor, DateRenderer } from './view.js';
