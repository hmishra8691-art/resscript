/**
 * Authored question -> `ResolvedQuestion`, the shape a renderer, a validator and a codec see.
 *
 * `ResolvedQuestion` is the boundary between authoring and running (F §1.2): one language,
 * randomization applied, masks applied, option `behaviour` already evaluated to booleans, and the
 * declared variable names already computed. Building it here — rather than in each of the three
 * consumers — is what makes "a renderer cannot read a condition it is not allowed to evaluate"
 * true by construction.
 *
 * The `visible`/`enabled`/`preselected` values are *inputs* to this function, not something it
 * computes. Evaluating an `OptionBehaviour` condition needs the logic engine and the respondent's
 * state, neither of which the kit may depend on (ADR-010, and `packages/logic` lands in P1-06). So
 * the runtime evaluates and passes the result; the default is "everything visible and enabled",
 * which is what an unconditional question resolves to anyway.
 */

import type { JsonValue } from '@resscript/schema';
import type { AuthoredQuestion } from './contract/authored.js';
import { itemCode, type AuthoredItem, type OptionCode, type ResolvedItem } from './contract/items.js';
import type { CodecContext } from './contract/codec.js';
import type {
  ResolvedQuestion,
  ResolvedQuestionVariables,
  ValidateContext,
  ValidationIssue,
  ValidationPhase,
  ValidationSide,
} from './contract/validate.js';
import type { CellControl, ComposeScope, VariableDeclaration } from './contract/variables.js';
import { createNamer } from './naming.js';

/** Per-item runtime state, as evaluated by the runtime. Absent = visible, enabled, not preselected. */
export interface ItemState {
  readonly visible?: boolean;
  readonly enabled?: boolean;
  readonly preselected?: boolean;
  /** Resolved asset URL. Plugins never resolve an asset id themselves (F §6). */
  readonly imageUrl?: string | null;
}

export interface ResolveOptions {
  /** `itemRef -> state`. Refs not present take the defaults. */
  readonly itemStates?: Readonly<Record<string, ItemState>>;
  /** Fallback label when the question has none, so `label` is never `null` for a renderer. */
  readonly fallbackLabelKey?: string;
}

function resolveItem(item: AuthoredItem, options: ResolveOptions): ResolvedItem {
  const state = options.itemStates?.[item.ref];
  return {
    ref: item.ref,
    code: item.code,
    labelKey: item.labelKey,
    position: item.position,
    ...(item.valueOverride === undefined ? {} : { valueOverride: item.valueOverride }),
    ...(item.exclusive === undefined ? {} : { exclusive: item.exclusive }),
    ...(item.otherSpecify === undefined ? {} : { otherSpecify: item.otherSpecify }),
    ...(item.meta === undefined ? {} : { meta: item.meta }),
    media:
      state?.imageUrl === undefined && item.media == null
        ? null
        : {
            ...(state?.imageUrl === undefined ? {} : { imageUrl: state.imageUrl }),
            ...(item.media?.altKey === undefined || item.media.altKey === null
              ? {}
              : { altKey: item.media.altKey }),
          },
    visible: state?.visible ?? true,
    enabled: state?.enabled ?? true,
    preselected: state?.preselected ?? false,
  };
}

/**
 * Index the declared names by the part they came from.
 *
 * This is the map that lets a validator say "attach this error to `Q2r5_other`" without building
 * the string — the reason `ResolvedQuestion.variables` exists at all (F §1.2).
 */
export function indexVariables(
  declarations: readonly VariableDeclaration[],
): ResolvedQuestionVariables {
  let self: string | undefined;
  let other: string | undefined;
  const byRow: Record<string, string> = {};
  const otherByItem: Record<string, string> = {};

  for (const declaration of declarations) {
    const part = declaration.source.part;
    switch (part.kind) {
      case 'self':
        // The response variable wins over a same-named derived view: `Q2` on a multi-select is the
        // set view, and an error attached to "the question" belongs on something a respondent can
        // fix.
        if (self === undefined || declaration.kind === 'response') self = declaration.name;
        break;
      case 'set_view':
        if (self === undefined) self = declaration.name;
        break;
      case 'option':
        byRow[part.optionRef] = declaration.name;
        break;
      case 'row':
        byRow[part.rowRef] = declaration.name;
        break;
      case 'column':
        byRow[part.columnRef] = declaration.name;
        break;
      case 'cell':
        // Keyed by row for a row-spanning cell, `row:column` for a true grid cell. A validator
        // reaching for a cell has both refs; one reaching for a row has one.
        byRow[part.columnRef === undefined ? part.rowRef : `${part.rowRef}:${part.columnRef}`] =
          declaration.name;
        break;
      case 'other_specify':
        if (part.ofRef === undefined) other = declaration.name;
        else otherByItem[part.ofRef] = declaration.name;
        break;
      case 'meta':
        byRow[`meta:${part.suffix}`] = declaration.name;
        break;
      default: {
        const never: never = part;
        throw new Error(`Unhandled declaration part: ${JSON.stringify(never)}`);
      }
    }
  }

  return {
    ...(self === undefined ? {} : { self }),
    ...(other === undefined ? {} : { other }),
    byRow,
    otherByItem,
  };
}

