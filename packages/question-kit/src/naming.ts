/**
 * Variable naming — schema §3's rule, implemented once for plugins.
 *
 * ## Why this is a second implementation and not a re-export
 *
 * `@resscript/schema` owns the rule (`deriveVariableName`) and this file does not re-export it,
 * which looks like exactly the duplication ADR-010 exists to prevent. It is not, and the reason
 * is a boundary rather than a preference: schema's `VariablePart` identifies items by
 * `OptionId`, and **a plugin has no ids**. `AuthoredItem` carries `ref` and `code` and nothing
 * else, on purpose (`contract/authored.ts`) — a plugin cannot resolve a database id and one that
 * stored one would be reaching across the boundary. Calling schema's function would mean
 * fabricating branded ids inside the kit to satisfy a parameter its naming logic never reads.
 *
 * So the rule is implemented over refs and codes here, and `naming.parity.test.ts` asserts the
 * two agree for **every** part kind, with real ids from schema's own id factory. That is the
 * same shape of guarantee `packages/logic-parity` makes for the evaluator: two implementations
 * that must not drift, with a test that fails the moment they do.
 */

import { applyLoopNaming, DEFAULT_LOOP_NAMING } from '@resscript/schema';
import { PluginComposeError } from './errors.js';
import type { AuthoredItem } from './contract/items.js';
import type {
  ComposeScope,
  DeclarationPart,
  LoopContext,
  VariableNamer,
} from './contract/variables.js';
import { NAME_SUFFIX_PATTERN } from './contract/variables.js';

export interface NamerSpec {
  readonly ref: string;
  readonly loop: LoopContext | null;
  readonly options: readonly AuthoredItem[];
  readonly rows: readonly AuthoredItem[];
  readonly columns: readonly AuthoredItem[];
}

/**
 * The base name (before loop naming) for one part.
 *
 * Row-by-row identical to schema's `deriveBaseName`, and deliberately written as an exhaustive
 * switch: a new `DeclarationPart` without a naming rule is a compile error here, which is the
 * only place it can be caught before it becomes a mystery column.
 */
function baseName(ref: string, part: DeclarationPart, codeOf: (itemRef: string) => number): string {
  switch (part.kind) {
    case 'self':
    case 'set_view':
      return ref;
    case 'option':
      return `${ref}r${codeOf(part.optionRef)}`;
    case 'row':
      return `${ref}r${codeOf(part.rowRef)}`;
    case 'column':
      return `${ref}c${codeOf(part.columnRef)}`;
    case 'cell':
      return part.columnRef === undefined
        ? `${ref}r${codeOf(part.rowRef)}`
        : `${ref}r${codeOf(part.rowRef)}c${codeOf(part.columnRef)}`;
    case 'other_specify':
      return part.ofRef === undefined ? `${ref}_other` : `${ref}r${codeOf(part.ofRef)}_other`;
    case 'meta': {
      if (!NAME_SUFFIX_PATTERN.test(part.suffix)) {
        throw new PluginComposeError(
          'compose_unnameable_part',
          `suffix ${JSON.stringify(part.suffix)} must match ${String(NAME_SUFFIX_PATTERN)}`,
          { suffix: part.suffix },
        );
      }
      return `${ref}_${part.suffix}`;
    }
    default: {
      const never: never = part;
      throw new Error(`Unhandled declaration part: ${JSON.stringify(never)}`);
    }
  }
}

/** Apply the loop template, if the question is inside a loop (schema §13). */
function withLoop(base: string, loop: LoopContext | null): string {
  if (loop === null) return base;
  return applyLoopNaming(loop.naming === '' ? DEFAULT_LOOP_NAMING : loop.naming, base, loop.iteration);
}

/**
 * Derive the name of one declaration part.
 *
 * Exported because verification needs it: `declareVariablesFor` recomputes the name for every
 * declaration's own `part` and rejects a mismatch. That check is what makes `part` and `name`
 * two views of one fact rather than two fields that can disagree — and it is what makes a
 * rename provably total, since after a rename every name is re-derived from the same parts.
 */
export function deriveDeclarationName(spec: NamerSpec, part: DeclarationPart): string {
  return withLoop(baseName(spec.ref, part, codeResolver(spec)), spec.loop);
}

function codeResolver(spec: NamerSpec): (itemRef: string) => number {
  // Options, rows and columns are searched in that order. A ref is unique per question per kind
  // (schema §5.1), so a collision across kinds is possible in principle; when it happens the
  // caller has passed a part whose kind already says which list to read, and `option`/`row`/
  // `column` parts are only ever constructed from the matching list.
  return (itemRef: string): number => {
    for (const list of [spec.options, spec.rows, spec.columns]) {
      const hit = list.find((item) => item.ref === itemRef);
      if (hit !== undefined) return hit.code;
    }
    throw new PluginComposeError(
      'compose_unnameable_part',
      `no option, row or column has ref ${JSON.stringify(itemRef)}`,
      { itemRef },
    );
  };
}

