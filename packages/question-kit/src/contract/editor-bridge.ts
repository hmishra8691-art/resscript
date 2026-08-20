/**
 * The editor bridge protocol — Deliverable F §6.
 *
 * **The editor component is the dangerous surface, not the renderer.** The renderer runs on the
 * isolated, cookieless per-survey origin where there is nothing to steal (ADR-005). The editor
 * would otherwise run inside `apps/studio`, in an authenticated staff or author browser with a
 * live Supabase session — executing third-party JS there is stored XSS against our own users
 * (ADR-005 threat 4). So an `org_custom` or `marketplace` editor renders inside a sandboxed
 * iframe on the *isolated* origin and talks to studio over this typed `postMessage` protocol.
 *
 * The types live in the kit rather than in studio because both ends need them and because the
 * inbound validation rules below are the security control: studio checks every inbound `patch`
 * against the plugin's `configSchema` **and** against `EDITOR_PATCH_PATH_ALLOWLIST` before
 * applying it. A first-party editor is imported directly and skips the iframe; it still goes
 * through `patch`, so the allowlist is exercised by every editor rather than only by the
 * untrusted ones — an allowlist only used on the dangerous path is an allowlist nobody notices
 * has stopped working.
 */

import type { AuthoredQuestion } from './authored.js';
import type { CompileDiagnostic } from './diagnostics.js';
import type { JsonPatchOp, TextDirection } from './view.js';
import type { JsonObject } from '@resscript/schema';

/** Protocol version, in every message, so a stale iframe is detected rather than misread. */
export const EDITOR_BRIDGE_PROTOCOL = 'rs.editor/1';

export type StudioToEditor =
  | {
      readonly t: 'init';
      readonly protocol: typeof EDITOR_BRIDGE_PROTOCOL;
      readonly question: AuthoredQuestion<JsonObject>;
      readonly schemaVersion: number;
      readonly lang: string;
      readonly dir: TextDirection;
      readonly theme: JsonObject;
    }
  | { readonly t: 'question:set'; readonly question: AuthoredQuestion<JsonObject> }
  | { readonly t: 'i18n:set'; readonly bundle: Readonly<Record<string, string>> }
  | { readonly t: 'validate:result'; readonly issues: readonly CompileDiagnostic[] };

export type EditorToStudio =
  | { readonly t: 'ready'; readonly pluginId: string; readonly pluginVersion: string }
  /** Patches only; the editor never owns the model. */
  | { readonly t: 'patch'; readonly ops: readonly JsonPatchOp[] }
  | { readonly t: 'resize'; readonly height: number }
  /** Studio owns the asset picker, so a plugin never sees a storage credential. */
  | { readonly t: 'asset:pick:request'; readonly accept: readonly string[] }
  | { readonly t: 'error'; readonly message: string };

/**
 * The JSON Patch paths an editor may write, as pointer *prefixes*.
 *
 * Everything outside this list is studio's: `required`, `ref`, `flags.pii`, `scripts`,
 * `validation`, `masks`, `emits`. Those are the fields that decide whether data is collected,
 * how it is classified and what runs — none of which a question-type editor has any reason to
 * change, and all of which a compromised one would love to.
 */
export const EDITOR_PATCH_PATH_ALLOWLIST: readonly string[] = [
  '/config',
  '/options',
  '/rows',
  '/columns',
  '/cells',
  '/label',
  '/instruction',
];

/**
 * Is this patch path writable by an editor?
 *
 * Prefix matching is done on *pointer segments*, not on strings: `'/configuration'` starts with
 * `'/config'` as a string and is a different field. Getting this wrong is how an allowlist
 * becomes decorative, which is the same failure mode `.dependency-cruiser.cjs` documents for
 * the `runtime-no-supabase` rule.
 */
export function isAllowedEditorPatchPath(path: string): boolean {
  if (!path.startsWith('/')) return false;
  // A pointer may not contain a raw `~` outside the `~0`/`~1` escapes (RFC 6901): rejecting it
  // outright keeps "the path I checked" and "the path applied" the same string.
  if (/~(?![01])/.test(path)) return false;
  return EDITOR_PATCH_PATH_ALLOWLIST.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
}

/** Reject the whole batch if any op is out of bounds: a partial apply is a corrupt question. */
export function checkEditorPatch(
  ops: readonly JsonPatchOp[],
): { readonly ok: true } | { readonly ok: false; readonly rejected: readonly string[] } {
  const rejected = ops.map((op) => op.path).filter((path) => !isAllowedEditorPatchPath(path));
  return rejected.length === 0 ? { ok: true } : { ok: false, rejected };
}
