/**
 * `GET|POST /api/v1/versions/:id/rules` — the central rule registry (API §2.7, roadmap P1-12).
 *
 * ## GET: the two questions that matter, as query params
 *
 * 03 §7 centralized rules precisely so "what affects Q12?" and "what does Q3 affect?" are index
 * lookups, and API §2.7 makes both first-class filters. `target_node_id` is the first question
 * (`rules_target_node_idx`); `depends_on_node_id` / `depends_on_variable_id` are the second —
 * array containment over the two GIN indexes (`rules_depends_var_gin`, `rules_depends_node_gin`),
 * which is exactly what the studio's "what affects this question?" panels call.
 *
 * ## POST: either `condition` (AST) or `source` (ResScript)
 *
 * The AST path takes `{kind, target, condition, effect, …}` verbatim. The source path parses ONE
 * `IF … THEN …` statement with the same parser the editor runs, stores the resolved AST **and
 * the trivia** (D §6.4 — comments survive), derives `kind`/`target`/`effect` from the statement
 * (`src/lib/rule-statement.ts`, the shared mapping), and records `authored_in: 'dsl'` so the
 * builder can warn before reformatting it (ADR-003).
 *
 * Both paths are TYPE-CHECKED ON WRITE: `LGC-*` errors are 422 and the rule is not stored;
 * warnings return 201 with `diagnostics` alongside the rule (API §2.7). Both paths also recompute
 * the dependency closure server-side — the arrays are derived state (DB §4.4), and a client that
 * could write them could make the usage panels lie.
 */

import { AppError, frozenVersion } from '@resscript/observability';
import { assertExprShape, isExprShape, type Expr } from '@resscript/logic';
import { parse } from '@resscript/rescript-dsl';
import type { JsonObject } from '@resscript/schema';
import type { RuleEffectShape } from '@/lib/rule-statement';
import { ruleFromStatements } from '@/lib/rule-statement';
import { requireRole } from '@/server/auth';
import { toDslRegistry } from '@/server/dsl/registry';
import { parseJsonBody, requireActiveOrg, route } from '@/server/http/handler';
import { idPosition, pageEnvelope, pageQueryFrom } from '@/server/http/pagination';
import { json } from '@/server/http/respond';
import { createRuleSchema } from '@/server/http/schemas';
import type { CreateRuleInput } from '@/server/repo/types';
import { assertTargetExists, checkRuleCondition, dependencyClosureOf } from '@/server/rules';

const RULE_KIND_VALUES = ['display', 'skip', 'mask', 'set_variable', 'validate', 'option_state', 'terminate'];

export const GET = route<{ id: string }>(async (ctx, req, params) => {
  // Reviewer floor — `rules_select`'s own floor. A review link reads conditions as printed
  // text; the rule list is part of what a review is FOR, unlike the redirects' vendor URLs.
  requireRole(ctx.role, 'reviewer');
  requireActiveOrg(ctx);
  const version = await ctx.repos.surveys.getVersion(params.id);
  if (version === null) throw new AppError('not_found', 'version not found');

  const url = new URL(req.url);
  const page = pageQueryFrom(url);
  const kind = url.searchParams.get('kind');
  if (kind !== null && !RULE_KIND_VALUES.includes(kind)) {
    throw new AppError('validation_failed', '1 field failed validation', {
      details: [{ path: 'kind', code: 'invalid_value', message: `one of ${RULE_KIND_VALUES.join(', ')}` }],
    });
  }
  const targetNodeId = url.searchParams.get('target_node_id');
  const dependsOnNodeId = url.searchParams.get('depends_on_node_id');
  const dependsOnVariableId = url.searchParams.get('depends_on_variable_id');
  const { rows, hasMore } = await ctx.repos.rules.list(params.id, {
    ...page,
    ...(kind === null ? {} : { kind: kind as CreateRuleInput['kind'] }),
    ...(targetNodeId === null ? {} : { target_node_id: targetNodeId }),
    ...(dependsOnNodeId === null ? {} : { depends_on_node_id: dependsOnNodeId }),
    ...(dependsOnVariableId === null ? {} : { depends_on_variable_id: dependsOnVariableId }),
  });
  return json(pageEnvelope(rows, hasMore, page.limit, idPosition), { requestId: ctx.requestId });
});

