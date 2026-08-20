/**
 * The variable model — Deliverable C §1 and §4.
 *
 * This is the load-bearing file of the package. Everything downstream (logic, piping,
 * masking, quotas, validation, export) reads variables, so the rules here define the export
 * contract of every survey the platform will ever run.
 *
 * Three responsibilities:
 *
 *  1. `deriveVariableName` — the deterministic naming rules. Documented, total, and testable
 *     row-by-row against C §1's table.
 *  2. `buildVariableRegistry` / `applyVariableRegistry` — turn a content tree into the ordered
 *     variable list, reusing ids so recomputation is not renaming.
 *  3. `renameRef` — rename a node's handle and recompute every derived name, changing no id.
 */

import { createIdFactory, type IdFactory, type QuestionId, type VariableId } from './ids.js';
import { isReservedVariableName, RESERVED_VARIABLE_NAMES } from './registries.js';
import { DEFAULT_LOOP_NAMING } from './types/content.js';
import type {
  BlockNode,
  ContentNode,
  LoopSpec,
  PageNode,
  QuestionCell,
  QuestionItem,
  QuestionNode,
  TextNode,
} from './types/content.js';
import type { Survey } from './types/survey.js';
import type {
  EnumDomainEntry,
  Variable,
  VariableKind,
  VariablePart,
  VariableStorage,
  VariableType,
} from './types/variables.js';

export { RESERVED_VARIABLE_NAMES, isReservedVariableName };

/* ========================================================================== */
/* 1. Name derivation                                                          */
/* ========================================================================== */

export interface DeriveVariableNameInput {
  /** The owning node's current `ref` — the *only* thing that changes on a rename. */
  readonly ref: string;
  readonly part: VariablePart;
  /** 1-based loop iteration; omit outside a loop. */
  readonly iteration?: number;
  /** Loop naming template; defaults to C §13's `{ref}_{iteration}`. */
  readonly loop_naming?: string;
}

/**
 * Derive a variable's name from its owner's `ref` and the part of the question it came from.
 *
 * The complete rule set (Deliverable C §1 and §3):
 *
 * | Source                                    | Name             |
 * |-------------------------------------------|------------------|
 * | single select / numeric / text / NPS      | `Q1`             |
 * | multi-select option fan-out               | `Q2r1`…`Q2r5`    |
 * | derived set view over that fan-out        | `Q2`             |
 * | matrix row / numeric list row             | `Q3r1`           |
 * | matrix column                             | `Q3c1`           |
 * | row x column grid cell                    | `Q3r1c2`         |
 * | other-specify on the question             | `Q6_other`       |
 * | other-specify on one option of a fan-out  | `Q2r5_other`     |
 * | plugin companion (NPS band, …)            | `Q7_band`        |
 * | design task slot                          | `MD_t1_best`     |
 * | any of the above inside a loop            | `…_1`, `…_2`     |
 *
 * **`r{n}` and `c{n}` use the item's `code`, never its `position`.** This is the same
 * distinction C §5.1 calls "a classic data disaster", applied to column names: a column
 * header is an exported value, so randomizing or reordering the display must not rewrite it.
 * With codes, `Q2r3` means "the option whose code is 3" for the life of the study, in every
 * wave, regardless of how the list was reordered in between.
 */
export function deriveVariableName(input: DeriveVariableNameInput): string {
  const base = deriveBaseName(input.ref, input.part);
  if (input.iteration === undefined) return base;
  const template = input.loop_naming ?? DEFAULT_LOOP_NAMING;
  return applyLoopNaming(template, base, input.iteration);
}

function deriveBaseName(ref: string, part: VariablePart): string {
  switch (part.kind) {
    case 'scalar':
    case 'set_view':
      return ref;
    case 'option':
      return `${ref}r${part.code}`;
    case 'row':
      return `${ref}r${part.code}`;
    case 'column':
      return `${ref}c${part.code}`;
    case 'cell':
      return `${ref}r${part.row_code}c${part.column_code}`;
    case 'other_specify':
      return part.code === undefined ? `${ref}_other` : `${ref}r${part.code}_other`;
    case 'suffix':
      return `${ref}_${part.suffix}`;
    case 'design_task':
      return `${ref}_t${part.task}_${part.role}`;
    default: {
      // Exhaustiveness guard: adding a VariablePart without a naming rule is a compile error
      // here, which is the only place it can be caught before it becomes a mystery column.
      const never: never = part;
      throw new Error(`Unhandled variable part: ${JSON.stringify(never)}`);
    }
  }
}

