/**
 * The compiled artifact — Deliverable C §17.
 *
 * **Types only.** The compiler that produces these lives in `packages/compiler` (milestone
 * P1-08). They are declared here because the compiler contract is part of the schema
 * contract: the runtime reads these shapes, the exporter reads the variable manifest, and
 * both must be able to type against them without depending on the compiler.
 *
 * Two guarantees the shapes are designed around:
 *
 * 1. Rendering one page needs `manifest` + `graph` + `logic` + one `page`. The first three are
 *    fetched once per session and cached, so survey size affects the one-time cost and not the
 *    per-page cost. A 2,000-question survey costs the same per page as a 20-question one.
 * 2. The artifact is self-contained: given it and a session's variable state, the next page is
 *    computable with no database read except the session itself.
 */

import type { ContentNodeId, PageId, QuestionId, VariableId } from '../ids.js';
import type { Expr, Iso8601, JsonObject } from './common.js';
import type { FlowNode } from './flow.js';
import type { QuotaConfig } from './quotas.js';
import type { StringBundle } from './i18n.js';
import type { EnumDomainEntry, VariableKind, VariableType } from './variables.js';
import type { Mask } from './masks.js';
import type { ValidationRule } from './validation.js';
import type { QuestionCell, QuestionItem } from './content.js';

/** One column of the export contract, versioned with the artifact so it cannot shift. */
export interface VariableManifestEntry {
  readonly id: VariableId;
  readonly name: string;
  readonly kind: VariableKind;
  readonly type: VariableType;
  readonly export_column: string;
  readonly export_include: boolean;
  readonly enum_domain?: readonly EnumDomainEntry[] | null;
  readonly pii: boolean;
  readonly persist: boolean;
}

export interface ArtifactManifest {
  /** The artifact's own schema version, distinct from the authoring `schema_version`. */
  readonly artifact_schema_version: number;
  readonly survey_id: string;
  readonly survey_version_id: string;
  readonly artifact_hash: string;
  readonly compiled_at: Iso8601;
  readonly base_language: string;
  readonly languages: readonly string[];
  /** `ref → sha256`, so a tampered script fails its integrity check rather than executing. */
  readonly script_hashes: { readonly [ref: string]: string };
  readonly csp_directives: { readonly [directive: string]: readonly string[] };
  readonly variable_manifest: readonly VariableManifestEntry[];
  readonly entitlements: readonly string[];
}

/** A flattened page graph with static edges, so the runtime never scans the whole survey. */
export interface ArtifactGraph {
  readonly page_order: readonly PageId[];
  readonly nodes: readonly FlowNode[];
  /** `page_id → flow node id` entry points, precomputed. */
  readonly page_entry: { readonly [pageId: string]: string };
}

export interface CompiledQuestion {
  readonly id: QuestionId;
  readonly ref: string;
  readonly question_type: string;
  readonly required: boolean;
  /** Labels are already resolved to the respondent's language — no key lookup at render. */
  readonly label?: string | null;
  readonly instruction?: string | null;
  readonly config: JsonObject;
  readonly options?: readonly CompiledItem[];
  readonly rows?: readonly CompiledItem[];
  readonly columns?: readonly CompiledItem[];
  readonly cells?: readonly QuestionCell[];
  readonly validation: readonly ValidationRule[];
  readonly masks: readonly Mask[];
  readonly emits: readonly VariableId[];
}

/** A compiled item: the authoring item with its label resolved and position densified. */
export type CompiledItem = Omit<QuestionItem, 'label'> & { readonly label?: string | null };

export interface CompiledPage {
  readonly id: PageId;
  readonly ref: string;
  readonly block_path: readonly ContentNodeId[];
  readonly questions: readonly CompiledQuestion[];
  /** Rules whose trigger and target are both on this page, inlined to avoid a fetch. */
  readonly inline_rules: readonly CompiledRule[];
  readonly settings: JsonObject;
}

export interface CompiledRule {
  readonly id: string;
  readonly kind: string;
  readonly condition: Expr;
  readonly effect: JsonObject;
  readonly target_id?: string | null;
}

/**
 * Cross-page rules indexed by trigger variable. Indexing is what keeps this file small
 * relative to rule count: a page change dirties a handful of variables, and only their rules
 * are considered.
 */
export interface ArtifactLogic {
  readonly by_trigger_variable: { readonly [variableId: string]: readonly CompiledRule[] };
  readonly rules: readonly CompiledRule[];
}

export interface CompiledArtifact {
  readonly manifest: ArtifactManifest;
  readonly graph: ArtifactGraph;
  readonly pages: { readonly [pageId: string]: CompiledPage };
  readonly logic: ArtifactLogic;
  readonly quotas?: QuotaConfig | null;
  readonly designs?: { readonly [designRef: string]: JsonObject };
  readonly i18n: { readonly [languageCode: string]: StringBundle };
  readonly theme_css?: string | null;
  readonly scripts?: { readonly [ref: string]: string };
}
