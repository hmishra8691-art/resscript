/**
 * Media type sniffing and serving headers (security §4, roadmap P2-12).
 *
 * Every test here is about not trusting the uploader. The client's `Content-Type` is a string it
 * chose, so a file named `logo.png`, declared `image/png`, containing an HTML document is an XSS on
 * the media origin the moment a browser sniffs it. The cases:
 *
 *  * a real signature is recognised, and only at the right OFFSET — RIFF and ISO-BMFF put their
 *    identifier after a length field, so matching at byte 0 identifies a WEBP as a generic RIFF;
 *  * SVG is REFUSED, by name, because it is a scriptable document and not an image;
 *  * an HTML or XML document is refused whatever its extension claimed;
 *  * `nosniff` is unconditional and non-displayable types get `attachment`.
 */

import { describe, expect, it } from 'vitest';

import { ALLOWED_MEDIA_TYPES, mediaHeaders, sniffMediaType } from './media.js';

const bytes = (...b: number[]) => new Uint8Array(b);
const ascii = (s: string) => new TextEncoder().encode(s);
/** U+FEFF, spelled as an escape so the source file itself carries no BOM. */
const BOM = '﻿';

/** `RIFF` + a four-byte length + a form type — the shape WEBP and WAV share. */
const riff = (form: string) =>
  new Uint8Array([...ascii('RIFF'), 0x24, 0x00, 0x00, 0x00, ...ascii(form)]);
/** A four-byte box size, `ftyp`, then a brand — ISO-BMFF, shared by MP4 and AVIF. */
const isobmff = (brand: string) =>
  new Uint8Array([0x00, 0x00, 0x00, 0x20, ...ascii('ftyp'), ...ascii(brand)]);

/* ---------------------------------------------------------------- *
 * Recognising the real thing
 * ---------------------------------------------------------------- */

describe('sniffMediaType — real signatures', () => {
  it('recognises PNG', () => {
    expect(sniffMediaType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0))).toEqual({
      ok: true,
      mime: 'image/png',
    });
  });

  it('recognises JPEG and GIF', () => {
    expect(sniffMediaType(bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0))).toEqual({
      ok: true,
      mime: 'image/jpeg',
    });
    expect(sniffMediaType(ascii('GIF89a....'))).toEqual({ ok: true, mime: 'image/gif' });
    expect(sniffMediaType(ascii('GIF87a....'))).toEqual({ ok: true, mime: 'image/gif' });
  });

  it('recognises WEBP at its real OFFSET, not as generic RIFF', () => {
    // The reason signatures carry an offset. RIFF puts a four-byte length before the form type, so
    // matching at byte 0 identifies every RIFF container as the same thing.
    expect(sniffMediaType(riff('WEBP'))).toEqual({ ok: true, mime: 'image/webp' });
    expect(sniffMediaType(riff('WAVE'))).toEqual({ ok: true, mime: 'audio/wav' });
  });

  it('distinguishes AVIF from MP4 by brand, both after the ftyp box', () => {
    expect(sniffMediaType(isobmff('avif'))).toEqual({ ok: true, mime: 'image/avif' });
    expect(sniffMediaType(isobmff('isom'))).toEqual({ ok: true, mime: 'video/mp4' });
    expect(sniffMediaType(isobmff('mp42'))).toEqual({ ok: true, mime: 'video/mp4' });
  });

  it('recognises WebM, Ogg and PDF', () => {
    expect(sniffMediaType(bytes(0x1a, 0x45, 0xdf, 0xa3, 0, 0))).toEqual({
      ok: true,
      mime: 'video/webm',
    });
    expect(sniffMediaType(ascii('OggS....'))).toEqual({ ok: true, mime: 'audio/ogg' });
    expect(sniffMediaType(ascii('%PDF-1.7'))).toEqual({ ok: true, mime: 'application/pdf' });
  });

  it('recognises MP3 in both common spellings', () => {
    // An ID3 tag or a bare frame sync — both appear in the wild, and refusing the second would
    // reject files every other tool accepts.
    expect(sniffMediaType(ascii('ID3 '))).toEqual({ ok: true, mime: 'audio/mpeg' });
    expect(sniffMediaType(bytes(0xff, 0xfb, 0x90, 0x00))).toEqual({ ok: true, mime: 'audio/mpeg' });
  });
});

/* ---------------------------------------------------------------- *
 * The refusals
 * ---------------------------------------------------------------- */

