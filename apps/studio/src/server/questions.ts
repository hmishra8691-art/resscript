/**
 * `declareVariables` on question save — the roadmap's P1-04 line, wired into the P1-03 routes.
 *
 * ## Why the plugin decides, and not this file
 *
 * A question is a UI construct; a variable is a data construct; the question declares which
 * variables it emits (C §1, F §1.1), and that declaration IS the export schema of every survey
 * that uses the type (ADR-002, ADR-007). So the only thing this module does is call
 * `declareVariablesFor` and translate what comes back. It contains no table of "which question
 * type emits what" — `packages/schema`'s `planQuestionEmissions` is exactly such a table and its
 * own comment calls it a stand-in for the plugin contract, so reading it here in preference to
 * the plugin would make a first-party table authoritative over the plugin that replaced it.
 *
 * ## Why names come from `deriveVariableName` and never from string building
 *
 * `content.variables.name` is STORED (0007's column comment: "so it is diffable and greppable")
 * but it is DERIVED from `(ref, part)`, and the compiler re-derives it at publish through
 * `buildVariableRegistry` → `deriveVariableName`. If this module spelled the rule itself —
 * `${ref}r${code}` — a rename would produce a name the compiler then disagreed with, and the
 * disagreement would surface as a renamed export column in a client's data file. So the same
 * function computes it here. The kit's own namer arrives at the same string (its
 * `verifyDeclarations` refuses any declaration whose name is not the one its part derives, and
 * `naming.parity.test.ts` pins the kit's derivation against schema's), which is why a mismatch is
 * reported as a plugin bug rather than papered over.
 *
 * ## Why ids survive a rename
 *
 * Every declaration is matched against the question's existing rows by schema's
 * `variableSignature` — "which part of which question", never the name — and a match carries its
 * `id`, its manifest position and a deliberately overridden `export_column` forward. That is the
 * whole of P1-03's acceptance criterion "renaming a ref changes exactly the derived variable
 * names and no id", and the reason every logic AST, quota and mask pointing at the id keeps
 * working untouched.
 */

import {
  applySchemaDefaults,
  createRegistry,
  declareVariablesFor,
  fromQuestionNode,
  toVariablePart,
  FIRST_PARTY_CORES,
  type AnyPluginCore,
  type JsonSchema,
  type PluginRegistry,
  type VariableDeclaration,
} from '@resscript/question-kit';
import { deriveVariableName, variableSignature } from '@resscript/schema';
import type {
  JsonObject,
  OptionId,
  QuestionId,
  QuestionItem,
  QuestionNode,
  VariablePart,
} from '@resscript/schema';
import type {
  CellRow,
  ItemRow,
  NodeRow,
  VariableRow,
  WriteVariableInput,
} from '@/server/repo/types';

/**
 * The first-party registry, built once per process.
 *
 * `createRegistry()` with `{ trust: 'first_party' }` per core, exactly as
 * `packages/compiler`'s `firstPartyRegistry()` does it, and for the reason `FIRST_PARTY_CORES`'
 * own comment gives: `register` assigns trust from the SOURCE, so a pre-populated registry handed
 * around would make `first_party` the default for anything anyone added to it.
 *
 * Memoized because compiling fifteen `configSchema`s per request would make the plugin contract
 * the slowest thing in a question save; the registry is immutable once built, and `org_custom`
 * plugins (F §6) are a later milestone that will need a per-org registry rather than an entry in
 * this one.
 */
let cached: PluginRegistry<AnyPluginCore> | undefined;

export function questionRegistry(): PluginRegistry<AnyPluginCore> {
  if (cached === undefined) {
    const registry = createRegistry();
    for (const core of FIRST_PARTY_CORES) registry.register(core, { trust: 'first_party' });
    cached = registry;
  }
  return cached;
}

/**
 * The config a question is BORN with, or the reason it cannot be.
 *
 * F §1's `defaultConfig(ctx)` is the plugin's own answer to "what does one of these look like
 * before anybody configures it", and it is not the same thing as the JSON Schema's `default`
 * keywords: `MULTI_SELECT_CONFIG_SCHEMA` requires `display` and `other` and supplies neither, so
 * `applySchemaDefaults({})` leaves an object the plugin's own schema rejects. A question created
 * with `config: {}` would therefore be unconfigurable AND unable to declare its variables — which
 * is precisely what happened before this function existed.
 *
 * So the order is: the plugin's defaults, then the caller's fields over them, then the schema's
 * `default` top-up (F §5's "a new optional field with a default" promise), then validation. The
 * merge is SHALLOW, and deliberately: `{other: {enabled: true}}` replaces the whole `other`
 * object and the schema top-up then refills its siblings, which is one rule a client can predict.
 * A deep merge would make "clear this sub-object" unexpressible.
 *
 * `asCellControl: false`, always. A cell control's config comes from `PUT /nodes/{id}/cells`,
 * where the plugin gets `asCellControl: true` and can pick the compact default (a dropdown rather
 * than a 7-across button group) — that is a different call site with a different answer.
 */
