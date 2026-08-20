/**
 * Structural validation.
 *
 * This is the cheap half of the QA gate. The compiler (P1-08) owns the expensive half —
 * forward references, unreachable content, unfillable quota cells — because those need the
 * flow graph resolved and the logic AST type-checked. What lives here is everything that can
 * be decided from the document alone, which is also everything the editor can afford to run
 * on every keystroke.
 *
 * `validateStructural` never throws. A survey that is structurally broken is exactly the
 * input this function exists to describe.
 */

import {
  isValidRef,
  idPrefixOf,
  type IdPrefix,
} from './ids.js';
import { isReservedVariableName } from './registries.js';
import { MASK_FALLBACKS } from './types/masks.js';
import { QUOTA_COUNTER_SCOPES } from './types/quotas.js';
import type { Diagnostic } from './diagnostics.js';
import { pointer, sortDiagnostics } from './diagnostics.js';
import type { ContentNode, QuestionItem, QuestionNode } from './types/content.js';
import type { Survey } from './types/survey.js';
import type { Variable } from './types/variables.js';
import { deriveVariableName } from './variables.js';

interface Ctx {
  readonly survey: Survey;
  readonly out: Diagnostic[];
  /** Every id in the document → the path that declared it, for duplicate detection. */
  readonly ids: Map<string, string>;
  /**
   * Every id in the document, collected in a pre-pass. Reference checks read this rather than
   * `ids`, because a mask on the first question may legitimately point at an option of the
   * last one and a single-pass walk would call that dangling.
   */
  readonly known: ReadonlySet<string>;
  /** Question id → the question, for cross-checking variable sources. */
  readonly questions: Map<string, QuestionNode>;
  readonly assetIds: Set<string>;
  readonly i18nKeys: Set<string>;
}

export function validateStructural(survey: Survey): readonly Diagnostic[] {
  const ctx: Ctx = {
    survey,
    out: [],
    ids: new Map(),
    known: collectAllIds(survey),
    questions: new Map(),
    assetIds: collectAssetIds(survey),
    i18nKeys: new Set(Object.keys(survey.languages?.bundles?.[survey.languages.base] ?? {})),
  };

  declareId(ctx, survey.meta.id, 'svy', pointer('meta', 'id'));
  checkRef(ctx, survey.meta.ref, pointer('meta', 'ref'));

  checkLanguages(ctx);
  checkAssets(ctx);
  checkContent(ctx, survey.content, ['content']);
  checkVariables(ctx);
  checkLogicRules(ctx);
  checkFlow(ctx);
  checkQuotas(ctx);
  checkVendors(ctx);
  checkDesigns(ctx);

  return sortDiagnostics(ctx.out);
}

/* -------------------------------------------------------------------------- */
/* helpers                                                                    */
/* -------------------------------------------------------------------------- */

function report(
  ctx: Ctx,
  code: Diagnostic['code'],
  path: string,
  message: string,
  detail?: Diagnostic['detail'],
): void {
  ctx.out.push({
    code,
    severity: 'error',
    message,
    path,
    ...(detail === undefined ? {} : { detail }),
  });
}

/** Register an id: checks the prefix (SCH-1002) and global uniqueness (SCH-1009). */
function declareId(ctx: Ctx, id: string, prefix: IdPrefix, path: string): void {
  if (idPrefixOf(id) !== prefix) {
    report(ctx, 'SCH-1002', path, `Expected a ${prefix}_ id, got ${JSON.stringify(id)}.`, {
      id,
      expected_prefix: prefix,
    });
    return;
  }
  const first = ctx.ids.get(id);
  if (first !== undefined) {
    report(ctx, 'SCH-1009', path, `Id ${id} is already used at ${first}.`, {
      id,
      first_declared_at: first,
    });
    return;
  }
  ctx.ids.set(id, path);
}

function checkRef(ctx: Ctx, ref: string, path: string): void {
  if (!isValidRef(ref)) {
    report(
      ctx,
      'SCH-1014',
      path,
      `Ref ${JSON.stringify(ref)} must start with a letter and contain only letters, digits and underscores (max 64).`,
      { ref },
    );
  }
}

