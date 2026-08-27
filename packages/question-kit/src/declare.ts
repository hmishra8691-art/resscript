/**
 * Calling `declareVariables` safely, and checking what came back.
 *
 * A plugin's `declareVariables` is the export schema of every survey that uses it (ADR-002,
 * ADR-007). The compiler therefore never calls it directly: it calls `declareVariablesFor`,
 * which builds the context, catches what a plugin can throw, and *verifies* the result against
 * the invariants F §1.1 states and F §9's test kit asserts. The verification is here rather than
 * only in the test kit for a specific reason: the test kit runs in the plugin author's CI, and
 * an `org_custom` plugin attached to an artifact never ran it. The compiler is the last place a
 * bad declaration can be stopped before it becomes a column in a client's data file.
 *
 * Everything is reported as a diagnostic. A `declareVariables` that throws is a bug in the
 * plugin, and the compiler's job is to say which plugin and why, not to crash the compile job.
 */

import { isReservedVariableName } from '@resscript/schema';
import { PluginComposeError } from './errors.js';
import { applySchemaDefaults, type JsonSchema } from './json-schema.js';
import { createNamer, createScopedNamer, deriveDeclarationName, rescopePart, type NamerSpec } from './naming.js';
import type { PluginRegistry } from './registry.js';
import type { AnyPluginCore, QuestionTypePluginCore } from './contract/plugin.js';
import type { AuthoredQuestion } from './contract/authored.js';
import type { PluginDiagnostic } from './contract/diagnostics.js';
import { namespaceDiagnostics, type CompileDiagnostic } from './contract/diagnostics.js';
import type { AuthoredItem } from './contract/items.js';
import { itemsForDeclaration } from './contract/items.js';
import type { PluginTrust } from './contract/meta.js';
import type {
  CellControl,
  CellOverride,
  ComposeScope,
  VariableDeclaration,
  VariableDeclContext,
} from './contract/variables.js';
import { isScalarVariableType, requiresEnumDomain } from './contract/variables.js';

export interface DeclareOptions {
  /** Needed only if the plugin composes. A plugin that calls `compose` without one is a bug. */
  readonly registry?: PluginRegistry<AnyPluginCore>;
  /**
   * Parents that legitimately emit more than one `response` variable per cell (F §3.1 rule 6).
   * Opt-in, because the default protects the common case: a cell that writes two columns breaks
   * the "one cell, one value" assumption every grid export layout makes.
   */
  readonly allowMultiVarCells?: boolean;
  /** JSON Pointer to the question in the survey document. Only the compiler knows it. */
  readonly basePath?: string;
}

export interface DeclareResult {
  /** Empty when any diagnostic is an error: a partial variable set is worse than none. */
  readonly declarations: readonly VariableDeclaration[];
  readonly diagnostics: readonly CompileDiagnostic[];
}

/**
 * Build the context, call the plugin, verify the result.
 *
 * Deterministic by construction: the context exposes no clock, no randomness and no I/O, and
 * every list it hands the plugin is sorted by `code` (`itemsForDeclaration`) rather than kept in
 * authored order — see `contract/items.ts` for why that is what makes F §9's
 * `assertOrderIndependent` satisfiable at all.
 */
export function declareVariablesFor<Config>(
  plugin: QuestionTypePluginCore<Config, unknown>,
  question: AuthoredQuestion<Config>,
  options: DeclareOptions = {},
): DeclareResult {
  const problems: PluginDiagnostic[] = [];
  /**
   * Items are sorted by `code` *here*, once, rather than in each plugin.
   *
   * F §9's `assertOrderIndependent` says reordering options must produce an identical
   * declaration. Sorting in the kit makes that a property of the platform; sorting in each
   * plugin makes it a promise fifteen plugins have to keep, and the sixteenth is the one that
   * ships a column shift into a tracker. `cells` is sorted for the same reason: a matrix that
   * iterates its overrides would otherwise emit its rows in whatever order the editor wrote them.
   */
  const normalized: AuthoredQuestion<Config> = {
    ...question,
    options: itemsForDeclaration(question.options),
    rows: itemsForDeclaration(question.rows),
    columns: itemsForDeclaration(question.columns),
    cells: [...question.cells].sort(compareCellOverrides),
  };
  const spec: NamerSpec = {
    ref: normalized.ref,
    loop: normalized.loop,
    options: normalized.options,
    rows: normalized.rows,
    columns: normalized.columns,
  };

  let declared: readonly VariableDeclaration[] = [];
  try {
    declared = plugin.declareVariables(buildContext(plugin, normalized, spec, options, 0));
  } catch (error: unknown) {
    problems.push(declarationThrew(error));
    return finish(plugin.meta.id, options.basePath ?? '', [], problems);
  }

  problems.push(...verifyDeclarations(declared, spec));
  return finish(plugin.meta.id, options.basePath ?? '', declared, problems);
}

