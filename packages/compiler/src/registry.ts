/**
 * `Survey` → `LogicRegistryInput`: the branded-id boundary, and the only translation point
 * between the authoring model and the logic engine (D §3.2, roadmap P1-08).
 *
 * `packages/logic/src/registry.ts` names this file in its own header — "`packages/compiler`
 * (P1-08) builds a `LogicRegistryInput` from a `Survey`. That adapter is the single translation
 * point, and it is where the branded-id casts happen" — and the reason it has to be exactly one
 * file is `packages/logic/src/ids.ts`: schema's `Id<'var'>` and logic's `VariableId` are distinct
 * nominal types on purpose, so `asVariableId` and friends are the seam. Spread the casts across
 * six passes and the seam stops being a seam; "which id space is this string in" becomes a
 * question about the whole package instead of about this file.
 *
 * There is a working twin at `apps/studio/src/server/dsl/registry.ts`, which builds the same
 * declarations from `content.*` rows for the per-keystroke editor path. It is deliberately not
 * shared: it reads a *relational* projection where the compiler reads the document, it ships no
 * derived expressions (its comment explains why — nothing on that path checks a derived
 * variable's own definition), and its `question_id`/`page_id` parenthood comes from a
 * `parent_id` column rather than from a tree walk. What *is* shared is every decision below,
 * because a rule that type-checks in the editor and fails at publish is worse than either.
 *
 * ## The three things schema does not store, and what is done about them
 *
 * 1. **Enum domain identity** (CONTEXT decision 6). `Variable.enum_domain` is a per-variable
 *    copy of `[{code, label_key}]` with no id column, so an id is synthesized:
 *    `dom_<emitting question id>` for a question-sourced variable, `dom_<variable id>` for a
 *    standalone one. Structurally identical domains are merged **only** when they already share
 *    that synthesized id. Merging two questions' identical option lists would be the unsound
 *    direction: D §2.2 makes domains nominal precisely so a copy-pasted `Q3 = Q4` is caught, and
 *    a heuristic that guesses "same codes means same list" *admits* the comparison the check
 *    exists to reject. The cost is a false `LGC-T021` on a legitimate cross-question mask, so
 *    `CMP-0701` names it: two synthesized domains, identical entries, and the question ids.
 * 2. **`EnumDomain.ordinal`** (CONTEXT decision 7). No column, and `buildTypeEnv` has no default
 *    but `false`. `false` everywhere makes `Q9 > 3` on a Likert scale a false `LGC-T009`, so it
 *    is derived from the emitting question's type: from the plugin registry when one is supplied,
 *    otherwise from `ORDERED_SCALE_QUESTION_TYPES` below. Ordinality is a property of the
 *    *domain*, which is why the per-declaration signal that would be better — `question-kit`'s
 *    `DeclaredAnalysis.measure` — cannot be used yet: it is per variable, and today many
 *    variables share one synthesized domain.
 * 3. **A structurally derived variable's expression.** See `derive.ts`. `VarDecl.expression` must
 *    be present exactly when `kind === 'derived'`, and `validateStructural` permits a derived
 *    variable with no expression when it has a `source`. Those are the ones synthesized here.
 *
 * ## What this module refuses to do
 *
 * It does not validate. Duplicate names, missing enum domains, unresolvable refs, reserved
 * names and i18n key presence are all `validateStructural`'s (`SCH-*`), and the compile gate
 * runs it first; re-checking here would double-report against a second code. It emits exactly
 * two things: `CMP-0701` for the domain-identity gap, and `CMP-0103` for a derived variable it
 * cannot give an expression to — which is not a validation failure but a *compilation* failure,
 * since the resulting cell would have no writer.
 *
 * Ids are taken as given. `asVariableId` throws on a wrong prefix, and that is correct here:
 * id wellformedness is schema's contract, asserted by the gate before this runs, so a throw
 * means a caller skipped the gate rather than that an author typed something.
 */

