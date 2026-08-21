/**
 * The round-trip fidelity report.
 *
 * D §6.4's last paragraph states the requirement precisely: "Rules authored in the builder get
 * `authored_in: 'visual'` (schema §7) and no trivia; the printer emits them with canonical
 * formatting. Rules authored in the DSL keep trivia. The field exists precisely so a round-trip
 * fidelity report can tell a user '3 of your 40 rules were edited in the builder and have been
 * reformatted.'"
 *
 * That sentence is the whole specification, and the shape below is built to produce exactly it.
 *
 * Why this is worth a file rather than a comment in the UI: R1 in the roadmap's risk register names
 * the failure mode this defends against — "a printer that drops a comment in a rule a programmer is
 * about to review with a client destroys trust in the whole code mode". Reformatting is *legitimate*
 * when the rule was authored visually (there is nothing to preserve) and *illegitimate* otherwise.
 * A report that distinguishes the two is how a user can trust the printer instead of auditing it.
 */

import type { Statement, Trivia } from './ast.js';
import { triviaIsEmpty } from './ast.js';

export interface FidelityInput {
  /** The rule's stable id, so the studio can link the entry to the rule header. */
  readonly id: string;
  readonly authored_in: 'visual' | 'dsl';
  /** Present for DSL-authored rules that were parsed from source. */
  readonly trivia?: Trivia;
  readonly label?: string;
}

export type FidelityReason =
  /** Authored in the builder: no trivia exists, so the printed form is canonical by construction. */
  | 'authored_in_visual'
  /** Authored in the DSL but carrying no trivia — most likely round-tripped through the builder. */
  | 'trivia_lost';

export interface FidelityEntry {
  readonly rule_id: string;
  readonly reason: FidelityReason;
  readonly message: string;
  readonly label?: string;
}

export interface FidelityReport {
  readonly total: number;
  /** Rules whose printed form is canonical rather than as-authored. */
  readonly reformatted: number;
  /** Rules whose comments, blank-line grouping and parentheses survive a round trip verbatim. */
  readonly preserved: number;
  readonly entries: readonly FidelityEntry[];
  /** One sentence, ready to render. Empty when nothing was reformatted. */
  readonly summary: string;
}

export function fidelityReport(rules: readonly FidelityInput[]): FidelityReport {
  const entries: FidelityEntry[] = [];
  let preserved = 0;

  for (const rule of rules) {
    if (rule.authored_in === 'visual') {
      entries.push({
        rule_id: rule.id,
        reason: 'authored_in_visual',
        message:
          'Authored in the visual builder, so it carries no comments, blank-line grouping or ' +
          'author parentheses to preserve. Printed with canonical formatting.',
        ...(rule.label === undefined ? {} : { label: rule.label }),
      });
      continue;
    }
    if (triviaIsEmpty(rule.trivia)) {
      entries.push({
        rule_id: rule.id,
        reason: 'trivia_lost',
        message:
          'Marked as DSL-authored but carrying no trivia. Either it was written without comments ' +
          'or blank lines, or it was opened in the builder, which drops them (09-ui §7.3). It will ' +
          'print with canonical formatting.',
        ...(rule.label === undefined ? {} : { label: rule.label }),
      });
      continue;
    }
    preserved += 1;
  }

  const reformatted = entries.length;
  const total = rules.length;
  return {
    total,
    reformatted,
    preserved,
    entries,
    summary:
      reformatted === 0
        ? ''
        : `${String(reformatted)} of your ${String(total)} rule${total === 1 ? '' : 's'} ` +
          `${reformatted === 1 ? 'was' : 'were'} edited in the builder and ${reformatted === 1 ? 'has' : 'have'} ` +
          'been reformatted.',
  };
}

/**
 * The report for a program that was just parsed, keyed by statement position.
 *
 * A parsed program has no rule ids — those are assigned when the compiler turns statements into
 * `Rule`s (see ast.ts on why statements are not rules) — so positions stand in for them. This is
 * the form the studio's format-on-save path wants: "did formatting this file change anything the
 * author would notice?"
 */
export function fidelityOfProgram(statements: readonly Statement[]): FidelityReport {
  return fidelityReport(
    statements
      .filter((statement) => statement.s === 'rule' || statement.s === 'action')
      .map((statement, index) => ({
        id: `statement:${String(index)}`,
        authored_in: 'dsl' as const,
        ...(statement.trivia === undefined ? {} : { trivia: statement.trivia }),
      })),
  );
}
