/**
 * The authored question, as a plugin sees it.
 *
 * This is the kit's view of `@resscript/schema`'s `QuestionNode`, and it is deliberately *not*
 * that type:
 *
 *  - it carries no ids (`QuestionId`, `OptionId`). A plugin has no business holding a database
 *    id: it cannot resolve one, and a plugin that stored one would be reaching across the
 *    boundary ADR-010 draws;
 *  - `config` is generic, so a plugin's own functions are typed in terms of its own config
 *    rather than `JsonObject` with casts at every read;
 *  - the fields a plugin may not touch (`emits`, `scripts`, `masks`, `validation`) are absent,
 *    which makes "a third-party editor cannot patch `required` or `flags.pii`" (F §6) a
 *    property of the type as well as of the patch allowlist.
 *
 * `../interop.ts` converts in both directions and is the only place that knows both shapes.
 */

import type { AuthoredItem } from './items.js';
import type { I18nKey } from './meta.js';
import type { CellOverride, LoopContext, QuestionFlagsView } from './variables.js';

export interface AuthoredQuestion<Config> {
  /** The renameable human handle. Never persisted by a plugin (schema §3). */
  readonly ref: string;
  /** The bare plugin id, as stored in `question.question_type`. Version resolution is the
   * compiler's job, not the author's (F §5.1). */
  readonly questionType: string;
  readonly label: I18nKey | null;
  readonly instruction: I18nKey | null;
  readonly required: boolean;
  readonly config: Config;
  readonly options: readonly AuthoredItem[];
  readonly rows: readonly AuthoredItem[];
  readonly columns: readonly AuthoredItem[];
  readonly cells: readonly CellOverride[];
  readonly flags: QuestionFlagsView;
  readonly loop: LoopContext | null;
}

/** Defaults context — F §1's `defaultConfig(ctx)`. */
export interface DefaultConfigContext {
  /** The org's locale, so a default can be locale-appropriate (a date format, a currency). */
  readonly lang: string;
  /**
   * The question's ref at insertion time. Present because a default may want to reference it
   * (a label key template); a plugin must not *store* it — schema §3 renames refs freely.
   */
  readonly ref: string;
  /**
   * True when the question is being inserted as a matrix cell control, so a plugin can pick a
   * more compact default (a dropdown rather than a 7-across button group).
   */
  readonly asCellControl: boolean;
}

/** Static-check context — F §1. The authored question plus the namer, and nothing else. */
export interface StaticCheckContext<Config> extends AuthoredQuestion<Config> {
  /** Names, so a diagnostic can say "Q5r3" rather than "row 3". */
  readonly name: import('./variables.js').VariableNamer;
}
