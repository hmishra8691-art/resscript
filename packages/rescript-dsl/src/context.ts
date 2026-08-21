/**
 * `contextAt(source, offset, registry)` — the completion/hover substrate named in 09-ui §7.4.
 *
 * The studio calls it on every keystroke to decide what is legal at the cursor:
 *
 * ```ts
 * const ctx = dsl.contextAt(model.getValue(), offsetOf(position), registry);
 * switch (ctx.expecting) {
 *   case 'variable': return variableItems(registry, { setBefore: ctx.flowPosition });
 *   case 'operator': return operatorItems(legalOperatorsFor(ctx.leftType));
 *   case 'enum_code': return optionItems(registry.domain(ctx.domainId));
 *   …
 * ```
 *
 * Two design points, both from that section:
 *
 *  - **Completion that offers an illegal operator teaches the user wrong.** So `leftType` is
 *    returned, not guessed at by the UI: after `Q5 : set<enum>` the legal operators are the set
 *    predicates, and after `AGE : num` they are the ordered comparisons. The type comes from the
 *    registry, which *is* the type environment (D §3.2).
 *  - **`domainId`** is returned at an enum-code position so the dropdown can show that domain's
 *    option labels. Since enum domains are nominal (D §2.2), offering another question's codes
 *    would be offering a type error.
 *
 * It is deliberately **token-driven, not parse-tree-driven**. 09-ui's sketch reads "the parse tree
 * at the cursor decides what is legal here", and a full parse is available (P8 guarantees one on
 * broken input) — but the tree at a cursor mid-identifier is precisely where recovery has the least
 * information, while the token to the left is unambiguous. So the tokens decide, and the registry
 * supplies the types. Recorded as a deviation from the sketch rather than a silent choice.
 */

import type { DomainId, Type } from '@resscript/logic';
import { lex } from './lexer.js';
import type { Token } from './tokens.js';
import { questionIdOf, type DslRegistry } from './registry.js';
import type { Span } from './diagnostics.js';

export type Expecting = 'statement' | 'variable' | 'operator' | 'enum_code' | 'question' | 'quota_ref';

export interface EditorContext {
  readonly expecting: Expecting;
  /** The type of the operand to the left, at an `operator` position. */
  readonly leftType?: Type;
  /** The enum domain whose codes are legal here, at an `enum_code` position. */
  readonly domainId?: DomainId;
  /** Which kind of content node a `question` position accepts. */
  readonly targetKind?: 'question' | 'page' | 'block';
  /**
   * How many statements precede the cursor. 09-ui §7.4 ranks variables "set *earlier in the flow*
   * first and later ones marked ⚠ forward reference"; this is the number that decides which is
   * which, using the same document-order notion as the resolver's LGC-F001 (see resolve.ts for
   * what that does and does not claim).
   */
  readonly flowPosition?: number;
  /** The token the cursor is inside or immediately after, for a replacement range. */
  readonly span?: Span;
}

/** Keywords after which an expression — and therefore a variable — is expected. */
const EXPECTS_OPERAND: ReadonlySet<string> = new Set([
  'IF', 'AND', 'OR', 'NOT', 'WHEN', 'THEN', 'ELSE', 'WHERE', 'REQUIRE', 'BETWEEN', 'CASE', 'SELECT',
]);

/** Keywords after which a content-node reference is expected. */
const EXPECTS_NODE: { readonly [keyword: string]: 'question' | 'page' | 'block' } = {
  SHOW: 'question',
  HIDE: 'question',
  DISABLE: 'question',
  ENABLE: 'question',
  PRESELECT: 'question',
  QUESTION: 'question',
  MASK: 'question',
  PIPE: 'question',
  RANDOMIZE: 'question',
  PAGE: 'page',
  BLOCK: 'block',
  TO: 'page',
};

const OPERATOR_TEXT: ReadonlySet<string> = new Set(['=', '==', '<>', '!=', '<', '<=', '>', '>=']);
const SET_OPERATOR_KEYWORDS: ReadonlySet<string> = new Set(['CONTAINS', 'OF', 'IN']);

