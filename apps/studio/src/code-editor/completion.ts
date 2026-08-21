/**
 * Completion, driven by `contextAt` — 09-ui §7.4.
 *
 * The provider in `register.ts` is a five-line adapter; everything that decides *what* is offered
 * lives here as a pure function of `(source, offset, environment)`, because that is the part worth
 * testing and the part that must not need a browser to run.
 *
 * §7.4's switch is reproduced faithfully:
 *
 *   statement  → the rule-authoring keywords
 *   variable   → the registry's variables, earlier-in-the-flow first, later ones marked
 *   operator   → only the operators legal for the left operand's type (see `operators.ts`)
 *   enum_code  → that domain's option refs, labels in `detail`, codes in `documentation`
 *   question   → question / page / block refs, filtered by what the position accepts
 *   quota_ref  → the version's quota plans
 *
 * ## Forward references need an ordering the DSL cannot have
 *
 * §7.4 wants variables "set *earlier in the flow* first and later ones marked ⚠ forward
 * reference". `contextAt` returns a `flowPosition`, but that is a count of *statements before the
 * cursor in this document* — it says nothing about where a variable is collected in the survey.
 * The thing that knows is the studio's tree. So `FlowOrder` is an input: a question → document
 * order map plus the position of the rule being edited. Without it nothing is marked, which is the
 * honest degraded state (and what the API routes, which have no tree, get).
 *
 * A variable with no emitting question — a hidden or system variable — is never forward: D §8.1
 * treats entry parameters and derived-at-entry values as set before the first page.
 */

import type { DomainId, QuestionId, Type } from '@resscript/logic';
import { typeName } from '@resscript/logic';
import { contextAt, type DslRegistry, type EditorContext, type Span } from '@resscript/rescript-dsl';
import { legalOperatorsFor } from './operators';

/** Monaco's `CompletionItemKind` values. Restated for the reason in `markers.ts`. */
export const COMPLETION_KIND = {
  variable: 4,
  operator: 11,
  enumMember: 16,
  keyword: 17,
  reference: 21,
} as const;

export interface FlowOrder {
  /** Document/flow order of every question, as the tree supplies it. */
  readonly questionOrder: ReadonlyMap<QuestionId, number>;
  /** Where the rule being edited sits in that order. */
  readonly here: number;
}

export interface CompletionEnvironment {
  readonly registry: DslRegistry;
  readonly flow?: FlowOrder;
  /** Quota plan refs, for `QUOTA <ref>`. Empty until P2-06 wires the quota console. */
  readonly quotaRefs?: readonly string[];
  /**
   * i18n key → base-language string. The registry stores `label_key`s (schema §16), and an option
   * list whose `detail` reads `fruit.alpha` is not the affordance §7.4 asked for. Absent, the key
   * is shown — visibly a key, rather than a guess at a label.
   */
  readonly labelOf?: (key: string) => string | undefined;
}

export interface CompletionItemData {
  readonly label: string;
  readonly kind: number;
  readonly insertText: string;
  readonly detail?: string;
  readonly documentation?: string;
  /** Ranking. Monaco sorts on this before the label, which is how "earlier first" is expressed. */
  readonly sortText?: string;
  /** True when this reference is set later in the flow than the rule being edited. */
  readonly forwardReference?: boolean;
}

export interface CompletionResult {
  readonly items: readonly CompletionItemData[];
  readonly context: EditorContext;
  /** The token the cursor is inside, if any: Monaco replaces it rather than appending. */
  readonly replace?: Span;
}

/**
 * §7.4's `keywordItems([...])`, verbatim — the seven keywords that start a rule.
 *
 * The grammar has more statement starters than this (`QUESTION`, `BLOCK`, `PAGE`, `RANDOMIZE`,
 * `PIPE`, `PRIORITY GROUP`, and the bare actions `SKIP`/`ENABLE`/`DISABLE`/…). §7.4's list is
 * the *rule* vocabulary, which is what the rule pane is for, so it is offered first and the
 * container/definition keywords follow it — ranked after rather than omitted, because the same
 * editor is used for survey blocks (§7.4's second use site).
 */