function checkI18nKey(ctx: Ctx, key: string | undefined | null, path: string): void {
  if (key === undefined || key === null || key === '') return;
  if (!ctx.i18nKeys.has(key)) {
    report(
      ctx,
      'SCH-1008',
      path,
      `i18n key ${JSON.stringify(key)} is not present in the base language bundle (${ctx.survey.languages.base}).`,
      { key, base_language: ctx.survey.languages.base },
    );
  }
}

function checkIdRef(
  ctx: Ctx,
  id: string | undefined | null,
  prefixes: readonly IdPrefix[],
  path: string,
  known: ReadonlySet<string> | undefined,
): void {
  if (id === undefined || id === null) return;
  const prefix = idPrefixOf(id);
  if (prefix === null || !prefixes.includes(prefix)) {
    report(
      ctx,
      'SCH-1002',
      path,
      `Expected one of ${prefixes.map((p) => `${p}_`).join(', ')}, got ${JSON.stringify(id)}.`,
      { id },
    );
    return;
  }
  const exists = known === undefined ? ctx.known.has(id) : known.has(id);
  if (!exists) {
    report(ctx, 'SCH-1004', path, `Reference to ${id} does not resolve to any node.`, { id });
  }
}

/** Pre-pass: every id the document declares anywhere, so forward references resolve. */
function collectAllIds(survey: Survey): ReadonlySet<string> {
  const out = new Set<string>();
  out.add(survey.meta.id);
  const walk = (nodes: readonly ContentNode[]): void => {
    for (const node of nodes) {
      out.add(node.id);
      if (node.type === 'block' || node.type === 'page') {
        walk(node.children);
        continue;
      }
      if (node.type !== 'question') continue;
      for (const item of [...(node.options ?? []), ...(node.rows ?? []), ...(node.columns ?? [])]) {
        out.add(item.id);
      }
      for (const mask of node.masks ?? []) out.add(mask.id);
      for (const rule of node.validation ?? []) out.add(rule.id);
    }
  };
  walk(survey.content);
  for (const variable of survey.variables) out.add(variable.id);
  for (const rule of survey.logic_rules) out.add(rule.id);
  for (const node of survey.flow.nodes) out.add(node.id);
  for (const dimension of survey.quotas?.dimensions ?? []) out.add(dimension.id);
  for (const plan of survey.quotas?.plans ?? []) out.add(plan.id);
  for (const vendor of survey.vendors ?? []) out.add(vendor.id);
  for (const design of survey.designs ?? []) out.add(design.id);
  for (const id of collectAssetIds(survey)) out.add(id);
  return out;
}

function checkAssets(ctx: Ctx): void {
  const assets = ctx.survey.assets;
  if (assets === undefined) return;
  (assets.scripts ?? []).forEach((asset, i) => {
    declareId(ctx, asset.id, 'ast', pointer('assets', 'scripts', i, 'id'));
    checkRef(ctx, asset.ref, pointer('assets', 'scripts', i, 'ref'));
  });
  (assets.html_templates ?? []).forEach((asset, i) => {
    declareId(ctx, asset.id, 'ast', pointer('assets', 'html_templates', i, 'id'));
    checkRef(ctx, asset.ref, pointer('assets', 'html_templates', i, 'ref'));
  });
  (assets.css ?? []).forEach((asset, i) => {
    declareId(ctx, asset.id, 'ast', pointer('assets', 'css', i, 'id'));
    checkRef(ctx, asset.ref, pointer('assets', 'css', i, 'ref'));
  });
  (assets.media ?? []).forEach((asset, i) => {
    declareId(ctx, asset.id, 'ast', pointer('assets', 'media', i, 'id'));
    if (asset.ref != null) checkRef(ctx, asset.ref, pointer('assets', 'media', i, 'ref'));
  });
}

function collectAssetIds(survey: Survey): Set<string> {
  const out = new Set<string>();
  const assets = survey.assets;
  for (const a of assets?.scripts ?? []) out.add(a.id);
  for (const a of assets?.html_templates ?? []) out.add(a.id);
  for (const a of assets?.css ?? []) out.add(a.id);
  for (const a of assets?.media ?? []) out.add(a.id);
  return out;
}

/* -------------------------------------------------------------------------- */
/* languages                                                                  */
/* -------------------------------------------------------------------------- */