import {
  flattenContent,
  pointer,
  type BlockNode,
  type EnumDomainEntry,
  type Expr as SchemaExpr,
  type JsonValue,
  type PageNode,
  type QuestionItem,
  type QuestionNode,
  type Survey,
  type Variable,
  type VariablePart,
} from '@resscript/schema';
import {
  asBlockId,
  asDomainId,
  asOptionId,
  asPageId,
  asQuestionId,
  asVariableId,
  buildTypeEnv,
  type BlockDecl,
  type DomainId,
  type EnumDomain,
  type Expr,
  type ItemDecl,
  type LogicRegistryInput,
  type PageDecl,
  type PageId,
  type QuestionDecl,
  type TypeEnv,
  type VarDecl,
  type VariableId,
  type VariablePartKind,
} from '@resscript/logic';
import type { PluginRegistry } from '@resscript/question-kit';

import { cmpDiagnostic, sortCompileDiagnostics, type CompileDiagnostic } from './diagnostics.js';
import { synthesizeDerived, type DeriveContext } from './derive.js';

/**
 * The stopgap ordinality allowlist.
 *
 * A STOPGAP, not a policy: it exists only because `Variable.enum_domain` has no `ordinal` flag
 * (`packages/logic/src/registry.ts`'s `EnumDomain.ordinal` comment records that it re-checked
 * schema and the flag is "**still missing**"). The moment a column or a plugin-declared measure
 * lands, this constant and the fallback that reads it should be deleted rather than extended:
 * a hard-coded list of question type ids is exactly the `if (question_type === …)` branch the
 * variable model exists to make unnecessary, and every entry added to it is a type whose
 * ordinality the plugin already knows and cannot say.
 *
 * Names, not plugin ids from the registry, because a survey can name a question type no
 * registry in this process has (an `org_custom` plugin, an artifact compiled elsewhere), and
 * the fallback has to answer for those too.
 */
export const ORDERED_SCALE_QUESTION_TYPES: readonly string[] = ['nps', 'rating', 'slider', 'likert'];

export interface BuildRegistryOptions {
  /** Absent means "answer ordinality and structural derivations from the fallbacks". */
  readonly plugins?: PluginRegistry | undefined;
}

export interface RegistryInputResult {
  readonly input: LogicRegistryInput;
  readonly diagnostics: readonly CompileDiagnostic[];
}

export interface TypeEnvResult extends RegistryInputResult {
  readonly env: TypeEnv;
}

/* ========================================================================== */
/* 1. The entry points                                                         */
/* ========================================================================== */

export function buildRegistryInput(
  survey: Survey,
  options: BuildRegistryOptions = {},
): RegistryInputResult {
  const diagnostics: CompileDiagnostic[] = [];
  const content = indexContent(survey);
  const domains = planDomains(survey, content, options);
  const idByName = new Map<string, VariableId>();
  for (const variable of survey.variables) idByName.set(variable.name, asVariableId(variable.id));

  const variables = survey.variables.map((variable, index) =>
    declare(survey, variable, index, {
      content,
      domains,
      idByName,
      diagnostics,
      ...(options.plugins === undefined ? {} : { plugins: options.plugins }),
    }),
  );

  diagnostics.push(...duplicateDomainWarnings(domains));

  return {
    input: {
      variables,
      domains: domains.declarations,
      questions: questionDecls(survey, content, domains),
      pages: content.pages,
      blocks: content.blocks,
    },
    diagnostics: sortCompileDiagnostics(diagnostics),
  };
}

/**
 * `buildTypeEnv` over the adapter's own output.
 *
 * Exported so no caller has to remember the second step. Two of them (the rule checker and the
 * quota pass) need only the env, and a caller that built the input and forgot to wrap it would
 * get a `TypeEnv`-shaped hole rather than a compile error.
 */
export function buildTypeEnvFor(
  survey: Survey,
  options: BuildRegistryOptions = {},
): TypeEnvResult {
  const { input, diagnostics } = buildRegistryInput(survey, options);
  return { env: buildTypeEnv(input), input, diagnostics };
}

/* ========================================================================== */
/* 2. The content index                                                        */
/* ========================================================================== */

interface ContentIndex {
  readonly questionNodes: readonly QuestionNode[];
  readonly questionById: ReadonlyMap<string, QuestionNode>;
  readonly pageOfQuestion: ReadonlyMap<string, PageId>;
  readonly pages: readonly PageDecl[];
  readonly blocks: readonly BlockDecl[];
}

