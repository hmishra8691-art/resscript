/**
 * The response codec — Deliverable F §1.2.
 *
 * The codec is the only place that knows how a wire payload becomes an `Answer` and how an
 * `Answer` becomes variable values. Storage is *always* variables; `Answer` is an in-memory
 * shape and never persisted, which is why resume and back-navigation go through
 * `fromVariables` rather than through a stored blob.
 *
 * The load-bearing invariant, from F §1.2: **`toVariables` must only produce keys that
 * `declareVariables` declared.** The server checks the result against the artifact's variable
 * manifest and rejects anything outside it (ADR-005 threat 3, response forgery). A plugin bug
 * here is a hard 400 with a `variable_manifest_violation` event, not a silently stored extra
 * column — so the test kit asserts the subset property for every fixture rather than trusting
 * it.
 */

import type { JsonValue } from '@resscript/schema';
import type { ResolvedQuestion } from './validate.js';
import type { CellControl, ComposeScope, VariableNamer } from './variables.js';

export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

/**
 * Why an untrusted payload was rejected.
 *
 * `code` is a small closed set because the API turns it into an HTTP response and a metric
 * label; a free-form string there becomes an unbounded label set within a month.
 *
 *  - `shape`      — not the expected JSON shape at all.
 *  - `domain`     — right shape, value outside the declared domain (an unknown option code).
 *  - `range`      — right shape, number outside the declared numeric domain.
 *  - `unknown_key`— a key the question does not have (a fabricated `rowRef`).
 *  - `too_large`  — beyond a hard bound. Deliberately distinct from `range`: this is the
 *                   defence against the 10,000-row and 1 MB-string payloads F §9's hostile
 *                   input list requires the codec to reject *without* allocating them.
 */
export interface CodecError {
  readonly code: 'shape' | 'domain' | 'range' | 'unknown_key' | 'too_large';
  readonly message: string;
  /** Pointer into the raw payload, when there is a meaningful sub-location. */
  readonly path?: string;
}

export interface CodecContext<Config> {
  readonly ref: string;
  readonly config: Config;
  readonly question: ResolvedQuestion<Config>;
  /** The same namer `declareVariables` used, so codec keys cannot drift from declared names. */
  readonly name: VariableNamer;
  /** Composition: delegate a sub-region to the child plugin's codec (F §3). */
  delegateToVariables(
    scope: ComposeScope,
    control: CellControl,
    answer: unknown,
  ): Readonly<Record<string, JsonValue | null>>;
  delegateParse(
    scope: ComposeScope,
    control: CellControl,
    raw: unknown,
  ): Result<unknown, CodecError>;
  delegateFromVariables(
    scope: ComposeScope,
    control: CellControl,
    vars: Readonly<Record<string, JsonValue | null>>,
  ): unknown;
}

export interface ResponseCodec<Config, Answer> {
  /** Untrusted wire payload -> Answer, or a reject. Runs on the server first. Never throws. */
  parse(raw: unknown, ctx: CodecContext<Config>): Result<Answer, CodecError>;
  /** Answer -> variable values keyed by the names from `declareVariables`. */
  toVariables(answer: Answer, ctx: CodecContext<Config>): Readonly<Record<string, JsonValue | null>>;
  /** Variable values -> Answer, for resume, back-navigation and prefill. */
  fromVariables(
    vars: Readonly<Record<string, JsonValue | null>>,
    ctx: CodecContext<Config>,
  ): Answer;
  /** The value written when the question was shown and left blank (vs. not shown at all). */
  emptyAnswer(ctx: CodecContext<Config>): Answer;
}

/**
 * Hard payload bounds, applied by every first-party codec before it allocates anything.
 *
 * These are a *contract* rather than a per-plugin choice: a hostile payload must be rejected
 * on shape, and "how big is too big" must not be a decision each plugin gets wrong
 * separately. The numbers are generous by two orders of magnitude for real instruments (the
 * largest realistic grid is ~200 rows; the longest realistic verbatim is a few thousand
 * characters) and small enough that a rejection costs a comparison rather than a parse.
 */
export const CODEC_LIMITS = {
  /** Max entries in an array-shaped answer (a multi-select's selections, a grid's rows). */
  maxItems: 1_000,
  /** Max characters in any single string an answer carries, before per-config truncation. */
  maxStringLength: 100_000,
  /** Max keys in an object-shaped answer. */
  maxKeys: 1_000,
} as const;

/**
 * Read a plain-object payload safely.
 *
 * Rejects arrays and `null`, and — the reason this helper exists rather than a `typeof` check
 * at each call site — refuses payloads carrying an own `__proto__`/`constructor`/`prototype`
 * key. `JSON.parse` produces those as ordinary own properties, so they are harmless until
 * something spreads them into a fresh object; F §9's `{ rows: { r1: { __proto__: … } } }`
 * hostile input exists to make sure no codec is that something.
 */
export function asPlainObject(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  for (const forbidden of ['__proto__', 'constructor', 'prototype']) {
    if (Object.prototype.hasOwnProperty.call(record, forbidden)) return undefined;
  }
  if (Object.keys(record).length > CODEC_LIMITS.maxKeys) return undefined;
  return record;
}

/**
 * Read a text field from an untrusted payload, bounded before anything is allocated.
 *
 * The two failure codes are distinct on purpose. `too_large` is the defence against the
 * megabyte-string payload in F §9's hostile list, and it has to fire on `raw.length` — a check that
 * costs a comparison — rather than after `[...raw]` has built a million-element array to count code
 * points. `maxLen` (the author's own limit) is then applied by *truncation*, because a respondent
 * pasting 500 characters into a 200-character box is a respondent, not an attacker: rejecting the
 * page would lose their other answers, and `validate` still reports the length so they can fix it.
 */
export type TextRead =
  | { readonly ok: true; readonly value: string | null }
  | { readonly ok: false; readonly code: 'shape' | 'too_large' };

export function readBoundedText(raw: unknown, maxLen: number): TextRead {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false, code: 'shape' };
  if (raw.length > CODEC_LIMITS.maxStringLength) return { ok: false, code: 'too_large' };
  return { ok: true, value: [...raw].slice(0, maxLen).join('') };
}

/** A scalar answer code as it arrives on the wire: number, string, or absent. */
export function asOptionCode(raw: unknown): number | string | null | undefined {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined;
  if (typeof raw === 'string') return raw.length <= CODEC_LIMITS.maxStringLength ? raw : undefined;
  return undefined;
}