export function contextAt(source: string, offset: number, registry: DslRegistry): EditorContext {
  const { tokens } = lex(source);
  const real = tokens.filter((token) => token.kind !== 'eof' && token.start < offset);
  const last = real[real.length - 1];
  const previous = real[real.length - 2];
  const flowPosition = countStatements(real);

  if (last === undefined) return { expecting: 'statement', flowPosition };

  const span: Span = { start: last.start, end: last.end, line: last.line, col: last.col };
  const inside = offset <= last.end;
  // The token being typed is the one the cursor is inside; otherwise the cursor is *after* a
  // complete token and the context is whatever that token demands next.
  const anchor = inside ? previous : last;
  const partial = inside ? span : undefined;

  if (anchor === undefined) return { expecting: 'statement', flowPosition, ...(partial === undefined ? {} : { span: partial }) };

  // A newline between the last token and the cursor ends the statement, whatever that token was.
  // Checked before everything else: after `… THEN SHOW Q12⏎` the cursor is on a fresh line and wants
  // statement keywords, not the operators that would follow `Q12` on the same line.
  if (!inside && startsNewLine(source, last.end, offset)) {
    return { expecting: 'statement', flowPosition };
  }

  if (anchor.kind === 'keyword') {
    if (anchor.upper === 'QUOTA') {
      return { expecting: 'quota_ref', flowPosition, ...(partial === undefined ? {} : { span: partial }) };
    }
    const nodeKind = EXPECTS_NODE[anchor.upper];
    if (nodeKind !== undefined) {
      return {
        expecting: 'question',
        targetKind: nodeKind,
        flowPosition,
        ...(partial === undefined ? {} : { span: partial }),
      };
    }
    if (EXPECTS_OPERAND.has(anchor.upper)) {
      return { expecting: 'variable', flowPosition, ...(partial === undefined ? {} : { span: partial }) };
    }
    if (SET_OPERATOR_KEYWORDS.has(anchor.upper)) {
      const domain = domainLeftOf(real, real.indexOf(anchor), registry);
      return {
        expecting: domain === undefined ? 'variable' : 'enum_code',
        ...(domain === undefined ? {} : { domainId: domain }),
        flowPosition,
        ...(partial === undefined ? {} : { span: partial }),
      };
    }
  }

  if (anchor.kind === 'punct' && OPERATOR_TEXT.has(anchor.text)) {
    const domain = domainLeftOf(real, real.indexOf(anchor), registry);
    return {
      expecting: domain === undefined ? 'variable' : 'enum_code',
      ...(domain === undefined ? {} : { domainId: domain }),
      flowPosition,
      ...(partial === undefined ? {} : { span: partial }),
    };
  }

  if (anchor.kind === 'ident') {
    const decl = registry.env.byRef(anchor.text);
    if (decl !== undefined) {
      return {
        expecting: 'operator',
        leftType: registry.env.typeOf(decl),
        flowPosition,
        ...(partial === undefined ? {} : { span: partial }),
      };
    }
    if (questionIdOf(registry, anchor.text) !== undefined) {
      return { expecting: 'operator', flowPosition, ...(partial === undefined ? {} : { span: partial }) };
    }
  }

  // Anything else: the cursor is somewhere a statement can start.
  return { expecting: 'statement', flowPosition, ...(partial === undefined ? {} : { span: partial }) };
}

/** The enum domain of the operand immediately left of `index`, if it has one. */
function domainLeftOf(
  tokens: readonly Token[],
  index: number,
  registry: DslRegistry,
): DomainId | undefined {
  for (let i = index - 1; i >= 0 && i >= index - 3; i -= 1) {
    const token = tokens[i];
    if (token === undefined) continue;
    if (token.kind !== 'ident') continue;
    const decl = registry.env.byRef(token.text);
    if (decl === undefined) continue;
    const type = registry.env.typeOf(decl);
    if (type.k === 'enum' || type.k === 'set') return type.d;
    return undefined;
  }
  return undefined;
}

function countStatements(tokens: readonly Token[]): number {
  let count = 0;
  for (const token of tokens) {
    if (token.kind === 'keyword' && token.nlBefore > 0) count += 1;
  }
  return count;
}

function startsNewLine(source: string, from: number, to: number): boolean {
  return source.slice(from, to).includes('\n');
}