function checkLanguages(ctx: Ctx): void {
  const languages = ctx.survey.languages;
  const declared = new Set(languages.available.map((l) => l.code));
  if (!declared.has(languages.base)) {
    report(
      ctx,
      'SCH-1011',
      pointer('languages', 'base'),
      `Base language ${JSON.stringify(languages.base)} is not listed in languages.available.`,
      { language: languages.base },
    );
  }
  for (const code of Object.keys(languages.bundles)) {
    if (!declared.has(code)) {
      report(
        ctx,
        'SCH-1011',
        pointer('languages', 'bundles', code),
        `Bundle for ${JSON.stringify(code)} has no matching entry in languages.available.`,
        { language: code },
      );
    }
  }
}

/* -------------------------------------------------------------------------- */
/* content                                                                    */
/* -------------------------------------------------------------------------- */

function checkContent(ctx: Ctx, nodes: readonly ContentNode[], path: readonly string[]): void {
  // Ref uniqueness is per *version*, i.e. per document, and case-insensitive because
  // Deliverable B's unique index is on lower(ref). `Q1` and `q1` are the same handle.
  const refs = new Map<string, string>();

  const walk = (list: readonly ContentNode[], base: readonly (string | number)[]): void => {
    list.forEach((node, index) => {
      const nodePath = [...base, index];
      switch (node.type) {
        case 'block': {
          declareId(ctx, node.id, 'blk', pointer(...nodePath, 'id'));
          checkNodeRef(ctx, refs, node.ref, pointer(...nodePath, 'ref'));
          checkI18nKey(ctx, node.title?.key, pointer(...nodePath, 'title', 'key'));
          for (const [i, assetId] of (node.settings?.on_enter_scripts ?? []).entries()) {
            checkIdRef(ctx, assetId, ['ast'], pointer(...nodePath, 'settings', 'on_enter_scripts', i), ctx.assetIds);
          }
          for (const [i, assetId] of (node.settings?.on_exit_scripts ?? []).entries()) {
            checkIdRef(ctx, assetId, ['ast'], pointer(...nodePath, 'settings', 'on_exit_scripts', i), ctx.assetIds);
          }
          const loop = node.settings?.loop;
          if (loop != null && loop.source.kind === 'selected_options') {
            checkIdRef(
              ctx,
              loop.source.variable_id,
              ['var'],
              pointer(...nodePath, 'settings', 'loop', 'source', 'variable_id'),
              new Set(ctx.survey.variables.map((v) => v.id)),
            );
          }
          walk(node.children, [...nodePath, 'children']);
          break;
        }
        case 'page': {
          declareId(ctx, node.id, 'pg', pointer(...nodePath, 'id'));
          checkNodeRef(ctx, refs, node.ref, pointer(...nodePath, 'ref'));
          checkI18nKey(ctx, node.title?.key, pointer(...nodePath, 'title', 'key'));
          checkIdRef(
            ctx,
            node.settings?.html_template_ref,
            ['ast'],
            pointer(...nodePath, 'settings', 'html_template_ref'),
            ctx.assetIds,
          );
          checkIdRef(ctx, node.settings?.css_ref, ['ast'], pointer(...nodePath, 'settings', 'css_ref'), ctx.assetIds);
          walk(node.children, [...nodePath, 'children']);
          break;
        }
        case 'question': {
          declareId(ctx, node.id, 'qst', pointer(...nodePath, 'id'));
          checkNodeRef(ctx, refs, node.ref, pointer(...nodePath, 'ref'));
          ctx.questions.set(node.id, node);
          checkQuestion(ctx, node, nodePath);
          break;
        }
        case 'text': {
          declareId(ctx, node.id, 'txt', pointer(...nodePath, 'id'));
          checkI18nKey(ctx, node.label.key, pointer(...nodePath, 'label', 'key'));
          checkIdRef(ctx, node.html_template_ref, ['ast'], pointer(...nodePath, 'html_template_ref'), ctx.assetIds);
          break;
        }
        default: {
          const never: never = node;
          throw new Error(`Unhandled content node: ${JSON.stringify(never)}`);
        }
      }
    });
  };

  walk(nodes, path);
}

function checkNodeRef(ctx: Ctx, seen: Map<string, string>, ref: string, path: string): void {
  checkRef(ctx, ref, path);
  const key = ref.toLowerCase();
  const first = seen.get(key);
  if (first !== undefined) {
    report(ctx, 'SCH-1001', path, `Ref ${JSON.stringify(ref)} is already used at ${first}.`, {
      ref,
      first_declared_at: first,
    });
    return;
  }
  seen.set(key, path);
}

