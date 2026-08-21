/**
 * `POST /api/v1/dsl/compile` — source → AST + positioned diagnostics (API §5.1).
 *
 * This is the parse half of the pair 09-ui §7.3 names ("**code → builder**: `parse(source)`"). The
 * studio's own editor calls `parse` in-process on every keystroke (that is the point of a
 * zero-dependency package); this endpoint is what makes the same compile available to CI, to a
 * customer's questionnaire generator, and to the studio when it has no registry cached.
 *
 * Three decisions worth stating, all from API §5.1:
 *
 *  1. **A parse failure is `200 { ok: false }`, never `4xx`.** "The caller asked us to compile
 *     something; we did, and it did not compile. `400` is for a malformed *request*." An
 *     editor-style client polling this on every keystroke must not have to distinguish a syntax
 *     error from a transport failure — and property P8 guarantees the parser terminates on
 *     arbitrary input rather than throwing, which is what makes the promise keepable.
 *  2. **`scope.survey_version_id` is required** (see `dslCompileSchema`).
 *  3. **`source_map` is returned** so a caller can map an `ast_node_id` back to a span — the same
 *     `n` the trace and the memo table use.
 *
 * ## Where this diverges from API §5.1's example response
 *
 * §5.1 shows `statements` as *rules* (`{kind: 'display', target, condition, effect}`). What comes
 * back here is the DSL's **statement** AST, because `@resscript/rescript-dsl` deliberately does not
 * desugar: one statement is one to three rules, and the ids, `order_key`s and flow nodes are the
 * compiler's (P1-08; see that package's README, "What this package does *not* do"). Keeping the
 * statement as the round-trip unit is what makes T1 provable, so the divergence is in the design,
 * not in this route. Reported rather than papered over with a half-built `Rule`.
 *
 * `mode` is accepted and, for now, does not change the result: the parser reads whatever the
 * source contains, and `mode: 'expression'` would need a bare-expression entry point the grammar
 * does not have (D §6.2's `program` is a statement list). Recorded, not silently dropped.
 */

import { AppError } from '@resscript/observability';
import { parse } from '@resscript/rescript-dsl';
import { requireRole } from '@/server/auth';
import { parseJsonBody, requireActiveOrg, route } from '@/server/http/handler';
import { json } from '@/server/http/respond';
import { dslCompileSchema } from '@/server/http/schemas';
import { toDslRegistry } from '@/server/dsl/registry';

export const POST = route(async (ctx, req) => {
  // `programmer`, not `reviewer`: §6's mode table puts code mode in Advanced, and a reviewer reads
  // conditions as printed text from the tree payload's `rule_summaries` rather than by compiling
  // source. A reviewer who needs to read a rule gets §7.1's builder view, which is a different
  // endpoint with a different (lower) bar.
  requireRole(ctx.role, 'programmer');
  requireActiveOrg(ctx);

  const { value } = await parseJsonBody(req, dslCompileSchema);
  const rows = await ctx.repos.registry.forVersion(value.scope.survey_version_id);
  // 404 and not 403 for another org's version: API §1.5 — confirming existence is the leak.
  if (rows === null) throw new AppError('not_found', 'version not found');

  const registry = toDslRegistry(rows);
  const result = parse(value.source, registry);

  return json(
    {
      ok: result.ok,
      statements: result.program.statements,
      diagnostics: result.diagnostics.map((diagnostic) => ({
        code: diagnostic.code,
        severity: diagnostic.severity,
        message: diagnostic.message,
        // `source_span` is the field name API §1.5 gives every positioned diagnostic; the offsets
        // are UTF-16 code units (the DSL package's diagnostics.ts records why).
        ...(diagnostic.span === undefined ? {} : { source_span: diagnostic.span }),
        ...(diagnostic.path === '' ? {} : { path: diagnostic.path }),
        ...(diagnostic.detail === undefined ? {} : { detail: diagnostic.detail }),
      })),
      source_map: result.source_map.map((entry) => ({
        ast_node_id: entry.node,
        statement: entry.statement,
        start: entry.span.start,
        end: entry.span.end,
      })),
      summary: {
        errors: result.diagnostics.filter((d) => d.severity === 'error').length,
        warnings: result.diagnostics.filter((d) => d.severity === 'warning').length,
        infos: result.diagnostics.filter((d) => d.severity === 'info').length,
      },
    },
    { requestId: ctx.requestId },
  );
});
