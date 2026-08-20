/**
 * Prefixed, type-branded ULIDs.
 *
 * WHY prefixed: every id that appears in a log line, a JSONB AST or a support ticket is
 * self-describing (Deliverable B §1). `qst_01J...` in a stack trace needs no lookup to know
 * what kind of thing it is, and a mask pointing at a `pg_` id is obviously wrong on sight.
 *
 * WHY branded: `Survey.content` is full of ids that are all `string` at runtime. Passing an
 * `OptionId` where a `QuestionId` belongs is the single easiest mistake to make in this
 * codebase and one of the hardest to see in review, because both values look like
 * `"opt_01J..."`/`"qst_01J..."` in a debugger. Branding moves that whole class of bug to
 * compile time. The ceremony (one cast at the parse boundary) is paid once here.
 *
 * WHY injectable clock and RNG: ids appear in serialized fixtures and in golden-file tests.
 * A factory seeded with a fixed clock and a fixed PRNG produces byte-identical output, which
 * is what makes the round-trip and rename tests assertable rather than approximate.
 *
 * The canonical wire format is Deliverable B's `app.ulid` domain:
 *
 *     ^[a-z]{2,5}_[0-7][0-9A-HJKMNP-TV-Z]{25}$
 *
 * i.e. a lowercase prefix, an underscore, then 26 Crockford base32 characters whose first
 * character is 0-7 because a 48-bit millisecond timestamp cannot overflow into the top bits
 * until the year 10889.
 */

/** Crockford base32: no I, L, O or U, so a transcribed id cannot be misread. */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_LEN = 10;
const RANDOM_LEN = 16;
const ULID_LEN = TIME_LEN + RANDOM_LEN;

/** The full ULID body, matching Deliverable B's `app.ulid` domain. */
export const ULID_BODY_PATTERN = '[0-7][0-9A-HJKMNP-TV-Z]{25}';
const ULID_BODY_RE = new RegExp(`^${ULID_BODY_PATTERN}$`);

/**
 * The prefix registry. Deliverable C §3 gives the ids; the extra `txt` comes from
 * Deliverable B §4.1's `content.node_kind`, which carries a `text` node for instruction
 * copy. Adding a member here is deliberately a two-line change (prefix + branded alias)
 * so a new node kind cannot slip in without an owner.
 */
export const ID_PREFIXES = {
  survey: 'svy',
  block: 'blk',
  page: 'pg',
  question: 'qst',
  text: 'txt',
  option: 'opt',
  variable: 'var',
  rule: 'rul',
  mask: 'msk',
  validation: 'val',
  design: 'dsn',
  asset: 'ast',
  flow_node: 'fn',
  quota_dimension: 'qd',
  quota_plan: 'qp',
  vendor: 'vnd',
} as const;

export type IdKind = keyof typeof ID_PREFIXES;
export type IdPrefix = (typeof ID_PREFIXES)[IdKind];

/** Every legal prefix, sorted longest-first so prefix matching is unambiguous. */
export const ALL_ID_PREFIXES: readonly IdPrefix[] = Object.values(ID_PREFIXES);

declare const ID_BRAND: unique symbol;

/**
 * A nominal id type. The brand exists only in the type system — at runtime this is a
 * plain string, so ids serialize and compare with no wrapper cost.
 */
export type Id<P extends IdPrefix> = string & { readonly [ID_BRAND]: P };

export type SurveyId = Id<'svy'>;
export type BlockId = Id<'blk'>;
export type PageId = Id<'pg'>;
export type QuestionId = Id<'qst'>;
export type TextNodeId = Id<'txt'>;
export type OptionId = Id<'opt'>;
export type VariableId = Id<'var'>;
export type RuleId = Id<'rul'>;
export type MaskId = Id<'msk'>;
export type ValidationId = Id<'val'>;
export type DesignId = Id<'dsn'>;
export type AssetId = Id<'ast'>;
export type FlowNodeId = Id<'fn'>;
export type QuotaDimensionId = Id<'qd'>;
export type QuotaPlanId = Id<'qp'>;
export type VendorId = Id<'vnd'>;

/** Any id, when the kind genuinely does not matter (diagnostics, generic walks). */
export type AnyId = Id<IdPrefix>;

/** Content-tree node ids. A parent may hold any of these. */
export type ContentNodeId = BlockId | PageId | QuestionId | TextNodeId;

export interface IdFactoryOptions {
  /** Milliseconds since epoch. Injected so fixtures are reproducible. */
  readonly now?: () => number;
  /** Uniform [0,1) source. Injected so fixtures are reproducible; never used for security. */
  readonly random?: () => number;
}

export interface IdFactory {
  /** Mint an id for a kind: `factory.next('question')` → `qst_01J...`. */
  next<K extends IdKind>(kind: K): Id<(typeof ID_PREFIXES)[K]>;
  /** Mint a bare ULID body, for callers that need one without a prefix (asset hashes, salts). */
  nextUlid(): string;
}

/**
 * A monotonic ULID generator.
 *
 * Monotonicity within a millisecond matters because ULIDs are used as sort keys in several
 * places (Deliverable B: "ULID lexicographic order is creation order"). Two ids minted in
 * the same millisecond must still order by creation, so the random tail is incremented
 * rather than re-drawn. A clock that jumps backwards is clamped forward for the same reason:
 * a backwards clock must never produce an id that sorts before one already issued.
 */