function finish(
  pluginId: string,
  basePath: string,
  declared: readonly VariableDeclaration[],
  problems: readonly PluginDiagnostic[],
): DeclareResult {
  const diagnostics = namespaceDiagnostics(pluginId, basePath, problems);
  const fatal = diagnostics.some((d) => d.severity === 'error');
  return { declarations: fatal ? [] : declared, diagnostics };
}

function declarationThrew(error: unknown): PluginDiagnostic {
  if (error instanceof PluginComposeError) {
    return {
      code: error.code,
      severity: 'error',
      message: error.message,
      path: '/config',
      detail: { ...error.detail },
    };
  }
  return {
    code: 'declare_variables_threw',
    severity: 'error',
    message: `declareVariables threw: ${error instanceof Error ? error.message : String(error)}`,
    path: '',
  };
}

/* ========================================================================== */
/* The context                                                                 */
/* ========================================================================== */

function buildContext<Config>(
  plugin: QuestionTypePluginCore<Config, unknown>,
  question: AuthoredQuestion<Config>,
  spec: NamerSpec,
  options: DeclareOptions,
  depth: number,
): VariableDeclContext<Config> {
  return {
    ref: question.ref,
    config: question.config,
    required: question.required,
    options: question.options,
    rows: question.rows,
    columns: question.columns,
    cells: question.cells,
    flags: question.flags,
    loop: question.loop,
    name: createNamer(spec),
    compose: (scope, control) =>
      compose(plugin.meta.trust, question, spec, scope, control, options, depth),
  };
}

/**
 * `compose` — F §3.1's six rules, enforced at compile time.
 *
 * The parent contributes the **name scope** and (for `use_columns`) the **enum domain**, and
 * nothing else. Everything inside a cell is somebody else's plugin, which is the test of whether
 * the contract is real.
 */
