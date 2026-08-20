/**
 * Log redaction.
 *
 * Security §8.1 is explicit about the mechanism and about why the obvious alternative is
 * wrong: "Redaction is done with a tainted-value type rather than a regex over log output,
 * because regex-based scrubbing fails the first time someone JSON-stringifies a nested
 * object." So there are two independent layers here, and both are needed:
 *
 *  1. `tainted(value)` — an explicit wrapper. Any value read from a `pii: true` variable
 *     (schema §4) is wrapped at the point it enters application code, and it serializes as
 *     `[redacted]` no matter how deeply it is later nested. This is the layer that makes an
 *     accidental `log.info('state', { vars })` safe by construction.
 *  2. A key denylist — a structural pass over the log fields that drops anything whose KEY
 *     looks like a credential or a direct identifier (`authorization`, `api_key`, `email`).
 *     This is the backstop for values nobody remembered to wrap: header bags, request bodies,
 *     third-party error objects.
 *
 * The denylist matches on key NAMES, never on value contents. Content scanning belongs at the
 * response-write boundary (security §8.2's detector), not in the logger, where it would cost
 * CPU on the respondent critical path and produce false positives that mangle survey refs.
 *
 * An allowlist sits above the denylist because some safe fields collide with the patterns:
 * `email_domain` and `email_hash` are aggregate/hashed and are exactly what an operator needs
 * during an incident, while `email` is not. Allowlist wins over denylist, deliberately, so a
 * team can opt a specific derived field back in without weakening the pattern for everyone.
 */

export const REDACTED = '[redacted]';

const TAINTED = Symbol.for('resscript.observability.tainted');

/** A value that must never reach a log line, a trace, or an outbound payload. */
export interface Tainted<T = unknown> {
  readonly [TAINTED]: true;
  /** Optional label, e.g. a variable name, so a log reads `[pii:Q12_email]` (security §8.1). */
  readonly label?: string;
  /**
   * The wrapped value. Reading it is a deliberate act that greps as one: search the codebase
   * for `.unsafeUnwrap` and you have the complete list of places PII is handled in the clear.
   */
  unsafeUnwrap(): T;
}

/** Wrap a PII-flagged value. The wrapper is what makes `log({ vars })` safe by construction. */
export function tainted<T>(value: T, label?: string): Tainted<T> {
  const wrapper: Tainted<T> = {
    [TAINTED]: true,
    ...(label === undefined ? {} : { label }),
    unsafeUnwrap: () => value,
  };
  return wrapper;
}

export function isTainted(v: unknown): v is Tainted {
  return typeof v === 'object' && v !== null && (v as Record<symbol, unknown>)[TAINTED] === true;
}

function taintedPlaceholder(v: Tainted): string {
  return v.label === undefined ? REDACTED : `[pii:${v.label}]`;
}

/**
 * Key patterns that are redacted unless explicitly allowlisted.
 *
 * Grouped by what they protect, because "why is this on the list" is the question a reviewer
 * asks and the answer is not always obvious:
 *  - credentials: leaking these in a log aggregator is a live compromise;
 *  - direct identifiers: GDPR-relevant respondent data (security §8.1);
 *  - vendor secrets: security §5 keeps HMAC keys in a secrets manager referenced by
 *    `secret_ref`; the referenced VALUE must never be logged even if code loads it.
 */
export const DEFAULT_DENY_PATTERNS: readonly RegExp[] = Object.freeze([
  // Credentials and secrets.
  /(^|_|\.|-)(pass|passwd|password|passphrase)($|_|\.|-)/i,
  /secret/i,
  /token/i,
  /^authorization$/i,
  /^proxy-authorization$/i,
  /api[-_]?key/i,
  /(^|_|\.|-)key($|_|\.|-)/i,
  /credential/i,
  /^cookie$/i,
  /^set-cookie$/i,
  /bearer/i,
  /signature/i,
  /(^|_|\.|-)hmac($|_|\.|-)/i,
  /private[-_]?key/i,
  /^otp$/i,
  /(^|_|\.|-)(totp|mfa_code|recovery_code)($|_|\.|-)/i,
  // Direct identifiers (security §8.1).
  /e[-_]?mail/i,
  /phone/i,
  /msisdn/i,
  /(^|_|\.|-)(ssn|nino|nin|national_id)($|_|\.|-)/i,
  /passport/i,
  /iban/i,
  /credit[-_]?card/i,
  /(^|_|\.|-)(pan|cvv|cvc)($|_|\.|-)/i,
  /(^|_|\.|-)(first_name|last_name|full_name|surname|given_name)($|_|\.|-)/i,
  /(^|_|\.|-)(address|street|postcode|postal_code|zip)($|_|\.|-)/i,
  /(^|_|\.|-)dob($|_|\.|-)/i,
  /date[-_]?of[-_]?birth/i,
  // Free text from respondents. An open end is the single most likely place for unflagged PII
  // (security §8.2), so its raw value is never a log field.
  /(^|_|\.|-)(verbatim|open_end|open_ends)($|_|\.|-)/i,
]);

/**
 * Keys that match a deny pattern but are safe and operationally valuable.
 *
 * `ip_hash` and `email_hash` are per-survey HMACs (security §8.3) — unlinkable across studies
 * and the only handle we have for duplicate detection. `secret_ref` is a POINTER into the
 * secrets manager (security §5); logging it is how you debug a misconfigured vendor, and it
 * carries no key material. `*_key_id` names a key without being one.
 */
