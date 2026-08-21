/**
 * `@resscript/schema` — the canonical survey model.
 *
 * Every other package is a view over these types: the studio edits them, the DSL parses into
 * them, the compiler reads them, the runtime executes their compiled form, and the exporter
 * reads their variable manifest. Exports are explicit rather than `export *` so that adding a
 * name to the public API is a deliberate line in this file.
 */

/* ---- the model ---------------------------------------------------------- */

export type {
  /* top level */
  Survey,
  SurveyMeta,
  /* settings */
  SurveySettings,
  NavigationSettings,
  ResumeSettings,
  ResumePosition,
  ProgressBarSettings,
  ProgressBarMode,
  ScreenoutSettings,
  QualitySettings,
  /* i18n */
  Languages,
  LanguageDef,
  LanguagePolicy,
  MissingStringPolicy,
  StringBundle,
  /* common */
  Expr,
  I18nRef,
  Iso8601,
  JsonObject,
  JsonPrimitive,
  JsonValue,
  ConditionalValue,
  RandomizationSpec,
  RandomizationMode,
  RandomizationSubBlock,
  AnchorSpec,
  /* variables */
  Variable,
  VariableExport,
  VariableKind,
  VariablePart,
  VariableSource,
  VariableStorage,
  VariableType,
  EnumDomainEntry,
  /* content */
  ContentNode,
  ContentNodeType,
  BlockNode,
  BlockSettings,
  PageNode,
  PageChild,
  PageSettings,
  PageLayout,
  MinTimeAction,
  QuestionNode,
  QuestionFlags,
  QuestionScripts,
  QuestionItem,
  QuestionCell,
  QuestionCellControl,
  OptionBehaviour,
  OptionMedia,
  TextNode,
  LoopSpec,
  LoopSource,
  LoopItem,
  /* validation and masking */
  ValidationRule,
  ValidationScope,
  ValidationType,
  Mask,
  MaskFallback,
  MaskFallbackSpec,
  MaskMode,
  MaskSource,
  MaskTarget,
  /* flow */
  Flow,
  FlowNode,
  FlowNodeType,
  FlowBranch,
  StartNode,
  SequenceNode,
  BranchNode,
  QuotaGateNode,
  RandomizerNode,
  LoopFlowNode,
  TerminationNode,
  ApiCallNode,
  EndNode,
  /* logic */
  LogicRule,
  RuleAction,
  RuleAuthoredIn,
  RuleEffect,
  RuleEvaluation,
  RuleKind,
  RuleTarget,
  /* quotas */
  QuotaConfig,
  QuotaPolicy,
  QuotaCounterScope,
  QuotaCountAt,
  QuotaStoreFailureMode,
  QuotaDimension,
  QuotaBucket,
  QuotaPlan,
  QuotaPlanType,
  QuotaCell,
  QuotaCellMode,
  QuotaTargetMode,
  VendorQuotaLimit,
  /* vendors */
  Vendor,
  VendorInboundParam,
  VendorSecurity,
  Redirects,
  RedirectMap,
  /* designs */
  Design,
  DesignBalance,
  DesignDiagnostics,
  DesignGenerated,
  DesignItem,
  DesignMethod,
  DesignSpec,
  /* assets */
  Assets,
  CssAsset,
  HtmlTemplateAsset,
  MediaAsset,
  ScriptAsset,
  ScriptHook,
  ScriptScope,
  ScriptTarget,
  /* the compiled artifact (types only — the compiler is P1-08) */
  CompiledArtifact,
  ArtifactManifest,
  ArtifactGraph,
  ArtifactLogic,
  ArtifactLogicCell,
  ArtifactLogicSchema,
  CompiledPage,
  CompiledQuestion,
  CompiledItem,
  CompiledRule,
  VariableManifestEntry,
} from './types/index.js';

