/**
 * Quotas — Deliverable C §8.
 */

import type { QuotaDimensionId, QuotaPlanId, VariableId } from '../ids.js';
import type { Expr } from './common.js';
import type { Disposition } from '../registries.js';

export const QUOTA_COUNT_AT = ['reservation', 'completion'] as const;
export type QuotaCountAt = (typeof QUOTA_COUNT_AT)[number];

export const QUOTA_STORE_FAILURE_MODES = ['fail_closed', 'fail_open'] as const;
export type QuotaStoreFailureMode = (typeof QUOTA_STORE_FAILURE_MODES)[number];

export const QUOTA_COUNTER_SCOPES = ['survey', 'version'] as const;
export type QuotaCounterScope = (typeof QUOTA_COUNTER_SCOPES)[number];

/**
 * `counter_scope` is required and has **no safe default**.
 *
 * When a live survey is republished mid-field — a label typo fix on day three of a four-week
 * tracker — do the quota counters carry over or reset? `survey` carries them (correct for the
 * typo fix, and the only sane choice for trackers); `version` resets them (correct when the
 * sample plan itself changed). Getting it wrong silently either double-counts a wave or
 * throws away three days of field, and neither failure is visible until the data is analysed.
 * So the compiler requires an explicit value rather than picking one.
 */
export interface QuotaPolicy {
  readonly count_at: QuotaCountAt;
  readonly reservation_ttl_s: number;
  readonly on_store_unavailable: QuotaStoreFailureMode;
  readonly counter_scope: QuotaCounterScope;
}

export interface QuotaBucket {
  readonly ref: string;
  /** The AST that decides whether a respondent falls in this bucket. */
  readonly match: Expr;
}

export interface QuotaDimension {
  readonly id: QuotaDimensionId;
  readonly ref: string;
  /** Quotas are defined over *variables*, not questions — the §1 model again. */
  readonly variable_id: VariableId;
  readonly buckets: readonly QuotaBucket[];
}

/**
 * `interlocked` = full cross-product cells; `marginal` = independent per-dimension targets.
 * They are different mathematical objects, and mixing them up is how a sample plan becomes
 * unfillable. The compiler checks that interlocked cell targets are consistent with any
 * marginal targets on the same dimensions and warns on an over-constrained plan — a plan that
 * cannot be filled should be a publish-time warning, not a discovery on field day four.
 */
export const QUOTA_PLAN_TYPES = ['interlocked', 'marginal'] as const;
export type QuotaPlanType = (typeof QUOTA_PLAN_TYPES)[number];

export const QUOTA_TARGET_MODES = ['count', 'percentage'] as const;
export type QuotaTargetMode = (typeof QUOTA_TARGET_MODES)[number];

/** `hard` closes the cell; `soft` keeps counting and only reports the overshoot. */
export const QUOTA_CELL_MODES = ['hard', 'soft'] as const;
export type QuotaCellMode = (typeof QUOTA_CELL_MODES)[number];

export interface QuotaCell {
  /** Bucket refs, one per dimension in `dimension_ids` order. */
  readonly key: readonly string[];
  readonly target?: number | null;
  readonly target_pct?: number | null;
  readonly mode: QuotaCellMode;
}

export interface QuotaPlan {
  readonly id: QuotaPlanId;
  readonly ref: string;
  readonly type: QuotaPlanType;
  readonly dimension_ids: readonly QuotaDimensionId[];
  readonly target_mode?: QuotaTargetMode;
  readonly cells: readonly QuotaCell[];
  /** Where a respondent goes when their cell is full. */
  readonly overflow?: Disposition | null;
}

export interface VendorQuotaLimit {
  readonly vendor_ref: string;
  readonly max_completes: number;
}

export interface QuotaConfig {
  readonly policy: QuotaPolicy;
  readonly dimensions: readonly QuotaDimension[];
  readonly plans: readonly QuotaPlan[];
  readonly vendor_limits?: readonly VendorQuotaLimit[];
}
