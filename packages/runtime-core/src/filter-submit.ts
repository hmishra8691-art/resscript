/**
 * The anti-tamper filter — E §5 step 3, verbatim.
 *
 * The threat (E §6): a respondent, or a bot farm optimizing for incentive payout, edits the
 * DOM or crafts a POST to skip a screener, unhide a question, or select a masked option. The
 * defence is structural — the server recomputed what was shown (step 2, from STORED state,
 * ignoring every client claim) and this filter discards anything inconsistent with it. There
 * is no signed form to forge and no hidden field to flip, because the client's verdicts are
 * advisory by design (ADR-004).
 *
 * Every rejection is RECORDED, never merely dropped: `rejected` feeds the event's
 * `rejected_values` column, which is what turns "someone DOM-edited the screener" into a
 * queryable fact, and the >N-rejections threshold into a quality flag the survey owner can
 * act on. Discarded means discarded — a rejected value must never reach `vars`, the document,
 * or a derived recomputation.
 *
 * Pure and shared with the client (which runs it for UX so a to-be-rejected value never even
 * leaves the form), which is why the manifest and the verdicts arrive as data.
 */

export type RejectReason =
  | 'unknown_variable'
  | 'non_response_write'
  | 'hidden_question_value'
  | 'not_on_this_page'
  | 'masked_option_value'
  | 'option_not_selectable'
  | 'type_violation'
  | 'text_truncated';

export interface ManifestVariableLike {
  readonly id: string;
  readonly name: string;
  readonly kind: string;              // response | hidden | derived | system | quota | design
  readonly type: string;              // enum | boolean | number | text | date | set | object
  readonly enum_domain?: readonly { readonly code: number }[] | null;
  readonly pii?: boolean;
}

export interface FilterInput {
  /** What the client POSTed, keyed by variable id or name. */
  readonly submitted: { readonly [key: string]: unknown };
  /** The artifact's variable manifest — the closed world of writable names. */
  readonly manifest: readonly ManifestVariableLike[];
  /** variable id → the question that emits it (from the page's `emits`). */
  readonly ownerQuestion: (variableId: string) => string | undefined;
  /** Questions on THIS page. Cross-page writes are rejected: E §6's one-page-per-POST rule. */
  readonly pageQuestions: ReadonlySet<string>;
  /** Questions the authoritative evaluation says were shown (E §5 step 2). */
  readonly shown: ReadonlySet<string>;
  /** The surviving item codes per question axis, post-mask; null = no items axis. */
  readonly itemsFor: (questionId: string) => readonly number[] | null;
  /** Per-option selectability, from the option-state cells. Absent option = selectable. */
  readonly optionSelectable?: (questionId: string, code: number) => boolean;
  /** Text length cap per declared max; default when the artifact declares none. */
  readonly defaultMaxTextLength?: number;
}

export interface Rejection {
  readonly variable: string;
  readonly reason: RejectReason;
  /** The client's claimed value, kept as evidence. Truncated so the EVENT stays bounded. */
  readonly claimed: unknown;
}

export interface FilterResult {
  /** The values that survive, keyed by variable id, coerced to their declared type. */
  readonly accepted: { readonly [variableId: string]: unknown };
  readonly rejected: readonly Rejection[];
  /** Variables written by accepted values — the visit's `wrote` set. */
  readonly wrote: readonly string[];
}

const DEFAULT_MAX_TEXT = 10_000;

/** Bounded evidence: a 5 MB "claimed value" must not become a 5 MB event row. */
function evidence(value: unknown): unknown {
  if (typeof value === 'string' && value.length > 256) return value.slice(0, 256) + '…';
  if (Array.isArray(value) && value.length > 32) return value.slice(0, 32);
  return value;
}

/**
 * Coerce a raw submitted value to the declared type, or return `undefined` for a value that
 * cannot be coerced. Coercion is deliberately narrow — form posts arrive as strings, so
 * '3' -> 3 for a number is transport repair, but {} -> anything is a violation.
 */
