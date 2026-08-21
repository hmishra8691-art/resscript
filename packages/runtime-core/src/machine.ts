/**
 * Task 51/53: The page state machine as a pure reducer, per Deliverable E §2.
 *
 * `step()` never awaits and never performs I/O. It returns the next state plus a list of
 * `Cmd`s for `apps/runtime` to interpret. Three consequences justify the constraint:
 *
 *   1. The whole machine is unit-testable with a table of fixtures — no Redis, no Postgres.
 *   2. A session is replayable by feeding its recorded inputs back through `step`.
 *   3. The same code runs in a mobile app for offline CAPI (E §15) with a different
 *      `Cmd` interpreter.
 *
 * Everything the machine cannot compute purely is injected through `PureCtx`: the clock,
 * the PRNG, condition evaluation (which lives in `packages/logic`), and page visibility.
 * That is what keeps `packages/runtime-core` free of both a logic dependency and a clock.
 */

/* ------------------------------------------------------------------ *
 * Structural types
 *
 * These are narrow, structural mirrors of `@resscript/schema`'s shapes rather than imports.
 * `runtime-core` must stay loadable in a browser and in QuickJS, so it declares the subset
 * of the artifact the machine actually reads and lets `CompiledArtifact` satisfy it
 * structurally. Branded ids (`Id<'fn'>` = `string & {…}`) are assignable to `string`, so a
 * real artifact type-checks against these without a cast.
 * ------------------------------------------------------------------ */

export type Disposition =
  | 'COMPLETE'
  | 'SCREENOUT'
  | 'QUOTA_FULL'
  | 'QUALITY'
  | 'DUPLICATE'
  | 'FRAUD'
  | 'TERMINATE'
  | 'CUSTOM'
  | 'ABANDONED'
  | 'TIMED_OUT';

export interface FlowBranchLike {
  /** `null` is the else arm; it must be last. */
  readonly condition: unknown | null;
  readonly next: string | null;
}

export type FlowNodeLike =
  | { readonly id: string; readonly type: 'start'; readonly next: string | null }
  | {
      readonly id: string;
      readonly type: 'sequence';
      readonly target_id: string;
      readonly next: string | null;
    }
  | { readonly id: string; readonly type: 'branch'; readonly branches: readonly FlowBranchLike[] }
  | {
      readonly id: string;
      readonly type: 'quota_gate';
      readonly quota_ref: string;
      readonly on_pass: string | null;
      readonly on_full: string | null;
    }
  | {
      readonly id: string;
      readonly type: 'randomizer';
      readonly targets: readonly string[];
      readonly mode: string;
      readonly n?: number | null;
      readonly even_distribution?: boolean;
      readonly seed_salt?: string | null;
      readonly next: string | null;
    }
  | {
      readonly id: string;
      readonly type: 'loop';
      readonly target_id: string;
      readonly over_variable_id?: string | null;
      readonly next: string | null;
    }
  | {
      readonly id: string;
      readonly type: 'termination';
      readonly disposition: string;
      readonly custom_key?: string | null;
    }
  | {
      readonly id: string;
      readonly type: 'api_call';
      readonly on_success: string | null;
      readonly on_error: string | null;
    }
  | { readonly id: string; readonly type: 'end'; readonly disposition: string };

/**
 * What the machine reads from the artifact: the graph, and nothing else.
 *
 * Deliberately NOT `pages`. C §17's contract is that rendering one page costs manifest + graph +
 * logic + *one* page, so a 2,000-question survey renders its 40th page with the same number of
 * byte-reads as a 20-question one. A machine that needed every page's `block_path` to route would
 * force the loader to fetch all of them and quietly break that.
 *
 * `page_entry` is the compiler's precomputed `page_id -> flow node id` index and is exactly the
 * routing information required, so the machine never scans content.
 */
export interface MachineArtifact {
  readonly graph: {
    readonly page_order: readonly string[];
    readonly nodes: readonly FlowNodeLike[];
    /** `page_id -> flow node id`. Precomputed by the compiler (C §17). */
    readonly page_entry: { readonly [pageId: string]: string };
  };
}

/* ------------------------------------------------------------------ *
 * Commands
 * ------------------------------------------------------------------ */