function compose<Config>(
  parentTrust: PluginTrust,
  question: AuthoredQuestion<Config>,
  spec: NamerSpec,
  scope: ComposeScope,
  control: CellControl,
  options: DeclareOptions,
  depth: number,
): readonly VariableDeclaration[] {
  // Rule 4: depth 1. A matrix inside a matrix cell produces `Q5r3r2`, which is representable and
  // makes schema §13's loop naming (`{ref}_{iteration}`) ambiguous when the outer matrix is
  // itself looped. Depth 1 keeps every name in the export contract derivable from one rule; a
  // customer who genuinely needs a nested grid gets a loop.
  if (depth >= 1) {
    throw new PluginComposeError(
      'compose_depth',
      'a composed cell control may not itself compose (F §3.1 rule 4): nested grids make the ' +
        'loop naming rule ambiguous, so the answer to a nested grid is a loop',
      { depth },
    );
  }

  const registry = options.registry;
  if (registry === undefined) {
    throw new PluginComposeError(
      'compose_unknown_plugin',
      'compose() was called without a registry: the child plugin cannot be resolved',
      { childId: control.question_type },
    );
  }

  // Rule 1: the child must exist and be composable.
  const resolved = registry.resolveForCompile(control.question_type);
  if (resolved === undefined) {
    throw new PluginComposeError(
      'compose_unknown_plugin',
      `cell control ${JSON.stringify(control.question_type)} is not a registered question type`,
      { childId: control.question_type },
    );
  }
  if (!resolved.meta.composable) {
    throw new PluginComposeError(
      'compose_not_composable',
      `question type ${JSON.stringify(control.question_type)} is not composable`,
      { childId: control.question_type },
    );
  }

  // Rule 2: trust may only go down.
  if (!registry.isComposeTrustAllowed(parentTrust, resolved.meta.trust, resolved.meta.id)) {
    throw new PluginComposeError(
      'compose_trust_violation',
      `a ${parentTrust} question type may not compose a ${resolved.meta.trust} control ` +
        `(${resolved.meta.id}) without an explicit allowlist entry`,
      { childId: resolved.meta.id, parentTrust, childTrust: resolved.meta.trust },
    );
  }

  // Rule 3: the child's config validates against the *child's* schema, with the child's own
  // defaults applied first — F §5's "new optional field with a default" promise is only real if
  // the top-up happens on the path that actually validates.
  const compiled = registry.configSchemaFor(registry.resolveEntry(resolved.key) ?? unreachable());
  const childConfig = applySchemaDefaults(
    resolved.plugin.configSchema as JsonSchema,
    control.config ?? {},
  );
  const validation = compiled.validate(childConfig);
  if (!validation.valid) {
    throw new PluginComposeError(
      'compose_invalid_config',
      `config for cell control ${resolved.meta.id} is invalid: ` +
        validation.issues.map((i) => `${i.path === '' ? '/' : i.path} ${i.message}`).join('; '),
      { childId: resolved.meta.id, issues: validation.issues.length },
    );
  }

/**
   * `use_columns`: the child's *options* are the parent's columns; otherwise its own `options`.
   *
   * F §3.1 does this by writing `config.__injectedOptions` into the child's config. That cannot
   * work: F §2's reference config schema — and every schema written like it — sets
   * `additionalProperties: false`, so the injected key fails the child's own validation, which
   * rule 3 requires to pass. Handing the columns over as the child's `options` is what
   * "choice controls draw their options from matrix columns" means anyway, and it keeps the
   * child's config exactly what its author declared.
   *
   * `control.options` is the second source, added for `matrix_side_by_side` — see `CellControl`'s
   * own note on why `[]` was not a viable default for an enum child. `use_columns` wins, so no
   * existing cell changes: an absent `options` is still `[]`.
   */
  const childItems: readonly AuthoredItem[] =
    control.use_columns === true ? question.columns : (control.options ?? []);

  const childContext: VariableDeclContext<unknown> = {
    ref: question.ref,
    config: childConfig,
    required: question.required,
    options: childItems,
    rows: [],
    columns: [],
    cells: [],
    flags: question.flags,
    loop: question.loop,
    // The scoped namer is the whole mechanism: the child's `self()` is its cell's name.
    name: createScopedNamer(spec, scope),
    compose: () => {
      throw new PluginComposeError(
        'compose_depth',
        'a composed cell control may not itself compose (F §3.1 rule 4)',
        { depth: depth + 1 },
      );
    },
  };

  const childDeclarations = resolved.plugin.declareVariables(childContext);

  // Rule 5: every child name must be inside the scope it was given. A child that names anything
  // else is writing into another question's export columns, and the compiler must not find that
  // out from a duplicate-column error three questions later. A ROW scope owns three name shapes:
  // the row itself (`Q1r1`), suffixes on it (`Q1r1_other`), and — the row-scope fan-out the
  // scoped namer sanctions — its cells (`Q1r1c2`). A grid-cell scope owns only the first two.
  const scopePrefix = deriveDeclarationName(spec, scopeSelfPart(scope));
  const cellFanOut = scope.kind === 'row' ? new RegExp(`^${scopePrefix}c[0-9]+$`) : null;
  for (const declaration of childDeclarations) {
    const inside =
      declaration.name === scopePrefix ||
      declaration.name.startsWith(`${scopePrefix}_`) ||
      (cellFanOut !== null && cellFanOut.test(declaration.name));
    if (!inside) {
      throw new PluginComposeError(
        'plugin_namespace_violation',
        `cell control ${resolved.meta.id} declared ${JSON.stringify(declaration.name)}, which is ` +
          `outside its scope ${JSON.stringify(scopePrefix)}`,
        { childId: resolved.meta.id, name: declaration.name, scope: scopePrefix },
      );
    }
  }

  // Provenance is rewritten here, not in the parent plugin as F §3.1's sample does it: the child
  // named itself through the scoped namer, so its own `part` describes a question it is not.
  // Doing it centrally means every composing plugin gets `other_specify` right too, which F's
  // sample flattens into a plain cell.
  const rescoped = childDeclarations.map((declaration) => ({
    ...declaration,
    source: { part: rescopePart(declaration.source.part, scope) },
  }));

  // Rule 6: one response variable per GRID CELL, unless the parent opted in. Counted per cell
  // COORDINATE rather than per compose() call, because a multi-select row legitimately fans out
  // into one boolean per column — each grid cell still holds exactly one value, which is the
  // export-layout assumption the rule protects. Two response variables landing on the SAME
  // coordinate is the violation — and an other-specify verbatim COUNTS AGAINST ITS ROW's
  // coordinate (it is a second column hanging off that cell), which is exactly the case the
  // opt-in exists for.
  const perCell = new Map<string, number>();
  for (const declaration of rescoped) {
    if (declaration.kind !== 'response') continue;
    const part = declaration.source.part;
    const key =
      part.kind === 'cell'
        ? `${part.rowRef}\u0000${part.columnRef ?? ''}`
        : part.kind === 'other_specify'
          ? `${part.ofRef ?? ''}\u0000`
          : `part:${part.kind}`;
    perCell.set(key, (perCell.get(key) ?? 0) + 1);
  }
  const worst = Math.max(0, ...perCell.values());
  if (worst > 1 && options.allowMultiVarCells !== true) {
    throw new PluginComposeError(
      'compose_multi_var_cell',
      `cell control ${resolved.meta.id} declares ${worst} response variables in one cell; ` +
        'set allowMultiVarCells if the parent layout really has room for them',
      { childId: resolved.meta.id, count: worst },
    );
  }

  return rescoped;
}