export function resolveQuestion<Config>(
  question: AuthoredQuestion<Config>,
  declarations: readonly VariableDeclaration[],
  options: ResolveOptions = {},
): ResolvedQuestion<Config> {
  const variables = indexVariables(declarations);
  const options_ = question.options.map((item) => resolveItem(item, options));
  const rows = question.rows.map((item) => resolveItem(item, options));
  const columns = question.columns.map((item) => resolveItem(item, options));

  return {
    ref: question.ref,
    config: question.config,
    required: question.required,
    label: question.label ?? options.fallbackLabelKey ?? `${question.ref}.label`,
    instruction: question.instruction,
    options: options_,
    rows,
    columns,
    cells: question.cells,
    variables,
    variableFor(rowRef) {
      const hit = variables.byRow[rowRef];
      if (hit === undefined) {
        // A throw, not `undefined`: a plugin asking for a row it does not have is a bug in the
        // plugin, and returning a blank name would attach an error to nothing at all.
        throw new Error(`question ${question.ref} declares no variable for ${JSON.stringify(rowRef)}`);
      }
      return hit;
    },
    optionRefOf(code) {
      for (const list of [options_, rows, columns]) {
        const hit = list.find((item) => sameCode(itemCode(item), code));
        if (hit !== undefined) return hit.ref;
      }
      return undefined;
    },
  };
}

function sameCode(a: OptionCode, b: JsonValue): boolean {
  // Strict: `'3'` is not code 3. A wire payload that sends the string arrives through the codec,
  // which is where the type is fixed; loosening it here would let a forged payload match a code
  // the UI never offered.
  return typeof b === 'number' || typeof b === 'string' ? a === b : false;
}

/* ========================================================================== */
/* Contexts                                                                    */
/* ========================================================================== */

export interface CodecContextOptions<Config> {
  readonly question: AuthoredQuestion<Config>;
  readonly resolved: ResolvedQuestion<Config>;
  /** Only needed by a composing plugin; a leaf plugin never calls the delegates. */
  readonly delegates?: Partial<Pick<
    CodecContext<Config>,
    'delegateToVariables' | 'delegateParse' | 'delegateFromVariables'
  >>;
}

/**
 * Build a `CodecContext`.
 *
 * The namer is the *same* construction `declareVariables` used, which is the point: F §1.2 says
 * "codec keys cannot drift from declared names", and they cannot because both sides call the same
 * function over the same authored question rather than two string builders that agree today.
 */
export function createCodecContext<Config>(options: CodecContextOptions<Config>): CodecContext<Config> {
  const { question, resolved } = options;
  const namer = createNamer({
    ref: question.ref,
    loop: question.loop,
    options: question.options,
    rows: question.rows,
    columns: question.columns,
  });
  const missing = (what: string) => (): never => {
    throw new Error(`this codec context has no ${what} delegate: the plugin is not composing`);
  };
  return {
    ref: question.ref,
    config: question.config,
    question: resolved,
    name: namer,
    delegateToVariables:
      options.delegates?.delegateToVariables ??
      (missing('toVariables') as (
        scope: ComposeScope,
        control: CellControl,
        answer: unknown,
      ) => Readonly<Record<string, JsonValue | null>>),
    delegateParse: options.delegates?.delegateParse ?? missing('parse'),
    delegateFromVariables: options.delegates?.delegateFromVariables ?? missing('fromVariables'),
  };
}

export interface ValidateContextOptions<Config, Answer> {
  readonly resolved: ResolvedQuestion<Config>;
  readonly value: Answer | undefined;
  readonly required?: boolean;
  readonly phase?: ValidationPhase;
  readonly side: ValidationSide;
  /** Sibling values on the page, for `scope: "page"` rules (schema §14). */
  readonly siblings?: Readonly<Record<string, JsonValue>>;
  readonly delegateValidate?: (
    scope: ComposeScope,
    control: CellControl,
    args: { readonly value: unknown; readonly required: boolean },
  ) => readonly ValidationIssue[];
}

export function createValidateContext<Config, Answer>(
  options: ValidateContextOptions<Config, Answer>,
): ValidateContext<Config, Answer> {
  return {
    question: options.resolved,
    value: options.value,
    required: options.required ?? options.resolved.required,
    phase: options.phase ?? 'on_submit',
    side: options.side,
    read: (variableName) => options.siblings?.[variableName],
    delegateValidate:
      options.delegateValidate ??
      ((): readonly ValidationIssue[] => {
        throw new Error('this validate context has no delegate: the plugin is not composing');
      }),
  };
}
