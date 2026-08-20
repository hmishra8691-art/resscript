/**
 * Entitlement gate — a STUB that returns true, on purpose.
 *
 * The seam exists now so that later milestones have somewhere to put the real check. arch §5
 * makes entitlements a single `billing.entitlement(feature_key)` function that the UI, the API
 * (`GET /v1/entitlements/{feature_key}`) and the compiler all call, precisely so a feature is
 * not gated in three places with three answers. The real implementation reads the plan through
 * that endpoint via TanStack Query and caches it per org.
 *
 * F §7's rule is the one this hook must NOT break when it becomes real: a feature the plan
 * lacks is shown as unavailable, never hidden — "you do not have that" is more useful to a
 * user than "it does not exist", and hiding it makes upgrade paths invisible.
 */

'use client';

export interface Entitlement {
  readonly enabled: boolean;
  /** `null` = unlimited. A numeric limit is reported, never silently enforced (arch §5). */
  readonly limit: number | null;
  readonly used: number | null;
  /** True until the real query resolves, so callers can render a skeleton rather than a denial. */
  readonly isLoading: boolean;
}

export function useEntitlement(featureKey: string): Entitlement {
  // Deliberately unconditional in P1-01: no billing tables exist yet (they land with arch §5),
  // and a hook that guessed would gate features on a value nobody set.
  void featureKey;
  return { enabled: true, limit: null, used: null, isLoading: false };
}
