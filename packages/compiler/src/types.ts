/**
 * The compiler's contract: what goes in, what comes out, and the two intermediate structures
 * that every static analysis shares.
 *
 * These declarations are deliberately in their own module with no logic in it, because six
 * other modules in this package code against them and a cycle through an implementation file
 * would be caught by `no-circular` at the worst possible moment.
 */

import type {
  CompiledArtifact,
  FlowNode,
  Iso8601,
  PageId,
  Survey,
  VariableId,
} from '@resscript/schema';
import type { PluginRegistry } from '@resscript/question-kit';

import type { CompileDiagnostic } from './diagnostics.js';

/**
 * The artifact schema version this build emits. Distinct from the authoring `schema_version`.
 *
 * Bumped to 2 by the addition of `ArtifactGraph.order_groups` (roadmap P2-03): the canonical item
 * list behind each `RandomizationSpec.group_ref`, without which shared order across a battery
 * degraded to an independent shuffle per question. Append-only and optional on the wire, so a
 * version-1 artifact still loads — it simply has no groups to share, which is the behaviour it
 * already had.
 */
export const ARTIFACT_SCHEMA_VERSION = 2;

/**
 * Everything the compile needs, passed in rather than reached for.
 *
 * `compiledAt` is a parameter and not a `Date.now()` because a compiler that reads a clock
 * cannot be tested for determinism, and determinism is this milestone's headline property. For
 * the same reason there is no `random` here at all: nothing in the compile is stochastic.
 */
export interface CompileInput {
  readonly survey: Survey;
  readonly surveyVersionId: string;
  readonly compiledAt: Iso8601;
  /** Defaults to the first-party registry. Injectable so a fixture can omit plugins entirely. */
  readonly plugins?: PluginRegistry;
  /**
   * The org's plan features.
   *
   * `undefined` and an empty `Set` are different, and the difference is load-bearing:
   * `undefined` means "there is no plan to check against" (a fixture, a unit test, a
   * self-hosted deploy with no billing) and skips the check entirely, while an empty `Set`
   * means "this plan grants nothing" and fails every requirement. Collapsing the two would
   * make every fixture survey publishable only by accident, or every unentitled survey
   * publishable on purpose.
   */
  readonly entitlements?: ReadonlySet<string> | undefined;
  /**
   * Theme token layers, nearest-last, for `compileTheme` — typically `[parentTheme, theme]`.
   *
   * Tokens rather than CSS, and that is the P2-12 decision. `themeCss` below stays for a caller
   * that already has bytes, but the compiler now DEFAULTS to compiling a theme rather than emitting
   * nothing: before this, `themeCss` was a parameter nothing supplied, so no artifact ever carried
   * a stylesheet and `.rs-target` — the class question-kit asserts on 6,601 times, whose whole
   * purpose is the WCAG touch-target floor — was defined nowhere at all.
   */
  readonly themeTokens?: readonly { readonly [k: string]: string }[];
  /**
   * Pre-compiled theme CSS, overriding `themeTokens`.
   *
   * Kept for a caller holding bytes it did not generate from tokens. NOT the default path any more:
   * an optional string that nothing set is how the theme went missing for two milestones, and a
   * default of "no stylesheet at all" is never the safe one for an accessibility guarantee.
   */
  readonly themeCss?: string | null;
  /**
   * `acknowledgementKey()` values the author has already accepted. Warnings whose key appears
   * here are still reported — the publish record must show what was accepted — but they no
   * longer need a fresh acknowledgement.
   */
  readonly acknowledgedWarnings?: readonly string[];
}

/** One file of the artifact tree, exactly as it is stored. */
export interface ArtifactFile {
  /** Storage-relative path: `manifest.json`, `graph.json`, `pages/pg_….json`, `theme.css`. */
  readonly path: string;
  /** The stored bytes, as text. JSON files are canonical (`stableStringify`). */
  readonly bytes: string;
  readonly sha256: string;
}

/**
 * A compiled artifact, addressed by the hash of its own content.
 *
 * THE ADDRESSING RULE, stated once here because it is subtle and load-bearing. Two fields of
 * `ArtifactManifest` cannot participate in the hash without making it self-referential or
 * time-dependent: `artifact_hash` (which *is* the hash) and `compiled_at` (which differs
 * between two compiles of an unchanged survey). So:
 *
 *  - `files` holds the bytes as stored, with those two fields emitted as the empty string.
 *  - `hash` is sha256 over `files` sorted by path — so the object key genuinely is the sha256
 *    of the object's own content, with no field excluded from what is stored.
 *  - `artifact` is the same artifact in memory with both fields filled, for callers and tests.
 *
 * The consequence is the one the roadmap asks for: republishing an unchanged survey a week
 * later produces the identical hash and writes no new object, and the runtime recovers
 * `artifact_hash` from the storage path it fetched and `compiled_at` from the version row.
 */