export {
  ANCHOR_PATTERN,
  DEFAULT_LOOP_NAMING,
  DESIGN_METHODS,
  FLOW_NODE_TYPES,
  MASK_FALLBACKS,
  MASK_MODES,
  MASK_TARGETS,
  MIN_TIME_ACTIONS,
  MISSING_STRING_POLICIES,
  PAGE_LAYOUTS,
  PROGRESS_BAR_MODES,
  QUOTA_CELL_MODES,
  QUOTA_COUNTER_SCOPES,
  QUOTA_COUNT_AT,
  QUOTA_PLAN_TYPES,
  QUOTA_STORE_FAILURE_MODES,
  QUOTA_TARGET_MODES,
  RANDOMIZATION_MODES,
  RESUME_POSITIONS,
  RULE_ACTIONS,
  RULE_AUTHORED_IN,
  RULE_EVALUATIONS,
  RULE_KINDS,
  SCRIPT_HOOKS,
  SCRIPT_SCOPES,
  SCRIPT_TARGETS,
  VALIDATION_SCOPES,
  VALIDATION_TYPES,
  VARIABLE_KINDS,
  VARIABLE_TYPES,
} from './types/index.js';

/* ---- ids ---------------------------------------------------------------- */

export {
  ALL_ID_PREFIXES,
  ID_PREFIXES,
  REF_PATTERN,
  ULID_BODY_PATTERN,
  asId,
  createIdFactory,
  idPrefixOf,
  isAnyId,
  isId,
  isValidRef,
  parseId,
} from './ids.js';

export type {
  AnyId,
  AssetId,
  BlockId,
  ContentNodeId,
  DesignId,
  FlowNodeId,
  Id,
  IdFactory,
  IdFactoryOptions,
  IdKind,
  IdParseResult,
  IdPrefix,
  MaskId,
  OptionId,
  PageId,
  QuestionId,
  QuotaDimensionId,
  QuotaPlanId,
  RuleId,
  SurveyId,
  TextNodeId,
  ValidationId,
  VariableId,
  VendorId,
} from './ids.js';

/* ---- canonical registries (Deliverable K) ------------------------------- */

export {
  COMPILE_STATES,
  DISPOSITIONS,
  DISPOSITION_FACTS,
  FLOW_REACHABLE_DISPOSITIONS,
  ORG_ROLES,
  ORG_ROLE_RANKS,
  PREVIEW_MESSAGE_TYPES,
  PREVIEW_PROTOCOL,
  REDIRECT_REQUIRED_DISPOSITIONS,
  RESERVED_VARIABLE_NAMES,
  SURVEY_TOKEN_PATTERN,
  VERSION_STATUSES,
  isReservedVariableName,
  roleRank,
} from './registries.js';

export type {
  CompileState,
  Disposition,
  OrgRole,
  PreviewMessageType,
  VersionStatus,
} from './registries.js';

/* ---- variables ---------------------------------------------------------- */

export {
  BUILTIN_SCALAR_TYPES,
  NPS_BAND_DOMAIN,
  applyLoopNaming,
  applyVariableRegistry,
  buildVariableRegistry,
  deriveVariableName,
  findContentNode,
  findReservedNameCollisions,
  flattenContent,
  mapContent,
  planQuestionEmissions,
  renameRef,
  variableSignature,
  variableTypeForControl,
  walkQuestions,
} from './variables.js';

export type {
  BuildVariableRegistryOptions,
  DeriveVariableNameInput,
  PlannedVariable,
  RenameRefOutcome,
  RenameRefResult,
  RenamedVariable,
  ReservedNameCollision,
  VariableRegistryResult,
} from './variables.js';

/* ---- diagnostics and validation ----------------------------------------- */

export {
  ALL_DIAGNOSTIC_CODES,
  DIAGNOSTIC_CODES,
  hasErrors,
  pointer,
  sortDiagnostics,
} from './diagnostics.js';

export type { Diagnostic, DiagnosticCode, DiagnosticSeverity } from './diagnostics.js';

export { validateStructural } from './validate.js';

/* ---- JSON Schema -------------------------------------------------------- */

export { SCHEMA_DEFS, SURVEY_DESC, fieldNamesOf, toJsonSchema, validateShape } from './json-schema.js';
export type { FieldDesc, FieldsOf, JsonSchemaObject, SchemaDesc } from './json-schema.js';

/* ---- serialization ------------------------------------------------------ */

export { parse, parseValue, serialize, stableStringify } from './serialize.js';
export type { ParseOptions, ParseResult } from './serialize.js';

/* ---- migration ---------------------------------------------------------- */

export { CURRENT_SCHEMA_VERSION, MIGRATIONS, migrateAndParse, migrateToCurrent } from './migrate.js';
export type { MigrateResult, Migration, SurveyDocument } from './migrate.js';