function coerce(decl: ManifestVariableLike, raw: unknown): unknown {
  switch (decl.type) {
    case 'number': {
      if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
      if (typeof raw === 'string' && raw.trim() !== '') {
        const n = Number(raw);
        if (Number.isFinite(n)) return n;
      }
      return undefined;
    }
    case 'enum': {
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
      if (!Number.isInteger(n)) return undefined;
      // An enum outside its declared domain is a type violation even before masking: the
      // domain is the codebook, and a code the codebook lacks corrupts the export.
      const domain = decl.enum_domain;
      if (domain && domain.length > 0 && !domain.some(e => e.code === n)) return undefined;
      return n;
    }
    case 'set': {
      const arr = Array.isArray(raw) ? raw : raw === null || raw === undefined ? [] : [raw];
      const out: number[] = [];
      for (const item of arr) {
        const n = typeof item === 'number' ? item : typeof item === 'string' ? Number(item) : NaN;
        if (!Number.isInteger(n)) return undefined;
        const domain = decl.enum_domain;
        if (domain && domain.length > 0 && !domain.some(e => e.code === n)) return undefined;
        if (!out.includes(n)) out.push(n); // a set has no duplicates; the transport may
      }
      return out;
    }
    case 'boolean': {
      if (typeof raw === 'boolean') return raw;
      if (raw === 'true' || raw === '1' || raw === 1) return true;
      if (raw === 'false' || raw === '0' || raw === 0) return false;
      return undefined;
    }
    case 'text':
      return typeof raw === 'string' ? raw : undefined;
    case 'date': {
      if (typeof raw !== 'string') return undefined;
      // ISO date or instant; the model has no local timestamps by design (schema common.ts).
      return /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z)?$/.test(raw) ? raw : undefined;
    }
    default:
      // 'object' and any plugin-declared type pass through untyped; the plugin's own
      // config-schema validation is the authority for those shapes.
      return raw;
  }
}

export function filterSubmit(input: FilterInput): FilterResult {
  const accepted: { [variableId: string]: unknown } = {};
  const rejected: Rejection[] = [];
  const wrote: string[] = [];

  const byId = new Map(input.manifest.map(v => [v.id, v]));
  const byName = new Map(input.manifest.map(v => [v.name, v]));
  const maxText = input.defaultMaxTextLength ?? DEFAULT_MAX_TEXT;

  for (const [key, raw] of Object.entries(input.submitted)) {
    const decl = byId.get(key) ?? byName.get(key);

    // E §5 step 3, in the spec's order — each check names its rejection so the event log
    // reads as a diagnosis, not a boolean.
    if (!decl) {
      rejected.push({ variable: key, reason: 'unknown_variable', claimed: evidence(raw) });
      continue;
    }
    if (decl.kind !== 'response') {
      // A POST that writes a hidden, derived, quota or system variable is a respondent
      // reaching for state the protocol never offered them (roadmap P1-10's
      // manifest-violation test injects `disposition` — that dies above as unknown; a real
      // hidden variable dies here).
      rejected.push({ variable: decl.id, reason: 'non_response_write', claimed: evidence(raw) });
      continue;
    }

    const question = input.ownerQuestion(decl.id);
    if (!question || !input.pageQuestions.has(question)) {
      // E §6's hardening: each POST names one page and can only write variables emitted by
      // questions ON that page. Cross-page writes would let a submit influence the very
      // visibility recomputation that is about to judge it.
      rejected.push({ variable: decl.id, reason: 'not_on_this_page', claimed: evidence(raw) });
      continue;
    }
    if (!input.shown.has(question)) {
      rejected.push({ variable: decl.id, reason: 'hidden_question_value', claimed: evidence(raw) });
      continue;
    }

    let value = coerce(decl, raw);
    if (value === undefined) {
      rejected.push({ variable: decl.id, reason: 'type_violation', claimed: evidence(raw) });
      continue;
    }

    // Masked options: an enum code must be among the SURVIVING items, and a set must not
    // smuggle one masked code among valid ones — the whole array is the answer, so the
    // masked member is stripped and recorded rather than the answer discarded wholesale.
    const items = input.itemsFor(question);
    if (items !== null && decl.type === 'enum' && typeof value === 'number') {
      if (!items.includes(value)) {
        rejected.push({ variable: decl.id, reason: 'masked_option_value', claimed: evidence(raw) });
        continue;
      }
      if (input.optionSelectable && !input.optionSelectable(question, value)) {
        rejected.push({
          variable: decl.id,
          reason: 'option_not_selectable',
          claimed: evidence(raw),
        });
        continue;
      }
    }
    if (items !== null && decl.type === 'set' && Array.isArray(value)) {
      const inItems = (value as number[]).filter(c => items.includes(c));
      const selectable = input.optionSelectable
        ? inItems.filter(c => input.optionSelectable!(question, c))
        : inItems;
      if (selectable.length !== (value as number[]).length) {
        rejected.push({
          variable: decl.id,
          reason: 'masked_option_value',
          claimed: evidence((value as number[]).filter(c => !selectable.includes(c))),
        });
      }
      if (selectable.length === 0 && (value as number[]).length > 0) continue;
      value = selectable;
    }

    // Text overflow truncates AND records, per E §5 step 3 — the respondent's answer is
    // worth keeping up to the cap, and the truncation must be visible in the log because a
    // systematically truncated open-end is a fielding defect someone needs to see.
    if (decl.type === 'text' && typeof value === 'string' && value.length > maxText) {
      rejected.push({ variable: decl.id, reason: 'text_truncated', claimed: value.length });
      value = value.slice(0, maxText);
    }

    accepted[decl.id] = value;
    wrote.push(decl.id);
  }

  return { accepted, rejected, wrote };
}
