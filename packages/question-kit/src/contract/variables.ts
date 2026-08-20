/**
 * Variable declaration — Deliverable F §1.1. The single most important type in the package.
 *
 * Everything else in the platform is written against variables (`03-survey-schema.md` §1), so
 * this file is where a new question type acquires logic, piping, masking, quotas,
 * randomization and export support: not by wiring, but because there is nothing to wire.
 *
 * Two rules, both enforced by the test kit and neither negotiable:
 *
 *  1. `declareVariables` is a pure, total function of the *authored* question. Not of the
 *     respondent, not of the language, not of the clock.
 *  2. Variable identity derives from `code`/`ref`, never from `position`.
 *
 * ## Three deviations from F §1.1's sketch, all in service of rule 2
 *
 * F §1.1 sketches `source.part` as six variants and `expression?: LogicAst` as a free-standing
 * optional. Both shapes are looser than the model they have to survive a round-trip through
 * (`packages/schema`'s `VariablePart` and `Variable.expression`), and in each case the looseness
 * costs a real guarantee:
 *
 *  - **`part` gains `column` and `set_view`, and `meta` gains `suffix`.** A variable's *name*
 *    must be reconstructible from its part alone — that is what makes renaming a `ref` a
 *    metadata edit (schema §3) and what lets the compiler match variables across a rebuild by
 *    source signature rather than by name. F's namer offers `column(n)` and `suffixed(s)` while
 *    F's part union can describe neither, so a plugin using them would have to file the
 *    provenance under `meta` and the exporter's "which part of which question produced this
 *    column" answer would be a guess. `verifyDeclarations` then checks name against part, which is
 *    only possible because the part carries enough to re-derive the name.
 *  - **`kind: 'derived'` carries a required `derivation`, and `expression` moves inside it.**
 *    A flat `expression?` makes two illegal states representable: a `response` variable with an
 *    expression, and a `derived` variable with nothing to compute it from. The second one is
 *    the trap: a multi-select's `set<enum>` view and an NPS band are *structurally* derived and
 *    have no authorable expression at all (Deliverable D's AST has no operator that collects
 *    the true booleans of a fan-out), which is exactly why `packages/schema`'s SCH-1015 check
 *    carries an explicit exception for them. Making the discriminant explicit means the
 *    contract states which of the two a plugin meant, instead of leaving the compiler to infer
 *    it from the absence of a field.
 */

import type { JsonObject, JsonValue, VariableType } from '@resscript/schema';
import type { AuthoredItem, OptionCode } from './items.js';
import type { I18nKey } from './meta.js';

/**
 * A logic AST. Deliberately schema's opaque `Expr` envelope rather than `packages/logic`'s
 * node union: `question-kit` must not depend on `logic` (ADR-010 keeps the two versionable
 * apart), and what the kit needs is narrower than the union — carry an AST losslessly into the
 * manifest, where P1-06's checker types it like any other derived expression.
 */
export type LogicAst = { readonly op: string; readonly [key: string]: JsonValue | undefined };

/**
 * Which part of the question a declaration came from.
 *
 * One variant per naming rule in schema §3's table, so `part` and `name` are two views of one
 * fact rather than two fields that can disagree.
 */
export type DeclarationPart =
  /** The question emits one variable: `Q1`. */
  | { readonly kind: 'self' }
  /** One variable per option in a fan-out: `Q2r1` (by `code`, not by position). */
  | { readonly kind: 'option'; readonly optionRef: string }
  /** One variable per row: `Q3r1`. */
  | { readonly kind: 'row'; readonly rowRef: string }
  /** One variable per column, for a column-oriented grid: `Q3c1`. */
  | { readonly kind: 'column'; readonly columnRef: string }
  /** A row x column cell: `Q3r1c2`. Without `columnRef` the cell spans the row: `Q3r1`. */
  | { readonly kind: 'cell'; readonly rowRef: string; readonly columnRef?: string }
  /** `Q6_other`, or `Q2r5_other` when the "other" is one option of a fan-out. */
  | { readonly kind: 'other_specify'; readonly ofRef?: string }
  /** The derived `set<enum>` view over a fan-out: named exactly like the question, `Q2`. */
  | { readonly kind: 'set_view' }
  /**
   * A plugin companion variable: `Q7_band`, `Q9_raw`, `Q9_n`.
   *
   * `suffix` is the name component (schema §4's `{ kind: 'suffix' }` part); `label` is the
   * human provenance the studio shows ("first click x", "region:top_left"). F §1.1 carries only
   * the label, which is why this variant needs both — see the file header.
   */
  | { readonly kind: 'meta'; readonly label: string; readonly suffix: string };

