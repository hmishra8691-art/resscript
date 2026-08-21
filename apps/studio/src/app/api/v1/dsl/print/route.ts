/**
 * `POST /api/v1/dsl/print` — AST → source (API §5.2, named by 09-ui §7.3 as the builder → code
 * direction).
 *
 * ```
 * POST /v1/dsl/print
 * { "statements": [ {…AST…} ], "scope": { "survey_version_id": "ver_01H…" } }
 * → 200 { "source": "IF S1 = Yes AND AGE >= 18 THEN SHOW Q12\n" }
 * ```
 *
 * Two things this route is for, beyond the toggle:
 *
 *  - API §11.1's workflow — an agency prints its rules to a `.rsl` file and diffs it in code
 *    review. That is the commercial argument for T1/T2 and it needs a server-side printer.
 *  - The tree's annotation lines (§3.1: "the printer is the renderer"), when the studio renders
 *    them without a local registry.
 *
 * ## `scope` is required here even though API §5.2's example omits it
 *
 * §5.2's own guarantee is that "`id → ref` rendering uses the *current* `ref`, so a rule printed
 * after a rename reads with the new name". An AST stores ids (D §2.1 item 3), so there is no way to
 * print `Q12` without the registry that maps `qst_…` to `Q12`. Printing without one would emit raw
 * ids — unreadable — or omit the target, which would be worse. So the field is required and the
 * omission in §5.2's example is reported as a documentation gap rather than implemented as an
 * unusable optional.
 *
 * ## Why an invalid AST is a `400` here and an invalid *source* is a `200` in the sibling route
 *
 * A malformed AST is a malformed **request**: no user typed it, a program built it, and the caller
 * has a bug. A malformed source is the normal state of a text editor between keystrokes. The
 * asymmetry is API §1.5's rule applied honestly in both directions.
 */

import { AppError } from '@resscript/observability';
import { print, type Program, type Statement } from '@resscript/rescript-dsl';
import { requireRole } from '@/server/auth';
import { parseJsonBody, requireActiveOrg, route } from '@/server/http/handler';
import { json } from '@/server/http/respond';
import { dslPrintSchema } from '@/server/http/schemas';
import { toDslRegistry } from '@/server/dsl/registry';

export const POST = route(async (ctx, req) => {
  requireRole(ctx.role, 'programmer');
  requireActiveOrg(ctx);

  const { value } = await parseJsonBody(req, dslPrintSchema);
  if (value.options?.symbolic_option_refs === false) {
    throw new AppError('validation_failed', '1 field failed validation', {
      details: [
        {
          path: 'options.symbolic_option_refs',
          code: 'not_implementable',
          message:
            'D §6.4 T2 forbids the printer changing the author\'s symbolic-vs-numeric choice; it ' +
            'comes from the AST trivia. Only `true` (the default) is available.',
        },
      ],
    });
  }

  const rows = await ctx.repos.registry.forVersion(value.scope.survey_version_id);
  if (rows === null) throw new AppError('not_found', 'version not found');
  const registry = toDslRegistry(rows);

  // The cast is where an unvalidated AST becomes a typed one, and the `try` below is what makes it
  // honest: the printer's exhaustive `switch` throws `LogicInvariant` on a node kind it does not
  // know, which is a far better validator than a hand-written Zod mirror of 58 node kinds could
  // ever be (see `dslPrintSchema`).
  const program: Program = { statements: value.statements as readonly Statement[] };
  let source: string;
  try {
    source = print(program, registry, {
      ...(value.options?.width === undefined ? {} : { width: value.options.width }),
      ...(value.options?.indent === undefined ? {} : { indent: value.options.indent }),
    });
  } catch (error: unknown) {
    throw new AppError('validation_failed', 'the statements could not be printed', {
      details: [
        {
          path: 'statements',
          code: 'invalid_ast',
          message: error instanceof Error ? error.message : String(error),
        },
      ],
      cause: error,
    });
  }

  return json({ source }, { requestId: ctx.requestId });
});
