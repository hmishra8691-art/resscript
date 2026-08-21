/**
 * D §8.2's content-level unreachability: `LGC-U002` (a question is provably never visible) and
 * `LGC-U003` (the same, for a required question).
 *
 * WHY THESE ARE NOT `LGC-U001`. `flow.ts` already reports `LGC-U001` for a flow *node* the
 * respondent cannot reach from `start`, and that is a different claim from the one here. A survey
 * can have a perfectly connected flow graph in which a question is still never seen: its page is
 * laid out by no flow node at all (so it is not a node in the graph, reachable or otherwise), or
 * every rule that could reveal it is provably false. Those are content defects, and they are
 * reported per *question* — which is the unit the author edits and the unit that carries
 * `required`. This module deliberately does not re-report node-level unreachability; the pipeline
 * takes `FlowGraph.diagnostics` for that.
 *
 * WHY `U003` IS AN ERROR AND `U002` IS NOT. A question that is never visible is usually dead
 * weight: a page dropped from a wave of a tracker, an option branch the client cancelled. It is
 * worth a warning and an acknowledgement, not a blocked publish, because "we keep the question
 * in the document and stopped asking it" is a real and reasonable state. A *required* question
 * that is never visible is different in kind: `required` is a promise that no respondent
 * completes without answering it, and a question nobody can see cannot keep that promise. It is
 * a contradiction inside the document rather than an unused branch, so it is an error — and a
 * question that qualifies for `U003` does not also get `U002`, because one defect gets one
 * diagnostic.
 *
 * ## The three sound reasons, and why the obvious fourth is not one
 *
 * A question is provably never visible when any of:
 *
 *  1. **No flow node lays out its page** (or it sits under no page at all). Content-level, and
 *     the common real case: a block whose `sequence` node was deleted.
 *  2. **It is base-hidden and every `show` rule that could reveal it can never fire.**
 *     `compileLogic`'s `deriveBaseVisible` flips a node to base-hidden the moment a `show` rule
 *     targets it — "otherwise a `show` rule could never hide anything and `IF x THEN SHOW Q12`
 *     would show Q12 unconditionally". So a base-hidden node whose only revealers are
 *     unsatisfiable is invisible on every path.
 *  3. **A `hide` or `skip` rule targeting it always fires.** `hide` is absorbing in D §4.6's
 *     visibility meet, and a `skip` that always fires removes the node from the flow.
 *
 * The tempting fourth — "every display rule targeting it has a provably-false condition" stated
 * without the base-visibility qualifier — is **wrong in the dangerous direction**. A question
 * with no `show` rule is base-*visible*: a `hide` rule that can never fire leaves it visible, not
 * invisible, so reporting it would be a false positive on a survey whose only defect is a dead
 * hide rule. The qualifier is the whole content of case 2.
 *
 * Visibility is checked for the question *and* its ancestors — its page and every enclosing
 * block — because a page that is never visible takes its questions with it, and the author's
 * next action is to look at whichever node carries the defective rule. `detail.node_id` says
 * which one it was.
 *
 * ## What this module refuses to do
 *
 * It reports nothing when the flow has no start node or lays out no pages. Both are already
 * errors (`CMP-0001`, and the pipeline's `CMP-0801`), both make *every* question unreachable, and
 * a diagnostic per question would bury the one that explains them — the same reasoning
 * `buildFlowGraph` gives for not storming `LGC-U001` when there is no start.
 */

import { type PageId, type QuestionNode, type Survey } from '@resscript/schema';
import { diagnostic, type Rule, type TypeEnv } from '@resscript/logic';

import { fromLogicDiagnostic, sortCompileDiagnostics, type CompileDiagnostic } from '../diagnostics.js';
import { blockPathOf, pageOfQuestion } from '../flow.js';
import type { FlowGraph } from '../types.js';
import { provablyAlwaysTrue, provablyNeverTrue, questionSites, rulePointers } from './solver.js';

export interface UnreachableInput {
  readonly survey: Survey;
  readonly graph: FlowGraph;
  /** `buildRules`' output. `show`/`hide`/`skip` effects are what this reads. */
  readonly rules: readonly Rule[];
  readonly env: TypeEnv;
}

/** Why a question is never visible. One value per case in the header, in `detail.reason`. */
type Reason =
  | 'question_has_no_page'
  | 'page_not_laid_out'
  | 'show_rules_never_fire'
  | 'hide_rule_always_fires'
  | 'skip_rule_always_fires';

interface Finding {
  readonly reason: Reason;
  /** The content node the defect is on: the question, its page, or an enclosing block. */
  readonly nodeId: string;
  /** The rules that make the claim, for `detail`. Empty for a layout failure. */
  readonly ruleIds: readonly string[];
}