/**
 * One walk of `content`, producing the page and block declarations and the question→page map.
 *
 * `flattenContent` gives document order, which is the order `questions` must be in: it is the
 * order a respondent meets them and therefore the order `buildVariableRegistry` used for the
 * export columns. Parenthood comes from each container's own `children` rather than from a
 * second flatten, because a `PageDecl.question_ids` built by filtering a flat list would need a
 * parent pointer schema's document does not carry.
 */
function indexContent(survey: Survey): ContentIndex {
  const questionNodes: QuestionNode[] = [];
  const questionById = new Map<string, QuestionNode>();
  const pageOfQuestion = new Map<string, PageId>();
  const pages: PageDecl[] = [];
  const blocks: BlockDecl[] = [];
  const parentBlock = new Map<string, string>();

  // One pass suffices because `flattenContent` emits a container before its children, so a
  // page's parent block is always already registered when the page is reached.
  for (const node of flattenContent(survey.content)) {
    switch (node.type) {
      case 'block': {
        for (const child of node.children) {
          if (child.type === 'block' || child.type === 'page') parentBlock.set(child.id, node.id);
        }
        blocks.push(blockDecl(node));
        break;
      }
      case 'page': {
        for (const child of node.children) {
          if (child.type === 'question') pageOfQuestion.set(child.id, asPageId(node.id));
        }
        pages.push(pageDecl(node, parentBlock));
        break;
      }
      case 'question':
        questionNodes.push(node);
        questionById.set(node.id, node);
        break;
      case 'text':
        // A text node emits nothing and is not referenceable from logic (schema's own comment).
        break;
      default: {
        const never: never = node;
        void never;
        break;
      }
    }
  }

  return { questionNodes, questionById, pageOfQuestion, pages, blocks };
}

function pageDecl(node: PageNode, parentBlock: ReadonlyMap<string, string>): PageDecl {
  const block = parentBlock.get(node.id);
  return {
    id: asPageId(node.id),
    question_ids: node.children
      .filter((child): child is QuestionNode => child.type === 'question')
      .map((child) => asQuestionId(child.id)),
    ...(block === undefined ? {} : { block_id: asBlockId(block) }),
  };
}

function blockDecl(node: BlockNode): BlockDecl {
  return {
    id: asBlockId(node.id),
    // Immediate page children only. A nested block's pages belong to that block: `BlockDecl` is
    // a tree edge, and flattening it here would make a page a member of two blocks.
    page_ids: node.children
      .filter((child): child is PageNode => child.type === 'page')
      .map((child) => asPageId(child.id)),
  };
}

/* ========================================================================== */
/* 3. Domains                                                                  */
/* ========================================================================== */

interface DomainBucket {
  readonly id: DomainId;
  /** code → label key. First declaration of a code wins; duplicates are `SCH-1008`. */
  readonly entries: Map<number, string>;
  readonly questionId: string | undefined;
  /** Index into `survey.variables` of the variable that introduced this domain. */
  readonly at: number;
}

interface DomainPlan {
  readonly byId: ReadonlyMap<DomainId, DomainBucket>;
  readonly ofVariable: ReadonlyMap<string, DomainId>;
  readonly ofQuestion: ReadonlyMap<string, DomainId>;
  readonly declarations: readonly EnumDomain[];
}

/**
 * Synthesize the domain ids, once, before any variable is declared.
 *
 * A separate pass because three later things need the whole map: a derived variable's
 * synthesized expression needs *its own* domain to build set and enum literals in (`derive.ts`
 * takes it as a parameter rather than re-deriving it, so the two cannot disagree), a
 * `QuestionDecl.domain` needs the domain of a question whose variables may appear anywhere in
 * the registry, and `CMP-0701` needs every domain before it can say two are identical.
 */
