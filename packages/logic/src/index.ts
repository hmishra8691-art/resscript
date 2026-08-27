/**
 * `@resscript/logic` — the logic engine. Deliverable D, milestone P1-06.
 *
 * The AST, the type checker, Kleene three-valued semantics, the evaluator, and the cell
 * dependency graph. **Zero third-party dependencies and no Node builtins** (ADR-004, ADR-010):
 * this exact code runs in Node, in a browser, in a web worker and inside QuickJS-WASM, and
 * divergence between any two of them means a survey behaves differently in preview than in field.
 *
 * The one fact that makes the whole package small: **logic never references questions, it
 * references variables.** A matrix row is a variable, a multi-select option is a variable, a
 * hidden vendor parameter is a variable. There are no special cases for grids, loops or
 * "other, specify".
 */

/* ---- the AST and its registry ------------------------------------------- */
export {
  AST_FAMILY,
  AST_KINDS,
  AGG_FNS,
  PROBE_KINDS,
  isAstKind,
  type AggFn,
  type AstFamily,
  type AstKind,
  type ProbeKind,
} from './ast-kinds.js';

export {
  T_BOOL,
  T_DATE,
  T_NEVER,
  T_NULL,
  T_NUM,
  T_TEXT,
  assertExprShape,
  childrenOf,
  countNodes,
  exprEq,
  groupEq,
  isExprShape,
  isStateFree,
  kindOf,
  literalEq,
  mapChildren,
  probesOf,
  readsOf,
  typeEq,
  typeName,
  walkExpr,
  type Agg,
  type Arith,
  type BoolOp,
  type Cast,
  type CaseExpr,
  type Cmp,
  type CmpOp,
  type Coalesce,
  type DateOp,
  type DateUnit,
  type Expr,
  type Group,
  type GroupItem,
  type ItemAttr,
  type ItemRef,
  type LabelOf,
  type Lit,
  type LiteralValue,
  type NodeBase,
  type Probe,
  type ProbeTarget,
  type SetOp,
  type StrOp,
  type Type,
  type VarRef,
} from './ast.js';

export { astBuilder, renumber, stripTypes, type AggSpec, type AstBuilder } from './build.js';

/* ---- ids and invariants -------------------------------------------------- */
export {
  LogicInvariant,
  asBlockId,
  asDomainId,
  asFlowNodeId,
  asOptionId,
  asPageId,
  asQuestionId,
  asQuotaDimensionId,
  asQuotaPlanId,
  asRuleId,
  asVariableId,
  at,
  hasPrefix,
  invariant,
  type BlockId,
  type CellIdx,
  type DomainId,
  type FlowNodeId,
  type LogicId,
  type LogicIdPrefix,
  type LoopId,
  type NodeId,
  type NodeIdx,
  type OptionId,
  type PageId,
  type QuestionId,
  type QuotaDimensionId,
  type QuotaPlanId,
  type RuleId,
  type VariableId,
} from './ids.js';

/* ---- values and three-valued logic ------------------------------------- */
export {
  EMPTY_CODES,
  FALSE,
  NULL,
  TRUE,
  bool,
  compareValues,
  date,
  enumValue,
  formatValue,
  isNull,
  normalizeCodes,
  num,
  objValue,
  setValue,
  text,
  valueEq,
  valueToJson,
  type Value,
  type ValueKind,
} from './value.js';

export {
  TRI_VALUES,
  and3,
  andAll,
  not3,
  or3,
  orAll,
  triOf,
  triToValue,
  type Tri,
} from './kleene.js';

/* ---- diagnostics -------------------------------------------------------- */
export {
  ALL_LGC_CODES,
  LGC_DIAGNOSTIC_CODES,
  LGC_SEVERITY,
  diagnostic,
  errorsOnly,
  hasErrors,
  pointer,
  sortDiagnostics,
  type LgcCode,
  type LgcDiagnostic,
  type LgcJsonValue,
  type LgcSeverity,
} from './diagnostics.js';

/* ---- the type environment ---------------------------------------------- */
export {
  VARIABLE_KINDS,
  VARIABLE_TYPES,
  WRITABLE_VARIABLE_KINDS,
  buildTypeEnv,
  isWritableKind,
  type BlockDecl,
  type EnumDomain,
  type EnumEntry,
  type ItemDecl,
  type LogicRegistryInput,
  type PageDecl,
  type QuestionDecl,
  type TypeEnv,
  type VarDecl,
  type VariableKind,
  type VariablePartKind,
  type VariableType,
} from './registry.js';

/* ---- the checker -------------------------------------------------------- */
export {
  annotate,
  checkExpr,
  checkRule,
  constantVerdict,
  groupElementType,
  mayBeUnknown,
  regexDiagnosis,
  unify,
  type CheckExprOptions,
  type CheckResult,
  type CheckRuleOptions,
  type ItemBinding,
  type RuleCheckResult,
} from './check.js';

/* ---- rules, cells and the coercion boundary ---------------------------- */
export {
  DISPOSITIONS,
  PHASE_RANK,
  RULE_EVALUATIONS,
  RULE_KINDS,
  SAFE_ON_UNKNOWN,
  applyMask,
  cellKey,
  collapseUnknown,
  combineAbsorbingFalse,
  combineOr,
  combineVisible,
  exprsOf,
  optPropCombiner,
  setVariableOutcome,
  writesOf,
  type Cell,
  type CellKind,
  type Collapse,
  type Disposition,
  type Effect,
  type MaskAxis,
  type OptProp,
  type Rule,
  type RuleEvaluation,
  type RuleKind,
  type SetVariableOutcome,
  type Target,
} from './rules.js';

/* ---- state, context and the trace -------------------------------------- */
export {
  boolCell,
  cellBool,
  cellCodes,
  cellValueEq,
  cellValueOf,
  collectingTrace,
  createEvalState,
  orderScope,
  varStateOf,
  type CellValue,
  type EvalContext,
  type EvalState,
  type MaskFallback,
  type Provenance,
  type SessionFacts,
  type TraceCell,
  type TraceSink,
  type TraceWriter,
  type VarState,
} from './state.js';

/* ---- evaluation --------------------------------------------------------- */
export {
  EMPTY_SCHEMA,
  NO_CELLS,
  aggregate,
  bindItem,
  evalCondition,
  evalExpr,
  evalStateFree,
  literalValue,
  type CellReader,
  type EvalSchema,
  type ExprEnv,
  type ItemBindingValue,
} from './evaluator.js';

export {
  buildEvalSchema,
  compileFailed,
  compileLogic,
  createInterner,
  itemsKey,
  optionKey,
  type CompileOptions,
  type CompiledLogic,
  type Interner,
} from './compile.js';

export {
  buildCellGraph,
  stronglyConnected,
  type BuildGraphOptions,
  type CellGraph,
} from './graph.js';

/* ---- the optimizer (D §10.1, roadmap P2-01) ----------------------------- */
export { optimizeExpr } from './optimize.js';

export {
  evaluate,
  onAnswerChange,
  type CellChange,
  type EvaluateOptions,
  type Termination,
  type ValidationFailure,
  type Verdict,
} from './engine.js';

/* ---- date arithmetic ---------------------------------------------------- */
export {
  civilFromDays,
  compareCivil,
  dateAdd,
  dateDiff,
  dateTrunc,
  dayOfWeek,
  daysFromCivil,
  daysInMonth,
  epochMs,
  formatIso,
  isLeapYear,
  parseIso,
  type CivilTime,
} from './date.js';

export { MinHeap } from './heap.js';