export function applyLoopNaming(template: string, base: string, iteration: number): string {
  return template.replaceAll('{ref}', base).replaceAll('{iteration}', String(iteration));
}

/**
 * A stable identity for "which part of which question, in which iteration".
 *
 * This is what makes recomputation safe: names change on rename, ids must not, so variables
 * are matched across a rebuild by *source signature* rather than by name.
 */
export function variableSignature(
  questionId: QuestionId | undefined,
  part: VariablePart,
  iteration?: number,
): string {
  const suffix = iteration === undefined ? '' : `@${iteration}`;
  const owner = questionId ?? '-';
  switch (part.kind) {
    case 'scalar':
      return `${owner}:scalar${suffix}`;
    case 'set_view':
      return `${owner}:set_view${suffix}`;
    case 'option':
      return `${owner}:option:${part.option_id}${suffix}`;
    case 'row':
      return `${owner}:row:${part.row_id}${suffix}`;
    case 'column':
      return `${owner}:column:${part.column_id}${suffix}`;
    case 'cell':
      return `${owner}:cell:${part.row_id}:${part.column_id}${suffix}`;
    case 'other_specify':
      return `${owner}:other:${part.option_id ?? '-'}${suffix}`;
    case 'suffix':
      return `${owner}:suffix:${part.suffix}${suffix}`;
    case 'design_task':
      return `${owner}:design:${part.task}:${part.role}${suffix}`;
    default: {
      const never: never = part;
      throw new Error(`Unhandled variable part: ${JSON.stringify(never)}`);
    }
  }
}

/* ========================================================================== */
/* 2. Reserved namespace                                                       */
/* ========================================================================== */

export interface ReservedNameCollision {
  readonly name: string;
  readonly reserved: string;
}

/**
 * Case-insensitive because Deliverable B's uniqueness index is on `lower(name)`: accepting
 * `Respondent_Id` here would only defer the failure to the INSERT, with a Postgres error
 * message instead of a diagnostic.
 */
export function findReservedNameCollisions(
  names: readonly string[],
): readonly ReservedNameCollision[] {
  const out: ReservedNameCollision[] = [];
  for (const name of names) {
    if (isReservedVariableName(name)) out.push({ name, reserved: name.toLowerCase() });
  }
  return out;
}

/* ========================================================================== */
/* 3. Emission planning                                                        */
/* ========================================================================== */

/** One variable a question will emit, before it is given an id and a name. */
export interface PlannedVariable {
  readonly part: VariablePart;
  readonly kind: VariableKind;
  readonly type: VariableType;
  readonly enum_domain?: readonly EnumDomainEntry[] | null;
  readonly storage?: VariableStorage;
  readonly pii?: boolean;
  readonly persist?: boolean;
}

/**
 * The built-in emission table.
 *
 * In P1-04 this becomes the plugin contract's `declareVariables()` (Deliverable F §1) and
 * every question type owns its own emission. Schema ships this table because the canonical
 * model has to be usable — and testable against C §1's table — before `question-kit` exists,
 * and because `packages/schema` must never depend on `question-kit` (ADR-010). Anything not
 * listed falls back to a single scalar, which is wrong for exotic types and deliberately
 * conservative: one column of the right name beats zero columns.
 */
export const BUILTIN_SCALAR_TYPES: Readonly<Record<string, VariableType>> = {
  single_select: 'enum',
  dropdown: 'enum',
  numeric: 'number',
  slider: 'number',
  nps: 'number',
  text: 'text',
  open_text: 'text',
  textarea: 'text',
  email: 'text',
  date: 'date',
  ranking: 'number',
};

/** NPS bands, the first-party example of a plugin-declared companion variable. */
export const NPS_BAND_DOMAIN: readonly EnumDomainEntry[] = [
  { code: 1, label_key: 'sys.nps.detractor' },
  { code: 2, label_key: 'sys.nps.passive' },
  { code: 3, label_key: 'sys.nps.promoter' },
];

function itemsDomain(items: readonly QuestionItem[] | undefined): readonly EnumDomainEntry[] {
  return (items ?? []).map((i) => ({ code: i.code, label_key: i.label?.key ?? '' }));
}

function cellFor(
  cells: readonly QuestionCell[] | undefined,
  rowRef: string,
  columnRef?: string,
): QuestionCell | undefined {
  return (cells ?? []).find(
    (c) => c.row_ref === rowRef && (c.column_ref ?? null) === (columnRef ?? null),
  );
}

