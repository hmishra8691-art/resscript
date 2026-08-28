/**
 * What a media file actually IS, decided from its bytes (security §4, roadmap P2-12).
 *
 * ## Why the client's Content-Type is not evidence
 *
 * It is a string the uploader chose. A file named `logo.png`, declared `image/png`, containing an
 * HTML document is an XSS on the media origin the moment a browser sniffs it — which browsers did
 * for years and some still do for some types. So the type is determined here, from magic bytes, and
 * the declared type is used for exactly one thing: noticing that it disagrees, which is worth
 * logging because it is either a broken uploader or an attempt.
 *
 * ## The SVG rule, stated once
 *
 * `image/svg+xml` is not in the allowlist and never will be by this route. An SVG is an XML
 * DOCUMENT that can carry `<script>`, `onload`, and external references — security §4 lists `<svg>`
 * among the tags the HTML sanitizer strips outright for that reason. "It is an image" is true of the
 * rendering and false of the security model, and the media origin serves files to browsers.
 *
 * A client that needs vector art rasterizes it. That is a real cost and it is smaller than a
 * scriptable document on an origin that serves respondent-facing bytes.
 *
 * ## Sniffing is a prefix match, deliberately shallow
 *
 * Enough bytes to identify a container, and no attempt to validate the whole file. A deep parser
 * would be a second attack surface (image parsers are a classic CVE source) for a guarantee this
 * does not need: the question is "is this the type it claims", not "is this file well-formed". A
 * malformed PNG is a broken image, which is the author's problem; a PNG that is really an HTML
 * document is ours.
 *
 * ## Everything not an image, video or audio is served as a download
 *
 * Security §4's rule. A PDF rendered inline runs in the origin's context in some viewers, so it gets
 * `Content-Disposition: attachment` — see `mediaHeaders`.
 */

/** The types the media origin will serve. `image/svg+xml` is absent by design — see the header. */
export const ALLOWED_MEDIA_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'video/mp4',
  'video/webm',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'application/pdf',
] as const;

export type MediaType = (typeof ALLOWED_MEDIA_TYPES)[number];

/**
 * Magic-byte signatures, longest-prefix first where two share a lead.
 *
 * `offset` because several container formats put their identifier after a length field: RIFF (WEBP,
 * WAV) and ISO-BMFF (MP4, AVIF) both do, and matching only at offset 0 would identify a WEBP as a
 * generic RIFF and then fail.
 */
const SIGNATURES: readonly {
  readonly mime: MediaType;
  readonly offset: number;
  readonly bytes: readonly number[];
}[] = [
  { mime: 'image/png', offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: 'image/jpeg', offset: 0, bytes: [0xff, 0xd8, 0xff] },
  // GIF87a and GIF89a share the first five bytes, which is enough.
  { mime: 'image/gif', offset: 0, bytes: [0x47, 0x49, 0x46, 0x38] },
  // RIFF....WEBP — the four length bytes at offset 4 are skipped by matching at 8.
  { mime: 'image/webp', offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] },
  // RIFF....WAVE
  { mime: 'audio/wav', offset: 8, bytes: [0x57, 0x41, 0x56, 0x45] },
  // ISO-BMFF: `....ftyp` then a brand. `avif` and the mp4 brands share the ftyp box.
  { mime: 'image/avif', offset: 4, bytes: [0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66] },
  { mime: 'video/mp4', offset: 4, bytes: [0x66, 0x74, 0x79, 0x70] },
  // EBML — WebM and Matroska share it; the DocType would distinguish them and the distinction does
  // not matter here, because both are served identically and neither is scriptable.
  { mime: 'video/webm', offset: 0, bytes: [0x1a, 0x45, 0xdf, 0xa3] },
  { mime: 'audio/ogg', offset: 0, bytes: [0x4f, 0x67, 0x67, 0x53] },
  { mime: 'application/pdf', offset: 0, bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] },
  // MP3: an ID3 tag, or a bare frame sync. Both spellings are common in the wild.
  { mime: 'audio/mpeg', offset: 0, bytes: [0x49, 0x44, 0x33] },
  { mime: 'audio/mpeg', offset: 0, bytes: [0xff, 0xfb] },
  { mime: 'audio/mpeg', offset: 0, bytes: [0xff, 0xf3] },
  { mime: 'audio/mpeg', offset: 0, bytes: [0xff, 0xf2] },
];

