/**
 * `GET|PUT /api/v1/versions/:id/translations/:lang` — the flat-file round trip (roadmap
 * P1-12: "Translation import/export as flat key-value files").
 *
 * ## The body IS the file
 *
 * GET returns `{key: value}` and nothing else — no envelope, no metadata — because the
 * response is what gets saved to disk, mailed to a translation agency, and PUT back verbatim.
 * Every BASE-language key appears (`''` where untranslated): the file is the translator's
 * whole worklist, and a file of only the finished strings would hide exactly the rows the
 * agency was hired for. PUT accepts the same shape back.
 *
 * ## Unknown keys are a 422 NAMING EACH ONE, and nothing is stored
 *
 * Keys are validated against the BASE language's key set before any write. The failure mode
 * this exists for: a translator edits `q1.text` into `q1.txt` in a text editor, the import
 * "succeeds", and the French survey ships with a missing string nobody can explain — the
 * typo'd row is attached to a key no question reads, so it is invisible everywhere except
 * here. Validation runs to completion over the whole body BEFORE the store is touched
 * (security §12.3's write rule, same as redirects), and the details name every offending key.
 *
 * ## `''` clears, deliberately
 *
 * An empty value imports as state `missing`, value NULL — 0007's own encoding
 * (`i18n_missing_has_no_value`). That is what makes export-then-import a no-op, and it also
 * gives the manager a way to retract a wrong translation without a delete endpoint (deletes
 * on `content.i18n_strings` are programmer-floor; clearing is translation entry).
 *
 * ## Floors
 *
 * Reviewer for BOTH directions — `i18n_select`/`i18n_insert`/`i18n_update`'s own floor
 * (0007): translation entry is reviewer work by design, one floor below every other content
 * write. The route must not be stricter than the policy, or the agency-facing workflow the
 * floor exists for is dead; it must not be looser, or the policy filters the write to zero
 * rows and the user sees a 404 they cannot act on.
 */

import { AppError, frozenVersion } from '@resscript/observability';
import { requireRole } from '@/server/auth';
import { parseJsonBody, requireActiveOrg, route } from '@/server/http/handler';
import { json } from '@/server/http/respond';
import { importTranslationsSchema } from '@/server/http/schemas';
import { baseKeysOf, flatTranslationFile, planImport } from '@/server/translations';
import type { RequestContext } from '@/server/context';
import type { LanguageRow, SurveyVersionRow } from '@/server/repo/types';

/** 404 for an unknown language: `:lang` is an address, and a miss is a missing resource. */
async function resolveLanguage(
  ctx: RequestContext,
  versionId: string,
  lang: string,
): Promise<{ version: SurveyVersionRow; language: LanguageRow; baseLang: string }> {
  const version = await ctx.repos.surveys.getVersion(versionId);
  if (version === null) throw new AppError('not_found', 'version not found');
  const languages = await ctx.repos.i18n.listLanguages(versionId);
  const language = languages.find((l) => l.lang === lang);
  if (language === undefined) {
    throw new AppError('not_found', 'this version does not carry that language', {
      details: [{ path: 'lang', code: 'unknown_language', message: lang }],
    });
  }
  const baseLang = languages.find((l) => l.is_base)?.lang ?? lang;
  return { version, language, baseLang };
}

export const GET = route<{ id: string; lang: string }>(async (ctx, _req, params) => {
  requireRole(ctx.role, 'reviewer');
  requireActiveOrg(ctx);
  const { baseLang } = await resolveLanguage(ctx, params.id, params.lang);
  const strings = await ctx.repos.i18n.listStrings(params.id);
  // The flat map, verbatim — see the header. `Content-Disposition` names the file so the
  // manager's Export button is a plain link-click save.
  return json(flatTranslationFile(strings, baseLang, params.lang), {
    requestId: ctx.requestId,
    headers: {
      'Content-Disposition': `attachment; filename="${params.id}.${params.lang}.json"`,
    },
  });
});

export const PUT = route<{ id: string; lang: string }>(async (ctx, req, params) => {
  requireRole(ctx.role, 'reviewer');
  requireActiveOrg(ctx);
  const { version, baseLang } = await resolveLanguage(ctx, params.id, params.lang);
  // Frozen check before the body is read, as everywhere: a frozen version's strings are part
  // of what it published (content.tg_draft_only is the trigger's copy of this answer).
  if (version.status !== 'draft') throw frozenVersion(version.id);

  const { value } = await parseJsonBody(req, importTranslationsSchema);

  const strings = await ctx.repos.i18n.listStrings(params.id);
  const plan = planImport(value, baseKeysOf(strings, baseLang));
  if (plan.unknownKeys.length > 0) {
    // Every offending key, not the first: the translator fixes the file once, not N times.
    throw new AppError(
      'validation_failed',
      `${plan.unknownKeys.length} key${plan.unknownKeys.length === 1 ? '' : 's'} do not exist in the base language`,
      {
        details: plan.unknownKeys.map((key) => ({
          path: key,
          code: 'unknown_key',
          message: `${key} is not a key of the ${baseLang} base language`,
        })),
      },
    );
  }

  const written = await ctx.repos.i18n.upsertStrings(params.id, params.lang, plan.rows);
  const cleared = plan.rows.filter((row) => row.state === 'missing').length;

  await ctx.repos.audit.write({
    action: 'version.translations_imported',
    target_kind: 'survey_version',
    target_id: version.id,
    survey_id: version.survey_id,
    survey_version_id: version.id,
    summary: `imported ${written} ${params.lang} string${written === 1 ? '' : 's'}`,
    // Counts, not values: an open-end's label can quote survey content, and the audit row
    // outlives the row-level answer GET gives anyone entitled to the strings.
    diff: { lang: params.lang, written, cleared },
    request_id: ctx.requestId,
  });

  return json(
    {
      survey_version_id: version.id,
      lang: params.lang,
      written,
      translated: written - cleared,
      cleared,
    },
    { requestId: ctx.requestId },
  );
});