function checkQuestion(ctx: Ctx, question: QuestionNode, base: readonly (string | number)[]): void {
  checkI18nKey(ctx, question.label?.key, pointer(...base, 'label', 'key'));
  checkI18nKey(ctx, question.instruction?.key, pointer(...base, 'instruction', 'key'));

  checkItems(ctx, question.options, [...base, 'options']);
  checkItems(ctx, question.rows, [...base, 'rows']);
  checkItems(ctx, question.columns, [...base, 'columns']);

  // Cell overrides address rows and columns by ref, so a typo there is a dangling reference
  // that would otherwise surface as "the numeric row rendered as a select".
  const rowRefs = new Set((question.rows ?? []).map((r) => r.ref));
  const columnRefs = new Set((question.columns ?? []).map((c) => c.ref));
  (question.cells ?? []).forEach((cell, i) => {
    if (!rowRefs.has(cell.row_ref)) {
      report(
        ctx,
        'SCH-1004',
        pointer(...base, 'cells', i, 'row_ref'),
        `Cell override references row ${JSON.stringify(cell.row_ref)}, which this question does not have.`,
        { row_ref: cell.row_ref },
      );
    }
    if (cell.column_ref != null && !columnRefs.has(cell.column_ref)) {
      report(
        ctx,
        'SCH-1004',
        pointer(...base, 'cells', i, 'column_ref'),
        `Cell override references column ${JSON.stringify(cell.column_ref)}, which this question does not have.`,
        { column_ref: cell.column_ref },
      );
    }
  });

  (question.validation ?? []).forEach((rule, i) => {
    declareId(ctx, rule.id, 'val', pointer(...base, 'validation', i, 'id'));
    checkI18nKey(ctx, rule.message_key, pointer(...base, 'validation', i, 'message_key'));
  });

  const variableIds = new Set(ctx.survey.variables.map((v) => v.id));
  (question.masks ?? []).forEach((mask, i) => {
    const maskPath = [...base, 'masks', i];
    declareId(ctx, mask.id, 'msk', pointer(...maskPath, 'id'));
    // The field most often forgotten in masking implementations, and the cause of the classic
    // "empty required question, respondent cannot proceed" dead end. There is no default.
    const fallback = mask.fallback as { when_empty?: string } | undefined;
    if (fallback?.when_empty === undefined) {
      report(
        ctx,
        'SCH-1005',
        pointer(...maskPath, 'fallback'),
        'Mask is missing fallback.when_empty, which has no safe default (skip_question | show_all | terminate).',
      );
    } else if (!MASK_FALLBACKS.includes(fallback.when_empty as (typeof MASK_FALLBACKS)[number])) {
      report(
        ctx,
        'SCH-1005',
        pointer(...maskPath, 'fallback', 'when_empty'),
        `Mask fallback ${JSON.stringify(fallback.when_empty)} is not one of ${MASK_FALLBACKS.join(' | ')}.`,
        { when_empty: fallback.when_empty },
      );
    }
    const source = mask.source;
    if (source.kind === 'selected_in' || source.kind === 'not_selected_in') {
      checkIdRef(ctx, source.variable_id, ['var'], pointer(...maskPath, 'source', 'variable_id'), variableIds);
    } else if (source.kind === 'explicit') {
      source.item_ids.forEach((itemId, j) => {
        checkIdRef(ctx, itemId, ['opt'], pointer(...maskPath, 'source', 'item_ids', j), undefined);
      });
    }
  });

  for (const [i, assetId] of (question.scripts?.on_load ?? []).entries()) {
    checkIdRef(ctx, assetId, ['ast'], pointer(...base, 'scripts', 'on_load', i), ctx.assetIds);
  }
  for (const [i, assetId] of (question.scripts?.on_answer ?? []).entries()) {
    checkIdRef(ctx, assetId, ['ast'], pointer(...base, 'scripts', 'on_answer', i), ctx.assetIds);
  }
  for (const [i, assetId] of (question.scripts?.on_validate ?? []).entries()) {
    checkIdRef(ctx, assetId, ['ast'], pointer(...base, 'scripts', 'on_validate', i), ctx.assetIds);
  }

  const variableIdSet = new Set(ctx.survey.variables.map((v) => v.id));
  (question.emits ?? []).forEach((variableId, i) => {
    checkIdRef(ctx, variableId, ['var'], pointer(...base, 'emits', i), variableIdSet);
  });
}