export type Cmd =
  | { c: 'render'; page_id: string }
  | { c: 'reserve_quota'; quota_ref: string; node_id: string }
  | { c: 'commit_quota' }
  | { c: 'release_quota' }
  | { c: 'call_api'; node_id: string }
  | { c: 'finalize'; disposition: Disposition; custom_key?: string }
  | { c: 'emit_event'; event: { kind: string; [k: string]: unknown } };

/* ------------------------------------------------------------------ *
 * State the machine reads and writes
 * ------------------------------------------------------------------ */

export type MachineStateTag =
  | { state: 'ENTRY' }
  | { state: 'INVALID' }
  | { state: 'CREATED' }
  | { state: 'SCREENING' }
  | { state: 'QUOTA_GATE' }
  | { state: 'PAGE_LOOP'; current_page_id: string }
  | { state: 'TERMINATING'; disposition: string; custom_key?: string }
  | { state: 'FLOW_END' }
  | { state: 'COMPLETING' }
  | { state: 'FINALIZED'; disposition: string };

export interface MachineVisit {
  readonly page_id: string;
  readonly entered_at: number;
  readonly submitted_at: number | null;
  readonly wrote: readonly string[];
  readonly shown: readonly string[];
  readonly attempt: number;
}

/**
 * The subset of `SessionState` (E §3.1) the machine touches. `apps/runtime`'s full
 * `SessionState` satisfies this structurally, and `step` is generic over it, so callers get
 * their own concrete type back rather than a widened one.
 */
export interface MachineSession {
  machine_state: MachineStateTag;
  current_page_id: string | null;
  flow_cursor: { node_id: string; iteration_stack: readonly unknown[] };
  history: readonly MachineVisit[];
  disposition: string | null;
  custom_key: string | null;
  last_activity_at: number;
  server_time_ms: number;
  revision: number;
}

export type Input =
  | { i: 'enter' }
  /** The respondent submitted `page_id`; validation already passed (E §2.1: validate < commit). */
  | { i: 'submitted'; page_id: string }
  /** Back navigation. The target is derived from history, not supplied by the client. */
  | { i: 'back' }
  /** Resolution of an outstanding `reserve_quota` command. */
  | { i: 'quota_result'; passed: boolean }
  /** Entry-time dedup/fraud verdict, or an authored `TERMINATE` rule firing. */
  | { i: 'terminate'; disposition: Disposition; custom_key?: string };

export interface PureCtx {
  /** Injected clock. The machine never reads `Date.now()` — that would break replay. */
  now_ms: number;
  /** Seeded PRNG (ADR-006). `salt` scopes the draw; see `prng.deriveKey`. */
  random: (salt: string) => number;
  /**
   * Evaluate a branch condition. Returns `null` for UNKNOWN, which takes the else arm —
   * matching the compiler's `CMP-0700` treatment of an unhandled unknown at the site.
   */
  evalCondition: (condition: unknown) => boolean | null;
  /** Page-level visibility after rule evaluation. Defaults to visible when absent. */
  isPageVisible?: (page_id: string) => boolean;
}

/* ------------------------------------------------------------------ *
 * Graph helpers
 * ------------------------------------------------------------------ */

function nodeById(artifact: MachineArtifact, id: string): FlowNodeLike | undefined {
  return artifact.graph.nodes.find(n => n.id === id);
}

/**
 * The pages a flow node covers, in `page_order`.
 *
 * Read off `page_entry`, which the compiler populates by flattening the content tree at publish
 * time. Two reasons this beats resolving `sequence.target_id` against each page's `block_path`:
 * nested blocks are already resolved, and the machine does not need a single page object — which
 * is what keeps per-page cost independent of survey size (C §17).
 */
export function pagesForNode(artifact: MachineArtifact, node_id: string): string[] {
  return artifact.graph.page_order.filter(pageId => artifact.graph.page_entry[pageId] === node_id);
}

function isVisible(ctx: PureCtx, page_id: string): boolean {
  return ctx.isPageVisible ? ctx.isPageVisible(page_id) : true;
}

/**
 * The next visible page owned by `node_id`, strictly after `after`, or the first if `after` is
 * null. Returns null when the sequence is exhausted — the caller then follows `node.next`.
 *
 * Invisible pages are skipped here rather than filtered upstream so that a page made visible
 * by an answer on an earlier page of the same block is picked up on this pass.
 */
