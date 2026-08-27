/**
 * The editor bridge's studio half: what a plugin editor is allowed to write, and what one batch
 * of ops becomes on the wire.
 *
 * The allowlist itself is tested in the kit (`editor-bridge.test.ts`); what is tested here is that
 * studio actually consults it — including for a first-party editor, which is the case
 * `editor-bridge.ts` says is easy to skip and expensive to lose ("an allowlist only used on the
 * dangerous path is an allowlist nobody notices has stopped working").
 */

import { describe, expect, it } from 'vitest';
import { translateEditorPatch } from '@/components/tree/editor-patch';

const CONFIG = { display: 'vertical', other: { enabled: false, labelKey: 'x' }, columns: 1 };

describe('translateEditorPatch', () => {
  it('folds a config op into one PATCH body', () => {
    const result = translateEditorPatch(
      [{ op: 'replace', path: '/config/display', value: 'dropdown' }],
      { config: CONFIG },
    );
    expect(result).toEqual({
      ok: true,
      body: { config: { display: 'dropdown', other: { enabled: false, labelKey: 'x' }, columns: 1 } },
    });
  });

  it('reaches a nested member without dropping its siblings', () => {
    const result = translateEditorPatch(
      [{ op: 'replace', path: '/config/other/enabled', value: true }],
      { config: CONFIG },
    );
    if (!result.ok) throw new Error(result.reason);
    expect(result.body).toEqual({
      config: { display: 'vertical', other: { enabled: true, labelKey: 'x' }, columns: 1 },
    });
    // The source config is untouched: the fold is immutable, so a rejected write leaves the
    // editor rendering what it rendered before.
    expect(CONFIG.other.enabled).toBe(false);
  });

  it('collapses a multi-op batch into ONE request', () => {
    const result = translateEditorPatch(
      [
        { op: 'replace', path: '/config/display', value: 'horizontal' },
        { op: 'replace', path: '/config/columns', value: 3 },
        { op: 'replace', path: '/label', value: 'Which brands?' },
      ],
      { config: CONFIG },
    );
    if (!result.ok) throw new Error(result.reason);
    expect(result.body).toEqual({
      label: 'Which brands?',
      config: { display: 'horizontal', other: { enabled: false, labelKey: 'x' }, columns: 3 },
    });
  });

  it('removes a config member', () => {
    const result = translateEditorPatch([{ op: 'remove', path: '/config/columns' }], {
      config: CONFIG,
    });
    if (!result.ok) throw new Error(result.reason);
    expect(result.body).toEqual({
      config: { display: 'vertical', other: { enabled: false, labelKey: 'x' } },
    });
  });

  it('rejects the whole batch when one op is outside the kit’s allowlist', () => {
    const result = translateEditorPatch(
      [
        { op: 'replace', path: '/config/display', value: 'dropdown' },
        // studio's, not the editor's: `required` decides whether data is collected.
        { op: 'replace', path: '/required', value: false },
      ],
      { config: CONFIG },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('/required');
    expect(result.reason).toContain('studio owns');
  });

  it('rejects a flags.pii write, which is the one that matters most', () => {
    const result = translateEditorPatch([{ op: 'replace', path: '/flags/pii', value: false }], {
      config: CONFIG,
    });
    expect(result.ok).toBe(false);
  });

  it('sends an item-array patch to the options list rather than applying it', () => {
    const result = translateEditorPatch(
      [{ op: 'replace', path: '/options/3/code', value: 99 }],
      { config: CONFIG },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('options list');
  });

  it('refuses a config path that does not name an object', () => {
    const result = translateEditorPatch(
      [{ op: 'replace', path: '/config/display/nested', value: 1 }],
      { config: CONFIG },
    );
    expect(result.ok).toBe(false);
  });

  it('treats an empty batch as nothing to do, not as a write', () => {
    expect(translateEditorPatch([], { config: CONFIG }).ok).toBe(false);
  });
});