function checkItems(
  ctx: Ctx,
  items: readonly QuestionItem[] | undefined,
  base: readonly (string | number)[],
): void {
  if (items === undefined) return;
  const codes = new Map<number, string>();
  const refs = new Map<string, string>();
  items.forEach((item, i) => {
    const itemPath = [...base, i];
    declareId(ctx, item.id, 'opt', pointer(...itemPath, 'id'));
    checkRef(ctx, item.ref, pointer(...itemPath, 'ref'));
    checkI18nKey(ctx, item.label?.key, pointer(...itemPath, 'label', 'key'));
    checkI18nKey(ctx, item.media?.alt_key, pointer(...itemPath, 'media', 'alt_key'));
    checkIdRef(ctx, item.media?.image_asset_id, ['ast'], pointer(...itemPath, 'media', 'image_asset_id'), ctx.assetIds);

    const firstCode = codes.get(item.code);
    if (firstCode !== undefined) {
      // Codes are the exported values and the basis of every derived variable name, so a
      // duplicate does not just confuse a chart — it makes two columns claim one name.
      report(
        ctx,
        'SCH-1006',
        pointer(...itemPath, 'code'),
        `Code ${item.code} is already used at ${firstCode} within this list.`,
        { code: item.code, first_declared_at: firstCode },
      );
    } else {
      codes.set(item.code, pointer(...itemPath, 'code'));
    }

    const firstRef = refs.get(item.ref.toLowerCase());
    if (firstRef !== undefined) {
      report(ctx, 'SCH-1001', pointer(...itemPath, 'ref'), `Item ref ${JSON.stringify(item.ref)} is already used at ${firstRef}.`, {
        ref: item.ref,
        first_declared_at: firstRef,
      });
    } else {
      refs.set(item.ref.toLowerCase(), pointer(...itemPath, 'ref'));
    }
  });
}

/* -------------------------------------------------------------------------- */
/* variables                                                                  */
/* -------------------------------------------------------------------------- */