export interface InitialConfig {
  readonly config: JsonObject;
  readonly issues: readonly QuestionIssue[];
}

export function initialQuestionConfig(input: {
  readonly questionType: string;
  readonly ref: string;
  readonly supplied: JsonObject | undefined;
  readonly lang: string;
}): InitialConfig {
  const registry = questionRegistry();
  const resolved = registry.resolveForCompile(input.questionType);
  if (resolved === undefined) {
    return {
      config: {},
      issues: [
        {
          path: 'question_type',
          code: 'unknown_question_type',
          message: `${input.questionType} is not a registered question type`,
        },
      ],
    };
  }
  const defaults = resolved.plugin.defaultConfig({
    lang: input.lang,
    ref: input.ref,
    asCellControl: false,
  }) as JsonObject;
  const merged: JsonObject = { ...defaults, ...(input.supplied ?? {}) };
  const config = applySchemaDefaults(
    resolved.plugin.configSchema as JsonSchema,
    merged,
  ) as JsonObject;
  const entry = registry.resolveEntry(resolved.key);
  if (entry === undefined) return { config, issues: [] };
  const validation = registry.configSchemaFor(entry).validate(config);
  if (validation.valid) return { config, issues: [] };
  return {
    config,
    issues: validation.issues.map((issue) => ({
      path: `config${issue.path}`,
      code: 'invalid_config',
      message: issue.message,
    })),
  };
}

/** One question as the store holds it: the node row plus its items and cell overrides. */
export interface QuestionShape {
  readonly node: NodeRow;
  readonly items: readonly ItemRow[];
  readonly cells: readonly CellRow[];
}

