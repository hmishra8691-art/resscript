/**
 * Vendors and redirects — Deliverable C §9.
 */

import type { VendorId } from '../ids.js';
import type { Disposition } from '../registries.js';

export interface VendorInboundParam {
  /** The query-string parameter name on the entry link. */
  readonly param: string;
  /** The hidden variable it populates, addressed by ref because vendors are authored by hand. */
  readonly variable_ref: string;
  readonly required: boolean;
}

/**
 * Every serious panel vendor signs entry links. Retrofitting signature verification after
 * launch means either accepting unverified traffic or breaking live links, so the fields exist
 * from the first release even though enforcement is a runtime concern.
 */
export interface VendorSecurity {
  readonly hash_param: string;
  readonly algorithm: 'sha256' | 'sha1' | 'md5';
  /** A reference to a secret in the vault. The secret itself is never in the survey model. */
  readonly secret_ref: string;
}

export interface Vendor {
  readonly id: VendorId;
  readonly ref: string;
  readonly name: string;
  readonly inbound_params: readonly VendorInboundParam[];
  readonly entry_url_template?: string | null;
  readonly max_completes?: number | null;
  /** Quota plan refs whose targets this vendor overrides. */
  readonly quota_plan_overrides?: readonly string[];
  readonly security?: VendorSecurity | null;
}

/**
 * A disposition → URL template map. Templates interpolate variables through the same piping
 * engine as question text, with URL-encoding applied automatically and `pii: true` variables
 * blocked unless explicitly allowed: leaking an open-end into a vendor callback URL is a real
 * incident class, not a hypothetical.
 *
 * `ABANDONED` and `TIMED_OUT` are intentionally not required here — they are inferred by a
 * server-side sweeper and there is nobody left to redirect (Deliverable K §2).
 */
export type RedirectMap = {
  readonly [D in Exclude<Disposition, 'IN_PROGRESS' | 'ABANDONED' | 'TIMED_OUT' | 'CUSTOM'>]?: string;
} & {
  /** Named custom terminations, keyed by `TerminationNode.custom_key`. */
  readonly CUSTOM?: { readonly [key: string]: string };
};

export interface Redirects {
  readonly default: RedirectMap;
  readonly by_vendor?: { readonly [vendorRef: string]: RedirectMap };
  readonly by_language?: { readonly [languageCode: string]: RedirectMap };
}
