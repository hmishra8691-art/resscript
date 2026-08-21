/**
 * `@resscript/question-kit` — the question-type plugin contract (Deliverable F, milestone P1-04).
 *
 * This entry point is **React-free at runtime**. The compiler, the exporter, the API boundary and
 * the server-side validation pass all import from here, and none of them may pull a component tree
 * into their process — React in `apps/worker` is dead weight, and React plus the *editor* in the
 * respondent bundle is dead weight on the page-load path of every survey we ever run. The React
 * halves live behind `./react.ts`, and `entrypoints.test.ts` walks this module's import graph to
 * prove the separation rather than trusting this comment.
 *
 * Exports are explicit rather than `export *`, following `@resscript/schema`: adding a name to the
 * public API should be a deliberate line in this file.
 */

import type { AnyPluginCore as AnyPluginCoreType } from './contract/plugin.js';
import { multiSelectCore } from './plugins/multi-select/core.js';
import { npsCore } from './plugins/nps/core.js';
import { binaryCore } from './plugins/binary/core.js';
import { consentCore } from './plugins/consent/core.js';
import { contentMediaCore } from './plugins/content-media/core.js';
import { contentTextCore } from './plugins/content-text/core.js';
import { dateCore } from './plugins/date/core.js';
import { matrixCore } from './plugins/matrix/core.js';
import { numericCore } from './plugins/numeric/core.js';
import { numericListCore } from './plugins/numeric-list/core.js';
import { ratingCore } from './plugins/rating/core.js';
import { textCore } from './plugins/text/core.js';
import { textareaCore } from './plugins/textarea/core.js';
import { textListCore } from './plugins/text-list/core.js';
import { singleSelectCore } from './plugins/single-select/core.js';

/* ---- the contract ------------------------------------------------------- */

export type {
  QuestionTypePlugin,
  QuestionTypePluginCore,
  AnyPlugin,
  AnyPluginCore,
  AnyPluginView,
  ConfigMigration,
} from './contract/plugin.js';
export { withComponents } from './contract/plugin.js';

export type {
  PluginMeta,
  PluginCategory,
  PluginTrust,
  I18nKey,
  Semver,
  ParsedPluginKey,
} from './contract/meta.js';
export {
  PLUGIN_CATEGORIES,
  PLUGIN_ID_PATTERN,
  PLUGIN_TRUST_RANK,
  PLUGIN_TRUST_TIERS,
  compareSemver,
  parsePluginKey,
  parseSemver,
  pluginKey,
} from './contract/meta.js';

/* ---- variables: the centre of the contract ------------------------------ */

export type {
  AnalysisMeasure,
  CellControl,
  CellOverride,
  ComposeScope,
  DeclarationBase,
  DeclarationKind,
  DeclarationPart,
  DeclarationPartKind,
  DeclaredAnalysis,
  DeclaredEnumEntry,
  DeclaredExport,
  DeclaredNumericDomain,
  Derivation,
  DerivedVariableDeclaration,
  LogicAst,
  LoopContext,
  NumericBand,
  QuestionFlagsView,
  ResponseVariableDeclaration,
  SetViewMember,
  StructuralComputation,
  StructuralDerivation,
  VariableDeclContext,
  VariableDeclaration,
  VariableNamer,
} from './contract/variables.js';
export {
  NAME_SUFFIX_PATTERN,
  SCALAR_VARIABLE_TYPES,
  compareCodes,
  evaluateDerivation,
  isScalarVariableType,
  requiresEnumDomain,
} from './contract/variables.js';

/* ---- items, authoring, validation, codec, export, a11y ------------------ */

export type { AuthoredItem, AuthoredItemMedia, OptionCode, ResolvedItem, ResolvedItemMedia } from './contract/items.js';
export { compareItemsForDeclaration, itemCode, itemsForDeclaration } from './contract/items.js';

export type { AuthoredQuestion, DefaultConfigContext, StaticCheckContext } from './contract/authored.js';

export type {
  ResolvedQuestion,
  ResolvedQuestionVariables,
  ValidateContext,
  ValidationIssue,
  ValidationPhase,
  ValidationSide,
  KitMessageKey,
} from './contract/validate.js';
export { KIT_MESSAGE_KEYS } from './contract/validate.js';

