/**
 * The rules routes' shared server logic: the dependency closure and the write-time type check.
 *
 * ## The closure (DB §4.4)
 *
 * `depends_on_variable_ids` / `depends_on_node_ids` are "recomputed from the AST on save" —
 * derived state, never client-supplied, because a client that could write them could make
 * "what does Q3 affect" lie. Computed here, once, from the SAME walkers the engine's dependency
 * graph uses (`readsOf`, `probesOf` — packages/logic/src/ast.ts: "anywhere else that re-derived
 * 'what are this node's children' would be a second definition of the AST"), so the panel's
 * answer and the evaluator's answer come from one definition of "reads".
 *
 * ## The type check (API §2.7: "type-checked on write; LGC-* errors are 422")
 *
 * `checkExpr` against the version's registry, plus the rule-boundary rule the checker cannot
 * know it is checking: a rule condition must be BOOLEAN (LGC-T033). Null-typed and never-typed
 * roots pass through — `never` means an error was already reported, and a literal `NULL`
 * condition is the checker's three-valued business, not a second diagnostic here.
 */

import { AppError } from '@resscript/observability';
import type { Expr, LgcDiagnostic } from '@resscript/logic';
import { buildTypeEnv, checkExpr, diagnostic, probesOf, readsOf } from '@resscript/logic';
import type { RuleEffectShape } from '@/lib/rule-statement';
import { toLogicRegistryInput } from '@/server/dsl/registry';
import type { CreateRuleInput, VersionRegistryRows } from '@/server/repo/types';

export interface DependencyClosure {
  readonly depends_on_variable_ids: readonly string[];
  readonly depends_on_node_ids: readonly string[];
}

/**
 * Everything the rule READS: variables referenced by the condition (and a `set` effect's value
 * expression — it is evaluated under the same condition), plus the question/page nodes named by
 * probes (`ANSWERED(QUESTION Q12)` reads the question, not a variable). Deduped, first-seen
 * order, matching `readsOf`'s own contract.
 */
export function dependencyClosureOf(condition: Expr, effect?: RuleEffectShape): DependencyClosure {
  const variables = new Set<string>(readsOf(condition));
  const nodes = new Set<string>();
  const probeTargets = (expr: Expr): void => {
    for (const probe of probesOf(expr)) {
      if (probe.target.kind === 'variable') variables.add(probe.target.id);
      else nodes.add(probe.target.id);
    }
  };
  probeTargets(condition);
  const value = effect?.value;
  if (value !== undefined) {
    for (const id of readsOf(value)) variables.add(id);
    probeTargets(value);
  }
  return {
    depends_on_variable_ids: [...variables],
    depends_on_node_ids: [...nodes],
  };
}

/**
 * The FK check the real table makes, surfaced as a 422 that names the field instead of a
 * constraint error dressed as a 500 — and made at all in the in-memory store, which holds no FK.
 */
export interface RuleTargetShape {
  readonly target_kind: 'node' | 'item' | 'variable';
  readonly target_node_id?: string | null | undefined;
  readonly target_item_id?: string | null | undefined;
  readonly target_variable_id?: string | null | undefined;
}

export function assertTargetExists(input: RuleTargetShape, rows: VersionRegistryRows): void {
  const miss = (path: string, message: string): never => {
    throw new AppError('validation_failed', '1 field failed validation', {
      details: [{ path, code: 'unknown_target', message }],
    });
  };
  if (input.target_kind === 'node' && !rows.nodes.some((n) => n.id === input.target_node_id)) {
    miss('target.node_id', 'not a node of this version');
  }
  if (input.target_kind === 'item' && !rows.items.some((i) => i.id === input.target_item_id)) {
    miss('target.item_id', 'not an item of this version');
  }
  if (
    input.target_kind === 'variable' &&
    !rows.variables.some((v) => v.id === input.target_variable_id)
  ) {
    miss('target.variable_id', 'not a variable of this version');
  }
}

export interface ConditionCheck {
  readonly diagnostics: readonly LgcDiagnostic[];
  readonly hasErrors: boolean;
}

export function checkRuleCondition(condition: Expr, rows: VersionRegistryRows): ConditionCheck {
  const env = buildTypeEnv(toLogicRegistryInput(rows));
  const result = checkExpr(condition, env, { path: '/condition' });
  const diagnostics = [...result.diagnostics];
  if (result.type.k !== 'bool' && result.type.k !== 'null' && result.type.k !== 'never') {
    diagnostics.push(
      diagnostic(
        'LGC-T033',
        `a rule condition must be boolean, got ${result.type.k}`,
        '/condition',
        { got: result.type.k },
      ),
    );
  }
  return {
    diagnostics,
    hasErrors: diagnostics.some((d) => d.severity === 'error'),
  };
}