export type SniffResult =
  | { readonly ok: true; readonly mime: MediaType }
  | {
      readonly ok: false;
      /** `unrecognised` | `not_allowed` — a scriptable or unknown container. */
      readonly reason: 'unrecognised' | 'not_allowed';
      /** What it appears to be, when that is worth logging. `svg`, `html`, `xml`, or null. */
      readonly looksLike: string | null;
    };

/**
 * Shapes that are actively dangerous on a media origin, recognised so the refusal can say WHY.
 *
 * Not needed for correctness — anything unrecognised is refused anyway — but a message that says
 * "this looks like an SVG, which cannot be served as media" is one an author acts on, where
 * "unrecognised file type" invites them to try again with a different extension.
 */
const DANGEROUS_PREFIXES: readonly { readonly label: string; readonly text: string }[] = [
  { label: 'svg', text: '<svg' },
  { label: 'html', text: '<!doctype html' },
  { label: 'html', text: '<html' },
  { label: 'xml', text: '<?xml' },
];

function matches(buf: Uint8Array, sig: { offset: number; bytes: readonly number[] }): boolean {
  if (buf.length < sig.offset + sig.bytes.length) return false;
  for (let i = 0; i < sig.bytes.length; i += 1) {
    if (buf[sig.offset + i] !== sig.bytes[i]) return false;
  }
  return true;
}

/**
 * Determine a media type from the leading bytes.
 *
 * `bytes` needs only the first ~32; a caller streaming an upload can decide before reading the rest,
 * which is the point — refusing a 4 GB file after storing it is not a refusal.
 */
export function sniffMediaType(bytes: Uint8Array): SniffResult {
  for (const sig of SIGNATURES) {
    if (matches(bytes, sig)) return { ok: true, mime: sig.mime };
  }

  // Nothing matched. Look for a shape worth naming, over the leading bytes only, lowercased and
  // with leading whitespace skipped — an XML document with a BOM or a newline first is still an XML
  // document, and a check anchored strictly at byte 0 would miss it.
  const head = new TextDecoder('utf-8', { fatal: false })
    .decode(bytes.subarray(0, 64))
    .replace(/^﻿/, '')
    .trimStart()
    .toLowerCase();
  for (const d of DANGEROUS_PREFIXES) {
    if (head.startsWith(d.text)) return { ok: false, reason: 'not_allowed', looksLike: d.label };
  }
  return { ok: false, reason: 'unrecognised', looksLike: null };
}

/**
 * Response headers for serving one media object.
 *
 * `nosniff` unconditionally, and `attachment` for anything a browser should not render in the
 * origin's context. Security §4 requires both; the second is what stops a PDF viewer executing in
 * the media origin, which is why the split is by whether the type is displayable rather than by
 * whether it is "safe".
 */
export function mediaHeaders(
  mime: MediaType,
  opts: { readonly bytes?: number; readonly immutable?: boolean } = {},
): Record<string, string> {
  const displayable =
    mime.startsWith('image/') || mime.startsWith('video/') || mime.startsWith('audio/');
  return {
    'content-type': mime,
    // Unconditional. A browser that sniffs a mislabelled file is the whole reason the type is
    // determined from bytes, and this is the header that tells it not to try.
    'x-content-type-options': 'nosniff',
    ...(displayable ? {} : { 'content-disposition': 'attachment' }),
    // A media object is addressed by its content hash, so `immutable` is a statement of fact — the
    // same argument the theme stylesheet's route makes.
    ...(opts.immutable === false ? {} : { 'cache-control': 'public, max-age=31536000, immutable' }),
    ...(opts.bytes === undefined ? {} : { 'content-length': String(opts.bytes) }),
    // A media origin serves no HTML and needs no scripts, so the strictest CSP that still allows an
    // image to render. Belt-and-braces over `nosniff`: if a browser did sniff a document out of
    // these bytes, this is what stops it doing anything.
    'content-security-policy': "default-src 'none'; sandbox",
    'referrer-policy': 'no-referrer',
  };
}
