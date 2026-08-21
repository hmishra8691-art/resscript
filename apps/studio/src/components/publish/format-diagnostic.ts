/**
 * One compile diagnostic, turned into something a survey programmer can act on.
 *
 * WHY THIS EXISTS. `CompileDiagnostic.detail` is where the ids and the flow positions live — for
 * `LGC-F001` that is both variables, the rule, both questions and both page indexes — and it is
 * the only part of the diagnostic that says *which* objects are involved. `message` names some of
 * them in prose but the gate writes that prose once, for a log line and a CI report, and the
 * dialog needs the same facts as a sentence with the ids in it ("Rule R14 on Q41 reads Q52, asked
 * later in the flow — page 18 vs page 24"). Rendering `detail` as `JSON.stringify` would technically
 * show the ids; it would also make the one screen a programmer reads under time pressure the one
 * screen that hands them a JSON blob and asks them to parse it.
 *
 * WHAT IT REFUSES TO DO.
 *
 *  - **It never decides severity.** `severity` is carried through from the diagnostic, because
 *    severity is a property of the CODE (`CMP_SEVERITY`, and the two other catalogues do the same)
 *    and a UI that decided for itself would eventually disagree with the gate that blocked the
 *    publish. Same reason `compileErrors`/`compileWarnings` are imported rather than re-filtered.
 *  - **It never rewrites the message.** `message` is rendered verbatim. The prose here is
 *    ADDITIVE — a `summary` sentence and a labelled subject list — so a diagnostic whose code this
 *    module has never heard of still renders the gate's own explanation, in full, under its code.
 *    That is the fallback case, and it is tested: codes are append-only and new ones will arrive
 *    from `packages/compiler` between studio releases, so "unknown code" is the NORMAL case for a
 *    deployed studio and must not render blank.
 *  - **It never reads a code that is not in `detail`.** Every accessor below is total: a missing
 *    key, a `null`, or a value of the wrong JSON type yields "no subject" rather than `undefined`
 *    printed into a sentence. `detail` is written by nine different analyses and by two other
 *    diagnostic catalogues that were lifted into this one; assuming a key is present is how a
 *    publish dialog renders "Rule undefined on undefined".
 *
 * Keyed on the full code string and not on its family, because the families are not homogeneous:
 * `LGC-U001` names a flow node and `LGC-U002` names a question, and a formatter for `LGC-U*` would
 * have to re-discover which by sniffing keys.
 */

import type { JsonValue } from '@resscript/schema';
import type { CompileDiagnostic, CompileSeverity } from '@resscript/compiler/diagnostics';

/** One object a diagnostic names: a label a human reads, and the id they paste into a search box. */
export interface DiagnosticSubject {
  readonly label: string;
  readonly value: string;
}

export interface FormattedDiagnostic {
  readonly code: string;
  readonly severity: CompileSeverity;
  /** The gate's sentence, verbatim and never truncated. */
  readonly message: string;
  /**
   * The objects in `detail`, as one sentence. `null` when the code has no formatter and the
   * generic path found nothing nameable — the subject list and the message still render.
   */
  readonly summary: string | null;
  readonly subjects: readonly DiagnosticSubject[];
  /** The JSON Pointer, `''` for the document itself. Rendered as the "where" affordance. */
  readonly path: string;
}

type Detail = { readonly [key: string]: JsonValue };

/* -------------------------------------------------------------------------- */
/* Total accessors over `detail`                                              */
/* -------------------------------------------------------------------------- */

