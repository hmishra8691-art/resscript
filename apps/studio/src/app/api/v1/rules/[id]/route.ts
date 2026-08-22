/**
 * `GET|PATCH|DELETE /api/v1/rules/:id` — one rule (API §2.7).
 *
 * Addressed by rule id alone, as the API table spells it: the caller got the id from a
 * version-scoped list that already scoped it, and the store re-derives the version (and RLS
 * re-derives the org) from the row itself.
 *
 * PATCH re-runs everything POST ran on whatever the merge produced: the type check against the
 * version's registry, the target-exists check, and — whenever the condition or the effect moved
 * — the dependency closure. The closure is derived state (DB §4.4 "recomputed from the AST on
 * save"); an update path that could change the AST without rewriting it is how the usage panels
 * start lying, so the recompute is unconditional on those two fields, not an option.
 *
 * DELETE is soft (`deleted_at`) — the editor's undo buffer, like every content row. No
 * `If-Match` on any of these: a rule row is edited as a unit (the AST is one value), so the
 * last-write-wins semantics of a whole-row PUT apply, and the ETag issuer stays singular
 * (see the redirects route for the argument).
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
import { json, noContent } from '@/server/http/respond';
import { updateRuleSchema } from '@/server/http/schemas';
import type { UpdateRuleInput } from '@/server/repo/types';
import { assertTargetExists, checkRuleCondition, dependencyClosureOf } from '@/server/rules';

export const GET = route<{ id: string }>(async (ctx, _req, params) => {
  requireRole(ctx.role, 'reviewer');
  requireActiveOrg(ctx);
  const rule = await ctx.repos.rules.get(params.id);
  if (rule === null) throw new AppError('not_found', 'rule not found');
  return json({ rule }, { requestId: ctx.requestId });
});

export const PATCH = route<{ id: string }>(async (ctx, req, params) => {
  requireRole(ctx.role, 'programmer');
  requireActiveOrg(ctx);
  const current = await ctx.repos.rules.get(params.id);
  if (current === null) throw new AppError('not_found', 'rule not found');
  const version = await ctx.repos.surveys.getVersion(current.survey_version_id);
  if (version === null) throw new AppError('not_found', 'rule not found');
  if (version.status !== 'draft') throw frozenVersion(version.id);

  const { value } = await parseJsonBody(req, updateRuleSchema);
  const rows = await ctx.repos.registry.forVersion(current.survey_version_id);
  if (rows === null) throw new AppError('not_found', 'rule not found');

  let patch: UpdateRuleInput = {
    ...(value.kind === undefined ? {} : { kind: value.kind }),
    ...(value.evaluation === undefined ? {} : { evaluation: value.evaluation }),
    ...(value.notes === undefined ? {} : { notes: value.notes }),
  };

  if (value.target !== undefined) {
    const t = value.target;
    patch = {
      ...patch,
      target_kind: t.node_id !== undefined ? 'node' : t.item_id !== undefined ? 'item' : 'variable',
      target_node_id: t.node_id ?? null,
      target_item_id: t.item_id ?? null,
      target_variable_id: t.variable_id ?? null,
    };
  }

  if (value.source !== undefined) {
    // Editing as ResScript replaces the whole semantic half of the row — condition, effect,
    // kind, trivia — and re-marks it `authored_in: 'dsl'` (ADR-003: fidelity reports on what
    // the author actually used last).
    const parsed = parse(value.source, toDslRegistry(rows));
    const parseErrors = parsed.diagnostics.filter((d) => d.severity === 'error');
    if (parseErrors.length > 0) {
      throw new AppError('validation_failed', 'the source does not compile', {
        details: parseErrors.map((d) => ({ path: 'source', code: d.code, message: d.message })),
      });
    }
    const mapped = ruleFromStatements(parsed.program.statements);
    if (!mapped.ok) {
      throw new AppError('validation_failed', '1 field failed validation', {
        details: [{ path: 'source', code: mapped.code, message: mapped.message }],
      });
    }
    patch = {
      ...patch,
      kind: mapped.rule.kind,
      condition: mapped.rule.condition as unknown as JsonObject,
      effect: mapped.rule.effect as unknown as JsonObject,
      authored_in: 'dsl',
      trivia: mapped.rule.trivia as JsonObject,
      ...(mapped.rule.target === undefined
        ? {}
        : {
            target_kind: mapped.rule.target.target_kind,
            target_node_id:
              mapped.rule.target.target_kind === 'node' ? mapped.rule.target.target_node_id : null,
            target_item_id: null,
            target_variable_id:
              mapped.rule.target.target_kind === 'variable'
                ? mapped.rule.target.target_variable_id
                : null,
          }),
    };
  } else {
    if (value.condition !== undefined) {
      if (!isExprShape(value.condition)) {
        throw new AppError('validation_failed', '1 field failed validation', {
          details: [{ path: 'condition', code: 'invalid_ast', message: 'not an AST node' }],
        });
      }
      // A hand-built AST landing here marks the rule visual again, and drops the trivia the
      // DSL form carried — the same loss the builder's toggle warns about, now recorded.
      patch = {
        ...patch,
        condition: value.condition as unknown as JsonObject,
        authored_in: 'visual',
        trivia: {},
      };
    }
    if (value.effect !== undefined) {
      patch = { ...patch, effect: value.effect as unknown as JsonObject };
    }
  }

  // The merged row is what must hold the invariants, not the patch alone.
  const mergedCondition = (patch.condition ?? current.condition) as unknown;
  const mergedEffect = (patch.effect ?? current.effect) as unknown as RuleEffectShape;
  if (!isExprShape(mergedCondition)) {
    throw new AppError('validation_failed', 'the stored condition is not an AST');
  }
  const condition: Expr = assertExprShape(mergedCondition);

  assertTargetExists(
    {
      target_kind: patch.target_kind ?? current.target_kind,
      target_node_id: patch.target_node_id === undefined ? current.target_node_id : patch.target_node_id,
      target_item_id: patch.target_item_id === undefined ? current.target_item_id : patch.target_item_id,
      target_variable_id:
        patch.target_variable_id === undefined ? current.target_variable_id : patch.target_variable_id,
    },
    rows,
  );

  const check = checkRuleCondition(condition, rows);
  if (check.hasErrors) {
    throw new AppError('validation_failed', 'the condition failed the type check', {
      details: check.diagnostics
        .filter((d) => d.severity === 'error')
        .map((d) => ({ path: 'condition' + d.path, code: d.code, message: d.message })),
    });
  }

  if (patch.condition !== undefined || patch.effect !== undefined) {
    patch = { ...patch, ...dependencyClosureOf(condition, mergedEffect) };
  }

  const rule = await ctx.repos.rules.update(params.id, patch);

  await ctx.repos.audit.write({
    action: 'rule.updated',
    target_kind: 'logic_rule',
    target_id: rule.id,
    survey_id: version.survey_id,
    survey_version_id: version.id,
    summary: `updated a ${rule.kind} rule`,
    request_id: ctx.requestId,
  });

  return json({ rule, diagnostics: check.diagnostics }, { requestId: ctx.requestId });
});

export const DELETE = route<{ id: string }>(async (ctx, _req, params) => {
  requireRole(ctx.role, 'programmer');
  requireActiveOrg(ctx);
  const current = await ctx.repos.rules.get(params.id);
  if (current === null) throw new AppError('not_found', 'rule not found');
  const version = await ctx.repos.surveys.getVersion(current.survey_version_id);
  if (version === null) throw new AppError('not_found', 'rule not found');
  if (version.status !== 'draft') throw frozenVersion(version.id);

  await ctx.repos.rules.remove(params.id);
  await ctx.repos.audit.write({
    action: 'rule.deleted',
    target_kind: 'logic_rule',
    target_id: current.id,
    survey_id: version.survey_id,
    survey_version_id: version.id,
    summary: `deleted a ${current.kind} rule`,
    request_id: ctx.requestId,
  });
  return noContent(ctx.requestId);
});