const RULE_KEYWORDS: readonly string[] = ['IF', 'SHOW', 'HIDE', 'TERMINATE', 'SET', 'MASK', 'VALIDATE'];
const OTHER_STATEMENT_KEYWORDS: readonly string[] = [
  'QUESTION', 'BLOCK', 'PAGE', 'RANDOMIZE', 'PIPE', 'PRIORITY', 'SKIP', 'ENABLE', 'DISABLE',
  'PRESELECT', 'REQUIRE', 'UNREQUIRE', 'FLAG',
];

export function completionsAt(
  source: string,
  offset: number,
  env: CompletionEnvironment,
): CompletionResult {
  const context = contextAt(source, offset, env.registry);
  const items = itemsFor(context, env);
  return context.span === undefined
    ? { items, context }
    : { items, context, replace: context.span };
}

function itemsFor(
  context: EditorContext,
  env: CompletionEnvironment,
): readonly CompletionItemData[] {
  switch (context.expecting) {
    case 'statement':
      return [
        ...RULE_KEYWORDS.map((word, index) => keywordItem(word, `0${String(index).padStart(2, '0')}`)),
        ...OTHER_STATEMENT_KEYWORDS.map((word) => keywordItem(word, `1${word}`)),
      ];
    case 'variable':
      return variableItems(env);
    case 'operator':
      return operatorItems(context.leftType, env);
    case 'enum_code':
      return context.domainId === undefined ? variableItems(env) : optionItems(context.domainId, env);
    case 'question':
      return nodeItems(context.targetKind ?? 'question', env);
    case 'quota_ref':
      return (env.quotaRefs ?? []).map((ref) => ({
        label: ref,
        kind: COMPLETION_KIND.reference,
        insertText: ref,
        detail: 'quota plan',
      }));
    default:
      return [];
  }
}

function keywordItem(word: string, sortText: string): CompletionItemData {
  return { label: word, kind: COMPLETION_KIND.keyword, insertText: word, sortText };
}

function variableItems(env: CompletionEnvironment): readonly CompletionItemData[] {
  const typeEnv = env.registry.env;
  return typeEnv.variables().map((decl): CompletionItemData => {
    const owner = typeEnv.ownerQuestion(decl.id);
    const forward = isForward(env, owner?.id);
    const where = owner === undefined ? 'set at entry' : `from ${owner.ref}`;
    const detail = forward
      ? `${decl.kind} · ${typeName(typeEnv.typeOf(decl))} · ${where} · ⚠ forward reference`
      : `${decl.kind} · ${typeName(typeEnv.typeOf(decl))} · ${where}`;
    return {
      label: decl.name,
      kind: COMPLETION_KIND.variable,
      insertText: decl.name,
      detail,
      documentation: variableDocumentation(decl.domain, env, decl.pii, forward),
      // Earlier-in-the-flow variables sort first; the label is the tie-break so the list is
      // stable rather than registry-ordered.
      sortText: `${forward ? '1' : '0'}${decl.name}`,
      ...(forward ? { forwardReference: true } : {}),
    };
  });
}

function variableDocumentation(
  domain: DomainId | undefined,
  env: CompletionEnvironment,
  pii: boolean,
  forward: boolean,
): string {
  const parts: string[] = [];
  if (pii) parts.push('**pii** — redacted in traces and refused in redirect templates without an Admin acknowledgement.');
  if (forward) {
    parts.push(
      'Set **later in the flow** than this rule. Reading it here yields UNKNOWN in field, which collapses per D §2.5 — LGC-F001.',
    );
  }
  if (domain !== undefined) {
    const preview = domainPreview(domain, env);
    if (preview !== undefined) parts.push(preview);
  }
  return parts.join('\n\n');
}