function planDomains(
  survey: Survey,
  content: ContentIndex,
  options: BuildRegistryOptions,
): DomainPlan {
  const byId = new Map<DomainId, DomainBucket>();
  const ofVariable = new Map<string, DomainId>();
  const ofQuestion = new Map<string, DomainId>();

  survey.variables.forEach((variable, index) => {
    const id = synthesizedDomainId(variable);
    if (id === undefined) return;
    ofVariable.set(variable.id, id);
    const questionId = variable.source?.question_id;
    if (questionId !== undefined) ofQuestion.set(questionId, id);
    const bucket =
      byId.get(id) ??
      ({
        id,
        entries: new Map<number, string>(),
        questionId,
        at: index,
      } satisfies DomainBucket);
    for (const entry of variable.enum_domain ?? []) {
      if (!bucket.entries.has(entry.code)) bucket.entries.set(entry.code, entry.label_key);
    }
    byId.set(id, bucket);
  });

  const declarations: EnumDomain[] = [...byId.values()].map((bucket) => ({
    id: bucket.id,
    entries: sortedEntries(bucket),
    ordinal: isOrdinal(bucket, content, options),
  }));

  return { byId, ofVariable, ofQuestion, declarations };
}

/**
 * `dom_<question id>` for a question-sourced variable, `dom_<variable id>` for a standalone one.
 *
 * The standalone case is nominally correct and slightly stricter than ideal — two hidden enums
 * carrying the same codes are not comparable — and `CODE()` is the documented escape (D §3.2).
 * It is the same choice the studio twin makes, deliberately: an id that differed between the two
 * would make a rule type-check in the editor and fail at publish.
 */
export function synthesizedDomainId(variable: Variable): DomainId | undefined {
  if (variable.type !== 'enum' && variable.type !== 'set') return undefined;
  return asDomainId(`dom_${variable.source?.question_id ?? variable.id}`);
}

function sortedEntries(bucket: DomainBucket): readonly EnumDomainEntry[] {
  return [...bucket.entries.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([code, label_key]) => ({ code, label_key }));
}

/**
 * Ordinality, from the emitting question's type. See the header, item 2.
 *
 * The plugin answer is `meta.category === 'scale'`, which is the only thing in `PluginMeta` that
 * distinguishes a rating scale from a brand list — and it is metadata, so it costs no plugin
 * call. A resolved plugin wins over the allowlist even when it says `false`: a plugin that
 * declares itself `choice` knows more about its own options than a list of ids in this file does.
 */
function isOrdinal(
  bucket: DomainBucket,
  content: ContentIndex,
  options: BuildRegistryOptions,
): boolean {
  if (bucket.questionId === undefined) return false;
  const question = content.questionById.get(bucket.questionId);
  if (question === undefined) return false;
  const resolved = options.plugins?.resolveForCompile(question.question_type);
  if (resolved !== undefined) return resolved.meta.category === 'scale';
  return ORDERED_SCALE_QUESTION_TYPES.includes(question.question_type);
}

/**
 * `CMP-0701`, one per pair of distinct synthesized domains with identical entries.
 *
 * Per pair rather than per group so the detail can name *both* sides: the author's next action is
 * to look at two questions, and a diagnostic listing five domain ids does not say which two.
 * Empty domains are skipped — an enum with no entries is `SCH-1007`, and calling two of them
 * "identical" would bury the real diagnostic under a warning about a symptom.
 */
function duplicateDomainWarnings(domains: DomainPlan): readonly CompileDiagnostic[] {
  const groups = new Map<string, DomainBucket[]>();
  for (const bucket of domains.byId.values()) {
    if (bucket.entries.size === 0) continue;
    const signature = JSON.stringify(sortedEntries(bucket));
    const list = groups.get(signature) ?? [];
    list.push(bucket);
    groups.set(signature, list);
  }

  const out: CompileDiagnostic[] = [];
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const sorted = [...list].sort((a, b) => a.id.localeCompare(b.id));
    for (let i = 0; i < sorted.length; i += 1) {
      for (let j = i + 1; j < sorted.length; j += 1) {
        const left = sorted[i];
        const right = sorted[j];
        if (left === undefined || right === undefined) continue;
        out.push(
          cmpDiagnostic(
            'CMP-0701',
            `The enum domains ${left.id} and ${right.id} have identical entries but distinct ` +
              'synthesized ids, because no column records that two questions share an option ' +
              'list. A cross-question comparison or mask between them will be reported as ' +
              'LGC-T021 even though it is legitimate.',
            pointer('variables', Math.max(left.at, right.at)),
            {
              domain_ids: [left.id, right.id],
              question_ids: [left.questionId ?? null, right.questionId ?? null],
              // Rebuilt as anonymous records rather than passed as `EnumDomainEntry[]`: an
              // `interface` has no implicit index signature, so it is not a `JsonValue` even
              // though its fields are. The alternative is a cast, and a cast in a diagnostic
              // detail is a cast on the one path that is only ever read by a human.
              entries: sortedEntries(left).map((entry) => ({
                code: entry.code,
                label_key: entry.label_key,
              })),
            },
          ),
        );
      }
    }
  }
  return out;
}

