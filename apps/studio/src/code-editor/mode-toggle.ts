/**
 * The `[builder | code]` toggle, as a pure state machine — 09-ui §7.3.
 *
 * Three behaviours that section specifies, and each is a decision the UI must not be able to get
 * wrong by accident, which is why they live here rather than inside a component:
 *
 *  1. **builder → code is `print`.** Always available: an AST always prints.
 *  2. **code → builder is `parse`, and it is BLOCKED when the source does not parse**, with the
 *     diagnostic shown at its span. "We never silently discard unparseable text and we never show
 *     a half-built tree." So the outcome type has no member that carries both a partial program
 *     and an error — the caller cannot render a half-built tree because it is never handed one.
 *  3. **Opening a DSL-authored rule in the builder loses its trivia**, so the UI warns *once per
 *     rule* with a "keep editing as code" escape. The warning is a distinct outcome from the
 *     switch, so a component cannot show the warning and switch anyway.
 *
 * Blocking is keyed on **errors**, not on diagnostics. `RSL-0012` (an unresolvable page ref, which
 * happens whenever the studio has no tree loaded yet) and every `LGC-W*` are warnings, and a
 * toggle that refused to open the builder because a rule has a warning would be refusing on the
 * normal case. `ParseResult.ok` is already exactly "no error diagnostics", so it is the gate.
 */

import type { DslDiagnostic, Program, Statement } from '@resscript/rescript-dsl';
import { parse, print, triviaIsEmpty, type DslRegistry, type PrintOptions } from '@resscript/rescript-dsl';

export type RuleEditorMode = 'builder' | 'code';

/** `content.logic_rules.authored_in` (migration 0008). */
export type AuthoredIn = 'visual' | 'dsl';

export interface TriviaLoss {
  /** Comment lines and end-of-line comments that opening the builder would drop. */
  readonly comments: number;
  /** Statements whose blank-line grouping would be normalized away. */
  readonly blankLineGroups: number;
  /** Author parentheses the printer would not re-emit (`(A AND B) OR C`). */
  readonly parenHints: number;
  /** Symbolic option refs (`Q5.Alpha`) that would print as codes. */
  readonly symbolicRefs: number;
}

export type ModeSwitch =
  | { readonly kind: 'switched'; readonly mode: 'code'; readonly source: string }
  | { readonly kind: 'switched'; readonly mode: 'builder'; readonly program: Program }
  | { readonly kind: 'blocked'; readonly reason: 'parse_error'; readonly diagnostic: DslDiagnostic }
  | {
      readonly kind: 'confirm';
      readonly reason: 'trivia_loss';
      readonly loss: TriviaLoss;
      /** The program to commit if the author accepts the loss. */
      readonly program: Program;
    };

/** builder → code. */
export function toCode(program: Program, registry: DslRegistry, options?: PrintOptions): ModeSwitch {
  return { kind: 'switched', mode: 'code', source: print(program, registry, options) };
}

export interface ToBuilderInput {
  readonly source: string;
  readonly registry: DslRegistry;
  readonly authoredIn: AuthoredIn;
  /**
   * True once this rule's trivia warning has been shown and accepted. "Once per rule" is a
   * property of the rule, not of the session, so the caller owns the set — the store (per rule id)
   * in the studio, a boolean in a test.
   */
  readonly triviaWarningAcknowledged?: boolean;
}

/** code → builder. */
export function toBuilder(input: ToBuilderInput): ModeSwitch {
  const result = parse(input.source, input.registry);
  if (!result.ok) {
    // The first *error*, in source order (`sortDslDiagnostics` already ordered them), because that
    // is where the cursor goes. Warnings never block.
    const diagnostic = result.diagnostics.find((d) => d.severity === 'error');
    if (diagnostic !== undefined) return { kind: 'blocked', reason: 'parse_error', diagnostic };
  }

  const loss = triviaLossOf(result.program.statements);
  const lossy = totalLoss(loss) > 0;
  if (input.authoredIn === 'dsl' && lossy && input.triviaWarningAcknowledged !== true) {
    return { kind: 'confirm', reason: 'trivia_loss', loss, program: result.program };
  }
  return { kind: 'switched', mode: 'builder', program: result.program };
}

/**
 * What the builder would drop.
 *
 * Counted from the parsed statements rather than from the source text: the printer replays
 * `Trivia`, so what survives a round trip is exactly what the parser attached, and a comment the
 * parser did not attach was never going to be preserved anyway.
 */
export function triviaLossOf(statements: readonly Statement[]): TriviaLoss {
  let comments = 0;
  let blankLineGroups = 0;
  let parenHints = 0;
  let symbolicRefs = 0;
  for (const statement of statements) {
    const trivia = statement.trivia;
    if (triviaIsEmpty(trivia) || trivia === undefined) continue;
    comments += (trivia.leading?.length ?? 0) + (trivia.trailing === undefined ? 0 : 1);
    if ((trivia.blank_before ?? 0) > 0) blankLineGroups += 1;
    parenHints += trivia.paren_hints?.length ?? 0;
    symbolicRefs += Object.keys(trivia.symbolic_refs ?? {}).length;
  }
  return { comments, blankLineGroups, parenHints, symbolicRefs };
}

export function totalLoss(loss: TriviaLoss): number {
  return loss.comments + loss.blankLineGroups + loss.parenHints + loss.symbolicRefs;
}

/** The warning copy, so the component renders a sentence and not a struct. */
export function describeTriviaLoss(loss: TriviaLoss): string {
  const parts: string[] = [];
  if (loss.comments > 0) parts.push(`${String(loss.comments)} comment${loss.comments === 1 ? '' : 's'}`);
  if (loss.blankLineGroups > 0) parts.push('blank-line grouping');
  if (loss.parenHints > 0) parts.push('your parentheses');
  if (loss.symbolicRefs > 0) {
    parts.push(`${String(loss.symbolicRefs)} symbolic option ref${loss.symbolicRefs === 1 ? '' : 's'}`);
  }
  const list =
    parts.length <= 1
      ? (parts[0] ?? 'nothing')
      : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1] ?? ''}`;
  return `Opening this rule in the builder discards ${list}. The logic is unchanged.`;
}