/** First three labels plus a count — §7.4's variable hover, reused as completion documentation. */
export function domainPreview(domain: DomainId, env: CompletionEnvironment): string | undefined {
  const decl = env.registry.env.domain(domain);
  if (decl === undefined) return undefined;
  const shown = decl.entries
    .slice(0, 3)
    .map((entry) => `${String(entry.code)} ${labelText(entry.label_key, env)}`)
    .join(', ');
  const rest = decl.entries.length > 3 ? `, … (${String(decl.entries.length)} codes)` : '';
  return `${decl.ordinal ? 'ordinal' : 'nominal'} domain: ${shown}${rest}`;
}

function operatorItems(
  leftType: Type | undefined,
  env: CompletionEnvironment,
): readonly CompletionItemData[] {
  return legalOperatorsFor(leftType, env.registry.env).map((operator, index) => ({
    label: operator.label,
    kind: COMPLETION_KIND.operator,
    insertText: operator.label,
    detail: operator.phrasing,
    documentation: operator.documentation,
    sortText: String(index).padStart(2, '0'),
  }));
}

function optionItems(
  domain: DomainId,
  env: CompletionEnvironment,
): readonly CompletionItemData[] {
  const decl = env.registry.env.domain(domain);
  if (decl === undefined) return [];
  // The symbolic ref lives on the question's items, not on the domain (logic's `EnumEntry` is
  // `{code, label_key}`), so the owning question is looked up to recover `Q5.Alpha`. When two
  // questions share a domain (a template brand list) the first one wins: either spelling parses
  // to the same code, and D §6.4 T2 preserves whichever the author actually typed.
  const items = itemsOfDomain(domain, env);
  return decl.entries.map((entry): CompletionItemData => {
    const ref = items.get(entry.code);
    const label = ref ?? String(entry.code);
    return {
      label,
      kind: COMPLETION_KIND.enumMember,
      insertText: label,
      // §7.4: "that domain's option refs with their labels in `detail` and their codes in
      // `documentation`".
      detail: labelText(entry.label_key, env),
      documentation: `code ${String(entry.code)}`,
      sortText: String(entry.code).padStart(6, '0'),
    };
  });
}

function itemsOfDomain(
  domain: DomainId,
  env: CompletionEnvironment,
): ReadonlyMap<number, string> {
  const out = new Map<number, string>();
  for (const question of env.registry.env.questions()) {
    if (question.domain !== domain) continue;
    for (const item of [...question.options, ...question.rows, ...question.columns]) {
      if (item.ref === undefined || out.has(item.code)) continue;
      // `Q5.Alpha`, the symbolic form D §3.4 recommends: it survives an option label change.
      out.set(item.code, `${question.ref}.${item.ref}`);
    }
    if (out.size > 0) break;
  }
  return out;
}

function nodeItems(
  kind: 'question' | 'page' | 'block',
  env: CompletionEnvironment,
): readonly CompletionItemData[] {
  if (kind !== 'question') {
    // Page and block refs only exist in the caller-supplied `NodeIndex` (rescript-dsl
    // registry.ts): logic's `PageDecl`/`BlockDecl` carry no ref. There is no enumeration on that
    // interface — it is ref → id, one direction — so there is nothing to list here until the
    // studio passes its tree. Returning nothing beats returning question refs at a page position.
    return [];
  }
  const typeEnv = env.registry.env;
  return typeEnv.questions().map((question): CompletionItemData => {
    const forward = isForward(env, question.id);
    return {
      label: question.ref,
      kind: COMPLETION_KIND.reference,
      insertText: question.ref,
      detail: forward ? 'question · ⚠ later in the flow' : 'question',
      sortText: `${forward ? '1' : '0'}${question.ref}`,
      ...(forward ? { forwardReference: true } : {}),
    };
  });
}

function isForward(env: CompletionEnvironment, question: QuestionId | undefined): boolean {
  if (env.flow === undefined || question === undefined) return false;
  const position = env.flow.questionOrder.get(question);
  return position !== undefined && position > env.flow.here;
}

function labelText(key: string, env: CompletionEnvironment): string {
  return env.labelOf?.(key) ?? key;
}
