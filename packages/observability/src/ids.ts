/**
 * Identifier generation for correlation ids, trace ids and span ids.
 *
 * WHY hand-rolled: `@resscript/observability` is imported by `apps/runtime`, which sits on
 * the respondent critical path (arch §3.3, §8: p95 page render < 300 ms). ADR-010 keeps that
 * dependency tree near-empty on purpose, so this package carries ZERO runtime dependencies.
 * That rules out `ulid`, `uuid`, `nanoid` and the OpenTelemetry SDK, all of which we would
 * otherwise reach for. The code below is the entire cost of that decision.
 *
 * WHY the Web Crypto API rather than `node:crypto`: `globalThis.crypto` is a standard in both
 * Node >= 19 (this repo requires >= 22) and every browser we support, so the same module works
 * in the studio's client bundle, the runtime server, and a Cloudflare-style edge worker without
 * a Node builtin import that a bundler would have to polyfill.
 */

/** Crockford base32, ULID's alphabet: no I, L, O or U, so a human can read an id aloud. */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const HEX = '0123456789abcdef';

/** ULID: 10 chars of 48-bit millisecond timestamp, 16 chars of 80-bit randomness. */
const ULID_TIME_CHARS = 10;
const ULID_RANDOM_CHARS = 16;
const ULID_RANDOM_BYTES = 10;

/**
 * Cross-platform random bytes.
 *
 * The fallback exists so that a bundle which strips crypto (a stray jsdom setup, an ancient
 * runtime) degrades to a working-but-weaker id instead of throwing inside a logger. Correlation
 * ids are not secrets — nothing authenticates on them — so a degraded id is a debuggability
 * problem, not a security one. Anything that IS a secret must use node:crypto directly.
 */
function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  // Typed structurally rather than as `Crypto`: the base tsconfig's lib is ES2022 with no DOM,
  // so the `Crypto` interface is not in scope, and referencing @types/node's `webcrypto.Crypto`
  // would make this module import a Node builtin — the one thing it must not do.
  const webcrypto = (globalThis as { crypto?: { getRandomValues?<T extends ArrayBufferView>(a: T): T } })
    .crypto;
  if (webcrypto !== undefined && typeof webcrypto.getRandomValues === 'function') {
    webcrypto.getRandomValues(out);
    return out;
  }
  for (let i = 0; i < n; i += 1) {
    out[i] = Math.floor(Math.random() * 256);
  }
  return out;
}

function encodeTime(ms: number): string {
  let remaining = ms;
  let out = '';
  for (let i = 0; i < ULID_TIME_CHARS; i += 1) {
    const mod = remaining % 32;
    // `?? '0'` is dead at runtime (mod is always 0..31) but required by
    // noUncheckedIndexedAccess, which is on for the whole repo.
    out = (CROCKFORD[mod] ?? '0') + out;
    remaining = (remaining - mod) / 32;
  }
  return out;
}

function encodeRandom(bytes: Uint8Array): string {
  // 10 bytes = 80 bits = exactly 16 base32 characters, so we can stream 5 bits at a time
  // without padding. Accumulate into a bit buffer rather than doing BigInt math.
  let out = '';
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    acc = (acc << 8) | (bytes[i] ?? 0);
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += CROCKFORD[(acc >>> bits) & 31] ?? '0';
    }
  }
  return out;
}

/** Monotonic guard state, so two ULIDs minted in the same millisecond still sort correctly. */
let lastMs = -1;
let lastRandom: Uint8Array = new Uint8Array(ULID_RANDOM_BYTES);

/**
 * A monotonic ULID.
 *
 * Monotonicity matters here because `ops.jobs.id` and `app.audit_log` ids are ULIDs and both
 * are read back in creation order by primary key (DB §10, §10.1). Two rows inserted in the
 * same millisecond that sort backwards would silently reorder a job list or an audit trail.
 */
export function ulid(nowMs: number = Date.now()): string {
  if (nowMs === lastMs) {
    // Same millisecond: increment the previous randomness as an 80-bit big-endian integer.
    const next = Uint8Array.from(lastRandom);
    for (let i = next.length - 1; i >= 0; i -= 1) {
      const b = next[i] ?? 0;
      if (b === 0xff) {
        next[i] = 0;
        continue;
      }
      next[i] = b + 1;
      break;
    }
    lastRandom = next;
  } else {
    lastMs = nowMs;
    lastRandom = randomBytes(ULID_RANDOM_BYTES);
  }
  return encodeTime(nowMs) + encodeRandom(lastRandom);
}

/** Prefixed ids per schema §2 / API §1.5 (`req_01JC8KX9…`). */
export function prefixedId(prefix: string, nowMs: number = Date.now()): string {
  return `${prefix}_${ulid(nowMs)}`;
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    const b = bytes[i] ?? 0;
    out += (HEX[(b >>> 4) & 15] ?? '0') + (HEX[b & 15] ?? '0');
  }
  return out;
}

/** W3C trace-context trace-id: 16 bytes, lowercase hex, never all zeroes. */
export function newTraceId(): string {
  for (;;) {
    const hex = toHex(randomBytes(16));
    if (!/^0{32}$/.test(hex)) return hex;
  }
}

/** W3C trace-context span-id: 8 bytes, lowercase hex, never all zeroes. */
export function newSpanId(): string {
  for (;;) {
    const hex = toHex(randomBytes(8));
    if (!/^0{16}$/.test(hex)) return hex;
  }
}

export const INVALID_TRACE_ID = '0'.repeat(32);
export const INVALID_SPAN_ID = '0'.repeat(16);

export function isValidTraceId(v: string): boolean {
  return /^[0-9a-f]{32}$/.test(v) && v !== INVALID_TRACE_ID;
}

export function isValidSpanId(v: string): boolean {
  return /^[0-9a-f]{16}$/.test(v) && v !== INVALID_SPAN_ID;
}

/** Exposed for tests only: resets the monotonic ULID guard. */
export function __resetUlidState(): void {
  lastMs = -1;
  lastRandom = new Uint8Array(ULID_RANDOM_BYTES);
}