export const DEFAULT_ALLOW_KEYS: readonly string[] = Object.freeze([
  'secret_ref',
  'key_id',
  'signing_key_id',
  'api_key_id',
  'email_domain',
  'email_hash',
  'ip_hash',
  'phone_hash',
  'idempotency_key',
  'export_col_key',
  'entitlement_key',
  'feature_key',
  'sort_key',
  'cache_key',
  'partition_key',
]);

export interface RedactionPolicy {
  readonly denyPatterns: readonly RegExp[];
  readonly allowKeys: ReadonlySet<string>;
  /** Depth beyond which a value is replaced by `[max_depth]`. Bounds log line size. */
  readonly maxDepth: number;
  /** Array elements beyond this are summarised as `[+N more]`. */
  readonly maxArrayLength: number;
  /** Strings longer than this are truncated with a `…(+N)` marker. */
  readonly maxStringLength: number;
}

export const DEFAULT_REDACTION_POLICY: RedactionPolicy = Object.freeze({
  denyPatterns: DEFAULT_DENY_PATTERNS,
  allowKeys: new Set(DEFAULT_ALLOW_KEYS),
  maxDepth: 8,
  maxArrayLength: 100,
  maxStringLength: 4096,
});

export function createRedactionPolicy(overrides: Partial<RedactionPolicy> = {}): RedactionPolicy {
  return Object.freeze({ ...DEFAULT_REDACTION_POLICY, ...overrides });
}

/** True when a field with this key must be replaced by a placeholder. */
export function isDeniedKey(key: string, policy: RedactionPolicy = DEFAULT_REDACTION_POLICY): boolean {
  if (policy.allowKeys.has(key)) return false;
  return policy.denyPatterns.some((p) => p.test(key));
}

function truncateString(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…(+${s.length - max})`;
}

/**
 * Serialise an Error without letting a `cause` chain or an enumerable property smuggle a
 * secret through. `stack` is kept because it is the whole point of logging an error; stack
 * frames contain file paths and argument-free frames, not values.
 */
function errorToObject(e: Error): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: e.name,
    message: e.message,
  };
  if (typeof e.stack === 'string') out['stack'] = e.stack;
  // AppError and friends expose structured context via toJSON; merge it so `code`/`status`
  // land as first-class fields and go through the same redaction pass as everything else.
  const maybeJson = (e as unknown as { toJSON?: () => unknown }).toJSON;
  if (typeof maybeJson === 'function') {
    const j = maybeJson.call(e);
    if (typeof j === 'object' && j !== null && !Array.isArray(j)) {
      Object.assign(out, j as Record<string, unknown>);
    }
  }
  if (e.cause !== undefined && e.cause !== null) out['cause'] = e.cause;
  return out;
}

/**
 * Produce a JSON-safe, redacted copy of `value`.
 *
 * Returns a fresh structure — the input is never mutated, because callers pass live
 * application state and a logger that edits its arguments is a debugging nightmare.
 */
export function redact(
  value: unknown,
  policy: RedactionPolicy = DEFAULT_REDACTION_POLICY,
): unknown {
  return walk(value, policy, 0, new WeakSet<object>());
}

function walk(
  value: unknown,
  policy: RedactionPolicy,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (isTainted(value)) return taintedPlaceholder(value);

  switch (typeof value) {
    case 'undefined':
      // JSON.stringify drops undefined properties silently; making it explicit is the
      // difference between "field absent" and "field present and unset" during an incident.
      return '[undefined]';
    case 'boolean':
    case 'number':
      return Number.isFinite(value as number) || typeof value === 'boolean'
        ? value
        : String(value);
    case 'string':
      return truncateString(value, policy.maxStringLength);
    case 'bigint':
      return `${value.toString()}n`;
    case 'symbol':
      return value.toString();
    case 'function':
      return `[function ${(value as { name?: string }).name ?? 'anonymous'}]`;
    case 'object':
      break;
    default: {
      const exhaustive: never = value as never;
      return String(exhaustive);
    }
  }

  if (value === null) return null;
  const obj = value as object;

  if (depth >= policy.maxDepth) return '[max_depth]';
  if (seen.has(obj)) return '[circular]';
  seen.add(obj);
  try {
    if (value instanceof Date) return value.toISOString();
    if (value instanceof RegExp) return value.toString();
    if (value instanceof Error) return walk(errorToObject(value), policy, depth + 1, seen);
    if (value instanceof Map) {
      return walk(Object.fromEntries(value.entries()), policy, depth, seen);
    }
    if (value instanceof Set) {
      return walk([...value.values()], policy, depth, seen);
    }
    if (Array.isArray(value)) {
      const slice = value.slice(0, policy.maxArrayLength);
      const out: unknown[] = slice.map((v) => walk(v, policy, depth + 1, seen));
      if (value.length > policy.maxArrayLength) {
        out.push(`[+${value.length - policy.maxArrayLength} more]`);
      }
      return out;
    }

    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record)) {
      if (isDeniedKey(key, policy)) {
        out[key] = REDACTED;
        continue;
      }
      out[key] = walk(record[key], policy, depth + 1, seen);
    }
    return out;
  } finally {
    // Release the node once its subtree is done. Keeping it in `seen` for the whole walk
    // would report a legitimately shared (diamond) reference as circular.
    seen.delete(obj);
  }
}
