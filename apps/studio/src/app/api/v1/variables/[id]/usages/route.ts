/**
 * `GET /api/v1/variables/:id/usages` — "everything that reads this variable" (API §2.6).
 *
 * The contract is `{rules, quotas, masks, pipes, redirects}`, "backed by the
 * `depends_on_variable_ids` GIN index (DB §4.4)". What is actually backed today, honestly:
 *
 *  - **`rules`** — real, and the GIN lookup: every `content.logic_rules` row whose dependency
 *    closure contains the variable (`@>` over `rules_depends_var_gin` in `SupabaseRepo`; the
 *    same predicate in JS in the test store).
 *  - **`quotas`** — always empty. Quota plans are P2-06; there is no `content.quotas` yet.
 *  - **`masks` / `pipes`** — always empty. Both live inside node config (schema §15 / §5), and
 *    the content-node routes are P1-03's; until nodes store masks there is nothing to walk.
 *  - **`redirects`** — always empty. A redirect's `url_template` can pipe a variable, but
 *    template-variable extraction belongs to the template validator (`src/server/redirects.ts`)
 *    and is not implemented; wiring a regex here would be a second, drifting parser.
 *
 * The empty arrays are in the response rather than omitted, so a client written against the
 * documented shape works unchanged when each producer lands. Gaps recorded, not papered over.
 */

import { AppError } from '@resscript/observability';
import { requireRole } from '@/server/auth';
import { requireActiveOrg, route } from '@/server/http/handler';
import { json } from '@/server/http/respond';

export const GET = route<{ id: string }>(async (ctx, _req, params) => {
  requireRole(ctx.role, 'reviewer');
  requireActiveOrg(ctx);
  const usages = await ctx.repos.rules.usagesOfVariable(params.id);
  // Another org's variable and a missing one answer identically (API §1.5).
  if (usages === null) throw new AppError('not_found', 'variable not found');
  return json(
    {
      variable_id: params.id,
      survey_version_id: usages.survey_version_id,
      rules: usages.rules,
      quotas: [],
      masks: [],
      pipes: [],
      redirects: [],
    },
    { requestId: ctx.requestId },
  );
});
