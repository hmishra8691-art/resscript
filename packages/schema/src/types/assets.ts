/**
 * Assets — Deliverable C §11.
 */

import type { AssetId } from '../ids.js';

export const SCRIPT_SCOPES = ['survey', 'page', 'question'] as const;
export type ScriptScope = (typeof SCRIPT_SCOPES)[number];

export const SCRIPT_HOOKS = [
  'onSurveyStart',
  'onPageLoad',
  'onAnswer',
  'onValidate',
  'onPageSubmit',
  'onSurveyEnd',
] as const;
export type ScriptHook = (typeof SCRIPT_HOOKS)[number];

/**
 * `runs_on` is required, never inferred. A client script and a server script have completely
 * different security models (ADR-005) — one is sandboxed in the respondent's browser and
 * cannot be trusted, the other executes with server privileges — and mixing them up is a
 * vulnerability, not a mistake. So the author declares intent and the compiler enforces the
 * matching restrictions.
 */
export const SCRIPT_TARGETS = ['client', 'server'] as const;
export type ScriptTarget = (typeof SCRIPT_TARGETS)[number];

export interface ScriptAsset {
  readonly id: AssetId;
  readonly ref: string;
  readonly scope: ScriptScope;
  readonly hooks: readonly ScriptHook[];
  readonly source: string;
  /** Integrity hash. The artifact manifest carries it so a tampered script fails CSP. */
  readonly sha256?: string | null;
  readonly runs_on: ScriptTarget;
}

export interface HtmlTemplateAsset {
  readonly id: AssetId;
  readonly ref: string;
  readonly source: string;
  readonly sha256?: string | null;
}

export interface CssAsset {
  readonly id: AssetId;
  readonly ref: string;
  readonly source: string;
  readonly scope: ScriptScope;
}

export interface MediaAsset {
  readonly id: AssetId;
  readonly ref?: string | null;
  readonly storage_key: string;
  readonly mime: string;
  readonly bytes?: number | null;
  readonly sha256?: string | null;
}

export interface Assets {
  readonly scripts?: readonly ScriptAsset[];
  readonly html_templates?: readonly HtmlTemplateAsset[];
  readonly css?: readonly CssAsset[];
  readonly media?: readonly MediaAsset[];
}