export const POST = route<{ id: string }>(async (ctx, req, params) => {
  requireRole(ctx.role, 'programmer');
  requireActiveOrg(ctx);
  const version = await ctx.repos.surveys.getVersion(params.id);
  if (version === null) throw new AppError('not_found', 'version not found');
  // Frozen first, as everywhere: the body is irrelevant to a version that cannot change.
  if (version.status !== 'draft') throw frozenVersion(version.id);

  const { value } = await parseJsonBody(req, createRuleSchema);
  const rows = await ctx.repos.registry.forVersion(params.id);
  if (rows === null) throw new AppError('not_found', 'version not found');

  let input: Omit<CreateRuleInput, 'depends_on_variable_ids' | 'depends_on_node_ids'>;
  let condition: Expr;
  let effect: RuleEffectShape;

  if (value.source !== undefined) {
    const parsed = parse(value.source, toDslRegistry(rows));
    const parseErrors = parsed.diagnostics.filter((d) => d.severity === 'error');
    if (parseErrors.length > 0) {
      throw new AppError('validation_failed', 'the source does not compile', {
        details: parseErrors.map((d) => ({
          path: 'source',
          code: d.code,
          message: d.message,
        })),
      });
    }
    const mapped = ruleFromStatements(parsed.program.statements);
    if (!mapped.ok) {
      throw new AppError('validation_failed', '1 field failed validation', {
        details: [{ path: 'source', code: mapped.code, message: mapped.message }],
      });
    }
    // The statement's own target wins when it names one; `TERMINATE` names none, so the body's
    // stands — and one of the two must exist (`rules_one_target` wants exactly one).
    const target =
      mapped.rule.target ??
      (value.target === undefined ? undefined : targetColumns(value.target));
    if (target === undefined) {
      throw new AppError('validation_failed', '1 field failed validation', {
        details: [
          {
            path: 'target',
            code: 'target_required',
            message: 'this effect names no target in the text; send target alongside source',
          },
        ],
      });
    }
    condition = mapped.rule.condition;
    effect = mapped.rule.effect;
    input = {
      survey_version_id: params.id,
      kind: mapped.rule.kind,
      target_kind: target.target_kind,
      ...(target.target_kind === 'node' ? { target_node_id: target.target_node_id } : {}),
      ...(target.target_kind === 'item' ? { target_item_id: target.target_item_id } : {}),
      ...(target.target_kind === 'variable' ? { target_variable_id: target.target_variable_id } : {}),
      condition: condition as unknown as JsonObject,
      effect: effect as unknown as JsonObject,
      ...(value.evaluation === undefined ? {} : { evaluation: value.evaluation }),
      authored_in: 'dsl',
      trivia: mapped.rule.trivia as JsonObject,
      ...(value.notes === undefined ? {} : { notes: value.notes }),
    };
  } else {
    // The schema's refinements guarantee these three; the narrowing here is for the compiler.
    if (value.kind === undefined || value.effect === undefined || value.target === undefined) {
      throw new AppError('validation_failed', 'the AST path requires kind, target and effect');
    }
    if (!isExprShape(value.condition)) {
      throw new AppError('validation_failed', '1 field failed validation', {
        details: [{ path: 'condition', code: 'invalid_ast', message: 'not an AST node' }],
      });
    }
    condition = assertExprShape(value.condition);
    effect = value.effect as RuleEffectShape;
    const target = targetColumns(value.target);
    input = {
      survey_version_id: params.id,
      kind: value.kind,
      target_kind: target.target_kind,
      ...(target.target_kind === 'node' ? { target_node_id: target.target_node_id } : {}),
      ...(target.target_kind === 'item' ? { target_item_id: target.target_item_id } : {}),
      ...(target.target_kind === 'variable' ? { target_variable_id: target.target_variable_id } : {}),
      condition: value.condition as unknown as JsonObject,
      effect: value.effect as unknown as JsonObject,
      ...(value.evaluation === undefined ? {} : { evaluation: value.evaluation }),
      authored_in: 'visual',
      ...(value.notes === undefined ? {} : { notes: value.notes }),
    };
  }

  assertTargetExists(input, rows);

  const check = checkRuleCondition(condition, rows);
  if (check.hasErrors) {
    // 422, and NOT stored — API §2.7. The details carry the LGC codes the editor renders.
    throw new AppError('validation_failed', 'the condition failed the type check', {
      details: check.diagnostics
        .filter((d) => d.severity === 'error')
        .map((d) => ({ path: 'condition' + d.path, code: d.code, message: d.message })),
    });
  }

  const closure = dependencyClosureOf(condition, effect);
  const rule = await ctx.repos.rules.create({ ...input, ...closure });

  await ctx.repos.audit.write({
    action: 'rule.created',
    target_kind: 'logic_rule',
    target_id: rule.id,
    survey_id: version.survey_id,
    survey_version_id: version.id,
    summary: `created a ${rule.kind} rule (${rule.authored_in})`,
    request_id: ctx.requestId,
  });

  return json(
    { rule, diagnostics: check.diagnostics },
    { status: 201, requestId: ctx.requestId },
  );
});

type TargetColumns =
  | { readonly target_kind: 'node'; readonly target_node_id: string }
  | { readonly target_kind: 'item'; readonly target_item_id: string }
  | { readonly target_kind: 'variable'; readonly target_variable_id: string };

function targetColumns(target: {
  readonly node_id?: string | undefined;
  readonly item_id?: string | undefined;
  readonly variable_id?: string | undefined;
}): TargetColumns {
  if (target.node_id !== undefined) return { target_kind: 'node', target_node_id: target.node_id };
  if (target.item_id !== undefined) return { target_kind: 'item', target_item_id: target.item_id };
  if (target.variable_id !== undefined) {
    return { target_kind: 'variable', target_variable_id: target.variable_id };
  }
  // Unreachable behind the schema's exactly-one refinement.
  throw new AppError('validation_failed', 'exactly one of node_id, item_id, variable_id');
}
