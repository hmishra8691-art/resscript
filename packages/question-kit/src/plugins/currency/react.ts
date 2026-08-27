/** `currency`, assembled. See `../single-select/react.ts` for why the split exists. */

import { withComponents, type QuestionTypePlugin } from '../../contract/plugin.js';
import { currencyCore, type CurrencyAnswer, type CurrencyConfig } from './core.js';
import { CurrencyEditor, CurrencyRenderer } from './view.js';

export const currency: QuestionTypePlugin<CurrencyConfig, CurrencyAnswer> = withComponents(
  currencyCore,
  {
    editor: CurrencyEditor,
    renderer: CurrencyRenderer,
  },
);

export {
  currencyCore,
  CURRENCY_CONFIG_SCHEMA,
  MINOR_UNITS,
  allowedCurrencies,
  minorUnitsOf,
} from './core.js';
export type { CurrencyAnswer, CurrencyConfig } from './core.js';

export { CurrencyEditor, CurrencyRenderer } from './view.js';
