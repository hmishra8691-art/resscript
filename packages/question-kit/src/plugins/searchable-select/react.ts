/** `searchable_select`, assembled. See `../single-select/react.ts` for why the split exists. */

import { withComponents, type QuestionTypePlugin } from '../../contract/plugin.js';
import {
  searchableSelectCore,
  type SearchableSelectAnswer,
  type SearchableSelectConfig,
} from './core.js';
import { SearchableSelectEditor, SearchableSelectRenderer } from './view.js';

export const searchableSelect: QuestionTypePlugin<
  SearchableSelectConfig,
  SearchableSelectAnswer
> = withComponents(searchableSelectCore, {
  editor: SearchableSelectEditor,
  renderer: SearchableSelectRenderer,
});

export {
  searchableSelectCore,
  SEARCHABLE_SELECT_CONFIG_SCHEMA,
  SEARCH_WORTHWHILE_AT,
  fold,
  searchMatches,
} from './core.js';
export type { SearchableSelectAnswer, SearchableSelectConfig } from './core.js';

export { SearchableSelectEditor, SearchableSelectRenderer } from './view.js';