describe('sniffMediaType — refusals', () => {
  it('REFUSES an SVG, and says so by name', () => {
    // The headline. An SVG is an XML document that can carry <script>, onload and external
    // references — security §4 strips <svg> from author HTML for exactly that reason. "It is an
    // image" is true of the rendering and false of the security model, and the media origin serves
    // files to browsers.
    const r = sniffMediaType(ascii('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'));
    expect(r).toEqual({ ok: false, reason: 'not_allowed', looksLike: 'svg' });
  });

  it('refuses an SVG with leading whitespace, a BOM, or an XML prolog', () => {
    // A check anchored strictly at byte 0 misses all three, and all three are still SVGs.
    expect(sniffMediaType(ascii('\n  <svg width="1"></svg>')).ok).toBe(false);
    expect(sniffMediaType(ascii(`${BOM}<svg/>`)).ok).toBe(false);
    const prolog = sniffMediaType(ascii('<?xml version="1.0"?><svg/>'));
    expect(prolog.ok).toBe(false);
    if (!prolog.ok) expect(prolog.looksLike).toBe('xml');
  });

  it('refuses an HTML document however it was named', () => {
    // The XSS this whole module exists to prevent: `logo.png`, declared image/png, containing HTML.
    for (const s of ['<!doctype html><h1>x', '<html><body>x', '<!DOCTYPE HTML>']) {
      const r = sniffMediaType(ascii(s));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.looksLike).toBe('html');
    }
  });

  it('refuses an unrecognised container without guessing', () => {
    const r = sniffMediaType(bytes(0x00, 0x01, 0x02, 0x03, 0x04, 0x05));
    expect(r).toEqual({ ok: false, reason: 'unrecognised', looksLike: null });
  });

  it('refuses an empty or truncated file rather than throwing', () => {
    expect(sniffMediaType(new Uint8Array()).ok).toBe(false);
    // A PNG signature cut short is not a PNG.
    expect(sniffMediaType(bytes(0x89, 0x50)).ok).toBe(false);
  });

  it('never returns a type outside the allowlist', () => {
    // The property, not an example: the sniffer is the only thing that assigns a mime, so a
    // signature added with a typo'd type would put an unservable value in the column.
    const samples = [
      riff('WEBP'), riff('WAVE'), isobmff('avif'), isobmff('isom'),
      ascii('GIF89a'), ascii('%PDF-1.4'), ascii('OggS'), ascii('ID3'),
      bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
      bytes(0xff, 0xd8, 0xff), bytes(0x1a, 0x45, 0xdf, 0xa3),
    ];
    for (const s of samples) {
      const r = sniffMediaType(s);
      if (r.ok) expect(ALLOWED_MEDIA_TYPES).toContain(r.mime);
    }
  });

  it('does not include image/svg+xml in the allowlist at all', () => {
    // Asserted directly, so adding it requires deleting a test that says why it is absent.
    expect(ALLOWED_MEDIA_TYPES as readonly string[]).not.toContain('image/svg+xml');
  });
});

/* ---------------------------------------------------------------- *
 * Serving headers
 * ---------------------------------------------------------------- */

describe('mediaHeaders', () => {
  it('sets nosniff unconditionally', () => {
    for (const mime of ALLOWED_MEDIA_TYPES) {
      expect(mediaHeaders(mime)['x-content-type-options']).toBe('nosniff');
    }
  });

  it('serves an image, video or audio INLINE', () => {
    for (const mime of ['image/png', 'video/mp4', 'audio/mpeg'] as const) {
      expect(mediaHeaders(mime)['content-disposition']).toBeUndefined();
    }
  });

  it('forces a DOWNLOAD for anything not displayable', () => {
    // Security §4. A PDF rendered inline runs in the origin's context in some viewers, so the split
    // is by whether the type is displayable rather than by whether it is "safe".
    expect(mediaHeaders('application/pdf')['content-disposition']).toBe('attachment');
  });

  it('sends a CSP that permits nothing, as belt-and-braces over nosniff', () => {
    // If a browser did sniff a document out of these bytes, this is what stops it doing anything.
    expect(mediaHeaders('image/png')['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(mediaHeaders('image/png')['referrer-policy']).toBe('no-referrer');
  });

  it('is immutably cacheable by default and can opt out', () => {
    expect(mediaHeaders('image/png')['cache-control']).toContain('immutable');
    expect(mediaHeaders('image/png', { immutable: false })['cache-control']).toBeUndefined();
  });

  it('sets content-length only when given one', () => {
    expect(mediaHeaders('image/png')['content-length']).toBeUndefined();
    expect(mediaHeaders('image/png', { bytes: 42 })['content-length']).toBe('42');
  });
});
