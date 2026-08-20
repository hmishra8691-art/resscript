/**
 * The top-level survey — Deliverable C §2.
 *
 * Cross-cutting concerns are top-level registries rather than nested inside content: logic
 * rules, quotas, vendors, designs and assets are all addressed by index elsewhere in the
 * product, and nesting them would make every such lookup a tree walk.
 */

import type { SurveyId } from '../ids.js';
import type { Assets } from './assets.js';
import type { ContentNode } from './content.js';
import type { Design } from './designs.js';
import type { Flow } from './flow.js';
import type { Languages } from './i18n.js';
import type { LogicRule } from './logic.js';
import type { QuotaConfig } from './quotas.js';
import type { SurveySettings } from './settings.js';
import type { Variable } from './variables.js';
import type { Redirects, Vendor } from './vendors.js';

export interface SurveyMeta {
  readonly id: SurveyId;
  /**
   * The human handle. Unique within a survey *version* — the version is the unit of
   * immutability, so uniqueness is enforced per version by a partial unique index.
   * Renameable at any time while draft, structurally un-renameable once published (ADR-002).
   */
  readonly ref: string;
  readonly name: string;
  readonly description?: string | null;
  readonly tags?: readonly string[];
}

export interface Survey {
  readonly meta: SurveyMeta;
  /**
   * The integer that makes stored surveys migratable. Migrations are forward-only and pure;
   * a survey is migrated in memory on load and written back at the next save (C §18).
   * Published *artifacts* are never migrated — that is what lets a survey published 14 months
   * ago keep collecting data unchanged, which is non-negotiable for trackers.
   */
  readonly schema_version: number;
  readonly settings: SurveySettings;
  readonly languages: Languages;
  /** A theme is a separate reusable entity; the survey only points at one. */
  readonly theme_ref?: string | null;
  readonly variables: readonly Variable[];
  /** The ordered tree. Roots are blocks. */
  readonly content: readonly ContentNode[];
  readonly flow: Flow;
  readonly logic_rules: readonly LogicRule[];
  readonly quotas?: QuotaConfig | null;
  readonly vendors?: readonly Vendor[];
  readonly redirects?: Redirects | null;
  readonly designs?: readonly Design[];
  readonly assets?: Assets;
  /**
   * Features this survey depends on, e.g. `conjoint`. Checked against the org's plan so that
   * "survey uses conjoint, plan does not include it" blocks publish rather than failing in
   * field.
   */
  readonly entitlement_reqs?: readonly string[];
}