export function analyzeUnreachableContent(input: UnreachableInput): readonly CompileDiagnostic[] {
  if (input.graph.start === '' || input.graph.pageOrder.length === 0) return [];

  const pageOf = pageOfQuestion(input.survey);
  const blockPath = blockPathOf(input.survey);
  const laidOut = new Set<string>(input.graph.pageOrder);
  const rules = indexRules(input.rules);
  const paths = rulePointers(input.survey);
  const out: CompileDiagnostic[] = [];

  for (const site of questionSites(input.survey)) {
    const question = site.question;
    const pageId = pageOf.get(question.id);
    const finding = findingFor(question, pageId, laidOut, blockPath, rules, input.env);
    if (finding === undefined) continue;

    const entry = pageId === undefined ? undefined : input.graph.pageEntry.get(pageId);
    const code = question.required ? 'LGC-U003' : 'LGC-U002';
    const subject = question.required ? 'Required question' : 'Question';
    out.push(
      fromLogicDiagnostic(
        diagnostic(
          code,
          `${subject} ${question.ref} can never be visible (${finding.reason}), so ` +
            (question.required
              ? 'no respondent can satisfy the requirement it declares and every session would ' +
                'dead-end on a question nobody is shown.'
              : 'it collects nothing and its export column is null for every respondent.'),
          site.path,
          {
            question_id: question.id,
            question_ref: question.ref,
            required: question.required,
            page_id: pageId ?? null,
            page_laid_out: pageId !== undefined && laidOut.has(pageId),
            flow_node_id: entry ?? null,
            flow_position: entry === undefined ? null : (input.graph.position.get(entry) ?? null),
            reason: finding.reason,
            node_id: finding.nodeId,
            rule_ids: [...finding.ruleIds],
            rule_paths: finding.ruleIds.map((id) => paths.get(id) ?? ''),
          },
        ),
      ),
    );
  }

  return sortCompileDiagnostics(out);
}

/**
 * The first reason that holds, in the order the header lists them.
 *
 * First and not all: `detail` names one defect and one place to go, and a question on an
 * unlaid-out page whose show rule is also dead does not have two problems.
 */
function findingFor(
  question: QuestionNode,
  pageId: PageId | undefined,
  laidOut: ReadonlySet<string>,
  blockPath: ReadonlyMap<string, readonly string[]>,
  rules: RuleIndex,
  env: TypeEnv,
): Finding | undefined {
  if (pageId === undefined) {
    return { reason: 'question_has_no_page', nodeId: question.id, ruleIds: [] };
  }
  if (!laidOut.has(pageId)) {
    return { reason: 'page_not_laid_out', nodeId: pageId, ruleIds: [] };
  }
  // Outermost block first: a whole block nobody can see is the more useful thing to say than
  // the leaf question inside it.
  const chain = [...(blockPath.get(pageId) ?? []), pageId, question.id];
  for (const nodeId of chain) {
    const finding = nodeFinding(nodeId, rules, env);
    if (finding !== undefined) return finding;
  }
  return undefined;
}

function nodeFinding(nodeId: string, rules: RuleIndex, env: TypeEnv): Finding | undefined {
  const shows = rules.shows.get(nodeId) ?? [];
  const hides = rules.hides.get(nodeId) ?? [];
  const skips = rules.skips.get(nodeId) ?? [];

  for (const rule of hides) {
    if (provablyAlwaysTrue(rule.condition, env)) {
      return { reason: 'hide_rule_always_fires', nodeId, ruleIds: [rule.id] };
    }
  }
  for (const rule of skips) {
    if (provablyAlwaysTrue(rule.condition, env)) {
      return { reason: 'skip_rule_always_fires', nodeId, ruleIds: [rule.id] };
    }
  }
  // Base-hidden is exactly "a `show` rule targets it" (`deriveBaseVisible`), so an empty `shows`
  // means base-visible and there is nothing to prove.
  if (shows.length === 0) return undefined;
  if (!shows.every((rule) => provablyNeverTrue(rule.condition, env))) return undefined;
  return { reason: 'show_rules_never_fire', nodeId, ruleIds: shows.map((rule) => rule.id) };
}

interface RuleIndex {
  /** Content node id → the `show` rules targeting it. */
  readonly shows: ReadonlyMap<string, readonly Rule[]>;
  readonly hides: ReadonlyMap<string, readonly Rule[]>;
  /** `skip_this` and `skip_to`: both remove the node the rule is scoped to. */
  readonly skips: ReadonlyMap<string, readonly Rule[]>;
}

function indexRules(rules: readonly Rule[]): RuleIndex {
  const shows = new Map<string, Rule[]>();
  const hides = new Map<string, Rule[]>();
  const skips = new Map<string, Rule[]>();
  const push = (map: Map<string, Rule[]>, id: string, rule: Rule): void => {
    const existing = map.get(id);
    if (existing === undefined) map.set(id, [rule]);
    else existing.push(rule);
  };

  for (const rule of rules) {
    const target = rule.target;
    // Only the three target kinds that carry a `visible` cell (`writesOf`): an option-targeted
    // `show`/`hide` is an `option_state` write and is `LGC-W040`'s business, not this one.
    if (target.type !== 'question' && target.type !== 'page' && target.type !== 'block') continue;
    switch (rule.effect.action) {
      case 'show':
        push(shows, target.id, rule);
        break;
      case 'hide':
        push(hides, target.id, rule);
        break;
      case 'skip_this':
      case 'skip_to':
        push(skips, target.id, rule);
        break;
      default:
        break;
    }
  }
  return { shows, hides, skips };
}