/** The namer handed to `declareVariables` and to `staticChecks`. */
export function createNamer(spec: NamerSpec): VariableNamer {
  const name = (part: DeclarationPart): string => deriveDeclarationName(spec, part);
  const byCode = (list: readonly AuthoredItem[], code: number, kind: string): string => {
    const hit = list.find((item) => item.code === code);
    if (hit === undefined) {
      throw new PluginComposeError(
        'compose_unnameable_part',
        `no ${kind} has code ${code}`,
        { kind, code },
      );
    }
    return hit.ref;
  };
  return {
    self: () => name({ kind: 'self' }),
    row: (code) => name({ kind: 'row', rowRef: byCode(spec.rows, code, 'row') }),
    column: (code) => name({ kind: 'column', columnRef: byCode(spec.columns, code, 'column') }),
    option: (code) => name({ kind: 'option', optionRef: byCode(spec.options, code, 'option') }),
    cell: (rowCode, columnCode) =>
      name({
        kind: 'cell',
        rowRef: byCode(spec.rows, rowCode, 'row'),
        columnRef: byCode(spec.columns, columnCode, 'column'),
      }),
    other: (optionCode) =>
      name(
        optionCode === undefined
          ? { kind: 'other_specify' }
          : { kind: 'other_specify', ofRef: byCode(spec.options, optionCode, 'option') },
      ),
    suffixed: (suffix) => name({ kind: 'meta', label: suffix, suffix }),
    of: name,
  };
}

/**
 * The namer a composed child gets (F §3.1).
 *
 * A child sees a namer whose `self()` is *its cell's* name — `Q5r3`, not `Q5` — which is how the
 * matrix contributes "the name scope and nothing else". Everything a child cannot legally name
 * in a cell scope throws `compose_unnameable_part` rather than inventing a name:
 *
 *  - `row`/`column`/`option`/`cell` — a child fanning out inside a cell would produce `Q5r3r2`,
 *    which F §3.1 rule 4 rejects for the same reason (loop naming has one `{iteration}` slot).
 *  - `suffixed` — there is no part in schema §4 that names `Q5r3_band`. See
 *    `ComposeErrorCode.compose_unnameable_part`; this is why a plugin with companion variables
 *    cannot be a cell control.
 *
 * `other()` survives, because `Q5r3_other` *is* representable: it is the `other_specify` part
 * with the row's code, exactly as a fan-out's other-specify is.
 */
export function createScopedNamer(spec: NamerSpec, scope: ComposeScope): VariableNamer {
  const selfPart: DeclarationPart =
    scope.kind === 'row'
      ? { kind: 'cell', rowRef: scope.rowRef }
      : { kind: 'cell', rowRef: scope.rowRef, columnRef: scope.columnRef };
  const selfName = deriveDeclarationName(spec, selfPart);

  const reject = (what: string): never => {
    throw new PluginComposeError(
      'compose_unnameable_part',
      `a composed child in a ${scope.kind} scope cannot name ${what}: no schema §4 variable part ` +
        'describes it, so the name could not survive a round-trip through the variable registry',
      { scope: scope.kind, what },
    );
  };

  return {
    self: () => selfName,
    row: () => reject('a row'),
    column: () => reject('a column'),
    option: () => reject('an option'),
    cell: () => reject('a cell'),
    other: () =>
      // The child's "other" hangs off the row it lives in, so the name is the row's name plus
      // `_other`. In a full grid scope even that is unrepresentable (`Q5r3c2_other` has no part).
      scope.kind === 'row'
        ? deriveDeclarationName(spec, { kind: 'other_specify', ofRef: scope.rowRef })
        : reject('an other-specify inside a grid cell'),
    suffixed: (suffix) => reject(`the suffix ${JSON.stringify(suffix)}`),
    of: (part) => {
      switch (part.kind) {
        case 'self':
        case 'set_view':
          return selfName;
        case 'other_specify':
          return scope.kind === 'row'
            ? deriveDeclarationName(spec, { kind: 'other_specify', ofRef: scope.rowRef })
            : reject('an other-specify inside a grid cell');
        case 'option':
        case 'row':
        case 'column':
        case 'cell':
        case 'meta':
          return reject(`a ${part.kind} part`);
        default: {
          const never: never = part;
          throw new Error(`Unhandled declaration part: ${JSON.stringify(never)}`);
        }
      }
    },
  };
}

/**
 * Rewrite a child's declaration part into the parent's coordinate system (F §3.1).
 *
 * The matrix's own `declareVariables` does `{ ...v, source: { part: { kind: 'cell', … } } }` in
 * F §3.1's sample; doing it in the kit instead means every composing plugin gets the provenance
 * right, including the `other_specify` case F's sample would have flattened into a cell.
 */
export function rescopePart(part: DeclarationPart, scope: ComposeScope): DeclarationPart {
  switch (part.kind) {
    case 'self':
    case 'set_view':
      return scope.kind === 'row'
        ? { kind: 'cell', rowRef: scope.rowRef }
        : { kind: 'cell', rowRef: scope.rowRef, columnRef: scope.columnRef };
    case 'other_specify':
      return { kind: 'other_specify', ofRef: scope.rowRef };
    case 'option':
    case 'row':
    case 'column':
    case 'cell':
    case 'meta':
      // Unreachable through `createScopedNamer`, which refuses to name these in the first place.
      // Kept as an explicit throw rather than a fallthrough so that a future scoped namer which
      // *does* allow one cannot silently ship the child's own provenance to the parent.
      throw new PluginComposeError(
        'compose_unnameable_part',
        `a composed child cannot contribute a ${part.kind} part`,
        { scope: scope.kind, part: part.kind },
      );
    default: {
      const never: never = part;
      throw new Error(`Unhandled declaration part: ${JSON.stringify(never)}`);
    }
  }
}
