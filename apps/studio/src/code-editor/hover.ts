/**
 * Hover and go-to-definition — 09-ui §7.4's "Hover" and "Navigation" paragraphs.
 *
 * Both answer the same question first — *what is the token under the cursor* — so they share
 * `tokenAt`, which uses the DSL's own lexer rather than a word-boundary regex. That matters for
 * the dotted option-ref form: `Q5.Alpha` is three tokens to the lexer and one word to a regex, and
 * hovering the `Alpha` half should say "option code 1", not "unknown variable Alpha".
 *
 * `DefinitionProvider` deliberately does **not** return a Monaco location. §7.4: "ctrl-click
 * selects that question in the tree and scrolls to it — not a Monaco file navigation, a studio
 * navigation." So `definitionAt` returns the *target* (a question or variable id) and the caller
 * routes to `…/edit/[nodeId]`. A Monaco `Location` would need a Uri for a model that does not
 * exist, and the editor would helpfully do nothing.
 */

import type { QuestionId, VariableId } from '@resscript/logic';
import { typeName } from '@resscript/logic';
import { lex, questionIdOf, type DslRegistry, type Span, type Token } from '@resscript/rescript-dsl';
import { describeOperatorToken } from './operators';
import { domainPreview, type CompletionEnvironment } from './completion';

export interface HoverResult {
  /** Markdown, one string per paragraph — Monaco renders an array of `IMarkdownString`. */
  readonly contents: readonly string[];
  readonly span: Span;
}

export interface DefinitionTarget {
  readonly kind: 'question' | 'variable';
  readonly id: QuestionId | VariableId;
  /** The ref/name as written, for the live-region announcement (§13.1). */
  readonly ref: string;
  readonly span: Span;
}

/** The token containing `offset`, or the one immediately to its left at a boundary. */
export function tokenAt(source: string, offset: number): Token | undefined {
  const { tokens } = lex(source);
  let previous: Token | undefined;
  for (const token of tokens) {
    if (token.kind === 'eof') break;
    if (offset >= token.start && offset < token.end) return token;
    if (token.end === offset) previous = token;
    if (token.start > offset) break;
  }
  return previous;
}

export function hoverAt(
  source: string,
  offset: number,
  env: CompletionEnvironment,
): HoverResult | undefined {
  const token = tokenAt(source, offset);
  if (token === undefined) return undefined;
  const span: Span = { start: token.start, end: token.end, line: token.line, col: token.col };
  const typeEnv = env.registry.env;

  if (token.kind === 'ident') {
    const decl = typeEnv.byRef(token.text);
    if (decl !== undefined) {
      const owner = typeEnv.ownerQuestion(decl.id);
      const contents = [
        `**${decl.name}** · \`${typeName(typeEnv.typeOf(decl))}\` · ${decl.kind}`,
        owner === undefined
          ? '_Set at entry_ — a hidden or system variable has no emitting question.'
          : `Collected by **${owner.ref}**. Ctrl-click to select it in the tree.`,
      ];
      if (decl.domain !== undefined) {
        const preview = domainPreview(decl.domain, env);
        if (preview !== undefined) contents.push(preview);
      }
      if (decl.pii) {
        contents.push('**pii** — values are redacted in debug traces and blocked from redirect templates without an Admin acknowledgement.');
      }
      if (!decl.persist) contents.push('_Transient_: not written to the response document.');
      return { contents, span };
    }
    const question = questionIdOf(env.registry, token.text);
    if (question !== undefined) {
      const decl2 = typeEnv.question(question);
      const page = decl2?.page_id;
      return {
        contents: [
          `**${token.text}** · question`,
          page === undefined ? 'Not attached to a page.' : `On page \`${page}\`.`,
          // The label itself is an i18n key on the node, which this registry does not carry
          // (logic's QuestionDecl has no label — see packages/logic/src/registry.ts on why the
          // projection is narrow). The studio's tree row has the preview; the pane shows the ref.
          decl2 === undefined
            ? ''
            : `${String(decl2.options.length)} options · ${decl2.required ? 'required' : 'optional'}`,
        ].filter((line) => line !== ''),
        span,
      };
    }
    return {
      contents: [`**${token.text}** is not a variable or a question in this version.`],
      span,
    };
  }

  const operator = describeOperatorToken(token.kind === 'keyword' ? token.upper : token.text);
  if (operator !== undefined) {
    return {
      contents: [`**${operator.label}** — ${operator.phrasing}`, operator.documentation],
      span,
    };
  }
  return undefined;
}

export function definitionAt(
  source: string,
  offset: number,
  registry: DslRegistry,
): DefinitionTarget | undefined {
  const token = tokenAt(source, offset);
  if (token === undefined || token.kind !== 'ident') return undefined;
  const span: Span = { start: token.start, end: token.end, line: token.line, col: token.col };

  // A question ref is preferred over a same-named variable, and that ordering is a decision:
  // a scalar question emits a variable with the same name (schema §1), so `Q9` names both. §7.4
  // says ctrl-click "selects that question in the tree", and the tree has no row for a variable —
  // so the question is the navigable target and the variable is the fallback for things like
  // `HEAVY_BUYER` that have no question at all.
  const question = questionIdOf(registry, token.text);
  if (question !== undefined) return { kind: 'question', id: question, ref: token.text, span };

  const decl = registry.env.byRef(token.text);
  if (decl === undefined) return undefined;
  const owner = registry.env.ownerQuestion(decl.id);
  return owner === undefined
    ? { kind: 'variable', id: decl.id, ref: decl.name, span }
    : { kind: 'question', id: owner.id, ref: owner.ref, span };
}