export interface ArtifactBundle {
  readonly hash: string;
  readonly files: readonly ArtifactFile[];
  /** Total stored size, for `survey_versions.artifact_bytes`. */
  readonly bytes: number;
  readonly artifact: CompiledArtifact;
}

export type CompileResult =
  | {
      readonly ok: true;
      readonly bundle: ArtifactBundle;
      readonly diagnostics: readonly CompileDiagnostic[];
      /** Warnings still needing acknowledgement before publish may proceed. */
      readonly unacknowledged: readonly CompileDiagnostic[];
    }
  | {
      readonly ok: false;
      readonly bundle?: undefined;
      readonly diagnostics: readonly CompileDiagnostic[];
      readonly unacknowledged?: undefined;
    };

/**
 * The flow graph, resolved once and shared by every analysis that needs to ask "can this
 * happen before that".
 *
 * WHY DOMINANCE AND NOT DOCUMENT ORDER. D §8.1 is emphatic, and it is right: comparing document
 * positions answers the forward-reference question only for a survey with no branches. With a
 * branch, "Q20 appears after Q12 in the file" and "every path that reaches Q12 has already
 * asked Q20" are different claims, and it is the second one that matters. A rule on Q12 reading
 * Q20 is safe exactly when Q20's write site dominates Q12's read site — that is, when no path
 * from `start` reaches the read without passing the write. Anything weaker either misses real
 * bugs (document order, on a branched survey) or cries wolf on correct surveys (any-order
 * comparison), and a static gate that cries wolf gets switched off.
 */
export interface FlowGraph {
  readonly nodes: ReadonlyMap<string, FlowNode>;
  readonly start: string;
  /** Reverse postorder from `start`. Unreachable nodes are absent. */
  readonly order: readonly string[];
  /** Flow node id → its index in `order`. Absent for unreachable nodes. */
  readonly position: ReadonlyMap<string, number>;
  readonly successors: ReadonlyMap<string, readonly string[]>;
  readonly predecessors: ReadonlyMap<string, readonly string[]>;
  readonly reachable: ReadonlySet<string>;
  /** Immediate dominator per reachable node. `start` maps to itself. */
  readonly idom: ReadonlyMap<string, string>;
  /** Page id → the flow node that lays it out. */
  readonly pageEntry: ReadonlyMap<string, string>;
  /** Every page a respondent can reach, in flow traversal order. */
  readonly pageOrder: readonly PageId[];
  /** Content node id → the flow nodes that lay it out (a block can be laid out twice). */
  readonly contentSites: ReadonlyMap<string, readonly string[]>;
  readonly diagnostics: readonly CompileDiagnostic[];
}

/**
 * Where each variable is written and read, in flow-node terms.
 *
 * A variable has more than one kind of write site and conflating them is how the analysis goes
 * wrong: a `response` variable is written where its question is asked, a `hidden` variable at
 * entry (so it dominates everything, and its site is the start node), a `derived` variable
 * wherever its inputs are complete, and a `set_variable` rule writes at the flow node its rule
 * is scoped to. Only the first two are positions in the graph; the last two are derived from
 * them, which is why this index is built once and shared rather than recomputed per analysis.
 */
export interface VariableSites {
  /** Variable id → flow nodes at which a value can first exist. */
  readonly writes: ReadonlyMap<VariableId, readonly string[]>;
  /** Variable id → flow nodes at which it is read. */
  readonly reads: ReadonlyMap<VariableId, readonly string[]>;
  /** Variable ids that are written before any page is rendered (entry params, system). */
  readonly preEntry: ReadonlySet<VariableId>;
}

/** `true` when every path from `start` to `b` passes through `a`. Reflexive. */
export function dominates(graph: FlowGraph, a: string, b: string): boolean {
  if (a === b) return true;
  if (!graph.reachable.has(b)) return false;
  let cursor = graph.idom.get(b);
  while (cursor !== undefined && cursor !== graph.start) {
    if (cursor === a) return true;
    const next = graph.idom.get(cursor);
    if (next === cursor) break;
    cursor = next;
  }
  return a === graph.start && graph.reachable.has(b);
}
