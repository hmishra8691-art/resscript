/**
 * The editor patch allowlist.
 *
 * This is a security control, not a convenience: a third-party editor runs in a sandboxed iframe
 * and everything it wants to change arrives as a JSON Patch that studio applies. The allowlist is
 * what stops it from patching `required`, `flags.pii`, `scripts` or another question entirely
 * (F §6, ADR-005 threat 4). `.dependency-cruiser.cjs` documents what happens to a control nobody
 * tests: the `runtime-no-supabase` rule matched nothing for a while and a deliberate violation
 * passed CI. So the cases below are mostly *rejections*, including the prefix trap the
 * implementation exists to avoid.
 */

import { describe, expect, it } from 'vitest';
import {
  checkEditorPatch,
  EDITOR_BRIDGE_PROTOCOL,
  EDITOR_PATCH_PATH_ALLOWLIST,
  isAllowedEditorPatchPath,
} from './editor-bridge.js';

describe('isAllowedEditorPatchPath', () => {
  it('allows the paths an editor owns', () => {
    for (const path of [
      '/config',
      '/config/display',
      '/config/other/enabled',
      '/options',
      '/options/0/label',
      '/rows/2/code',
      '/columns',
      '/cells/0/control/config/min',
      '/label',
      '/instruction',
    ]) {
      expect(isAllowedEditorPatchPath(path), path).toBe(true);
    }
  });

  it('refuses the fields that decide whether data is collected and how it is classified', () => {
    for (const path of [
      '/required',
      '/ref',
      '/flags',
      '/flags/pii',
      '/scripts',
      '/scripts/on_load',
      '/validation',
      '/validation/0',
      '/masks',
      '/emits',
      '/question_type',
      '/id',
      '',
      '/',
    ]) {
      expect(isAllowedEditorPatchPath(path), path).toBe(false);
    }
  });

  it('matches on pointer segments, not on string prefixes', () => {
    // `/configuration` starts with `/config` as a *string*. Getting this wrong is how an allowlist
    // becomes decorative — it would let an editor write a field it was never granted.
    expect(isAllowedEditorPatchPath('/configuration')).toBe(false);
    expect(isAllowedEditorPatchPath('/config-backup/x')).toBe(false);
    expect(isAllowedEditorPatchPath('/labelling')).toBe(false);
    expect(isAllowedEditorPatchPath('/optionsX')).toBe(false);
  });

  it('refuses a relative or escaped path outright', () => {
    expect(isAllowedEditorPatchPath('config/display')).toBe(false);
    // A raw `~` outside the `~0`/`~1` escapes is not a valid RFC 6901 pointer; rejecting it keeps
    // "the path I checked" and "the path applied" the same string.
    expect(isAllowedEditorPatchPath('/config/~foo')).toBe(false);
    expect(isAllowedEditorPatchPath('/config/~0foo')).toBe(true);
    expect(isAllowedEditorPatchPath('/config/~1foo')).toBe(true);
  });

  it('has an allowlist that names only the question’s own authoring surface', () => {
    expect([...EDITOR_PATCH_PATH_ALLOWLIST].sort()).toEqual([
      '/cells',
      '/columns',
      '/config',
      '/instruction',
      '/label',
      '/options',
      '/rows',
    ]);
  });
});

describe('checkEditorPatch', () => {
  it('accepts a batch where every op is in bounds', () => {
    expect(
      checkEditorPatch([
        { op: 'replace', path: '/config/display', value: 'dropdown' },
        { op: 'add', path: '/options/2', value: { ref: 'o3', code: 3 } },
      ]),
    ).toEqual({ ok: true });
  });

  it('rejects the whole batch if any op is out of bounds', () => {
    const result = checkEditorPatch([
      { op: 'replace', path: '/config/display', value: 'dropdown' },
      { op: 'replace', path: '/flags/pii', value: false },
      { op: 'remove', path: '/validation/0' },
    ]);
    // A partial apply is a corrupt question: half the config changed and the other half did not,
    // with no record of which.
    expect(result).toEqual({ ok: false, rejected: ['/flags/pii', '/validation/0'] });
  });

  it('accepts an empty batch without claiming anything was applied', () => {
    expect(checkEditorPatch([])).toEqual({ ok: true });
  });
});

describe('the protocol envelope', () => {
  it('is versioned, so a stale iframe is detected rather than misread', () => {
    // Deliberately distinct from Deliverable K §4's `rs.preview/1`: the preview channel and the
    // editor channel carry different payloads and version independently.
    expect(EDITOR_BRIDGE_PROTOCOL).toBe('rs.editor/1');
  });
});