function scopeSelfPart(scope: ComposeScope): {
  readonly kind: 'cell';
  readonly rowRef: string;
  readonly columnRef?: string;
} {
  return scope.kind === 'row'
    ? { kind: 'cell', rowRef: scope.rowRef }
    : { kind: 'cell', rowRef: scope.rowRef, columnRef: scope.columnRef };
}

/** Total order over cell overrides: by row ref, then by column ref (absent sorts first). */
function compareCellOverrides(a: CellOverride, b: CellOverride): number {
  if (a.row_ref !== b.row_ref) return a.row_ref < b.row_ref ? -1 : 1;
  const ac = a.column_ref ?? '';
  const bc = b.column_ref ?? '';
  return ac < bc ? -1 : ac > bc ? 1 : 0;
}

function unreachable(): never {
  // `resolveForCompile` returned a key, so `resolveEntry` on that key cannot miss. Stated as a
  // throw rather than a `!` so that a future registry whose two lookups can disagree fails here
  // with a name instead of at a property access.
  throw new Error('registry resolved a key it cannot look up');
}

/* ========================================================================== */
/* Verification                                                                */
/* ========================================================================== */

/**
 * The invariants every declaration set must satisfy, whoever produced it.
 *
 * Exported because the test kit asserts the same list against the plugin author's fixtures, and
 * two copies of this list would drift within a release.
 */