/* ========================================================================== */
/* 4. Variables                                                                */
/* ========================================================================== */

interface DeclareDeps {
  readonly content: ContentIndex;
  readonly domains: DomainPlan;
  readonly idByName: ReadonlyMap<string, VariableId>;
  readonly diagnostics: CompileDiagnostic[];
  readonly plugins?: PluginRegistry | undefined;
}

/**
 * One `Variable` → one `VarDecl`, in `survey.variables` order.
 *
 * The order is preserved and not sorted: it *is* the export column order
 * (`buildVariableRegistry`'s comment — "Order is the export column order … document order for
 * everything a question emits, then the authored hidden/derived/system/quota variables"), and
 * `TypeEnv.variables()` hands it straight back to the artifact's variable manifest.
 */
function declare(
  survey: Survey,
  variable: Variable,
  index: number,
  deps: DeclareDeps,
): VarDecl {
  const source = variable.source;
  const part = source === undefined ? undefined : partKindOf(source.part);
  const code = source === undefined ? undefined : codeOf(source.part);
  const optionId = source === undefined ? undefined : itemIdOf(source.part);
  const domain = deps.domains.ofVariable.get(variable.id);
  const expression = expressionFor(survey, variable, index, domain, deps);

  return {
    id: asVariableId(variable.id),
    name: variable.name,
    kind: variable.kind,
    type: variable.type,
    persist: variable.persist,
    pii: variable.pii,
    ...(domain === undefined ? {} : { domain }),
    ...(expression === undefined ? {} : { expression }),
    ...(source?.question_id === undefined
      ? {}
      : { question_id: asQuestionId(source.question_id) }),
    ...(part === undefined ? {} : { part }),
    ...(code === undefined ? {} : { code }),
    ...(optionId === undefined ? {} : { option_id: asOptionId(optionId) }),
    ...(source?.iteration === undefined ? {} : { iteration: source.iteration }),
    // `fields` is deliberately absent for `type: 'object'`. Schema declares no field types for
    // an object variable, so inventing an empty record here would be the same claim
    // `buildTypeEnv` already makes (`decl.fields ?? {}`) with an extra place to keep it in sync.
  };
}

/**
 * The expression of a `derived` variable: the author's, or a synthesized one, or a diagnostic.
 *
 * The authored AST is passed through with a cast and no re-validation. Schema carries it as an
 * opaque `{ op: string, …JSON }` envelope (its `Expr` comment: "The checker in P1-06 is where a
 * wrong `op` becomes an error"), and that checker is `checkExpr`, which reports `LGC-T002` for an
 * unknown kind. Re-deciding it here would either duplicate `isExprShape` or, worse, reject a node
 * kind logic knows and this file does not.
 */
function expressionFor(
  survey: Survey,
  variable: Variable,
  index: number,
  domain: DomainId | undefined,
  deps: DeclareDeps,
): Expr | undefined {
  if (variable.kind !== 'derived') return undefined;
  const authored = variable.expression;
  if (authored !== undefined && authored !== null) return asLogicExpr(authored);

  const questionId = variable.source?.question_id;
  const question = questionId === undefined ? undefined : deps.content.questionById.get(questionId);
  const synthesized =
    question === undefined
      ? undefined
      : synthesizeDerived(survey, variable, {
          question,
          domain,
          variablesOfQuestion: emittedBy(survey, questionId),
          variableId: (name) => deps.idByName.get(name),
          ...(deps.plugins === undefined ? {} : { plugins: deps.plugins }),
        } satisfies DeriveContext);

  if (synthesized === undefined) {
    deps.diagnostics.push(
      cmpDiagnostic(
        'CMP-0103',
        `Variable ${variable.name} is derived but has neither a stored expression nor a ` +
          'structure the compiler can derive one from, so its value cell would have no writer ' +
          'and the column would be null for every respondent.',
        pointer('variables', index),
        {
          variable_id: variable.id,
          name: variable.name,
          part: variable.source?.part.kind ?? null,
        },
      ),
    );
    return undefined;
  }
  deps.diagnostics.push(...synthesized.diagnostics);
  return synthesized.expression;
}