export type DeclarationPartKind = DeclarationPart['kind'];

export interface DeclaredEnumEntry {
  readonly code: OptionCode;
  readonly labelKey: I18nKey;
  readonly meta?: JsonObject;
}

export interface DeclaredNumericDomain {
  readonly min?: number;
  readonly max?: number;
  readonly decimals?: number;
}

export interface DeclaredExport {
  readonly include: boolean;
  readonly column: string;
  readonly labelKey: I18nKey;
  /**
   * Sort key within the question's own columns. Must be derived from `code` or from a constant,
   * never from an array index over a reorderable list — see `compareItemsForDeclaration`.
   */
  readonly order: number;
}

export type AnalysisMeasure = 'nominal' | 'ordinal' | 'scale';

export interface DeclaredAnalysis {
  readonly measure: AnalysisMeasure;
  /** Marks membership of a battery (a matrix, an NPS pair). Carried into SPSS metadata. */
  readonly batteryRef?: string;
}

/* -------------------------------------------------------------------------- */
/* Derivation                                                                 */
/* -------------------------------------------------------------------------- */

/** One member of a `set_view`: the boolean variable that carries it, and the code it stands for. */
export interface SetViewMember {
  readonly variableName: string;
  readonly code: OptionCode;
}

/** One band of a `numeric_band`: a closed interval mapped to an enum code. */
export interface NumericBand {
  readonly code: OptionCode;
  /** Inclusive. */
  readonly from: number;
  /** Inclusive. */
  readonly to: number;
}

/**
 * A *structural* derivation: computable from the question's own shape, with no AST.
 *
 * The closed union is the point. Both members exist because Deliverable D's AST cannot express
 * them (there is no operator that collects the true members of a fan-out, and a band table is
 * data rather than an expression), and both are computed by the platform — `evaluateDerivation`
 * here, the same way on both sides of ADR-004 — rather than by plugin code that would have to
 * run at response time. Adding a third member is a compile error everywhere it matters, which
 * is the property that keeps "derived without an expression" from becoming a catch-all.
 */
export type StructuralDerivation =
  | { readonly computation: 'set_view'; readonly members: readonly SetViewMember[] }
  | {
      readonly computation: 'numeric_band';
      readonly source: string;
      readonly bands: readonly NumericBand[];
    };

export type StructuralComputation = StructuralDerivation['computation'];

/**
 * How a derived variable gets its value.
 *
 * `expression` is the ordinary case (F §4's heatmap region hit-tests): an AST in the artifact,
 * recomputed identically on client and server (ADR-004) and visible in the debug trace.
 * `structural` is the case F §1.1's flat `expression?` cannot represent — see the file header.
 */
export type Derivation =
  | { readonly kind: 'expression'; readonly expression: LogicAst }
  | { readonly kind: 'structural'; readonly structural: StructuralDerivation };

/* -------------------------------------------------------------------------- */
/* The declaration                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Fields common to every declaration.
 *
 * Everything is `readonly`, which F §1.1's sketch does not require. The reason is the purity
 * rule: a declaration handed to the compiler and then mutated by a later plugin (or by the
 * studio panel that displays it) would make `declareVariables` output depend on call order, and
 * the determinism assertion would still pass because it re-derives from scratch. Freezing the
 * type moves that class of bug to compile time; composition still works, because
 * `{ ...v, source, export }` builds a new object rather than editing one.
 */
export interface DeclarationBase {
  /** A name from `ctx.name.*`. The compiler assigns the ULID `id` and stores both. */
  readonly name: string;
  readonly type: VariableType;
  /** Required for `enum` and `set`: the ordered code/label list. Codes, not positions. */
  readonly enumDomain?: readonly DeclaredEnumEntry[];
  /** Numeric domain, for range checks and for SPSS/Parquet type emission. */
  readonly numericDomain?: DeclaredNumericDomain;
  /** Provenance, so the studio can answer "which question produced this column?". */
  readonly source: { readonly part: DeclarationPart };
  readonly export: DeclaredExport;
  /** Inherited from question flags unless the plugin knows better (an open-end always is). */
  readonly pii: boolean;
  /** `false` = recomputed per page, never stored (schema §4). */
  readonly persist: boolean;
  /** Analysis hints carried into the manifest and into SPSS metadata. */
  readonly analysis?: DeclaredAnalysis;
}

/** A variable the respondent's answer writes directly. */
export interface ResponseVariableDeclaration extends DeclarationBase {
  readonly kind: 'response';
}