function checkVariables(ctx: Ctx): void {
  const names = new Map<string, string>();
  const columns = new Map<string, string>();

  ctx.survey.variables.forEach((variable, i) => {
    const base: readonly (string | number)[] = ['variables', i];
    declareId(ctx, variable.id, 'var', pointer(...base, 'id'));
    checkRef(ctx, variable.name, pointer(...base, 'name'));

    if (isReservedVariableName(variable.name)) {
      report(
        ctx,
        'SCH-1003',
        pointer(...base, 'name'),
        `Variable name ${JSON.stringify(variable.name)} collides with the reserved system variable ${JSON.stringify(
          variable.name.toLowerCase(),
        )}; system variables cannot be shadowed.`,
        { name: variable.name, reserved: variable.name.toLowerCase() },
      );
    }

    const nameKey = variable.name.toLowerCase();
    const firstName = names.get(nameKey);
    if (firstName !== undefined) {
      report(ctx, 'SCH-1001', pointer(...base, 'name'), `Variable name ${JSON.stringify(variable.name)} is already used at ${firstName}.`, {
        name: variable.name,
        first_declared_at: firstName,
      });
    } else {
      names.set(nameKey, pointer(...base, 'name'));
    }

    if (variable.export.include) {
      const columnKey = variable.export.column.toLowerCase();
      const firstColumn = columns.get(columnKey);
      if (firstColumn !== undefined) {
        // Deliverable B enforces this with a partial unique index; catching it here means the
        // author sees it in the editor instead of as a constraint violation on save.
        report(
          ctx,
          'SCH-1013',
          pointer(...base, 'export', 'column'),
          `Export column ${JSON.stringify(variable.export.column)} is already claimed at ${firstColumn}.`,
          { column: variable.export.column, first_declared_at: firstColumn },
        );
      } else {
        columns.set(columnKey, pointer(...base, 'export', 'column'));
      }
    }

    if (variable.type === 'enum' || variable.type === 'set') {
      const domain = variable.enum_domain;
      if (domain == null || domain.length === 0) {
        report(
          ctx,
          'SCH-1007',
          pointer(...base, 'enum_domain'),
          `Variable ${variable.name} is ${variable.type} but has no enum domain; an enum with no codes has no meaning.`,
          { name: variable.name },
        );
      } else {
        domain.forEach((entry, j) => {
          checkI18nKey(ctx, entry.label_key, pointer(...base, 'enum_domain', j, 'label_key'));
        });
      }
    }

    const hasExpression = variable.expression != null;
    /**
     * A derived variable normally must carry the expression that computes it — an author who
     * declares `AGE_BAND` without one has declared a column that will be null for everybody.
     *
     * The exception is a *structurally* derived variable: the `set<enum>` view over a
     * multi-select fan-out and a plugin companion like an NPS band. Their expressions are
     * synthesized at compile time from the question's own structure (Deliverable D §2.2), and
     * Deliverable D's AST has no authorable operator that collects the true booleans of a
     * fan-out — so requiring one here would make a correct survey unrepresentable.
     */
    const structurallyDerived = variable.source !== undefined;
    if (hasExpression && variable.kind !== 'derived') {
      report(
        ctx,
        'SCH-1015',
        pointer(...base, 'expression'),
        `Variable ${variable.name} has an expression but kind is ${JSON.stringify(variable.kind)}; only derived variables are computed.`,
        { name: variable.name, kind: variable.kind },
      );
    } else if (!hasExpression && variable.kind === 'derived' && !structurallyDerived) {
      report(
        ctx,
        'SCH-1015',
        pointer(...base, 'expression'),
        `Variable ${variable.name} has kind "derived" but no expression to compute it from.`,
        { name: variable.name, kind: variable.kind },
      );
    }

    checkI18nKey(ctx, variable.export.label_key, pointer(...base, 'export', 'label_key'));
    checkI18nKey(ctx, variable.title?.key, pointer(...base, 'title', 'key'));

    const source = variable.source;
    if (source === undefined) return;

    if (source.question_id !== undefined) {
      const question = ctx.questions.get(source.question_id);
      if (question === undefined) {
        report(
          ctx,
          'SCH-1004',
          pointer(...base, 'source', 'question_id'),
          `Variable ${variable.name} is sourced from ${source.question_id}, which is not a question in this survey.`,
          { question_id: source.question_id },
        );
        return;
      }
      checkSourceItems(ctx, variable, question, base);

      // The name is a function of (ref, part). A stored name that disagrees with the rule means
      // someone hand-edited the registry, and every downstream consumer — logic text,
      // export headers, the DSL printer — would disagree about what the column is called.
      const expected = deriveVariableName({
        ref: question.ref,
        part: source.part,
        ...(source.iteration === undefined ? {} : { iteration: source.iteration }),
      });
      if (expected !== variable.name) {
        report(
          ctx,
          'SCH-1010',
          pointer(...base, 'name'),
          `Variable name ${JSON.stringify(variable.name)} does not match the derivation rule for ${question.ref}; expected ${JSON.stringify(expected)}.`,
          { name: variable.name, expected },
        );
      }
    }
  });
}