function str(detail: Detail, key: string): string | null {
  const value = detail[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function num(detail: Detail, key: string): number | null {
  const value = detail[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function strList(detail: Detail, key: string): readonly string[] {
  const value = detail[key];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry !== '');
}

/** First non-empty string among `keys`. The analyses fall back from a ref to an id themselves. */
function first(detail: Detail, ...keys: readonly string[]): string | null {
  for (const key of keys) {
    const found = str(detail, key);
    if (found !== null) return found;
  }
  return null;
}

/**
 * `page N`, one-based.
 *
 * The `*_page_index` keys are ZERO-based (they are indexes into the compiler's page order) and the
 * gate's own message prints `page ${index + 1}`. Printing the raw index here would put two
 * different page numbers for one location on one screen, which is worse than printing neither.
 */
function pageLabel(detail: Detail, key: string): string | null {
  const index = num(detail, key);
  return index === null ? null : `page ${String(index + 1)}`;
}

/** `page 18` when the index is known, otherwise the flow position, otherwise nothing. */
function positionLabel(detail: Detail, pageKey: string, positionKey: string): string | null {
  const page = pageLabel(detail, pageKey);
  if (page !== null) return page;
  const position = num(detail, positionKey);
  return position === null ? null : `flow position ${String(position)}`;
}

/** `question_has_no_page` -> `question has no page`. Used for the enum-ish `reason` keys. */
function humanize(value: string): string {
  return value.replace(/_/g, ' ');
}

function subject(label: string, value: string | null): readonly DiagnosticSubject[] {
  return value === null ? [] : [{ label, value }];
}

interface Formatted {
  readonly summary: string | null;
  readonly subjects: readonly DiagnosticSubject[];
}

/* -------------------------------------------------------------------------- */
/* Per-code formatters                                                        */
/* -------------------------------------------------------------------------- */

/**
 * `LGC-F001` (error) and `LGC-F002` (warning) share a `detail` shape because `forward-ref.ts`
 * builds one object and chooses the code from `availability`. They differ in what the flow
 * positions MEAN — F001 is "no path sets it first", F002 is "some paths do" — so the sentence
 * differs and the subject list does not.
 */
function forwardReference(detail: Detail, conditional: boolean): Formatted {
  const rule = str(detail, 'rule_id');
  const target = str(detail, 'rule_target_id');
  const read = first(detail, 'blocking_variable_name', 'blocking_variable_id');
  const collectedBy = first(detail, 'write_question_ref', 'write_question_id');
  const readAt = positionLabel(detail, 'read_page_index', 'read_flow_position');
  const writeAt = positionLabel(detail, 'write_page_index', 'write_flow_position');
  const readPos = num(detail, 'read_flow_position');
  const writePos = num(detail, 'write_flow_position');

  const subjects = [
    ...subject('rule', rule),
    ...subject('on', target),
    ...subject('reads', read),
    ...subject('collected by', collectedBy),
    ...subject('read at', readAt),
    ...subject('collected at', writeAt),
  ];

  if (rule === null || read === null) return { summary: null, subjects };

  const later = readPos !== null && writePos !== null && writePos > readPos;
  const where = readAt === null || writeAt === null ? '' : ` — ${readAt} vs ${writeAt}`;
  const relation = later
    ? ', asked later in the flow'
    : conditional
      ? ', which only some of the paths that reach the rule have set'
      : ', which no path reaching the rule has set';

  return {
    summary:
      `Rule ${rule}${target === null ? '' : ` on ${target}`} reads ${read}` +
      `${collectedBy === null || collectedBy === read ? '' : ` (collected by ${collectedBy})`}` +
      `${relation}${where}.`,
    subjects,
  };
}

const UNREACHABLE_REASONS: Readonly<Record<string, string>> = {
  question_has_no_page: 'no page contains it',
  page_not_laid_out: 'no flow node lays out its page',
  hide_rule_always_fires: 'a hide rule always fires',
  skip_rule_always_fires: 'a skip rule always fires',
  show_rules_never_fire: 'its show rules can never fire',
};

/** `LGC-U002` / `LGC-U003` — a question that is provably never visible. */
function neverVisible(detail: Detail, required: boolean): Formatted {
  const question = first(detail, 'question_ref', 'question_id');
  const rawReason = str(detail, 'reason');
  const reason =
    rawReason === null ? null : (UNREACHABLE_REASONS[rawReason] ?? humanize(rawReason));
  // `page_id` here is an id and not an index (this diagnostic names the page it could not place),
  // so the position is the flow position or nothing.
  const position = num(detail, 'flow_position');
  const at = position === null ? null : `flow position ${String(position)}`;
  const rules = strList(detail, 'rule_ids');

  const subjects = [
    ...subject('question', question),
    ...subject('page', str(detail, 'page_id')),
    ...subject('reason', rawReason === null ? null : humanize(rawReason)),
    ...(rules.length === 0 ? [] : [{ label: 'rules', value: rules.join(', ') }]),
  ];

  if (question === null) return { summary: null, subjects };
  return {
    summary:
      `${required ? 'Required question' : 'Question'} ${question}` +
      `${at === null ? '' : ` (${at})`} is never shown` +
      `${reason === null ? '' : `: ${reason}`}` +
      `${rules.length === 0 ? '' : ` (${rules.join(', ')})`}.`,
    subjects,
  };
}

/** `LGC-U001` — a flow node no path reaches. Names a node, not a question. */
function unreachableNode(detail: Detail): Formatted {
  const node = str(detail, 'flow_node_id');
  const type = str(detail, 'node_type');
  const subjects = [...subject('flow node', node), ...subject('node type', type)];
  if (node === null) return { summary: null, subjects };
  return {
    summary: `Flow node ${node}${type === null ? '' : ` (${type})`} is not reachable from the start node.`,
    subjects,
  };
}

/** `LGC-W031` — a condition no assignment satisfies. */
function unsatisfiable(detail: Detail): Formatted {
  const rule = str(detail, 'rule_id');
  const kind = str(detail, 'kind');
  const targetType = str(detail, 'target_type');
  const subjects = [
    ...subject('rule', rule),
    ...subject('kind', kind),
    ...subject('target', targetType),
    ...subject('flow node', str(detail, 'flow_node_id')),
  ];
  if (rule === null) return { summary: null, subjects };
  const what = [kind, targetType === null ? null : `on a ${targetType}`]
    .filter((part): part is string => part !== null)
    .join(' ');
  return {
    summary:
      `Rule ${rule}${what === '' ? '' : ` (${what})`} can never fire: nothing its variables can ` +
      'hold satisfies the condition.',
    subjects,
  };
}

/** `LGC-W040` — an option a mask can never include. */
function deadOption(detail: Detail): Formatted {
  const option = first(detail, 'code', 'option_id');
  const question = first(detail, 'question_ref', 'question_id');
  const rule = str(detail, 'rule_id');
  const mode = str(detail, 'mode');
  const subjects = [
    ...subject('option', str(detail, 'option_id')),
    ...subject('code', str(detail, 'code')),
    ...subject('question', question),
    ...subject('mask rule', rule),
    ...subject('mode', mode),
  ];
  if (option === null || question === null) return { summary: null, subjects };
  return {
    summary:
      `Option ${option} of ${question} is never shown` +
      `${rule === null ? '' : `: mask rule ${rule}${mode === null ? '' : ` (${mode})`} can never make it visible`}.`,
    subjects,
  };
}

/** `CMP-0200` (blocking) / `CMP-0201` (fallback) — an incomplete language bundle. */
function translations(detail: Detail): Formatted {
  const language = str(detail, 'language');
  const base = str(detail, 'base_language');
  const missing = num(detail, 'missing_count');
  const total = num(detail, 'base_key_count');
  const keys = strList(detail, 'missing_keys');
  const onMissing = str(detail, 'on_missing');

  const subjects = [
    ...subject('language', language),
    ...subject('base language', base),
    ...(missing === null || total === null
      ? []
      : [{ label: 'missing keys', value: `${String(missing)} of ${String(total)}` }]),
    ...(keys.length === 0 ? [] : [{ label: 'for example', value: keys.slice(0, 3).join(', ') }]),
    ...subject('on missing', onMissing === null ? null : humanize(onMissing)),
  ];
  if (language === null || missing === null) return { summary: null, subjects };
  return {
    summary:
      `The ${language} bundle is missing ${String(missing)}` +
      `${total === null ? '' : ` of ${String(total)}`} key(s)` +
      `${base === null ? '' : ` the ${base} bundle declares`}` +
      `${keys.length === 0 ? '' : ` — for example ${keys.slice(0, 3).join(', ')}`}.`,
    subjects,
  };
}

/** `CMP-0400` — a `question_type` the registry does not resolve. */
function missingPlugin(detail: Detail): Formatted {
  const question = first(detail, 'question_ref', 'question_id');
  const type = str(detail, 'question_type');
  const plugin = str(detail, 'plugin_id');
  const subjects = [
    ...subject('question', question),
    ...subject('question type', type),
    ...subject('plugin', plugin),
    ...subject('row', str(detail, 'row_ref')),
  ];
  if (question === null || type === null) return { summary: null, subjects };
  return {
    summary: `${question} declares question type ${type}, which no plugin in the registry resolves.`,
    subjects,
  };
}

/** `CMP-0402` — a pinned major that is gone. The available keys are the actionable part. */
function retiredPluginMajor(detail: Detail): Formatted {
  const question = first(detail, 'question_ref', 'question_id');
  const type = str(detail, 'question_type');
  const major = num(detail, 'requested_major');
  const available = strList(detail, 'available_keys');
  const subjects = [
    ...subject('question', question),
    ...subject('question type', type),
    ...subject('pinned major', major === null ? null : String(major)),
    ...(available.length === 0 ? [] : [{ label: 'still available', value: available.join(', ') }]),
  ];
  if (question === null || major === null) return { summary: null, subjects };
  return {
    summary:
      `${question} is pinned to major ${String(major)}${type === null ? '' : ` of ${type}`}, which is no longer available` +
      `${available.length === 0 ? '' : `; the registry still has ${available.join(', ')}`}.`,
    subjects,
  };
}

/** `CMP-0701` — two synthesized enum domains that are structurally the same. */
function domainIdentity(detail: Detail): Formatted {
  const domains = strList(detail, 'domain_ids');
  const questions = strList(detail, 'question_ids');
  const subjects = [
    ...(domains.length === 0 ? [] : [{ label: 'domains', value: domains.join(' and ') }]),
    ...(questions.length === 0 ? [] : [{ label: 'questions', value: questions.join(' and ') }]),
  ];
  if (domains.length < 2) return { summary: null, subjects };
  return {
    summary:
      `${domains[0] ?? ''} and ${domains[1] ?? ''} hold identical options under distinct synthesized ids` +
      `${questions.length < 2 ? '' : ` (${questions.join(' and ')})`}, so a legitimate comparison between them reports LGC-T021.`,
    subjects,
  };
}

const FORMATTERS: Readonly<Record<string, (detail: Detail) => Formatted>> = {
  'LGC-F001': (detail) => forwardReference(detail, false),
  'LGC-F002': (detail) => forwardReference(detail, true),
  'LGC-U001': unreachableNode,
  'LGC-U002': (detail) => neverVisible(detail, false),
  'LGC-U003': (detail) => neverVisible(detail, true),
  'LGC-W031': unsatisfiable,
  'LGC-W040': deadOption,
  'CMP-0200': translations,
  'CMP-0201': translations,
  'CMP-0400': missingPlugin,
  'CMP-0402': retiredPluginMajor,
  'CMP-0701': domainIdentity,
};

/* -------------------------------------------------------------------------- */
/* The generic fallback                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Keys worth naming when the code has no formatter, most specific first.
 *
 * A prefix/suffix list rather than an allow-list of exact keys: the analyses spell the same
 * concept `question_ref`, `write_question_ref` and `rule_target_id`, and a new code will spell it
 * a fourth way. Object- and array-of-object-valued keys are skipped entirely — those are the ones
 * that would turn the list back into a JSON dump.
 */
function genericSubjects(detail: Detail): readonly DiagnosticSubject[] {
  const out: DiagnosticSubject[] = [];
  for (const key of Object.keys(detail).sort()) {
    const value = detail[key];
    if (typeof value === 'string' && value !== '') {
      out.push({ label: humanize(key), value });
      continue;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      out.push({ label: humanize(key), value: String(value) });
      continue;
    }
    if (typeof value === 'boolean') {
      out.push({ label: humanize(key), value: value ? 'yes' : 'no' });
      continue;
    }
    if (Array.isArray(value)) {
      const scalars = value.filter(
        (entry): entry is string | number =>
          (typeof entry === 'string' && entry !== '') || typeof entry === 'number',
      );
      // Only when every entry was a scalar: a partially rendered list reads as a complete one.
      if (scalars.length > 0 && scalars.length === value.length) {
        out.push({ label: humanize(key), value: scalars.map(String).join(', ') });
      }
      continue;
    }
    // `null` and objects: deliberately dropped. A `null` in `detail` means "the analysis could not
    // determine this", which is not a fact worth a row.
  }
  return out;
}

/**
 * Format one diagnostic.
 *
 * Total by construction: an unknown code, an absent `detail` and a `detail` full of nulls all
 * produce a `FormattedDiagnostic` whose `code` and `message` are the diagnostic's own.
 */
export function formatDiagnostic(diagnostic: CompileDiagnostic): FormattedDiagnostic {
  const detail = diagnostic.detail;
  const base = {
    code: diagnostic.code,
    severity: diagnostic.severity,
    message: diagnostic.message,
    path: diagnostic.path,
  };
  if (detail === undefined) return { ...base, summary: null, subjects: [] };

  const formatter = FORMATTERS[diagnostic.code];
  if (formatter === undefined) return { ...base, summary: null, subjects: genericSubjects(detail) };

  const formatted = formatter(detail);
  // A per-code formatter that found nothing it recognised still gets the generic list, rather
  // than an empty one: that is the case where a code's `detail` shape changed under the studio.
  return {
    ...base,
    summary: formatted.summary,
    subjects: formatted.subjects.length === 0 ? genericSubjects(detail) : formatted.subjects,
  };
}

/** True when this code has a hand-written formatter. Exported for the fallback test only. */
export function hasDiagnosticFormatter(code: string): boolean {
  return Object.prototype.hasOwnProperty.call(FORMATTERS, code);
}
