/**
 * `@resscript/rescript-dsl` — the ResScript surface language. Deliverable D §6, milestone P1-07.
 *
 * Lexer, recovering parser, type-annotating resolver and pretty-printer over the *same* AST
 * `packages/logic` owns (ADR-010: one definition, or preview and field disagree). Nothing here
 * defines a node type, a diagnostic severity or a type rule; those live in `packages/logic` and are
 * imported. What lives here is the mapping between text and that AST, and the two guarantees over
 * it (D §6.4):
 *
 *   **T1** `parse(print(a)) ≡ a` — structural equality after normalizing node ids.
 *   **T2** `print(parse(s)) = normalize(s)` and `print(parse(print(parse(s)))) = print(parse(s))`.
 *
 * The public surface is four functions. `parse` and `print` are the pair the guarantees are stated
 * over; `format` is their composition (what format-on-save and a CI `--check` mode call); and
 * `contextAt` is what the Monaco completion provider calls on every keystroke (09-ui §7.4).
 *
 * `parse` **never throws**, on any input (D §6.4 P8). That is asserted by property test P8 and by a
 * mutation suite over the corpus, and it is the reason the last line of `parse` is a `catch`.
 */

import { hasDslErrors, rslDiagnostic, sortDslDiagnostics, type DslDiagnostic } from './diagnostics.js';
import { parseProgram } from './parser.js';
import { resolveProgram, type SourceMapEntry } from './resolve.js';
import { print, type PrintOptions } from './printer.js';
import type { Program } from './ast.js';
import type { DslRegistry } from './registry.js';
import type { AstKind } from '@resscript/logic';

export interface ParseResult {
  readonly program: Program;
  readonly diagnostics: readonly DslDiagnostic[];
  /** AST node id → source span, per statement. The `ast_node_id` the API returns (API §5.1). */
  readonly source_map: readonly SourceMapEntry[];
  /**
   * `false` when any diagnostic is an error. The API's `ok` field (API §5.1): a parse failure is a
   * `200 { ok: false }`, never a transport error, because editor clients call this on every
   * keystroke and must not treat a syntax error as a failed request.
   */
  readonly ok: boolean;
}

export function parse(source: string, registry: DslRegistry): ParseResult {
  const parsed = parseProgram(source);
  try {
    const resolved = resolveProgram(parsed, registry);
    const diagnostics = sortDslDiagnostics([...parsed.diagnostics, ...resolved.diagnostics]);
    return {
      program: resolved.program,
      diagnostics,
      source_map: resolved.source_map,
      ok: !hasDslErrors(diagnostics),
    };
  } catch (error: unknown) {
    // P8 is absolute: "parser terminates, produces >= 1 diagnostic … never throws". The parser
    // itself is written not to throw, and the resolver only can by way of a `LogicInvariant` from
    // the checker — i.e. a bug in this package or in logic. Turning that into a diagnostic keeps the
    // editor alive and keeps the bug visible, where a rethrow would blank the pane and lose the
    // author's other diagnostics.
    const message = error instanceof Error ? error.message : String(error);
    return {
      program: { statements: [] },
      diagnostics: sortDslDiagnostics([
        ...parsed.diagnostics,
        rslDiagnostic(
          'RSL-0099',
          `Internal invariant while resolving: ${message}. This is a bug in @resscript/rescript-dsl ` +
            'or @resscript/logic, not in your source. Please report the source that produced it.',
          { start: 0, end: source.length, line: 1, col: 1 },
        ),
      ]),
      source_map: [],
      ok: false,
    };
  }
}

export interface FormatResult {
  readonly source: string;
  readonly diagnostics: readonly DslDiagnostic[];
  readonly ok: boolean;
}

/**
 * `print(parse(source))` in one call — `POST /v1/dsl/format`, ⌥⇧F, and format-on-save.
 *
 * Idempotent by T2, which is what makes format-on-save safe: a formatter that fights the user is a
 * formatter they turn off.
 */
export function format(source: string, registry: DslRegistry, options: PrintOptions = {}): FormatResult {
  const result = parse(source, registry);
  return {
    source: print(result.program, registry, options),
    diagnostics: result.diagnostics,
    ok: result.ok,
  };
}

/**
 * The renderer leg of D §7.2's three-way closure — **a typed hole for P1-12**.
 *
 * D §7.2 makes "every AST kind is parseable, printable, and renderable" a build failure rather than
 * a review item, by way of an exhaustive mapped type per leg. Two legs live in this package (the
 * printer's exhaustive `switch` and `closure.test.ts`'s exhaustive snippet table). The third is
 * `apps/studio/src/logic-builder/registry.ts`, which P1-12 owns. This type is what it should be
 * declared with, so that adding a node kind to `AST_KINDS` is a TypeScript error there too:
 *
 * ```ts
 * export const RENDERERS: AstRendererRegistry<NodeRenderer> = { … };
 * ```
 */
export type AstRendererRegistry<R> = { readonly [K in AstKind]: R };

/* ---- the AST and its trivia --------------------------------------------- */
export {
  EMPTY_TRIVIA,
  canonicalProgram,
  canonicalStatement,
  mapStatementExprs,
  statementExprs,
  statementNodeIds,
  structuralStatement,
  triviaIsEmpty,
  type Action,
  type ActionStmt,
  type ActionTarget,
  type ContainerDef,
  type DslLiteral,
  type ErrorStmt,
  type MaskSource,
  type MaskSpec,
  type NodeRef,
  type OptionDef,
  type OptionFlag,
  type PipeSpec,
  type PipeStmt,
  type PriorityGroupStmt,
  type Program,
  type QuestionDef,
  type RandModifier,
  type RandTarget,
  type RandomizeSpec,
  type RandomizeStmt,
  type RuleStmt,
  type SetStmt,
  type Statement,
  type StatementKind,
  type TerminateStmt,
  type Trivia,
  type UnsupportedStmt,
  type ValidateRule,
  type VarName,
} from './ast.js';

/* ---- diagnostics -------------------------------------------------------- */
export {
  ALL_RSL_CODES,
  RSL_DIAGNOSTIC_CODES,
  RSL_SEVERITY,
  hasDslErrors,
  rslDiagnostic,
  sortDslDiagnostics,
  spanCovers,
  withSpan,
  type DslCode,
  type DslDiagnostic,
  type RslCode,
  type Span,
} from './diagnostics.js';

/* ---- the registry ------------------------------------------------------- */
export {
  dslRegistry,
  fromTypeEnv,
  questionIdOf,
  refOfBlock,
  refOfPage,
  refOfQuestion,
  type DslRegistry,
  type NodeIndex,
} from './registry.js';

/* ---- lexing, for Monaco's tokenizer and for tests ---------------------- */
export { lex, lineColAt, quote } from './lexer.js';
export { KEYWORDS, PUNCTUATION, isKeyword, keywordList, type CommentToken, type Keyword, type Token } from './tokens.js';

/* ---- parsing and printing ---------------------------------------------- */
export { parseProgram, type ParsedProgram } from './parser.js';
export { resolveProgram, type ResolvedProgram, type SourceMapEntry } from './resolve.js';
export { print, printExpr, printStatement, type PrintOptions } from './printer.js';
export type { SExpr, SGroup } from './surface.js';

/* ---- editor services ---------------------------------------------------- */
export { contextAt, type EditorContext, type Expecting } from './context.js';

/* ---- the fidelity report ------------------------------------------------ */
export {
  fidelityOfProgram,
  fidelityReport,
  type FidelityEntry,
  type FidelityInput,
  type FidelityReason,
  type FidelityReport,
} from './fidelity.js';