function checkSourceItems(
  ctx: Ctx,
  variable: Variable,
  question: QuestionNode,
  base: readonly (string | number)[],
): void {
  const part = variable.source?.part;
  if (part === undefined) return;
  const options = new Set((question.options ?? []).map((o) => o.id));
  const rows = new Set((question.rows ?? []).map((r) => r.id));
  const columns = new Set((question.columns ?? []).map((c) => c.id));
  const path = pointer(...base, 'source', 'part');

  const missing = (id: string, list: ReadonlySet<string>, what: string): void => {
    if (!list.has(id)) {
      report(ctx, 'SCH-1004', path, `Variable ${variable.name} points at ${what} ${id}, which question ${question.ref} does not have.`, {
        id,
      });
    }
  };

  switch (part.kind) {
    case 'option':
      missing(part.option_id, options, 'option');
      break;
    case 'row':
      missing(part.row_id, rows, 'row');
      break;
    case 'column':
      missing(part.column_id, columns, 'column');
      break;
    case 'cell':
      missing(part.row_id, rows, 'row');
      missing(part.column_id, columns, 'column');
      break;
    case 'other_specify':
      if (part.option_id !== undefined) missing(part.option_id, options, 'option');
      break;
    case 'scalar':
    case 'set_view':
    case 'suffix':
    case 'design_task':
      break;
    default: {
      const never: never = part;
      throw new Error(`Unhandled variable part: ${JSON.stringify(never)}`);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* logic, flow, quotas, vendors, designs                                      */
/* -------------------------------------------------------------------------- */

function checkLogicRules(ctx: Ctx): void {
  const variableIds = new Set(ctx.survey.variables.map((v) => v.id));
  ctx.survey.logic_rules.forEach((rule, i) => {
    const base: readonly (string | number)[] = ['logic_rules', i];
    declareId(ctx, rule.id, 'rul', pointer(...base, 'id'));
    const target = rule.target;
    switch (target.type) {
      case 'question':
        checkIdRef(ctx, target.id, ['qst'], pointer(...base, 'target', 'id'), undefined);
        break;
      case 'page':
        checkIdRef(ctx, target.id, ['pg'], pointer(...base, 'target', 'id'), undefined);
        break;
      case 'block':
        checkIdRef(ctx, target.id, ['blk'], pointer(...base, 'target', 'id'), undefined);
        break;
      case 'option':
        checkIdRef(ctx, target.id, ['opt'], pointer(...base, 'target', 'id'), undefined);
        break;
      case 'variable':
        checkIdRef(ctx, target.id, ['var'], pointer(...base, 'target', 'id'), variableIds);
        break;
      case 'survey':
        break;
      default: {
        const never: never = target;
        throw new Error(`Unhandled rule target: ${JSON.stringify(never)}`);
      }
    }
    checkIdRef(
      ctx,
      rule.effect.target_id,
      ['qst', 'pg', 'blk', 'var'],
      pointer(...base, 'effect', 'target_id'),
      undefined,
    );
    checkI18nKey(ctx, rule.effect.message_key, pointer(...base, 'effect', 'message_key'));
  });
}

function checkFlow(ctx: Ctx): void {
  const flowIds = new Set(ctx.survey.flow.nodes.map((n) => n.id));
  const contentIds = new Set<string>();
  const collect = (nodes: readonly ContentNode[]): void => {
    for (const node of nodes) {
      contentIds.add(node.id);
      if (node.type === 'block' || node.type === 'page') collect(node.children);
    }
  };
  collect(ctx.survey.content);

  const next = (id: string | null | undefined, path: string): void => {
    if (id === undefined || id === null) return;
    checkIdRef(ctx, id, ['fn'], path, flowIds);
  };

  ctx.survey.flow.nodes.forEach((node, i) => {
    const base: readonly (string | number)[] = ['flow', 'nodes', i];
    declareId(ctx, node.id, 'fn', pointer(...base, 'id'));
    switch (node.type) {
      case 'start':
        next(node.next, pointer(...base, 'next'));
        break;
      case 'sequence':
        checkIdRef(ctx, node.target_id, ['blk', 'pg', 'qst', 'txt'], pointer(...base, 'target_id'), contentIds);
        next(node.next, pointer(...base, 'next'));
        break;
      case 'branch':
        node.branches.forEach((branch, j) => {
          next(branch.next, pointer(...base, 'branches', j, 'next'));
        });
        break;
      case 'quota_gate': {
        const planRefs = new Set((ctx.survey.quotas?.plans ?? []).map((p) => p.ref));
        if (!planRefs.has(node.quota_ref)) {
          report(
            ctx,
            'SCH-1004',
            pointer(...base, 'quota_ref'),
            `Quota gate references plan ${JSON.stringify(node.quota_ref)}, which is not defined in quotas.plans.`,
            { quota_ref: node.quota_ref },
          );
        }
        next(node.on_pass, pointer(...base, 'on_pass'));
        next(node.on_full, pointer(...base, 'on_full'));
        break;
      }
      case 'randomizer':
        node.targets.forEach((targetId, j) => {
          checkIdRef(ctx, targetId, ['blk', 'pg', 'qst'], pointer(...base, 'targets', j), contentIds);
        });
        next(node.next, pointer(...base, 'next'));
        break;
      case 'loop':
        checkIdRef(ctx, node.target_id, ['blk', 'pg'], pointer(...base, 'target_id'), contentIds);
        next(node.next, pointer(...base, 'next'));
        break;
      case 'termination':
      case 'end':
        break;
      case 'api_call':
        checkIdRef(ctx, node.asset_id, ['ast'], pointer(...base, 'asset_id'), ctx.assetIds);
        next(node.on_success, pointer(...base, 'on_success'));
        next(node.on_error, pointer(...base, 'on_error'));
        break;
      default: {
        const never: never = node;
        throw new Error(`Unhandled flow node: ${JSON.stringify(never)}`);
      }
    }
  });
}

function checkQuotas(ctx: Ctx): void {
  const quotas = ctx.survey.quotas;
  if (quotas == null) return;
  const variableIds = new Set(ctx.survey.variables.map((v) => v.id));

  const scope = quotas.policy?.counter_scope as string | undefined;
  if (scope === undefined || !QUOTA_COUNTER_SCOPES.includes(scope as (typeof QUOTA_COUNTER_SCOPES)[number])) {
    // No safe default: `survey` carries counters across a republish (right for a typo fix on a
    // tracker), `version` resets them (right when the sample plan changed). Guessing either
    // silently double-counts a wave or throws away days of field.
    report(
      ctx,
      'SCH-1012',
      pointer('quotas', 'policy', 'counter_scope'),
      `Quota policy needs an explicit counter_scope (${QUOTA_COUNTER_SCOPES.join(' | ')}); there is no safe default.`,
      { counter_scope: scope ?? null },
    );
  }

  const dimensionIds = new Set(quotas.dimensions.map((d) => d.id));
  quotas.dimensions.forEach((dimension, i) => {
    const base: readonly (string | number)[] = ['quotas', 'dimensions', i];
    declareId(ctx, dimension.id, 'qd', pointer(...base, 'id'));
    checkRef(ctx, dimension.ref, pointer(...base, 'ref'));
    checkIdRef(ctx, dimension.variable_id, ['var'], pointer(...base, 'variable_id'), variableIds);
  });

  quotas.plans.forEach((plan, i) => {
    const base: readonly (string | number)[] = ['quotas', 'plans', i];
    declareId(ctx, plan.id, 'qp', pointer(...base, 'id'));
    checkRef(ctx, plan.ref, pointer(...base, 'ref'));
    plan.dimension_ids.forEach((dimensionId, j) => {
      checkIdRef(ctx, dimensionId, ['qd'], pointer(...base, 'dimension_ids', j), dimensionIds);
    });
  });
}

function checkVendors(ctx: Ctx): void {
  const names = new Set(ctx.survey.variables.map((v) => v.name));
  (ctx.survey.vendors ?? []).forEach((vendor, i) => {
    const base: readonly (string | number)[] = ['vendors', i];
    declareId(ctx, vendor.id, 'vnd', pointer(...base, 'id'));
    checkRef(ctx, vendor.ref, pointer(...base, 'ref'));
    vendor.inbound_params.forEach((param, j) => {
      if (!names.has(param.variable_ref)) {
        report(
          ctx,
          'SCH-1004',
          pointer(...base, 'inbound_params', j, 'variable_ref'),
          `Vendor ${vendor.ref} writes inbound parameter ${JSON.stringify(param.param)} into variable ${JSON.stringify(
            param.variable_ref,
          )}, which is not declared.`,
          { variable_ref: param.variable_ref },
        );
      }
    });
  });
}

function checkDesigns(ctx: Ctx): void {
  const variableIds = new Set(ctx.survey.variables.map((v) => v.id));
  (ctx.survey.designs ?? []).forEach((design, i) => {
    const base: readonly (string | number)[] = ['designs', i];
    declareId(ctx, design.id, 'dsn', pointer(...base, 'id'));
    checkRef(ctx, design.ref, pointer(...base, 'ref'));
    design.spec.items.forEach((item, j) => {
      checkI18nKey(ctx, item.label_key, pointer(...base, 'spec', 'items', j, 'label_key'));
    });
    if (design.generated != null) {
      checkIdRef(
        ctx,
        design.generated.matrix_asset_id,
        ['ast'],
        pointer(...base, 'generated', 'matrix_asset_id'),
        ctx.assetIds,
      );
    }
    (design.emits ?? []).forEach((variableId, j) => {
      checkIdRef(ctx, variableId, ['var'], pointer(...base, 'emits', j), variableIds);
    });
  });
}
