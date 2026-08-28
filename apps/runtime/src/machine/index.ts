/**
 * Page state machine integration.
 *
 * The machine itself is pure and lives in `packages/runtime-core` (E §2.3). This module binds
 * it to `apps/runtime`'s concrete `SessionState` and `CompiledArtifact`, and owns the
 * `Cmd` interpreter — the only place I/O happens.
 *
 * The split is what makes the machine testable without Redis and replayable from a recorded
 * input list, and it is why `step` is re-exported here rather than reimplemented.
 */

import { step as pureStep } from '@resscript/runtime-core';
import type { Cmd, Input, MachineArtifact, PureCtx } from '@resscript/runtime-core';
import type { SessionState } from '../session/types.js';

export type { Cmd, Input, MachineArtifact, PureCtx } from '@resscript/runtime-core';

/**
 * Step the state machine forward.
 *
 * Pure: identical inputs always produce identical outputs. The returned `Cmd[]` is the only
 * instruction to perform side effects; the machine never awaits.
 *
 * Takes a `MachineArtifact` — the graph alone — rather than a whole `CompiledArtifact`. That is
 * the point of C §17's split: the machine routes without any page object, so the loader can fetch
 * pages lazily and per-page cost stays independent of survey size. An artifact head satisfies
 * this structurally, since branded ids are `string & {…}`.
 */
export function step(
  state: SessionState,
  input: Input,
  artifact: MachineArtifact,
  ctx: PureCtx,
): { next: SessionState; cmds: Cmd[] } {
  return pureStep(state, input, artifact, ctx);
}

/**
 * Build the injected context for one evaluation.
 *
 * `now_ms` is stamped once per request rather than read per call, so every timestamp within a
 * single `step` agrees — a session whose page timings disagree with its event log is not
 * reconcilable after the fact.
 */
export function makeCtx(opts: {
  now_ms: number;
  random: (salt: string) => number;
  evalCondition: (condition: unknown) => boolean | null;
  isPageVisible?: (page_id: string) => boolean;
  /** E §8.5's least-filled allocation, already resolved. See `PureCtx.randomizerAssignment`. */
  randomizerAssignment?: (flow_node_id: string) => readonly string[] | undefined;
}): PureCtx {
  // Built by spreading the optional members conditionally rather than by an if/else per
  // combination: this used to be a two-arm ternary on `isPageVisible` alone, and adding a second
  // optional field would have made it four arms and a third would make it eight.
  // `exactOptionalPropertyTypes` is why an unconditional `isPageVisible: opts.isPageVisible` will
  // not do — `undefined` is not assignable to an optional function.
  return {
    now_ms: opts.now_ms,
    random: opts.random,
    evalCondition: opts.evalCondition,
    ...(opts.isPageVisible ? { isPageVisible: opts.isPageVisible } : {}),
    ...(opts.randomizerAssignment ? { randomizerAssignment: opts.randomizerAssignment } : {}),
  };
}
