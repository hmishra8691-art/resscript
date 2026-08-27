/** `ranking`, assembled. See `../single-select/react.ts` for why the split exists. */

import { withComponents, type QuestionTypePlugin } from '../../contract/plugin.js';
import { rankingCore, type RankingAnswer, type RankingConfig } from './core.js';
import { RankingEditor, RankingRenderer } from './view.js';

export const ranking: QuestionTypePlugin<RankingConfig, RankingAnswer> = withComponents(
  rankingCore,
  {
    editor: RankingEditor,
    renderer: RankingRenderer,
  },
);

export { rankingCore, RANKING_CONFIG_SCHEMA, isDenseRanking } from './core.js';
export type { RankingAnswer, RankingConfig } from './core.js';

export { RankingEditor, RankingRenderer } from './view.js';