export function createIdFactory(options: IdFactoryOptions = {}): IdFactory {
  const now = options.now ?? (() => Date.now());
  const random = options.random ?? Math.random;

  let lastMs = -1;
  /** The random tail as base32 digit values, so increment-with-carry is exact. */
  let lastTail: number[] = [];

  const nextUlid = (): string => {
    const ms = now();
    const useMs = ms > lastMs ? ms : lastMs;

    if (useMs === lastMs && lastTail.length === RANDOM_LEN) {
      incrementTail(lastTail);
    } else {
      lastTail = drawTail(random);
    }
    lastMs = useMs;

    return encodeTime(useMs) + lastTail.map((d) => CROCKFORD[d] ?? '0').join('');
  };

  return {
    nextUlid,
    next<K extends IdKind>(kind: K): Id<(typeof ID_PREFIXES)[K]> {
      // The one unavoidable cast: branding is a type-level fiction, so the string has to be
      // asserted into the branded type exactly where it is constructed.
      return `${ID_PREFIXES[kind]}_${nextUlid()}` as Id<(typeof ID_PREFIXES)[K]>;
    },
  };
}

function drawTail(random: () => number): number[] {
  const tail: number[] = [];
  for (let i = 0; i < RANDOM_LEN; i += 1) {
    // Clamp: a custom RNG returning exactly 1 must not index past the alphabet.
    const r = Math.min(Math.max(random(), 0), 0.999999999);
    tail.push(Math.floor(r * 32));
  }
  return tail;
}

/** Increment the base32 tail in place, with carry. Overflow wraps, which is astronomically rare. */
function incrementTail(tail: number[]): void {
  for (let i = tail.length - 1; i >= 0; i -= 1) {
    const digit = tail[i] ?? 0;
    if (digit < 31) {
      tail[i] = digit + 1;
      return;
    }
    tail[i] = 0;
  }
}

function encodeTime(ms: number): string {
  let remaining = Math.floor(ms);
  const out: string[] = [];
  for (let i = 0; i < TIME_LEN; i += 1) {
    out.push(CROCKFORD[remaining % 32] ?? '0');
    remaining = Math.floor(remaining / 32);
  }
  return out.reverse().join('');
}

/** The prefix of an id, or `null` if the string is not a well-formed prefixed ULID. */
export function idPrefixOf(value: string): IdPrefix | null {
  const underscore = value.indexOf('_');
  if (underscore < 0) return null;
  const prefix = value.slice(0, underscore);
  const body = value.slice(underscore + 1);
  if (body.length !== ULID_LEN || !ULID_BODY_RE.test(body)) return null;
  return ALL_ID_PREFIXES.find((p) => p === prefix) ?? null;
}

/** True when `value` is a well-formed id with any known prefix. */
export function isAnyId(value: unknown): value is AnyId {
  return typeof value === 'string' && idPrefixOf(value) !== null;
}

/** True when `value` is a well-formed id with exactly this prefix. */
export function isId<P extends IdPrefix>(prefix: P, value: unknown): value is Id<P> {
  return typeof value === 'string' && idPrefixOf(value) === prefix;
}

export type IdParseResult<P extends IdPrefix> =
  | { readonly ok: true; readonly id: Id<P> }
  | { readonly ok: false; readonly reason: 'malformed' | 'wrong_prefix' };

/**
 * Parse a string into a branded id. Returns a result rather than throwing because the
 * caller is usually validating untrusted JSON and wants a diagnostic, not an exception.
 */
export function parseId<P extends IdPrefix>(prefix: P, value: unknown): IdParseResult<P> {
  if (typeof value !== 'string') return { ok: false, reason: 'malformed' };
  const actual = idPrefixOf(value);
  if (actual === null) return { ok: false, reason: 'malformed' };
  if (actual !== prefix) return { ok: false, reason: 'wrong_prefix' };
  // Guarded by idPrefixOf above; the cast only re-attaches the brand.
  return { ok: true, id: value as Id<P> };
}

/**
 * Assert a literal into a branded id. Intended for fixtures, tests and the JSON parse
 * boundary, where the shape has already been validated. Throws on a malformed id so a bad
 * fixture fails loudly at load rather than producing a survey with a broken reference.
 */
export function asId<P extends IdPrefix>(prefix: P, value: string): Id<P> {
  const parsed = parseId(prefix, value);
  if (!parsed.ok) {
    throw new Error(`Not a valid ${prefix}_ id: ${JSON.stringify(value)} (${parsed.reason})`);
  }
  return parsed.id;
}

/**
 * The human handle pattern from Deliverable B's `app.ref` domain. Refs must start with a
 * letter because they become variable names and export column headers, and a column named
 * `1` is not addressable in SQL, SPSS or a spreadsheet formula.
 */
export const REF_PATTERN = '[A-Za-z][A-Za-z0-9_]{0,63}';
const REF_RE = new RegExp(`^${REF_PATTERN}$`);

export function isValidRef(value: unknown): value is string {
  return typeof value === 'string' && REF_RE.test(value);
}
