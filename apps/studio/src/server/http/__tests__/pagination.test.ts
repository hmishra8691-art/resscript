/**
 * Cursor pagination unit tests.
 *
 * The cursor is opaque, so these tests assert the CONTRACT (round-trip, clamping, rejection),
 * never the encoding — asserting the base64 payload would freeze an implementation detail that
 * API §1.3 deliberately leaves free to change.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  decodeCursor,
  encodeCursor,
  pageEnvelope,
  pageQueryFrom,
  idPosition,
} from '@/server/http/pagination';

const position = { created_at: '2026-08-20T10:12:33.000Z', id: 'prj_01H000000000000000000000' };

describe('cursors', () => {
  it('round-trips the sort tuple', () => {
    expect(decodeCursor(encodeCursor(position))).toEqual(position);
  });

  it('is opaque — not a page number', () => {
    const cursor = encodeCursor(position);
    expect(cursor).not.toContain(position.id);
    expect(Number.isNaN(Number(cursor))).toBe(true);
  });

  it('rejects a cursor we did not mint with invalid_cursor', () => {
    for (const bad of ['not-base64!!', Buffer.from('{"c":1}').toString('base64url'), '']) {
      expect(() => decodeCursor(bad)).toThrowError(
        expect.objectContaining({ code: 'invalid_cursor' }) as unknown as Error,
      );
    }
  });
});

describe('limit handling', () => {
  it('defaults to 50', () => {
    expect(pageQueryFrom(new URL('http://x/?')).limit).toBe(DEFAULT_LIMIT);
  });

  it('CLAMPS above the maximum rather than rejecting', () => {
    expect(pageQueryFrom(new URL('http://x/?limit=100000')).limit).toBe(MAX_LIMIT);
  });

  it('rejects a non-numeric limit as a client bug worth reporting', () => {
    expect(() => pageQueryFrom(new URL('http://x/?limit=lots'))).toThrowError(
      expect.objectContaining({ code: 'malformed_request' }) as unknown as Error,
    );
  });
});

describe('envelope', () => {
  it('emits null next_cursor when exhausted so a client loop terminates', () => {
    const envelope = pageEnvelope([{ created_at: 'a', id: 'b' }], false, 50, idPosition);
    expect(envelope.page).toEqual({ next_cursor: null, has_more: false, limit: 50 });
  });

  it('emits a cursor derived from the LAST row when more remain', () => {
    const rows = [position, { created_at: '2026-08-19T00:00:00.000Z', id: 'prj_01H000000000000000000001' }];
    const envelope = pageEnvelope(rows, true, 2, idPosition);
    expect(envelope.page.has_more).toBe(true);
    expect(decodeCursor(envelope.page.next_cursor as string)).toEqual(rows[1]);
  });
});
