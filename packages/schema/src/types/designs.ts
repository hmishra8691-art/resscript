/**
 * Experimental designs — Deliverable C §10.
 */

import type { AssetId, DesignId, VariableId } from '../ids.js';
import type { Iso8601, JsonObject } from './common.js';

export const DESIGN_METHODS = ['maxdiff', 'cbc', 'conjoint_full_profile'] as const;
export type DesignMethod = (typeof DESIGN_METHODS)[number];

export interface DesignItem {
  readonly ref: string;
  readonly label_key: string;
  readonly meta?: JsonObject;
}

export interface DesignBalance {
  readonly frequency: boolean;
  readonly orthogonality: 'none' | 'near' | 'exact';
  readonly positional: boolean;
}

export interface DesignSpec {
  readonly items: readonly DesignItem[];
  readonly tasks_per_respondent: number;
  readonly items_per_task: number;
  /** Design blocks; a respondent is assigned one block, not a freshly generated design. */
  readonly blocks: number;
  readonly seed: number;
  readonly balance: DesignBalance;
}

/**
 * Diagnostics are stored with the design, not recomputed. A researcher has to defend the
 * design's balance to a client, and regenerating it later would produce a different matrix —
 * so the numbers that were reviewed must be the numbers that were shipped.
 */
export interface DesignDiagnostics {
  readonly item_frequency_sd?: number;
  readonly pair_cooccurrence_min?: number;
  readonly d_efficiency?: number;
  readonly [metric: string]: number | undefined;
}

/**
 * Design generation is offline and stored, not computed per respondent: the artifact carries
 * the matrix and the runtime only assigns a block. That keeps the runtime pure and fast, and
 * makes the design reviewable and exportable before field. (ACBC breaks this assumption and
 * is explicitly deferred as an architectural addition, not a feature.)
 */
export interface DesignGenerated {
  readonly generated_at: Iso8601;
  readonly algorithm: string;
  readonly diagnostics: DesignDiagnostics;
  readonly matrix_asset_id: AssetId;
}

export interface Design {
  readonly id: DesignId;
  readonly ref: string;
  readonly method: DesignMethod;
  readonly spec: DesignSpec;
  readonly generated?: DesignGenerated | null;
  /**
   * Design variables (`kind: "design"`). The design engine declares these *mandatorily*:
   * without a record of which block and task a respondent received, MaxDiff/conjoint data is
   * unanalysable, and that is discovered by the client's statistician.
   */
  readonly emits?: readonly VariableId[];
}