/** Map a control's question type onto the variable type its answer stores. */
export function variableTypeForControl(questionType: string): VariableType {
  return BUILTIN_SCALAR_TYPES[questionType] ?? (questionType === 'multi_select' ? 'set' : 'text');
}

/**
 * Plan the variables a question emits, from its declared structure.
 *
 * The shape is chosen by the question type; the *contents* come from the question's own
 * options/rows/columns/cells, which is why a mixed matrix needs no special case anywhere else
 * in the system: row A's cell says `numeric`, so row A's variable is a number.
 */
export function planQuestionEmissions(question: QuestionNode): readonly PlannedVariable[] {
  const qt = question.question_type;
  const pii = question.flags?.pii === true;
  const rows = question.rows ?? [];
  const columns = question.columns ?? [];
  const options = question.options ?? [];

  const withPii = (p: PlannedVariable): PlannedVariable => (pii ? { ...p, pii: true } : p);

  /**
   * Open-ends default to `pii: true` because a verbatim box is where respondents type their
   * name, their employer and occasionally their phone number. An author who knows better can
   * say so explicitly with `flags.pii = false`; the default is the safe direction, since a
   * column wrongly marked PII is an annoyance and one wrongly not marked is an incident.
   */
  const openEndPii = question.flags?.pii !== false;

  switch (qt) {
    case 'display_text':
    case 'text_display':
    case 'instruction':
      // A display node collects nothing. Emitting a phantom column here is how "why is Q4
      // empty for everyone" tickets happen.
      return [];

    case 'multi_select': {
      const planned: PlannedVariable[] = [];
      for (const opt of options) {
        planned.push(
          withPii({
            part: { kind: 'option', option_id: opt.id, code: opt.code },
            kind: 'response',
            type: 'boolean',
            storage: { code: opt.code, label_key: opt.label?.key ?? null },
          }),
        );
      }
      // The derived set view: `Q2 : set<enum>`. It is what lets `Q2 ANY_OF [1,3]` and
      // `Q2r1 == true` be the same machinery instead of two code paths.
      planned.push({
        part: { kind: 'set_view' },
        kind: 'derived',
        type: 'set',
        enum_domain: itemsDomain(options),
        persist: false,
      });
      for (const opt of options) {
        if (opt.other_specify === true) {
          planned.push({
            part: { kind: 'other_specify', option_id: opt.id, code: opt.code },
            kind: 'response',
            type: 'text',
            pii: openEndPii,
          });
        }
      }
      return planned;
    }

    case 'matrix':
    case 'matrix_single':
    case 'matrix_mixed':
    case 'numeric_list':
    case 'rank_list': {
      const defaultType: VariableType =
        qt === 'numeric_list' || qt === 'rank_list' ? 'number' : 'enum';
      const planned: PlannedVariable[] = [];
      for (const row of rows) {
        const cell = cellFor(question.cells, row.ref);
        const control = cell?.control;
        const type =
          control === undefined ? defaultType : variableTypeForControl(control.question_type);
        planned.push(
          withPii({
            part: { kind: 'row', row_id: row.id, code: row.code },
            kind: 'response',
            type,
            // The shared column list is the domain for a select row. A cell-level select that
            // supplies its own option list in plugin config is a P1-04 concern: `declareVariables`
            // owns it, and schema deliberately does not read plugin config to guess.
            ...(type === 'enum' || type === 'set' ? { enum_domain: itemsDomain(columns) } : {}),
            storage: { code: row.code, label_key: row.label?.key ?? null },
            // A text row in a mixed matrix is an open-end, so it inherits the same default.
            ...(type === 'text' ? { pii: openEndPii } : {}),
          }),
        );
      }
      return planned;
    }

    case 'matrix_grid': {
      const planned: PlannedVariable[] = [];
      for (const row of rows) {
        for (const col of columns) {
          const cell = cellFor(question.cells, row.ref, col.ref);
          const type =
            cell === undefined ? 'number' : variableTypeForControl(cell.control.question_type);
          planned.push(
            withPii({
              part: {
                kind: 'cell',
                row_id: row.id,
                row_code: row.code,
                column_id: col.id,
                column_code: col.code,
              },
              kind: 'response',
              type,
            }),
          );
        }
      }
      return planned;
    }

    case 'maxdiff': {
      const tasks = readPositiveInt(question.config?.['tasks']) ?? 0;
      const planned: PlannedVariable[] = [];
      const domain = itemsDomain(options);
      for (let t = 1; t <= tasks; t += 1) {
        for (const role of ['best', 'worst'] as const) {
          planned.push({
            part: { kind: 'design_task', task: t, role },
            // `design` kind: without a record of what the respondent was shown, MaxDiff data
            // cannot be estimated at all.
            kind: 'design',
            type: 'enum',
            enum_domain: domain,
          });
        }
      }
      return planned;
    }

    case 'nps': {
      return [
        withPii({ part: { kind: 'scalar' }, kind: 'response', type: 'number' }),
        {
          part: { kind: 'suffix', suffix: 'band' },
          kind: 'derived',
          type: 'enum',
          enum_domain: NPS_BAND_DOMAIN,
        },
      ];
    }

    default: {
      const type = BUILTIN_SCALAR_TYPES[qt] ?? 'text';
      const planned: PlannedVariable[] = [
        withPii({
          part: { kind: 'scalar' },
          kind: 'response',
          type,
          ...(type === 'enum' ? { enum_domain: itemsDomain(options) } : {}),
          ...(type === 'text' && BUILTIN_SCALAR_TYPES[qt] === 'text' ? { pii: openEndPii } : {}),
        }),
      ];
      const other = options.find((o) => o.other_specify === true);
      if (other !== undefined) {
        planned.push({
          part: { kind: 'other_specify' },
          kind: 'response',
          type: 'text',
          pii: openEndPii,
        });
      }
      return planned;
    }
  }
}

function readPositiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

/* ========================================================================== */
/* 4. The registry                                                             */
/* ========================================================================== */

export interface BuildVariableRegistryOptions {
  /** Id source for variables that did not exist before. Inject for deterministic fixtures. */
  readonly ids?: IdFactory;
}

export interface VariableRegistryResult {
  /** Ordered: question-emitted variables in document order, then authored non-response ones. */
  readonly variables: readonly Variable[];
  /** `question_id → emitted variable ids`, for writing back `QuestionNode.emits`. */
  readonly emits: ReadonlyMap<QuestionId, readonly VariableId[]>;
}

/**
 * Recompute the whole variable registry from the content tree.
 *
 * Order is the export column order (Deliverable B stores it as `variables.sort_key`), so it
 * has to be deterministic: document order for everything a question emits, then the authored
 * hidden/derived/system/quota variables in their declared order. Document order is the order
 * a respondent meets the questions in, which is the order an analyst expects the columns in.
 *
 * Ids are reused whenever a variable's *source signature* matches one already in the survey.
 * That is the whole reason renaming is a metadata edit: the name changes, the id does not, and
 * every AST, quota and mask that points at the id keeps working untouched.
 */
export function buildVariableRegistry(
  survey: Survey,
  options: BuildVariableRegistryOptions = {},
): VariableRegistryResult {
  const ids = options.ids ?? createIdFactory();

  const bySignature = new Map<string, Variable>();
  for (const existing of survey.variables) {
    if (existing.source === undefined) continue;
    bySignature.set(
      variableSignature(existing.source.question_id, existing.source.part, existing.source.iteration),
      existing,
    );
  }

  const out: Variable[] = [];
  const emits = new Map<QuestionId, VariableId[]>();

  walkQuestions(survey.content, (question, loop) => {
    const emitted: VariableId[] = [];
    const iterations = loop === undefined ? [undefined] : loopIterations(loop);
    for (const iteration of iterations) {
      for (const planned of planQuestionEmissions(question)) {
        const signature = variableSignature(question.id, planned.part, iteration);
        const previous = bySignature.get(signature);
        const name = deriveVariableName({
          ref: question.ref,
          part: planned.part,
          ...(iteration === undefined ? {} : { iteration }),
          ...(loop === undefined ? {} : { loop_naming: loop.variable_naming }),
        });
        const variable = materialize({
          previous,
          id: previous?.id ?? ids.next('variable'),
          name,
          planned,
          questionId: question.id,
          ...(iteration === undefined ? {} : { iteration }),
          excludeFromExport: question.flags?.exclude_from_export === true,
        });
        out.push(variable);
        emitted.push(variable.id);
      }
    }
    emits.set(question.id, emitted);
  });

  // Authored variables that no question produces: hidden (URL/vendor params), derived,
  // system, quota and design. They keep their declared order — a programmer who put
  // VENDOR_PID first wants it first in the export.
  for (const existing of survey.variables) {
    if (existing.source?.question_id !== undefined) continue;
    out.push(existing);
  }

  return { variables: out, emits };
}