/** A variable computed from its siblings. Plugins may not declare `system`/`quota`/`design`. */
export interface DerivedVariableDeclaration extends DeclarationBase {
  readonly kind: 'derived';
  readonly derivation: Derivation;
}

export type VariableDeclaration = ResponseVariableDeclaration | DerivedVariableDeclaration;

/** The kinds a plugin may declare. `system`, `quota` and `design` are the platform's (F §6). */
export type DeclarationKind = VariableDeclaration['kind'];

/**
 * The types that can be a column in a flat export table.
 *
 * F §4's policy in one value: an `object` or `set` declaration is fidelity, not analysis, and a
 * question whose *only* declarations are non-scalar fails the test kit with
 * `non_analysable_declaration`. This is the rule that keeps "questions emit variables" honest
 * for exotic types instead of letting them park a JSON blob in one cell.
 */
export const SCALAR_VARIABLE_TYPES: readonly VariableType[] = [
  'enum',
  'boolean',
  'number',
  'text',
  'date',
];

export function isScalarVariableType(type: VariableType): boolean {
  switch (type) {
    case 'enum':
    case 'boolean':
    case 'number':
    case 'text':
    case 'date':
      return true;
    case 'set':
    case 'object':
      return false;
    default: {
      // Adding a VariableType must be a decision about analysability, made here, rather than a
      // silent inheritance of whichever branch `default` happened to fall into.
      const never: never = type;
      throw new Error(`Unhandled variable type: ${JSON.stringify(never)}`);
    }
  }
}

/** Does this declaration need an `enumDomain`? An enum with no codes has no meaning. */
export function requiresEnumDomain(type: VariableType): boolean {
  return type === 'enum' || type === 'set';
}

/* -------------------------------------------------------------------------- */
/* Naming                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The ONLY sanctioned source of variable names.
 *
 * A plugin that string-builds `${ctx.ref}r${n}` would work today and break the day the
 * loop-naming template changes; going through the namer means a rename propagates to export
 * columns with no find-and-replace anywhere. `../naming.ts` is the implementation and carries
 * the parity test against `@resscript/schema`'s `deriveVariableName`.
 */
export interface VariableNamer {
  /** `"Q5"` */
  self(): string;
  /** `"Q5r3"` — `code` is the row's code, never its position. */
  row(code: number): string;
  /** `"Q5c2"` — `code` is the column's code. */
  column(code: number): string;
  /** `"Q5r3"` — options and rows share the r-namespace (schema §3). */
  option(code: number): string;
  /**
   * `"Q5r3c2"`.
   *
   * Not in F §1.1's namer, which lists only `row`/`column`/`option`. A full row x column grid
   * (schema §4's `cell` part, `matrix_grid`) has to name its cells somehow, and the alternative
   * is every grid plugin concatenating `row(r) + 'c' + c` by hand — which is the string-building
   * this interface exists to prevent.
   */
  cell(rowCode: number, columnCode: number): string;
  /** `"Q5_other"`, or `"Q5r3_other"` when the "other" is one option of a fan-out. */
  other(optionCode?: number): string;
  /** `"Q5_band"`. `suffix` must match `NAME_SUFFIX_PATTERN`. */
  suffixed(suffix: string): string;
  /** Name whatever this part describes. The other methods are sugar over this one. */
  of(part: DeclarationPart): string;
}

/**
 * Suffix charset, from F §1.1 (`/^[A-Za-z0-9_]{1,24}$/`).
 *
 * Narrow on purpose: a suffix becomes an export column name, an SPSS variable name (8–64 chars
 * depending on version) and a Parquet field name. A suffix with a hyphen or a space in it is
 * representable here and unrepresentable three formats downstream.
 */
export const NAME_SUFFIX_PATTERN = /^[A-Za-z0-9_]{1,24}$/;

/* -------------------------------------------------------------------------- */
/* Composition (F §3)                                                         */
/* -------------------------------------------------------------------------- */

/** The composition envelope. Mirrors schema §5.2's `QuestionCellControl` exactly. */
export interface CellControl {
  /** Any plugin with `meta.composable === true`. */
  readonly question_type: string;
  /** Validated against THAT plugin's `configSchema`. */
  readonly config?: JsonObject;
  /** Choice controls draw their options from the parent's shared column list. */
  readonly use_columns?: boolean;
}

/**
 * Where a composed child lives inside its parent.
 *
 * `rowCode`/`columnCode` are carried alongside the refs because the child's namer needs the
 * *code* (names are code-derived, F §1.1 rule 2) while its diagnostics and its provenance need
 * the *ref*. `index` is 1-based and exists for `export.order` arithmetic (F §3.1 uses
 * `i * 100 + v.export.order`).
 */
