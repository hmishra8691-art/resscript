/**
 * @resscript/runtime-core — pure functions for P1-09 (Deliverable E).
 *
 * Seeded PRNG (ADR-006), page state machine, piping, validation execution.
 * All functions are pure: identical inputs → identical outputs, replayable
 * across Node, browser, and QuickJS.
 */

export { deriveKey, permute, sfc32Counter, testDistributionUniformity, testPermuteDeterminism } from './prng.js';

export {
  randomize,
  testRandomizationDeterminism,
  testSharedGroupOrder,
  testAnchors,
  type Item,
  type Group,
  type RandomizationMode,
  type RandomizationConfig,
} from './randomize.js';

export {
  applyMasking,
  testIncludeMasking,
  testExcludeMasking,
  testSelectedInMasking,
  testFallbackWhenEmpty,
  type Mask,
  type MaskMode,
  type MaskSource,
  type FallbackKind,
  type MaskResult,
} from './masking.js';

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
