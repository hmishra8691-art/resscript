/**
 * The protocol validators — security §3.2's "every message validated before dispatch".
 *
 * The negative cases are the point: a malformed postMessage from a compromised preview frame
 * must parse to null, never crash, and never pass through with unvalidated extra fields.
 */

import { describe, expect, it } from 'vitest';
import { parsePreviewToStudio, parseStudioToPreview } from './preview-protocol.js';

const HASH = 'a'.repeat(64);
const SEED = 'b'.repeat(32);

describe('parseStudioToPreview', () => {
  it('accepts every well-formed message', () => {
    expect(parseStudioToPreview({
      t: 'preview:init', artifact_hash: HASH, language: 'en', device: 'desktop', seed: SEED,
    })).toEqual({ t: 'preview:init', artifact_hash: HASH, language: 'en', device: 'desktop', seed: SEED });
    expect(parseStudioToPreview({ t: 'preview:goto', page_id: 'pg_1' }))
      .toEqual({ t: 'preview:goto', page_id: 'pg_1' });
    expect(parseStudioToPreview({ t: 'preview:setVars', vars: { Q1: 3 } }))
      .toEqual({ t: 'preview:setVars', vars: { Q1: 3 } });
    expect(parseStudioToPreview({ t: 'preview:setDevice', device: 'mobile' }))
      .toEqual({ t: 'preview:setDevice', device: 'mobile' });
    expect(parseStudioToPreview({ t: 'preview:reload', artifact_hash: HASH }))
      .toEqual({ t: 'preview:reload', artifact_hash: HASH });
  });

  it.each([
    ['not an object', 'hello'],
    ['null', null],
    ['unknown t', { t: 'preview:evil' }],
    ['init with a malformed hash', { t: 'preview:init', artifact_hash: 'xyz', language: 'en', device: 'desktop' }],
    ['init with a malformed seed', { t: 'preview:init', artifact_hash: 'a'.repeat(64), language: 'en', device: 'desktop', seed: 'nope' }],
    ['init with an invented device', { t: 'preview:init', artifact_hash: 'a'.repeat(64), language: 'en', device: 'tv' }],
    ['goto with an oversized id', { t: 'preview:goto', page_id: 'x'.repeat(65) }],
    ['setVars with an array', { t: 'preview:setVars', vars: [1, 2] }],
  ])('rejects %s as null, never a throw', (_label, msg) => {
    expect(parseStudioToPreview(msg)).toBeNull();
  });

  it('STRIPS unvalidated extra fields rather than passing them through', () => {
    const parsed = parseStudioToPreview({
      t: 'preview:goto', page_id: 'pg_1', __proto__pollution: 'x', extra: { deep: true },
    });
    expect(parsed).toEqual({ t: 'preview:goto', page_id: 'pg_1' });
    expect(Object.keys(parsed ?? {})).toEqual(['t', 'page_id']);
  });
});

describe('parsePreviewToStudio', () => {
  it('accepts the frame-side messages', () => {
    expect(parsePreviewToStudio({ t: 'preview:ready', artifact_hash: HASH, session_id: 'ses_1' }))
      .toEqual({ t: 'preview:ready', artifact_hash: HASH, session_id: 'ses_1' });
    expect(parsePreviewToStudio({ t: 'preview:page', page_id: 'pg_1', height: 480 }))
      .toEqual({ t: 'preview:page', page_id: 'pg_1', height: 480 });
    expect(parsePreviewToStudio({ t: 'preview:disposition', disposition: 'COMPLETE', redirect_url: null }))
      .toEqual({ t: 'preview:disposition', disposition: 'COMPLETE', redirect_url: null });
    expect(parsePreviewToStudio({ t: 'preview:error', code: 'boom', message: 'x' }))
      .toEqual({ t: 'preview:error', code: 'boom', message: 'x' });
  });

  it('rejects the malformed', () => {
    expect(parsePreviewToStudio({ t: 'preview:page', page_id: 'pg_1', height: 'tall' })).toBeNull();
    expect(parsePreviewToStudio({ t: 'preview:disposition', disposition: 42, redirect_url: null })).toBeNull();
    expect(parsePreviewToStudio(undefined)).toBeNull();
  });
});