function nextPageInNode(
  artifact: MachineArtifact,
  ctx: PureCtx,
  node_id: string,
  after: string | null,
): string | null {
  const pages = pagesForNode(artifact, node_id);
  const start = after === null ? 0 : pages.indexOf(after) + 1;
  if (after !== null && start === 0) {
    // `after` is not in this sequence — treat it as "start from the beginning".
    for (const p of pages) if (isVisible(ctx, p)) return p;
    return null;
  }
  for (let i = start; i < pages.length; i++) {
    const p = pages[i]!;
    if (isVisible(ctx, p)) return p;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * The reducer
 * ------------------------------------------------------------------ */

/** How many nodes the traversal may cross before it is treated as a cycle. */
const MAX_TRAVERSAL_STEPS = 10_000;

/**
 * Walk the flow graph from `cursor` until it reaches something that stops it: a page to
 * render, a quota gate, an api_call, a termination, or the end.
 *
 * `fromPage` is the page just left, so a `sequence` node knows where to resume. It is null
 * when entering a node for the first time.
 */
function traverse<S extends MachineSession>(
  state: S,
  artifact: MachineArtifact,
  ctx: PureCtx,
  startNodeId: string,
  fromPage: string | null,
): { next: S; cmds: Cmd[] } {
  const cmds: Cmd[] = [];
  let cursor: string | null = startNodeId;
  let resumeAfter = fromPage;
  let steps = 0;

  while (cursor !== null) {
    if (++steps > MAX_TRAVERSAL_STEPS) {
      // A cyclic graph blocks publish (P1-08's reachability analysis), so reaching this is a
      // compiler escape rather than an authored defect. Terminate rather than spin a request.
      cmds.push({
        c: 'emit_event',
        event: { kind: 'flow.traversal_limit', node_id: cursor, steps },
      });
      return finalizeWith(state, cmds, 'TERMINATE', undefined, cursor);
    }

    const node = nodeById(artifact, cursor);
    if (!node) {
      cmds.push({ c: 'emit_event', event: { kind: 'flow.missing_node', node_id: cursor } });
      return finalizeWith(state, cmds, 'TERMINATE', undefined, cursor);
    }

    switch (node.type) {
      case 'start': {
        cursor = node.next;
        resumeAfter = null;
        break;
      }

      case 'sequence':
      case 'loop': {
        const page = nextPageInNode(artifact, ctx, node.id, resumeAfter);
        if (page !== null) {
          cmds.push({ c: 'render', page_id: page });
          const alreadyVisited = state.history.filter(v => v.page_id === page).length;
          return {
            next: {
              ...state,
              machine_state: { state: 'PAGE_LOOP', current_page_id: page },
              current_page_id: page,
              flow_cursor: { ...state.flow_cursor, node_id: node.id },
              history: [
                ...state.history,
                {
                  page_id: page,
                  entered_at: ctx.now_ms,
                  submitted_at: null,
                  wrote: [],
                  shown: [],
                  attempt: alreadyVisited + 1,
                },
              ],
              last_activity_at: ctx.now_ms,
              server_time_ms: ctx.now_ms,
              revision: state.revision + 1,
            },
            cmds,
          };
        }
        // Sequence exhausted — every page in it was either visited or invisible.
        cursor = node.next;
        resumeAfter = null;
        break;
      }

      case 'branch': {
        let taken: string | null = null;
        let matched = false;
        for (const arm of node.branches) {
          if (arm.condition === null) {
            // The else arm. Also where UNKNOWN lands.
            taken = arm.next;
            matched = true;
            break;
          }
          const verdict = ctx.evalCondition(arm.condition);
          if (verdict === true) {
            taken = arm.next;
            matched = true;
            break;
          }
          // false and null (UNKNOWN) both fall through to the next arm.
        }
        if (!matched) {
          // No arm matched and the author wrote no else. Schema requires one, so this is a
          // malformed artifact; surface it rather than silently completing.
          cmds.push({
            c: 'emit_event',
            event: { kind: 'flow.branch_no_arm', node_id: node.id },
          });
          return finalizeWith(state, cmds, 'TERMINATE', undefined, node.id);
        }
        cursor = taken;
        resumeAfter = null;
        break;
      }

      case 'quota_gate': {
        // The reserve is all-or-none and needs Redis (E §10), so the machine stops here and
        // waits for a `quota_result` input rather than guessing.
        cmds.push({ c: 'reserve_quota', quota_ref: node.quota_ref, node_id: node.id });
        return {
          next: {
            ...state,
            machine_state: { state: 'QUOTA_GATE' },
            flow_cursor: { ...state.flow_cursor, node_id: node.id },
            last_activity_at: ctx.now_ms,
            server_time_ms: ctx.now_ms,
            revision: state.revision + 1,
          },
          cmds,
        };
      }

      case 'randomizer': {
        // Order is derived from the seed, so nothing is stored for the seeded modes. The
        // counter-backed modes (`rotate`, `even_distribution`) persist a `design` variable
        // instead — E §8.5, wired in P1-10 where the counter infrastructure lives.
        cursor = node.next;
        resumeAfter = null;
        break;
      }

      case 'api_call': {
        cmds.push({ c: 'call_api', node_id: node.id });
        return {
          next: {
            ...state,
            flow_cursor: { ...state.flow_cursor, node_id: node.id },
            last_activity_at: ctx.now_ms,
            server_time_ms: ctx.now_ms,
            revision: state.revision + 1,
          },
          cmds,
        };
      }

      case 'termination': {
        return finalizeWith(
          state,
          cmds,
          node.disposition as Disposition,
          node.custom_key ?? undefined,
          node.id,
        );
      }

      case 'end': {
        // Reaching an `end` node is what makes a session a COMPLETE, and it is the only place
        // a reservation converts to `committed` (E §2.2).
        const disposition = node.disposition as Disposition;
        if (disposition === 'COMPLETE') cmds.push({ c: 'commit_quota' });
        else cmds.push({ c: 'release_quota' });
        cmds.push({ c: 'finalize', disposition });
        return {
          next: {
            ...state,
            machine_state: { state: 'FINALIZED', disposition },
            disposition,
            flow_cursor: { ...state.flow_cursor, node_id: node.id },
            last_activity_at: ctx.now_ms,
            server_time_ms: ctx.now_ms,
            revision: state.revision + 1,
          },
          cmds,
        };
      }
    }
  }

  // A null `next` with no terminal node. The compiler rejects this (every path must reach a
  // termination or an end), so treat it as a malformed artifact rather than a completion.
  cmds.push({ c: 'emit_event', event: { kind: 'flow.dangling_edge' } });
  return finalizeWith(state, cmds, 'TERMINATE', undefined, state.flow_cursor.node_id);
}

/** Shared tail for every non-COMPLETE exit: release the reservation, then finalize. */
function finalizeWith<S extends MachineSession>(
  state: S,
  cmds: Cmd[],
  disposition: Disposition,
  custom_key: string | undefined,
  node_id: string,
): { next: S; cmds: Cmd[] } {
  // `exactOptionalPropertyTypes` is on, so an absent custom_key must be absent, not undefined.
  const finalize: Cmd =
    custom_key === undefined
      ? { c: 'finalize', disposition }
      : { c: 'finalize', disposition, custom_key };
  const out: Cmd[] = [...cmds, { c: 'release_quota' }, finalize];
  return {
    next: {
      ...state,
      machine_state: { state: 'FINALIZED', disposition },
      disposition,
      custom_key: custom_key ?? null,
      flow_cursor: { ...state.flow_cursor, node_id },
      revision: state.revision + 1,
    },
    cmds: out,
  };
}

/**
 * Advance the machine one input.
 *
 * Pure: identical `(state, input, artifact, ctx)` always produces identical output. Generic
 * over the session type so `apps/runtime` gets its own `SessionState` back.
 */
export function step<S extends MachineSession>(
  state: S,
  input: Input,
  artifact: MachineArtifact,
  ctx: PureCtx,
): { next: S; cmds: Cmd[] } {
  // A finalized session is immutable. Re-submitting a finished session is a normal event
  // (a double-clicked Next on the last page, a retried request), not an error.
  if (state.machine_state.state === 'FINALIZED') {
    return {
      next: state,
      cmds: [{ c: 'emit_event', event: { kind: 'session.already_finalized' } }],
    };
  }

  switch (input.i) {
    case 'terminate': {
      return finalizeWith(
        state,
        [],
        input.disposition,
        input.custom_key,
        state.flow_cursor.node_id,
      );
    }

    case 'enter': {
      // Entry starts at the graph's `start` node rather than trusting the stored cursor, so a
      // replayed or tampered session cannot enter mid-flow.
      const start = artifact.graph.nodes.find(n => n.type === 'start');
      if (!start) {
        return finalizeWith(
          state,
          [{ c: 'emit_event', event: { kind: 'flow.no_start_node' } }],
          'TERMINATE',
          undefined,
          state.flow_cursor.node_id,
        );
      }
      return traverse(state, artifact, ctx, start.id, null);
    }

    case 'submitted': {
      // Only the page the respondent is actually on may be submitted. A mismatch means a
      // stale tab or a replayed request; re-render rather than advancing state.
      if (state.current_page_id !== input.page_id) {
        return {
          next: state,
          cmds: [
            {
              c: 'emit_event',
              event: {
                kind: 'submit.stale_page',
                submitted: input.page_id,
                current: state.current_page_id,
              },
            },
            ...(state.current_page_id
              ? [{ c: 'render', page_id: state.current_page_id } as Cmd]
              : []),
          ],
        };
      }

      // Stamp the visit before advancing, so page timings survive the transition.
      const history = state.history.map((v, i) =>
        i === state.history.length - 1 && v.page_id === input.page_id && v.submitted_at === null
          ? { ...v, submitted_at: ctx.now_ms }
          : v,
      );
      const stamped: S = {
        ...state,
        history,
        last_activity_at: ctx.now_ms,
        server_time_ms: ctx.now_ms,
      };

      return traverse(stamped, artifact, ctx, state.flow_cursor.node_id, input.page_id);
    }

    case 'back': {
      // The target is the previous *submitted* page in history, never a client-supplied id.
      // Anything else lets a respondent jump to a page whose preconditions never held.
      const submitted = state.history.filter(v => v.submitted_at !== null);
      const target = submitted[submitted.length - 1];
      if (!target || !state.current_page_id) {
        return {
          next: state,
          cmds: [{ c: 'emit_event', event: { kind: 'back.no_target' } }],
        };
      }
      // Truncate history to just before the target's last visit. Invalidate-forward (task 58)
      // clears the variables those dropped pages wrote; the machine only moves the cursor.
      const cut = state.history.lastIndexOf(target);
      return {
        next: {
          ...state,
          machine_state: { state: 'PAGE_LOOP', current_page_id: target.page_id },
          current_page_id: target.page_id,
          history: [
            ...state.history.slice(0, cut),
            { ...target, submitted_at: null, attempt: target.attempt + 1 },
          ],
          last_activity_at: ctx.now_ms,
          server_time_ms: ctx.now_ms,
          revision: state.revision + 1,
        },
        cmds: [{ c: 'render', page_id: target.page_id }],
      };
    }

    case 'quota_result': {
      const node = nodeById(artifact, state.flow_cursor.node_id);
      if (!node || node.type !== 'quota_gate') {
        return {
          next: state,
          cmds: [
            {
              c: 'emit_event',
              event: { kind: 'quota.unexpected_result', node_id: state.flow_cursor.node_id },
            },
          ],
        };
      }
      if (input.passed) {
        const onPass = node.on_pass;
        if (onPass === null) {
          return finalizeWith(state, [], 'TERMINATE', undefined, node.id);
        }
        return traverse(state, artifact, ctx, onPass, null);
      }
      // A full hard cell took no reservation, so there is nothing to release.
      const onFull = node.on_full;
      if (onFull === null) {
        return {
          next: {
            ...state,
            machine_state: { state: 'FINALIZED', disposition: 'QUOTA_FULL' },
            disposition: 'QUOTA_FULL',
            revision: state.revision + 1,
          },
          cmds: [{ c: 'finalize', disposition: 'QUOTA_FULL' }],
        };
      }
      return traverse(state, artifact, ctx, onFull, null);
    }
  }
}