function asLogicExpr(expression: SchemaExpr): Expr {
  return expression as unknown as Expr;
}

function emittedBy(survey: Survey, questionId: string | undefined): readonly Variable[] {
  if (questionId === undefined) return [];
  return survey.variables.filter((variable) => variable.source?.question_id === questionId);
}

/**
 * Schema's nine-arm `VariablePart` union → logic's flat `VariablePartKind`.
 *
 * A `switch` and not `part.kind as VariablePartKind`, even though the strings coincide today.
 * The two unions are independently declared (logic cannot import schema — ADR-010), so a new arm
 * on either side must be a compile error somewhere, and this is the only place that can be.
 */
export function partKindOf(part: VariablePart): VariablePartKind {
  switch (part.kind) {
    case 'scalar':
      return 'scalar';
    case 'option':
      return 'option';
    case 'row':
      return 'row';
    case 'column':
      return 'column';
    case 'cell':
      return 'cell';
    case 'other_specify':
      return 'other_specify';
    case 'set_view':
      return 'set_view';
    case 'suffix':
      return 'suffix';
    case 'design_task':
      return 'design_task';
    default: {
      const never: never = part;
      throw new Error(`Unhandled variable part: ${JSON.stringify(never)}`);
    }
  }
}

/**
 * The item code a fan-out member carries.
 *
 * A `cell` reports its **row** code, and that choice is underdetermined by the model rather than
 * obvious: `groupItems` compares `VarDecl.code` against the *column*'s code for
 * `matrix_rows({ column_ref })` and against the *row*'s code for `matrix_cols({ row_ref })`, so
 * one `code` field cannot serve both and whichever is chosen leaves the other group kind
 * resolving to zero items (`LGC-T018`). The row is chosen because it is the axis everything else
 * about a cell leads with — `deriveVariableName` produces `Q3r1c2`, and `option_id` below points
 * at the row too, so `findItem` resolves `item.label` to the row's label, which for a grid is the
 * statement rather than the scale point. A real fix is a second code field on `ItemDecl`, which
 * is logic's to make.
 */
function codeOf(part: VariablePart): number | undefined {
  switch (part.kind) {
    case 'option':
    case 'row':
    case 'column':
      return part.code;
    case 'cell':
      return part.row_code;
    case 'other_specify':
      return part.code;
    case 'scalar':
    case 'set_view':
    case 'suffix':
    case 'design_task':
      return undefined;
    default: {
      const never: never = part;
      void never;
      return undefined;
    }
  }
}

function itemIdOf(part: VariablePart): string | undefined {
  switch (part.kind) {
    case 'option':
      return part.option_id;
    case 'row':
      return part.row_id;
    case 'column':
      return part.column_id;
    case 'cell':
      return part.row_id;
    case 'other_specify':
      return part.option_id;
    case 'scalar':
    case 'set_view':
    case 'suffix':
    case 'design_task':
      return undefined;
    default: {
      const never: never = part;
      void never;
      return undefined;
    }
  }
}

/* ========================================================================== */
/* 5. Questions and items                                                      */
/* ========================================================================== */

function questionDecls(
  survey: Survey,
  content: ContentIndex,
  domains: DomainPlan,
): readonly QuestionDecl[] {
  const variableOfItem = indexItemVariables(survey);

  return content.questionNodes.map((node): QuestionDecl => {
    const pageId = content.pageOfQuestion.get(node.id);
    const domain = domains.ofQuestion.get(node.id);
    const emits = node.emits ?? fallbackEmits(survey, node.id);
    return {
      id: asQuestionId(node.id),
      ref: node.ref,
      required: node.required,
      options: itemDecls(node.options, variableOfItem),
      rows: itemDecls(node.rows, variableOfItem),
      columns: itemDecls(node.columns, variableOfItem),
      emits: emits.map((id) => asVariableId(id)),
      ...(domain === undefined ? {} : { domain }),
      ...(pageId === undefined ? {} : { page_id: pageId }),
    };
  });
}