function loopIterations(loop: LoopSpec): readonly number[] {
  const out: number[] = [];
  for (let i = 1; i <= loop.max_iterations; i += 1) out.push(i);
  return out;
}

interface MaterializeInput {
  readonly previous: Variable | undefined;
  readonly id: VariableId;
  readonly name: string;
  readonly planned: PlannedVariable;
  readonly questionId: QuestionId;
  readonly iteration?: number;
  readonly excludeFromExport: boolean;
}

function materialize(input: MaterializeInput): Variable {
  const { previous, planned } = input;

  // An export column that still matches the old derived name was a default, so it follows the
  // rename. One that does not was set deliberately — usually to match a client's existing
  // tracker layout — and must survive, or a rename would silently break their column mapping.
  const columnWasDefault = previous === undefined || previous.export.column === previous.name;
  const column = columnWasDefault ? input.name : previous.export.column;

  // A stored `pii` value wins: it may have been set deliberately in the studio, and a
  // recomputation must not silently un-flag a column somebody classified by hand. The plan
  // only supplies the default the first time the variable appears.
  const pii = previous?.pii ?? planned.pii ?? false;
  const persist = planned.persist ?? previous?.persist ?? true;

  return {
    id: input.id,
    name: input.name,
    kind: planned.kind,
    type: planned.type,
    source: {
      question_id: input.questionId,
      part: planned.part,
      ...(input.iteration === undefined ? {} : { iteration: input.iteration }),
    },
    ...(planned.enum_domain === undefined ? {} : { enum_domain: planned.enum_domain }),
    ...(planned.storage === undefined ? {} : { storage: planned.storage }),
    ...(previous?.expression === undefined || previous.expression === null
      ? {}
      : { expression: previous.expression }),
    export: {
      include: !input.excludeFromExport && (previous?.export.include ?? true),
      column,
      ...(previous?.export.label === undefined || previous.export.label === null
        ? {}
        : { label: previous.export.label }),
      ...(previous?.export.label_key === undefined || previous.export.label_key === null
        ? {}
        : { label_key: previous.export.label_key }),
    },
    pii,
    persist,
    ...(previous?.meta === undefined ? {} : { meta: previous.meta }),
  };
}

/** Replace `survey.variables` and every question's `emits` with a freshly built registry. */
export function applyVariableRegistry(
  survey: Survey,
  options: BuildVariableRegistryOptions = {},
): Survey {
  const { variables, emits } = buildVariableRegistry(survey, options);
  const content = mapContent(survey.content, (node) => {
    if (node.type !== 'question') return node;
    const ids = emits.get(node.id) ?? [];
    return { ...node, emits: ids };
  });
  return { ...survey, variables, content };
}

/* ========================================================================== */
/* 5. Tree walking helpers                                                     */
/* ========================================================================== */

/**
 * Depth-first walk of every question, carrying the innermost enclosing loop.
 *
 * The innermost loop wins because nested loops are not unrolled in Phase 1 (C §13's naming
 * template has exactly one `{iteration}` slot); a survey that nests them is a compile error
 * rather than a silently truncated column set.
 */
export function walkQuestions(
  nodes: readonly ContentNode[],
  visit: (question: QuestionNode, loop: LoopSpec | undefined) => void,
  loop?: LoopSpec,
): void {
  for (const node of nodes) {
    switch (node.type) {
      case 'block': {
        // The innermost enclosing loop wins.
        walkQuestions(node.children, visit, node.settings?.loop ?? loop);
        break;
      }
      case 'page':
        walkQuestions(node.children, visit, loop);
        break;
      case 'question':
        visit(node, loop);
        break;
      case 'text':
        break;
      default: {
        const never: never = node;
        throw new Error(`Unhandled content node: ${JSON.stringify(never)}`);
      }
    }
  }
}

/** Structure-preserving map over the content tree. Returns new objects; mutates nothing. */
export function mapContent(
  nodes: readonly ContentNode[],
  fn: (node: ContentNode) => ContentNode,
): readonly ContentNode[] {
  return nodes.map((node) => {
    switch (node.type) {
      case 'block': {
        const mapped = fn(node);
        if (mapped.type !== 'block') return mapped;
        return { ...mapped, children: mapContent(mapped.children, fn) };
      }
      case 'page': {
        const mapped = fn(node);
        if (mapped.type !== 'page') return mapped;
        const children = mapContent(mapped.children, fn).filter(isPageChild);
        return { ...mapped, children };
      }
      case 'question':
      case 'text':
        return fn(node);
      default: {
        const never: never = node;
        throw new Error(`Unhandled content node: ${JSON.stringify(never)}`);
      }
    }
  });
}

