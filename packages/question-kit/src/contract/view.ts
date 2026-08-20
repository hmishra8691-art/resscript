/**
 * The visual half of the contract — Deliverable F §1.2 and §8.
 *
 * ## Why this file is separate from the rest of `contract/`
 *
 * The compiler and the exporter need `declareVariables`, `validate` and the codec. They must
 * never pull React into their process, and the *runtime* respondent bundle must never pull the
 * editor. Both of those are true only if the module graph makes them true, so:
 *
 *  - every React reference in this package is `import type` (erased under
 *    `verbatimModuleSyntax`), so importing these types costs nothing at runtime;
 *  - the actual components live in `.tsx` modules reachable only from the `./react` entry
 *    point, never from `./index`, and `entrypoints.test.ts` walks the import graph to prove it.
 *
 * Getting this wrong is not a style problem: it puts React in the respondent bundle, on the
 * page-load path of every survey, permanently.
 */

import type { ReactNode } from 'react';
import type { JsonValue } from '@resscript/schema';
import type { AuthoredQuestion } from './authored.js';
import type { ResolvedItem } from './items.js';
import type { I18nKey } from './meta.js';
import type { ResolvedQuestion, ValidationIssue } from './validate.js';
import type { CellControl, ComposeScope } from './variables.js';

export type TextDirection = 'ltr' | 'rtl';
export type RenderDevice = 'desktop' | 'tablet' | 'mobile';

/** Aria ids allocated by the page shell, so they are stable across SSR and hydration. */
export interface RenderIds {
  readonly labelId: string;
  readonly instructionId: string;
  readonly errorId: string;
  readonly groupId: string;
}

export interface ChildProps {
  readonly value: unknown;
  onChange(next: unknown): void;
  readonly issues: readonly ValidationIssue[];
  readonly labelledBy: string;
  /** Choice controls drawing their options from the parent's columns (F §3). */
  readonly injectedOptions?: readonly ResolvedItem[];
  /** In a full grid, the single column cell this child instance is responsible for. */
  readonly restrictToOption?: string;
}

export interface RenderContext {
  readonly lang: string;
  readonly dir: TextDirection;
  readonly device: RenderDevice;
  readonly isTest: boolean;
  /**
   * Seeded ordering (ADR-006). The ONLY randomness a renderer may use — `Math.random()` is
   * forbidden outright, because a replayed session must reproduce what the respondent saw.
   *
   * F §1.2 types the parameter as `AuthoredItem`; it is `ResolvedItem` here, because a
   * renderer only ever holds resolved items and handing it authored ones would hand it
   * unevaluated conditions it is not allowed to evaluate.
   */
  order(
    scope: 'options' | 'rows' | 'columns',
    items: readonly ResolvedItem[],
  ): readonly ResolvedItem[];
  /** Piping / interpolation over current variable state, and i18n resolution. */
  pipe(text: I18nKey): string;
  /** Read another variable's current value. Read-only, page-scoped, no writes. */
  read(variableName: string): JsonValue | undefined;
  /** Render a composed child control (mixed matrix cells). */
  renderChild(scope: ComposeScope, control: CellControl, props: ChildProps): ReactNode;
  readonly ids: RenderIds;
  /**
   * Announce to the *page-level* live region. Plugins must not create their own: two
   * `aria-live` nodes on a page means one of them is silently ignored, and which one is a
   * screen-reader implementation detail (F §8).
   */
  announce(message: string, politeness?: 'polite' | 'assertive'): void;
}

export interface RendererProps<Config, Answer> {
  /** Labels resolved for one language, randomization and masks applied. */
  readonly question: ResolvedQuestion<Config>;
  readonly value: Answer | undefined;
  /** Fires client logic re-evaluation (ADR-004). */
  onChange(next: Answer): void;
  readonly issues: readonly ValidationIssue[];
  readonly ctx: RenderContext;
}

/**
 * A respondent-facing renderer. `ssr` is on the *component*, not in `meta`, so the flag cannot
 * be set by a plugin that never wrote a server-safe render: the value has to be attached to
 * the function the harness actually calls.
 */
export interface RendererComponent<Config, Answer> {
  (props: RendererProps<Config, Answer>): ReactNode;
  readonly ssr: true;
}

/**
 * Attach the SSR flag. A helper rather than a manual `Object.assign` at each plugin because
 * `ssr` is `readonly true` — which is what stops a plugin from flipping it off later — and a
 * readonly property cannot be assigned after construction.
 */
export function defineRenderer<Config, Answer>(
  render: (props: RendererProps<Config, Answer>) => ReactNode,
): RendererComponent<Config, Answer> {
  return Object.assign(render, { ssr: true } as const);
}

/* -------------------------------------------------------------------------- */
/* Editor                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A JSON Patch operation (RFC 6902), restricted to the three verbs the editor bridge allows.
 *
 * The editor emits patches and never a whole question, for the reason F §6 gives: studio owns
 * the authoring model, and a component that returns a full object can silently drop or rewrite
 * a field it does not understand — `required`, `flags.pii`, another plugin's config left over
 * from a type change. A patch is checkable against a path allowlist; a replacement object is
 * not.
 */
export type JsonPatchOp =
  | { readonly op: 'add'; readonly path: string; readonly value: JsonValue }
  | { readonly op: 'replace'; readonly path: string; readonly value: JsonValue }
  | { readonly op: 'remove'; readonly path: string };

export interface EditorContext {
  readonly lang: string;
  readonly dir: TextDirection;
  /** Resolve an i18n key for the *studio* UI (never respondent copy). */
  t(key: I18nKey): string;
  /**
   * Request an asset from studio's picker. The editor never sees a storage credential
   * (F §6) — it asks, studio picks, studio patches.
   */
  requestAsset(accept: readonly string[]): void;
}

export interface EditorProps<Config> {
  readonly question: AuthoredQuestion<Config>;
  /** The only way an editor changes anything. Validated by studio before it is applied. */
  patch(ops: readonly JsonPatchOp[]): void;
  readonly ctx: EditorContext;
}

export interface EditorComponent<Config> {
  (props: EditorProps<Config>): ReactNode;
}
