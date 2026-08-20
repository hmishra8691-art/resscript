/**
 * The only file that knows both shapes: `@resscript/schema`'s canonical model and the kit's
 * plugin-facing view of it.
 *
 * It exists because of the direction of the dependency (ADR-010): `question-kit` depends on
 * `schema`, never the reverse, so the conversion has to live on this side. Keeping it in one
 * module means the two shapes can diverge deliberately — a plugin sees refs and codes, the
 * database sees ULIDs — without every call site learning both.
 *
 * Two conversions, in opposite directions:
 *
 *  - `fromQuestionNode` — a stored `QuestionNode` becomes the `AuthoredQuestion` a plugin sees.
 *    This is what the API boundary and the compiler call before `declareVariablesFor`.
 *  - `toPlannedVariables` — declarations become `PlannedVariable`s, which
 *    `buildVariableRegistry` turns into `content.variables` rows with stable ids. This is the
 *    P1-04 roadmap line "declareVariables invoked on question save to recompute content.variables".
 */

import type {
  EnumDomainEntry,
  JsonObject,
  LoopSpec,
  OptionId,
  PlannedVariable,
  QuestionItem,
  QuestionNode,
  VariablePart,
} from '@resscript/schema';
import type { AuthoredQuestion } from './contract/authored.js';
import type { AuthoredItem } from './contract/items.js';
import { itemsForDeclaration } from './contract/items.js';
import type {
  CellOverride,
  DeclarationPart,
  LoopContext,
  VariableDeclaration,
} from './contract/variables.js';

/* ========================================================================== */
/* Schema -> kit                                                               */
/* ========================================================================== */

export function toAuthoredItem(item: QuestionItem): AuthoredItem {
  return {
    ref: item.ref,
    code: item.code,
    labelKey: item.label?.key ?? '',
    position: item.position,
    ...(item.value_override === undefined || item.value_override === null
      ? {}
      : { valueOverride: item.value_override }),
    ...(item.exclusive === undefined ? {} : { exclusive: item.exclusive }),
    ...(item.other_specify === undefined ? {} : { otherSpecify: item.other_specify }),
    ...(item.anchor === undefined ? {} : { anchor: item.anchor }),
    ...(item.media === undefined || item.media === null
      ? {}
      : {
          media: {
            ...(item.media.image_asset_id === undefined || item.media.image_asset_id === null
              ? {}
              : { imageAssetId: item.media.image_asset_id }),
            ...(item.media.alt_key === undefined || item.media.alt_key === null
              ? {}
              : { altKey: item.media.alt_key }),
          },
        }),
    ...(item.meta === undefined ? {} : { meta: item.meta }),
  };
}

export interface FromQuestionNodeOptions {
  /** Set when the question is inside a loop, once per unrolled iteration (schema §13). */
  readonly loop?: { readonly spec: LoopSpec; readonly iteration: number };
}

/**
 * Convert a stored question into the shape a plugin sees.
 *
 * Items are sorted by `code` on the way in (`itemsForDeclaration`), so a plugin cannot depend on
 * authored order even by accident — which is what makes F §9's `assertOrderIndependent` a
 * property of the platform rather than a promise each plugin has to keep.
 */
export function fromQuestionNode<Config = JsonObject>(
  node: QuestionNode,
  options: FromQuestionNodeOptions = {},
): AuthoredQuestion<Config> {
  const loop: LoopContext | null =
    options.loop === undefined
      ? null
      : {
          iterationVariableRef: options.loop.spec.iteration_variable_ref,
          naming: options.loop.spec.variable_naming,
          iteration: options.loop.iteration,
        };
  const cells: readonly CellOverride[] = (node.cells ?? []).map((cell) => ({
    row_ref: cell.row_ref,
    ...(cell.column_ref === undefined || cell.column_ref === null
      ? {}
      : { column_ref: cell.column_ref }),
    control: {
      question_type: cell.control.question_type,
      ...(cell.control.config === undefined ? {} : { config: cell.control.config }),
      ...(cell.control.use_columns === undefined
        ? {}
        : { use_columns: cell.control.use_columns }),
    },
  }));

  return {
    ref: node.ref,
    questionType: node.question_type,
    label: node.label?.key ?? null,
    instruction: node.instruction?.key ?? null,
    required: node.required,
    config: (node.config ?? {}) as Config,
    options: itemsForDeclaration((node.options ?? []).map(toAuthoredItem)),
    rows: itemsForDeclaration((node.rows ?? []).map(toAuthoredItem)),
    columns: itemsForDeclaration((node.columns ?? []).map(toAuthoredItem)),
    cells,
    flags: {
      pii: node.flags?.pii === true,
      excludeFromExport: node.flags?.exclude_from_export === true,
    },
    loop,
  };
}

/* ========================================================================== */
/* Kit -> schema                                                               */
/* ========================================================================== */

/**
 * Resolve an item ref to its stored id.
 *
 * The caller supplies it because only the caller has the ids: a plugin never sees one
 * (`contract/authored.ts`), and schema's `VariablePart` needs them because `variableSignature`
 * matches variables across a rebuild by *source*, not by name. That match is the reason a rename
 * keeps every id — and therefore keeps every logic AST, quota and mask pointing at the right
 * column.
 */
export type ItemIdResolver = (ref: string) => OptionId | undefined;

