/**
 * Page state machine integration.
 *
 * The pure state machine lives in packages/runtime-core. This module provides
 * the integration point and Cmd dispatch logic for apps/runtime.
 *
 * Per E §2.3, the machine is a pure reducer:
 *   step(state, input, artifact) -> { next: SessionState; cmds: Cmd[] }
 *
 * No I/O happens in the machine itself. Commands are dispatched by the HTTP
 * handlers to effect side effects (artifact loads, quota reserves, redirects, etc).
 */

import type { CompiledArtifact } from '@resscript/schema';
import type { SessionState } from '../session/types.js';

export type Cmd =
  | { c: 'render'; page_id: string }
  | { c: 'reserve_quota'; plan_ids: string[]; cells: string[] }
  | { c: 'commit_quota' }
  | { c: 'release_quota' }
  | { c: 'run_script'; asset_ref: string; hook: string }
  | { c: 'call_api'; node_id: string }
  | { c: 'finalize'; disposition: string; custom_key?: string }
  | { c: 'emit_event'; event: unknown };

export interface PureCtx {
  // Injected context for the machine to query without side effects
  now_ms: number;
  random: (salt: string) => number;
}

/**
 * Step the state machine forward.
 *
 * This is a pure function: identical inputs always produce identical outputs.
 * Call this from P1-10's submit handler to advance state and get the Cmd list.
 *
 * TODO: P1-09 will implement this in packages/runtime-core.
 */
export function step(
  state: SessionState,
  input: { i: 'enter' } | { i: 'submitted'; page_id: string } | { i: 'back'; page_id: string },
  artifact: CompiledArtifact,
  ctx: PureCtx,
): { next: SessionState; cmds: Cmd[] } {
  throw new Error('P1-09: state machine not implemented');
}