export function verifyDeclarations(
  declarations: readonly VariableDeclaration[],
  spec: NamerSpec,
): readonly PluginDiagnostic[] {
  const problems: PluginDiagnostic[] = [];
  const seenNames = new Set<string>();
  const seenColumns = new Set<string>();
  const declaredNames = new Set(declarations.map((d) => d.name));

  if (declarations.length === 0) return problems;

  declarations.forEach((declaration, index) => {
    const at = `/emits/${index}`;

    // 1. Name and part are two views of one fact. A name that is not the one its own part derives
    //    means a rename would move the column and leave the provenance behind — or the other way
    //    round, which is worse because nothing downstream would notice.
    let expected: string | undefined;
    try {
      expected = deriveDeclarationName(spec, declaration.source.part);
    } catch (error: unknown) {
      problems.push({
        code: 'unnameable_part',
        severity: 'error',
        message: `declaration ${JSON.stringify(declaration.name)} has an unnameable part: ${
          error instanceof Error ? error.message : String(error)
        }`,
        path: at,
      });
    }
    if (expected !== undefined && expected !== declaration.name) {
      problems.push({
        code: 'variable_name_not_derived',
        severity: 'error',
        message:
          `declaration ${JSON.stringify(declaration.name)} does not match the name schema §3 ` +
          `derives from its source part (${JSON.stringify(expected)}). Names must come from ` +
          '`ctx.name.*`, never from string building.',
        path: at,
        detail: { declared: declaration.name, derived: expected },
      });
    }

    // 2. Uniqueness, of the name and of the export column. Both are unique per version in the
    //    database (Deliverable B's `variables_export_col_key`), so a duplicate here is a failed
    //    INSERT later — with a Postgres message instead of a diagnostic.
    if (seenNames.has(declaration.name)) {
      problems.push({
        code: 'duplicate_variable_name',
        severity: 'error',
        message: `two declarations are named ${JSON.stringify(declaration.name)}`,
        path: at,
      });
    }
    seenNames.add(declaration.name);
    if (declaration.export.include) {
      if (seenColumns.has(declaration.export.column)) {
        problems.push({
          code: 'duplicate_export_column',
          severity: 'error',
          message: `two declarations export the column ${JSON.stringify(declaration.export.column)}`,
          path: at,
        });
      }
      seenColumns.add(declaration.export.column);
    }

    // 3. The reserved namespace (Deliverable K §6). A plugin cannot shadow `duration_s`.
    if (isReservedVariableName(declaration.name)) {
      problems.push({
        code: 'reserved_variable_name',
        severity: 'error',
        message: `${JSON.stringify(declaration.name)} is in the reserved system namespace`,
        path: at,
      });
    }

    // 4. An enum or set with no domain has no meaning (schema's SCH-1007, restated where the
    //    domain is actually produced).
    const domain = declaration.enumDomain ?? [];
    if (requiresEnumDomain(declaration.type) && domain.length === 0) {
      problems.push({
        code: 'missing_enum_domain',
        severity: 'error',
        message: `${declaration.name} is ${declaration.type} but declares no enum domain`,
        path: at,
      });
    }
    const codes = new Set<string>();
    for (const entry of domain) {
      const key = `${typeof entry.code}:${String(entry.code)}`;
      if (codes.has(key)) {
        problems.push({
          code: 'duplicate_enum_code',
          severity: 'error',
          message: `${declaration.name} declares code ${String(entry.code)} twice`,
          path: at,
        });
      }
      codes.add(key);
    }

    // 5. `persist: false` means "recomputed per page, never stored", which schema §4 allows only
    //    for derived and system variables. A response variable that is not stored is data loss.
    if (!declaration.persist && declaration.kind === 'response') {
      problems.push({
        code: 'response_not_persisted',
        severity: 'error',
        message: `${declaration.name} is a response variable with persist: false — the answer ` +
          'would be collected and then discarded',
        path: at,
      });
    }

    // 6. A structural derivation must point at variables that exist in this question. The whole
    //    point of `set_view` is that it collects *these* booleans; a typo'd member silently
    //    produces an empty set for every respondent, which looks like real data.
    if (declaration.kind === 'derived' && declaration.derivation.kind === 'structural') {
      const structural = declaration.derivation.structural;
      const sources =
        structural.computation === 'set_view'
          ? structural.members.map((m) => m.variableName)
          : [structural.source];
      for (const source of sources) {
        if (!declaredNames.has(source)) {
          problems.push({
            code: 'derivation_unresolved_source',
            severity: 'error',
            message: `${declaration.name} derives from ${JSON.stringify(source)}, which this ` +
              'question does not declare',
            path: at,
            detail: { source },
          });
        }
      }
    }
  });

  // 7. F §4's analysability policy. A non-scalar declaration is fidelity; if a question's *only*
  //    declarations are non-scalar then the flat table gets a JSON blob in one cell, which is not
  //    analysable — and the whole "questions emit variables" model stops paying for itself.
  const exported = declarations.filter((d) => d.export.include);
  const considered = exported.length > 0 ? exported : declarations;
  if (!considered.some((d) => isScalarVariableType(d.type))) {
    problems.push({
      code: 'non_analysable_declaration',
      severity: 'error',
      message:
        'every declaration is non-scalar (object/set). A non-scalar type must be accompanied by ' +
        'scalar projections (F §4) — otherwise the export has a blob where a column should be.',
      path: '/emits',
    });
  }

  return problems;
}