/** A refusal, in the shape `AppError.details` wants (API §1.5's dotted request-body path). */
export interface QuestionIssue {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export interface VariablePlan {
  /** Empty when `issues` has anything: a partial variable set is worse than none (F §1.1). */
  readonly rows: readonly WriteVariableInput[];
  readonly issues: readonly QuestionIssue[];
}

export interface PlanOptions {
  readonly question: QuestionShape;
  /** The question's CURRENT variables, which is where ids and deliberate overrides live. */
  readonly existing: readonly VariableRow[];
  /** Id source for variables that did not exist before. Injected so a test can fix them. */
  readonly newId: () => string;
}

/**
 * Everything the question's plugin says it emits, as rows ready for `replaceQuestionVariables`.
 *
 * Total: every failure mode is an `issue`, never a throw. A plugin that throws is a bug in the
 * plugin and the API's job is to say which plugin and why (declare.ts's own rule), not to answer
 * 500 on a question save.
 */
export function planQuestionVariables(options: PlanOptions): VariablePlan {
  const { node, items, cells } = options.question;
  // A block, a page or a text node emits nothing. `nodes_kind_shape` makes the second half of
  // this unreachable for a question row, and the check is here because "which columns does this
  // node produce" must have an answer for every node kind.
  if (node.node_kind !== 'question' || node.question_type === null || node.ref === null) {
    return { rows: [], issues: [] };
  }

  const registry = questionRegistry();
  const resolved = registry.resolveForCompile(node.question_type);
  if (resolved === undefined) {
    return {
      rows: [],
      issues: [
        {
          path: 'question_type',
          code: 'unknown_question_type',
          message: `${node.question_type} is not a registered question type`,
        },
      ],
    };
  }

  // F §5's "new optional field with a default" promise is only real if the top-up happens on the
  // path that actually validates — and a plugin's `declareVariables` reads `ctx.config.x.y`
  // directly, so an un-defaulted config makes it throw rather than emit.
  const config = applySchemaDefaults(
    resolved.plugin.configSchema as JsonSchema,
    node.config,
  ) as JsonObject;
  const entry = registry.resolveEntry(resolved.key);
  if (entry !== undefined) {
    const validation = registry.configSchemaFor(entry).validate(config);
    if (!validation.valid) {
      return {
        rows: [],
        issues: validation.issues.map((issue) => ({
          path: `config${issue.path}`,
          code: 'invalid_config',
          message: issue.message,
        })),
      };
    }
  }

  const questionNode = toQuestionNode({ node, items, cells, config });
  const authored = fromQuestionNode(questionNode);
  const declared = declareVariablesFor(resolved.plugin, authored, { registry });
  const errors = declared.diagnostics.filter((d) => d.severity === 'error');
  if (errors.length > 0) {
    return {
      rows: [],
      issues: errors.map((d) => ({
        // The plugin's own diagnostic code, namespaced by `namespaceDiagnostics`, verbatim: one
        // diagnostic vocabulary across the compiler, the API and the studio's problems pane.
        path: d.path === '' ? 'emits' : `emits${d.path}`,
        code: d.code,
        message: d.message,
      })),
    };
  }

  const bySignature = new Map<string, VariableRow>();
  for (const row of options.existing) {
    if (row.source_part === null) continue;
    bySignature.set(
      variableSignature(node.id as QuestionId, row.source_part as unknown as VariablePart),
      row,
    );
  }

  const codeOf = (ref: string): number | undefined =>
    items.find((item) => item.ref === ref)?.code;
  const idOf = (ref: string): OptionId | undefined => {
    const hit = items.find((item) => item.ref === ref);
    return hit === undefined ? undefined : (hit.id as OptionId);
  };

  const rows: WriteVariableInput[] = [];
  const issues: QuestionIssue[] = [];
  for (const declaration of declared.declarations) {
    const part = toVariablePart(declaration.source.part, codeOf, idOf);
    if (part === undefined) {
      issues.push({
        path: 'emits',
        code: 'unknown_item_ref',
        message: `${declaration.name} names an item this question does not have`,
      });
      continue;
    }
    const previous = bySignature.get(variableSignature(node.id as QuestionId, part));
    rows.push(
      variableRowOf({
        declaration,
        part,
        ref: node.ref,
        previous,
        id: previous?.id ?? options.newId(),
        excludeFromExport: node.flags['exclude_from_export'] === true,
      }),
    );
  }
  return issues.length > 0 ? { rows: [], issues } : { rows, issues: [] };
}

interface VariableRowInput {
  readonly declaration: VariableDeclaration;
  readonly part: VariablePart;
  readonly ref: string;
  readonly previous: VariableRow | undefined;
  readonly id: string;
  readonly excludeFromExport: boolean;
}

/**
 * One declaration as a `content.variables` row, applying the three carry-forward rules
 * `packages/schema`'s `materialize()` states. They live here rather than being imported because
 * `materialize` is private to `buildVariableRegistry`, which operates on a whole `Survey`
 * document; the RULES are what matter and each one is a decision, not a detail:
 */
function variableRowOf(input: VariableRowInput): WriteVariableInput {
  const { declaration, part, previous } = input;
  // The name the COMPILER will derive at publish, from the node's current ref. Never built here.
  const name = deriveVariableName({ ref: input.ref, part });

  // 1. An export column that still matched the old derived name was a DEFAULT, so it follows the
  //    rename. One that did not was set deliberately — usually to match a client's existing
  //    tracker layout — and must survive, or a rename silently breaks their column mapping.
  const column =
    previous !== undefined && previous.export_column !== previous.name
      ? previous.export_column
      : declaration.export.column;

  // 2. A stored `pii` wins: it may have been classified by hand in the studio, and a recompute
  //    must not un-flag a column somebody marked. The declaration supplies the first-time default.
  const pii = previous?.pii ?? declaration.pii;

  // 3. `export_include` is the AND of the question's flag and any stored exclusion, which is
  //    materialize()'s `!excludeFromExport && (previous?.export.include ?? true)` — the question
  //    flag can only ever remove a column, never restore one the author excluded by hand.
  const include = !input.excludeFromExport && (previous?.export_include ?? declaration.export.include);

  const domain =
    declaration.enumDomain === undefined
      ? null
      : declaration.enumDomain.flatMap((entry) =>
          typeof entry.code === 'number'
            ? [{ code: entry.code, label_key: entry.labelKey }]
            : // `toPlannedVariables` reports this as `enum_code_not_numeric` and refuses to
              // coerce, for the reason it gives: Number('BRAND_C') is NaN and Number('07') is 7,
              // so a coercion either fabricates a code or collides with one. Dropping the entry
              // here would be the same lie quietly; the plugin's own `verifyDeclarations` has
              // already refused a domain it cannot name, so this arm is unreachable for a
              // first-party core and is a dropped entry rather than a fabricated code if it ever
              // is not.
              [],
        );

  return {
    id: input.id,
    name,
    kind: declaration.kind,
    vtype: declaration.type,
    // The item half of the provenance, denormalized out of `source_part` because
    // `variables_source_idx` and the FK to `content.question_items` are what make "delete the
    // option, the column goes with it" a database fact rather than an application sweep.
    source_item_id: itemIdOf(part),
    source_part: part as unknown as JsonObject,
    enum_domain: domain,
    export_include: include,
    export_column: column,
    export_label_key: declaration.export.labelKey,
    pii,
    persist: declaration.persist,
  };
}

/** The item a part hangs off, if any — `source_item_id`'s value. */
function itemIdOf(part: VariablePart): string | null {
  switch (part.kind) {
    case 'option':
    case 'other_specify':
      return part.option_id ?? null;
    case 'row':
      return part.row_id;
    case 'column':
      return part.column_id;
    case 'cell':
      return part.row_id;
    default:
      return null;
  }
}

interface ToQuestionNodeInput {
  readonly node: NodeRow;
  readonly items: readonly ItemRow[];
  readonly cells: readonly CellRow[];
  readonly config: JsonObject;
}

/**
 * `content.*` rows → the canonical `QuestionNode`, so `fromQuestionNode` can make the plugin's
 * view of it.
 *
 * Two conversions rather than one direct build, deliberately: `question-kit`'s `interop.ts` is
 * "the only file that knows both shapes" and this keeps it that way. What this function owns is
 * only the part that is genuinely the database's: the fractional `sort_key` becoming C §5.1's
 * dense `position`, which is the same materialization `apps/worker`'s `itemsOf` performs on the
 * publish path — and `code` is untouched by it, because randomizing display order must never
 * rewrite an exported value.
 */
function toQuestionNode(input: ToQuestionNodeInput): QuestionNode {
  const { node } = input;
  const kindOf = (kind: ItemRow['item_kind']): readonly QuestionItem[] =>
    input.items
      .filter((item) => item.item_kind === kind)
      .sort((a, b) => (a.sort_key === b.sort_key ? (a.id < b.id ? -1 : 1) : a.sort_key < b.sort_key ? -1 : 1))
      .map((item, index): QuestionItem => ({
        id: item.id as OptionId,
        ref: item.ref,
        code: item.code,
        ...(item.label_key === null ? {} : { label: { key: item.label_key } }),
        position: index + 1,
        ...(item.anchor === 'none' ? {} : { anchor: item.anchor as NonNullable<QuestionItem['anchor']> }),
        ...(item.exclusive ? { exclusive: true } : {}),
        ...(Object.keys(item.behaviour).length === 0
          ? {}
          : { behaviour: item.behaviour as unknown as NonNullable<QuestionItem['behaviour']> }),
        ...(item.value_override === null ? {} : { value_override: item.value_override }),
        ...(item.custom_class === null ? {} : { custom_class: item.custom_class }),
        ...(Object.keys(item.meta).length === 0 ? {} : { meta: item.meta }),
      }));

  const byId = new Map(input.items.map((item) => [item.id, item]));
  return {
    id: node.id as QuestionId,
    type: 'question',
    ref: node.ref ?? '',
    question_type: node.question_type ?? '',
    ...(node.label_key === null ? {} : { label: { key: node.label_key } }),
    ...(node.instruction_key === null ? {} : { instruction: { key: node.instruction_key } }),
    required: node.required ?? false,
    config: input.config,
    options: kindOf('option'),
    rows: kindOf('row'),
    columns: kindOf('column'),
    // The table addresses a cell by item ID and the document by item REF (C §5.2), the same
    // resolution `apps/worker`'s `cellsOf` performs. A cell whose row item is missing is dropped
    // rather than emitted with an empty ref: the composite FK makes it unreachable, and an
    // emitted `row_ref: ''` would draw a diagnostic naming a row nobody wrote.
    cells: input.cells.flatMap((cell) => {
      const row = byId.get(cell.row_item_id);
      if (row === undefined) return [];
      const column = cell.column_item_id === null ? undefined : byId.get(cell.column_item_id);
      if (cell.column_item_id !== null && column === undefined) return [];
      return [
        {
          row_ref: row.ref,
          ...(column === undefined ? {} : { column_ref: column.ref }),
          control: {
            question_type: cell.question_type,
            config: cell.config,
            ...(cell.use_columns ? { use_columns: true } : {}),
          },
        },
      ];
    }),
    ...(Object.keys(node.flags).length === 0
      ? {}
      : { flags: node.flags as unknown as NonNullable<QuestionNode['flags']> }),
  };
}