export type ComposeScope =
  | {
      readonly kind: 'row';
      readonly rowRef: string;
      readonly rowCode: number;
      readonly index: number;
    }
  | {
      readonly kind: 'cell';
      readonly rowRef: string;
      readonly rowCode: number;
      readonly columnRef: string;
      readonly columnCode: number;
      readonly index: number;
    };

/** A per-row/per-cell control override, as authored (schema §5.2's `QuestionCell`). */
export interface CellOverride {
  readonly row_ref: string;
  readonly column_ref?: string | null;
  readonly control: CellControl;
}

/* -------------------------------------------------------------------------- */
/* The declaration context                                                    */
/* -------------------------------------------------------------------------- */

export interface QuestionFlagsView {
  readonly pii: boolean;
  readonly excludeFromExport: boolean;
}

/**
 * The loop a question sits inside (schema §13).
 *
 * `iteration` is an addition to F §1.1's sketch, which lists only
 * `{ iterationVariableRef, naming }`. Without the 1-based index the kit *cannot* apply the
 * naming template it promises to apply — `{ref}_{iteration}` has nothing to substitute — so
 * either the field exists or every looped plugin re-implements naming, which is the failure
 * mode the namer exists to prevent. The compiler unrolls iterations (schema §13 caps them),
 * calling `declareVariables` once per iteration with this set.
 */
export interface LoopContext {
  readonly iterationVariableRef: string;
  readonly naming: string;
  readonly iteration: number;
}

export interface VariableDeclContext<Config> {
  /** Current human handle, e.g. "Q5". Renameable (schema §3) — never persist it. */
  readonly ref: string;
  readonly config: Config;
  readonly required: boolean;
  readonly options: readonly AuthoredItem[];
  readonly rows: readonly AuthoredItem[];
  readonly columns: readonly AuthoredItem[];
  readonly cells: readonly CellOverride[];
  readonly flags: QuestionFlagsView;
  readonly loop: LoopContext | null;
  readonly name: VariableNamer;
  /**
   * Delegate a sub-region of this question to another plugin and adopt its declarations under a
   * scoped namer. This is how mixed matrices work without the matrix plugin knowing anything
   * about numeric or text inputs (F §3).
   *
   * Throws `PluginComposeError` when a composition rule is violated; `declareVariablesFor`
   * catches it and turns it into a compile diagnostic, so the compiler never handles an
   * exception. A plugin must not catch it: swallowing a namespace violation is how a cell
   * control ends up writing a column that belongs to another question.
   */
  compose(scope: ComposeScope, control: CellControl): readonly VariableDeclaration[];
}

/* -------------------------------------------------------------------------- */
/* Evaluating a structural derivation                                         */
/* -------------------------------------------------------------------------- */

/**
 * Compute a structurally derived value from a flat variable map.
 *
 * Lives in the contract rather than in the runtime because both sides of ADR-004 need the
 * identical function, and because the exporter's projection needs it too: a `set_view` that the
 * client computes one way and the server another is precisely the divergence ADR-004's metric
 * exists to catch. Total and pure — an absent or wrong-typed input yields `null`, never a throw,
 * because this runs per response row in the projection job.
 */
export function evaluateDerivation(
  derivation: StructuralDerivation,
  vars: Readonly<Record<string, JsonValue | null | undefined>>,
): JsonValue | null {
  switch (derivation.computation) {
    case 'set_view': {
      const selected: OptionCode[] = [];
      for (const member of derivation.members) {
        if (vars[member.variableName] === true) selected.push(member.code);
      }
      // Sorted by code, deduped: schema §1's set model is order-free, and an order-carrying
      // representation would make two equal sets compare unequal in the logic engine.
      return [...new Set(selected)].sort(compareCodes);
    }
    case 'numeric_band': {
      const raw = vars[derivation.source];
      if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
      for (const band of derivation.bands) {
        if (raw >= band.from && raw <= band.to) return band.code;
      }
      // Out of every band is `null`, not the nearest band: a value outside the declared domain
      // is missing data, and quietly rounding it into a band would fabricate a promoter.
      return null;
    }
    default: {
      const never: never = derivation;
      throw new Error(`Unhandled structural derivation: ${JSON.stringify(never)}`);
    }
  }
}

/** Total order over option codes, mixed numeric/string. Numbers first, then strings. */
export function compareCodes(a: OptionCode, b: OptionCode): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'number') return -1;
  if (typeof b === 'number') return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}
