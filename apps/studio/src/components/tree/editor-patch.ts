/**
 * The editor bridge, studio side — F §6's `patch(ops)` translated into `PATCH /nodes/{id}`.
 *
 * A question-type editor never owns the model: it emits JSON-Patch ops and studio decides
 * whether to apply them (`contract/view.ts`: "a component that returns a full object can
 * silently drop or rewrite a field it does not understand"). This module is that decision, and
 * it is a pure function so the decision is testable without a DOM.
 *
 * Three rules, each from the contract rather than from convenience:
 *
 *  1. **The allowlist runs first, for every editor.** `checkEditorPatch` is the kit's own
 *     function, and `editor-bridge.ts` is explicit about why a first-party editor goes through
 *     it too: "an allowlist only used on the dangerous path is an allowlist nobody notices has
 *     stopped working". A rejected batch is rejected WHOLE — a partial apply is a corrupt
 *     question.
 *  2. **`/config` is applied client-side and sent as one field.** `PATCH /nodes/{id}` takes a
 *     partial node, not a patch document, so the ops are folded into a copy of the config and
 *     the result is sent as `{config}`. The server re-validates it against the plugin's
 *     `configSchema` (P1-04's boundary check), so the client's fold is a convenience, never the
 *     authority.
 *  3. **Item arrays are refused here, with a pointer to where they live.** `/options`, `/rows`,
 *     `/columns` and `/cells` are separate resources with their own ids, codes and move
 *     endpoint (API §2.5), and an RFC-6902 index into an array whose identity is `ref`/`code`
 *     cannot be applied to them safely — `/options/3/code` says nothing about *which* option.
 *     None of the fifteen first-party editors emits one; the refusal exists so that when a
 *     sixteenth does, it fails with a sentence instead of writing the wrong option's code.
 */

import type { JsonPatchOp } from '@resscript/question-kit';
import { checkEditorPatch } from '@resscript/question-kit';

export type EditorPatchResult =
  | { readonly ok: true; readonly body: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly reason: string };

/** The item-bearing roots. Editing these is the items editor's job, not a patch's. */
const ITEM_ROOTS = ['/options', '/rows', '/columns', '/cells'];

function segmentsOf(path: string): readonly string[] {
  return path
    .split('/')
    .slice(1)
    .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Fold one op into a config object, cloning only the path it touches.
 *
 * `add` and `replace` are treated identically for object members: RFC 6902 distinguishes them by
 * whether the member exists, and a plugin editor that says `add` for a field it has already set
 * (or `replace` for one it has not) is describing the same intent either way. Arrays inside
 * `config` are replaced wholesale rather than spliced, for the reason ITEM_ROOTS are refused.
 */
function applyOp(
  config: Readonly<Record<string, unknown>>,
  op: JsonPatchOp,
): EditorPatchResult {
  const segments = segmentsOf(op.path);
  if (segments[0] !== 'config') {
    return { ok: false, reason: `${op.path} is not a config path` };
  }
  const rest = segments.slice(1);
  if (rest.length === 0) {
    if (op.op === 'remove') return { ok: false, reason: 'config cannot be removed' };
    if (!isRecord(op.value)) return { ok: false, reason: 'config must be an object' };
    return { ok: true, body: op.value };
  }

  const next: Record<string, unknown> = { ...config };
  let cursor: Record<string, unknown> = next;
  for (const segment of rest.slice(0, -1)) {
    const child = cursor[segment];
    if (!isRecord(child)) {
      return { ok: false, reason: `${op.path} does not name a config object` };
    }
    const clone: Record<string, unknown> = { ...child };
    cursor[segment] = clone;
    cursor = clone;
  }
  const leaf = rest[rest.length - 1];
  if (leaf === undefined) return { ok: false, reason: `${op.path} is not a config path` };
  if (op.op === 'remove') delete cursor[leaf];
  else cursor[leaf] = op.value;
  return { ok: true, body: next };
}

export interface EditorPatchTarget {
  readonly config: Readonly<Record<string, unknown>>;
}

/**
 * Translate one batch of editor ops into a `PATCH /nodes/{id}` body.
 *
 * The batch is atomic in both directions: one rejected op rejects the batch (rule 1), and the
 * accepted ops collapse into ONE request — an editor that flips two config fields in one
 * `patch([…])` call must not become two revisions of the survey.
 */
export function translateEditorPatch(
  ops: readonly JsonPatchOp[],
  target: EditorPatchTarget,
): EditorPatchResult {
  if (ops.length === 0) return { ok: false, reason: 'nothing to apply' };

  const allowed = checkEditorPatch(ops);
  if (!allowed.ok) {
    return {
      ok: false,
      reason: `the editor tried to write ${allowed.rejected.join(', ')}, which studio owns`,
    };
  }

  const itemPath = ops.find((op) =>
    ITEM_ROOTS.some((root) => op.path === root || op.path.startsWith(root + '/')),
  );
  if (itemPath !== undefined) {
    return {
      ok: false,
      reason: `${itemPath.path} is edited in the options list, not by the type editor`,
    };
  }

  const body: Record<string, unknown> = {};
  let config = target.config;
  for (const op of ops) {
    if (op.path === '/label' || op.path === '/instruction') {
      const field = op.path.slice(1);
      body[field] = op.op === 'remove' ? null : op.value;
      continue;
    }
    const applied = applyOp(config, op);
    if (!applied.ok) return applied;
    config = applied.body;
  }
  if (config !== target.config) body['config'] = config;
  if (Object.keys(body).length === 0) return { ok: false, reason: 'nothing to apply' };
  return { ok: true, body };
}
