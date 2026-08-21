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
import type { CompiledArtifact } from '@resscript/schema';
import type { SessionState } from '../session/types.js';

export type { Cmd, Input, PureCtx } from '@resscript/runtime-core';

/**
 * Step the state machine forward.
 *
 * Pure: identical inputs always produce identical outputs. The returned `Cmd[]` is the only
 * instruction to perform side effects; the machine never awaits.
 *
 * `CompiledArtifact` satisfies `MachineArtifact` structurally — branded ids are `string &
 * {…}`, so the narrow shape the machine reads accepts a real artifact without a cast at the
 * value level. The one cast below is on the *type* only, because `readonly` variance on the
 * nested `FlowNode` union is invariant under TypeScript's structural rules for unions.
 */
export function step(
  state: SessionState,
  input: Input,
  artifact: CompiledArtifact,
  ctx: PureCtx,
): { next: SessionState; cmds: Cmd[] } {
  return pureStep(state, input, artifact as unknown as MachineArtifact, ctx);
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
}): PureCtx {
  return opts.isPageVisible
    ? {
        now_ms: opts.now_ms,
        random: opts.random,
        evalCondition: opts.evalCondition,
        isPageVisible: opts.isPageVisible,
      }
    : { now_ms: opts.now_ms, random: opts.random, evalCondition: opts.evalCondition };
}
