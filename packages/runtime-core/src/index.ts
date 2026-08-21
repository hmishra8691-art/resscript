/**
 * @resscript/runtime-core — pure functions for P1-09 (Deliverable E).
 *
 * Seeded PRNG (ADR-006), page state machine, piping, validation execution.
 * All functions are pure: identical inputs → identical outputs, replayable
 * across Node, browser, and QuickJS.
 */

export {
  deriveKey,
  hashString,
  permute,
  randomAt,
  sfc32Counter,
  testCounterVariesOutput,
  testDistributionUniformity,
  testPermutationCoverage,
  testPermuteDeterminism,
} from './prng.js';

export {
  rehydrate,
  ruleOf,
  schemaOf,
  cellsWrittenBy,
  toCompiledLogic,
  type MaskItemsFn,
  type RehydratedLogic,
} from './artifact-logic.js';

export {
  runValidations,
  type ValidateInput,
  type ValidateQuestion,
  type ValidationFailure as PageValidationFailure,
  type ValidationRuleLike,
} from './validate.js';

export {
  filterSubmit,
  type FilterInput,
  type FilterResult,
  type ManifestVariableLike,
  type RejectReason,
  type Rejection,
} from './filter-submit.js';

export {
  evaluatePage,
  type EvalConditionFn,
  type EvaluateFn,
  type EvaluatePageInput,
  type EvaluatedPage,
  type PageVerdict,
  type VarStateFn,
} from './evaluate-page.js';

export {
  renderPage,
  computeOrders,
  orderScope,
  type Axis,
  type MaskFallback,
  type OptionState,
  type RenderCtx,
  type RenderItem,
  type RenderPage,
  type RenderQuestion,
  type RenderedAxis,
  type RenderedPage,
  type RenderedQuestion,
} from './render.js';

export {
  randomize,
  applyAnchors,
  saltFor,
  type AnchorSpec,
  type OrderGroup,
  type RandomizationMode,
  type RandomizationSpec,
  type RandomizationSubBlock,
  type RandomizeItem,
  type RandomizeResult,
} from './randomize.js';

export {
  invalidateForward,
  invalidationCost,
  dependentVariables,
  valueEquals,
  type AnswersInvalidatedEvent,
  type InvalidateInput,
  type InvalidateProvenance,
  type InvalidateResult,
  type InvalidationArtifact,
  type InvalidationCell,
  type InvalidationVisit,
  type RecomputeProbe,
} from './invalidate.js';

export {
  step,
  pagesForNode,
  type Cmd,
  type Disposition,
  type FlowNodeLike,
  type FlowBranchLike,
  type Input,
  type MachineArtifact,
  type MachineSession,
  type MachineStateTag,
  type MachineVisit,
  type PureCtx,
} from './machine.js';

export {
  pipe,
  escape,
  testBasicPiping,
  testVariableForms,
  testFilters,
  testNullHandling,
  testEscaping,
  type EscapeContext,
} from './piping.js';