export type { CodecContext, CodecError, ResponseCodec, Result, TextRead } from './contract/codec.js';
export {
  CODEC_LIMITS,
  asOptionCode,
  asPlainObject,
  err,
  ok,
  readBoundedText,
} from './contract/codec.js';

export type { DerivedExportColumn, ExportContext, ExportContribution, ExportSidecar } from './contract/export.js';

export type { A11yContract, A11yException, A11yInteractionModel, A11yKey } from './contract/a11y.js';
export { MIN_TOUCH_TARGET_PX, TOUCH_TARGET_CLASS, checkA11yContract } from './contract/a11y.js';

export type { HookContext, PluginHooks } from './contract/hooks.js';

export type { CompileDiagnostic, DiagnosticSeverity, PluginDiagnostic } from './contract/diagnostics.js';
export { hasErrors, namespaceCode, namespaceDiagnostics, pointer } from './contract/diagnostics.js';

/* ---- the editor bridge (types + the patch allowlist) -------------------- */

export type { EditorToStudio, StudioToEditor } from './contract/editor-bridge.js';
export {
  EDITOR_BRIDGE_PROTOCOL,
  EDITOR_PATCH_PATH_ALLOWLIST,
  checkEditorPatch,
  isAllowedEditorPatchPath,
} from './contract/editor-bridge.js';

/**
 * View *types* only — no components. `RendererComponent` and `EditorComponent` are needed to state
 * the contract; the implementations are behind `./react.ts`. Every React reference on this path is
 * an `import type`, so it is erased under `verbatimModuleSyntax`.
 */
export type {
  ChildProps,
  EditorComponent,
  EditorContext,
  EditorProps,
  JsonPatchOp,
  RenderContext,
  RenderDevice,
  RenderIds,
  RendererComponent,
  RendererProps,
  TextDirection,
} from './contract/view.js';
export { defineRenderer } from './contract/view.js';

/* ---- the machinery ------------------------------------------------------ */

export type { DeclareOptions, DeclareResult } from './declare.js';
export { declareVariablesFor, verifyDeclarations } from './declare.js';

export type { NamerSpec } from './naming.js';
export { createNamer, createScopedNamer, deriveDeclarationName, rescopePart } from './naming.js';

export type {
  CompileResolution,
  ListFilter,
  PluginListEntry,
  PluginRegistry,
  PluginSource,
  RegisteredPlugin,
  RegistryOptions,
} from './registry.js';
export { createRegistry } from './registry.js';

export type {
  CodecContextOptions,
  ItemState,
  ResolveOptions,
  ValidateContextOptions,
} from './resolve.js';
export { createCodecContext, createValidateContext, indexVariables, resolveQuestion } from './resolve.js';

export type {
  FromQuestionNodeOptions,
  InteropIssue,
  ItemIdResolver,
  PlannedVariablesResult,
  ToPlannedOptions,
} from './interop.js';
export { fromQuestionNode, toAuthoredItem, toPlannedVariables, toVariablePart } from './interop.js';

export type {
  CompiledSchema,
  CompileOptions,
  ConfigIssue,
  ConfigValidationResult,
  JsonSchema,
  JsonSchemaObject,
  JsonSchemaType,
  SchemaCache,
} from './json-schema.js';
export {
  RANDOMIZATION_SPEC_SCHEMA,
  SCHEMA_REF_PREFIX,
  applySchemaDefaults,
  compileSchema,
  createSchemaCache,
} from './json-schema.js';

export type { ComposeErrorCode, RegistryErrorCode } from './errors.js';
export { PluginComposeError, PluginRegistryError } from './errors.js';

/* ---- first-party plugin cores (no components) --------------------------- */

export { singleSelectCore, SINGLE_SELECT_CONFIG_SCHEMA } from './plugins/single-select/core.js';
export type {
  SingleSelectAnswer,
  SingleSelectConfig,
  SingleSelectOtherConfig,
} from './plugins/single-select/core.js';