export interface InteropIssue {
  readonly code:
    /** A part referenced an item ref that the question does not contain. */
    | 'unknown_item_ref'
    /**
     * A `value_override` string reached an enum domain, which schema types as `number`.
     *
     * Not coerced: `Number('BRAND_C')` is `NaN` and `Number('07')` is `7`, so a silent coercion
     * either fabricates a code or collides with an existing one. Both are worse than a rejected
     * publish, because both are discovered by the client's analyst.
     */
    | 'enum_code_not_numeric';
  readonly message: string;
  readonly variableName: string;
}

export interface PlannedVariablesResult {
  readonly planned: readonly PlannedVariable[];
  /** Non-empty means the compiler must fail the publish; there is no partial-credit conversion. */
  readonly issues: readonly InteropIssue[];
}

/**
 * Map a kit declaration part onto schema's persisted `VariablePart`.
 *
 * Exhaustive both ways on purpose: this switch is where a new part kind on either side becomes a
 * compile error, and it is the only place the two models are pinned to each other.
 */
export function toVariablePart(
  part: DeclarationPart,
  codeOf: (ref: string) => number | undefined,
  idOf: ItemIdResolver,
): VariablePart | undefined {
  const item = (ref: string): { id: OptionId; code: number } | undefined => {
    const id = idOf(ref);
    const code = codeOf(ref);
    return id === undefined || code === undefined ? undefined : { id, code };
  };
  switch (part.kind) {
    case 'self':
      return { kind: 'scalar' };
    case 'set_view':
      return { kind: 'set_view' };
    case 'option': {
      const hit = item(part.optionRef);
      return hit === undefined ? undefined : { kind: 'option', option_id: hit.id, code: hit.code };
    }
    case 'row': {
      const hit = item(part.rowRef);
      return hit === undefined ? undefined : { kind: 'row', row_id: hit.id, code: hit.code };
    }
    case 'column': {
      const hit = item(part.columnRef);
      return hit === undefined
        ? undefined
        : { kind: 'column', column_id: hit.id, code: hit.code };
    }
    case 'cell': {
      const row = item(part.rowRef);
      if (row === undefined) return undefined;
      // A row-spanning cell (a numeric or text row in a mixed matrix) *is* schema's `row` part:
      // its name is `Q5r3` and it carries one value for the whole row. Only a true row x column
      // cell is schema's `cell`.
      if (part.columnRef === undefined) {
        return { kind: 'row', row_id: row.id, code: row.code };
      }
      const column = item(part.columnRef);
      return column === undefined
        ? undefined
        : {
            kind: 'cell',
            row_id: row.id,
            row_code: row.code,
            column_id: column.id,
            column_code: column.code,
          };
    }
    case 'other_specify': {
      if (part.ofRef === undefined) return { kind: 'other_specify' };
      const hit = item(part.ofRef);
      return hit === undefined
        ? undefined
        : { kind: 'other_specify', option_id: hit.id, code: hit.code };
    }
    case 'meta':
      return { kind: 'suffix', suffix: part.suffix };
    default: {
      const never: never = part;
      throw new Error(`Unhandled declaration part: ${JSON.stringify(never)}`);
    }
  }
}

export interface ToPlannedOptions {
  readonly question: AuthoredQuestion<unknown>;
  readonly idOf: ItemIdResolver;
}

/**
 * Turn declarations into `PlannedVariable`s for `buildVariableRegistry`.
 *
 * Note what is *not* carried across: `expression`. A structural derivation has no AST at all
 * (that is the whole point — schema's SCH-1015 carries the matching exception), and an
 * expression-backed derivation is written by the compiler when it materializes the artifact,
 * because only then does the AST get type-checked against the finished variable registry.
 * `PlannedVariable` has no expression field for exactly this reason.
 */
export function toPlannedVariables(
  declarations: readonly VariableDeclaration[],
  options: ToPlannedOptions,
): PlannedVariablesResult {
  const issues: InteropIssue[] = [];
  const planned: PlannedVariable[] = [];
  const { question } = options;

  const codeOf = (ref: string): number | undefined => {
    for (const list of [question.options, question.rows, question.columns]) {
      const hit = list.find((item) => item.ref === ref);
      if (hit !== undefined) return hit.code;
    }
    return undefined;
  };

  for (const declaration of declarations) {
    const part = toVariablePart(declaration.source.part, codeOf, options.idOf);
    if (part === undefined) {
      issues.push({
        code: 'unknown_item_ref',
        message: `${declaration.name} has a source part naming an item this question does not have`,
        variableName: declaration.name,
      });
      continue;
    }

    let domain: readonly EnumDomainEntry[] | undefined;
    if (declaration.enumDomain !== undefined) {
      const entries: EnumDomainEntry[] = [];
      for (const entry of declaration.enumDomain) {
        if (typeof entry.code !== 'number') {
          issues.push({
            code: 'enum_code_not_numeric',
            message:
              `${declaration.name} declares the non-numeric code ${JSON.stringify(entry.code)}; ` +
              'schema §4 stores enum codes as integers, and coercing a string code would either ' +
              'fabricate one or collide with an existing one',
            variableName: declaration.name,
          });
          continue;
        }
        entries.push({ code: entry.code, label_key: entry.labelKey });
      }
      domain = entries;
    }

    planned.push({
      part,
      kind: declaration.kind,
      type: declaration.type,
      ...(domain === undefined ? {} : { enum_domain: domain }),
      pii: declaration.pii,
      persist: declaration.persist,
    });
  }

  return { planned, issues };
}
