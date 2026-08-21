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
  renderPage,
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
  applyMasking,
  type Mask,
  type MaskContext,
  type MaskFallback,
  type MaskItem,
  type MaskMode,
  type MaskResult,
  type MaskSource,
  type MaskTarget,
} from './masking.js';

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
  pagesForTarget,
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