/**
 * `QuestionNode.emits` is stored (schema keeps it so a version diff shows "Q12 stopped emitting
 * Q12r4" without re-deriving), but it is optional in the type, and `groupItems` needs it: with an
 * empty `emits` every `question_emits` group falls back to a full scan of `variables`. Rebuilding
 * it from the registry when it is absent keeps a hand-written or partially-migrated document
 * working, in registry order — which is the order `buildVariableRegistry` would have written.
 */
function fallbackEmits(survey: Survey, questionId: string): readonly string[] {
  return survey.variables
    .filter((variable) => variable.source?.question_id === questionId)
    .map((variable) => variable.id);
}

/** item id → the fan-out variable it emits, per axis, so an `other_specify` cannot claim it. */
function indexItemVariables(survey: Survey): ReadonlyMap<string, VariableId> {
  const out = new Map<string, VariableId>();
  for (const variable of survey.variables) {
    const part = variable.source?.part;
    if (part === undefined) continue;
    const id =
      part.kind === 'option'
        ? part.option_id
        : part.kind === 'row'
          ? part.row_id
          : part.kind === 'column'
            ? part.column_id
            : undefined;
    if (id === undefined) continue;
    // First wins, which for a looped question means iteration 1. An `ItemDecl` has one
    // `variable_id` and a loop unrolls one item into N variables, so any answer is partial;
    // the lowest iteration is the deterministic one, and `loop_iterations` groups are how a
    // rule reaches the others.
    if (!out.has(id)) out.set(id, asVariableId(variable.id));
  }
  return out;
}

/**
 * `QuestionItem` → `ItemDecl`.
 *
 * **`position` is the 0-based array index, not schema's `position` field.** They disagree, and it
 * matters: `ItemDecl.position` is documented as "0-based canonical position", `GroupItem.position`
 * as "0-based position in the *canonical* (unrandomized) list", and `groupItems`' `options` case
 * passes `item.position` straight through to `item_attr position` — while schema's
 * `QuestionItem.position` is "the compiled, dense **display** position" and is written 1-based by
 * `packages/schema`'s own fixtures (`__fixtures__/mini.ts` uses `position: 1, 2`). Copying the
 * field would make `item.position == 0` unsatisfiable for the first option in every survey, which
 * is a silent wrong answer rather than an error. The array index is 0-based, dense, and equals
 * canonical order for an unrandomized list, and it is what the studio twin uses — so a mask that
 * type-checks in the editor resolves to the same positions at publish.
 */
function itemDecls(
  items: readonly QuestionItem[] | undefined,
  variableOfItem: ReadonlyMap<string, VariableId>,
): readonly ItemDecl[] {
  return (items ?? []).map((item, index): ItemDecl => {
    const variableId = variableOfItem.get(item.id);
    const meta = primitiveMeta(item.meta);
    return {
      option_id: asOptionId(item.id),
      code: item.code,
      label_key: item.label?.key ?? '',
      position: index,
      ref: item.ref,
      ...(item.pin === undefined ? {} : { pin: item.pin }),
      ...(meta === undefined ? {} : { meta }),
      ...(variableId === undefined ? {} : { variable_id: variableId }),
    };
  });
}

/**
 * `QuestionItem.meta` is free-form `JsonObject`; `ItemDecl.meta` admits only primitives.
 *
 * Nested values are dropped rather than stringified. `check.ts` types an `item_attr` meta lookup
 * from the *observed* metas of a group and reports `LGC-T013` when they disagree, so a value
 * flattened to `"[object Object]"` would type as `text` and compare equal to another question's
 * flattened object — a condition that is true for the wrong reason. A dropped key is `LGC-T013`
 * ("no item in this group declares the meta key"), which names the real problem.
 */
function primitiveMeta(
  meta: { readonly [key: string]: JsonValue } | undefined,
): { readonly [key: string]: string | number | boolean | null } | undefined {
  if (meta === undefined) return undefined;
  const out: { [key: string]: string | number | boolean | null } = {};
  let any = false;
  for (const key of Object.keys(meta).sort()) {
    const value = meta[key];
    if (value === undefined) continue;
    const primitive =
      value === null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean';
    if (primitive) {
      out[key] = value;
      any = true;
    }
  }
  return any ? out : undefined;
}