function isPageChild(node: ContentNode): node is QuestionNode | TextNode {
  return node.type === 'question' || node.type === 'text';
}

/** Find a content node by id, at any depth. */
export function findContentNode(
  nodes: readonly ContentNode[],
  id: string,
): ContentNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    if (node.type === 'block') {
      const hit = findContentNode(node.children, id);
      if (hit !== undefined) return hit;
    } else if (node.type === 'page') {
      const hit = findContentNode(node.children, id);
      if (hit !== undefined) return hit;
    }
  }
  return undefined;
}

/** Every content node, flattened in document order. */
export function flattenContent(nodes: readonly ContentNode[]): readonly ContentNode[] {
  const out: ContentNode[] = [];
  const push = (list: readonly ContentNode[]): void => {
    for (const node of list) {
      out.push(node);
      if (node.type === 'block' || node.type === 'page') push(node.children);
    }
  };
  push(nodes);
  return out;
}

/* ========================================================================== */
/* 6. Renaming                                                                 */
/* ========================================================================== */

export interface RenamedVariable {
  readonly id: VariableId;
  readonly from: string;
  readonly to: string;
}

export interface RenameRefResult {
  readonly survey: Survey;
  readonly node_ref: { readonly from: string; readonly to: string };
  readonly variables: readonly RenamedVariable[];
  readonly export_columns: readonly RenamedVariable[];
}

export type RenameRefError =
  | { readonly ok: false; readonly reason: 'not_found' }
  | { readonly ok: false; readonly reason: 'invalid_ref' }
  | { readonly ok: false; readonly reason: 'duplicate_ref' };

export type RenameRefOutcome = ({ readonly ok: true } & RenameRefResult) | RenameRefError;

/**
 * Rename a content node's `ref` and recompute every name derived from it.
 *
 * This is the operation C §3 exists for. Renaming `Q1` to `S1` is a metadata edit rather than
 * a find-and-replace across the survey, because *nothing* internal points at `ref`: logic
 * ASTs, quota definitions, masks and flow edges all reference ids. What has to follow the
 * rename is the derived surface — variable names and the export columns that defaulted to
 * them — and that is exactly what this recomputes.
 *
 * Invariant asserted by the tests: after a rename, the set of variable *ids* is unchanged.
 */
export function renameRef(
  survey: Survey,
  nodeId: string,
  nextRef: string,
  options: BuildVariableRegistryOptions = {},
): RenameRefOutcome {
  const target = findContentNode(survey.content, nodeId);
  if (target === undefined || target.type === 'text') return { ok: false, reason: 'not_found' };

  const from = target.ref;
  if (from === nextRef) {
    return {
      ok: true,
      survey,
      node_ref: { from, to: nextRef },
      variables: [],
      export_columns: [],
    };
  }

  const collision = flattenContent(survey.content).some(
    (n) => n.type !== 'text' && n.id !== nodeId && n.ref.toLowerCase() === nextRef.toLowerCase(),
  );
  if (collision) return { ok: false, reason: 'duplicate_ref' };

  const renamedContent = mapContent(survey.content, (node) => {
    if (node.id !== nodeId || node.type === 'text') return node;
    return renameNode(node, nextRef);
  });

  const before = new Map(survey.variables.map((v) => [v.id, v]));
  const next = applyVariableRegistry({ ...survey, content: renamedContent }, options);

  const variables: RenamedVariable[] = [];
  const exportColumns: RenamedVariable[] = [];
  for (const variable of next.variables) {
    const previous = before.get(variable.id);
    if (previous === undefined) continue;
    if (previous.name !== variable.name) {
      variables.push({ id: variable.id, from: previous.name, to: variable.name });
    }
    if (previous.export.column !== variable.export.column) {
      exportColumns.push({
        id: variable.id,
        from: previous.export.column,
        to: variable.export.column,
      });
    }
  }

  return {
    ok: true,
    survey: next,
    node_ref: { from, to: nextRef },
    variables,
    export_columns: exportColumns,
  };
}

function renameNode(node: BlockNode | PageNode | QuestionNode, ref: string): ContentNode {
  switch (node.type) {
    case 'block':
      return { ...node, ref };
    case 'page':
      return { ...node, ref };
    case 'question':
      return { ...node, ref };
    default: {
      const never: never = node;
      throw new Error(`Unhandled node: ${JSON.stringify(never)}`);
    }
  }
}