export { multiSelectCore, MULTI_SELECT_CONFIG_SCHEMA } from './plugins/multi-select/core.js';
export type { MultiSelectAnswer, MultiSelectConfig } from './plugins/multi-select/core.js';

export { npsCore, NPS_BANDS, NPS_CONFIG_SCHEMA, NPS_MAX_SCORE, NPS_MIN_SCORE } from './plugins/nps/core.js';
export type { NpsAnswer, NpsConfig } from './plugins/nps/core.js';

export { binaryCore, BINARY_CONFIG_SCHEMA } from './plugins/binary/core.js';
export type { BinaryAnswer, BinaryConfig } from './plugins/binary/core.js';

export { ratingCore, RATING_CONFIG_SCHEMA } from './plugins/rating/core.js';
export type { RatingAnswer, RatingConfig } from './plugins/rating/core.js';

export { textCore, TEXT_CONFIG_SCHEMA } from './plugins/text/core.js';
export type { TextAnswer, TextConfig, TextInputMode } from './plugins/text/core.js';

export {
  textareaCore,
  TEXTAREA_CONFIG_SCHEMA,
  TEXTAREA_MESSAGE_KEYS,
  countWords,
} from './plugins/textarea/core.js';
export type { TextareaAnswer, TextareaConfig } from './plugins/textarea/core.js';

export {
  textListCore,
  TEXT_LIST_CONFIG_SCHEMA,
  TEXT_LIST_MESSAGE_KEYS,
} from './plugins/text-list/core.js';
export type { TextListAnswer, TextListConfig } from './plugins/text-list/core.js';

export {
  numericCore,
  MAX_NUMERIC_MAGNITUDE,
  NUMERIC_CONFIG_SCHEMA,
  onDecimalGrid,
  readGridNumber,
} from './plugins/numeric/core.js';
export type { NumericAnswer, NumericConfig, NumericUnit } from './plugins/numeric/core.js';

export { numericListCore, NUMERIC_LIST_CONFIG_SCHEMA } from './plugins/numeric-list/core.js';
export type {
  NumericListAnswer,
  NumericListConfig,
  NumericListSum,
} from './plugins/numeric-list/core.js';

export { dateCore, DATE_CONFIG_SCHEMA, ISO_DATE_PATTERN, isCalendarDate } from './plugins/date/core.js';
export type { DateAnswer, DateConfig } from './plugins/date/core.js';

export { matrixCore, MATRIX_CONFIG_SCHEMA, controlForRow, rowScope } from './plugins/matrix/core.js';
export type { MatrixAnswer, MatrixConfig } from './plugins/matrix/core.js';

export { contentTextCore, CONTENT_TEXT_CONFIG_SCHEMA } from './plugins/content-text/core.js';
export type { ContentTextAnswer, ContentTextConfig } from './plugins/content-text/core.js';

export { contentMediaCore, CONTENT_MEDIA_CONFIG_SCHEMA } from './plugins/content-media/core.js';
export type { ContentMediaAnswer, ContentMediaConfig } from './plugins/content-media/core.js';

export { consentCore, CONSENT_CONFIG_SCHEMA } from './plugins/consent/core.js';
export type { ConsentAnswer, ConsentConfig } from './plugins/consent/core.js';

export {
  createComposeDelegates,
  resolveComposedChild,
  type ChildSeat,
  type ComposeDelegateOptions,
  type ComposeDelegates,
} from './compose-host.js';

/**
 * The Phase-1 cores registered by the compiler and the API boundary.
 *
 * A list rather than a pre-built registry: the registry's `register` assigns trust from the
 * *source*, and only the caller knows whether it is building the first-party set, an org's custom
 * set, or a per-artifact set (F §6, F §7). Handing out a pre-populated registry would make
 * "first_party" the default for anything anyone added to it.
 */
export const FIRST_PARTY_CORES: readonly AnyPluginCoreType[] = [
  singleSelectCore,
  multiSelectCore,
  npsCore,
  binaryCore,
  ratingCore,
  textCore,
  textareaCore,
  textListCore,
  numericCore,
  numericListCore,
  dateCore,
  matrixCore,
  contentTextCore,
  contentMediaCore,
  consentCore,
];
