/**
 * `GET|POST /api/v1/versions/:id/translations` — the language manager's read, and the
 * add-language write (roadmap P1-12: "Language manager with per-string state and a
 * completeness gauge").
 *
 * ## The completeness gauge is computed HERE, not in the client
 *
 * Completeness = strings in state `translated`/`reviewed` over the BASE language's key count.
 * Server-side because the base key set is the denominator of every language's gauge, and a
 * client that re-derived it from a per-language read would count keys the base does not have
 * (imported typos of an earlier era, keys deleted from the base) as progress. The same
 * denominator also scopes the numerator: a stray row under a key the base no longer carries is
 * not translation progress, it is drift, and the gauge must not reward it.
 *
 * ## `?lang=` — the per-string detail, on the same route
 *
 * The manager's per-string state table (key → value/state, missing keys materialized as
 * `missing`) rides this route behind `?lang=` rather than living on `/translations/:lang`,
 * because that route's body is the FLAT FILE (`{key: value}`, the import/export round-trip
 * shape) and a second shape on the same path would make "what does GET return" depend on an
 * Accept header nobody sends. One route per shape.
 *
 * ## POST adds a language; nothing here removes one
 *
 * `languages_insert` is programmer-floor + draft-only (0007): adding a fielding language
 * changes what the compiler is asked to gate on (`block_publish_if_incomplete`), which is
 * survey structure, not translation entry. Removal is a DELETE policy this API deliberately
 * does not expose yet — dropping a language cascades away its strings, and that wants the
 * undo story P1-03's soft-delete machinery owns.
 */

import { AppError, frozenVersion } from '@resscript/observability';
import { requireRole } from '@/server/auth';
import { parseJsonBody, requireActiveOrg, route } from '@/server/http/handler';
import { json } from '@/server/http/respond';
import { addLanguageSchema } from '@/server/http/schemas';
import { summarizeTranslations } from '@/server/translations';

export const GET = route<{ id: string }>(async (ctx, req, params) => {
  // Reviewer floor — `languages_select` / `i18n_select`'s own floor (0007): translation state
  // is review material in a way redirect URLs (programmer-floor, vendor relationships) are not.
  requireRole(ctx.role, 'reviewer');
  requireActiveOrg(ctx);
  const version = await ctx.repos.surveys.getVersion(params.id);
  if (version === null) throw new AppError('not_found', 'version not found');

  const [languages, strings, survey] = await Promise.all([
    ctx.repos.i18n.listLanguages(params.id),
    ctx.repos.i18n.listStrings(params.id),
    ctx.repos.surveys.get(version.survey_id),
  ]);
  // The worker's `languagesOf` fallback, verbatim: no base row yet means the survey's
  // default_language IS the base — a version created before any string landed must still
  // answer with a denominator of zero rather than a 500.
  const baseLang =
    languages.find((l) => l.is_base)?.lang ?? survey?.default_language ?? 'en';

  const detailLang = new URL(req.url).searchParams.get('lang');
  const summary = summarizeTranslations({ languages, strings, baseLang, detailLang });

  return json(
    {
      survey_version_id: version.id,
      base_lang: baseLang,
      total_keys: summary.totalKeys,
      languages: summary.languages,
      ...(summary.strings === undefined ? {} : { strings: summary.strings }),
    },
    { requestId: ctx.requestId },
  );
});

export const POST = route<{ id: string }>(async (ctx, req, params) => {
  requireRole(ctx.role, 'programmer');
  requireActiveOrg(ctx);
  const version = await ctx.repos.surveys.getVersion(params.id);
  if (version === null) throw new AppError('not_found', 'version not found');
  // Frozen check first, as in every content write: a frozen version's language set is part of
  // what it published, and the body is irrelevant to that answer.
  if (version.status !== 'draft') throw frozenVersion(version.id);

  const { value } = await parseJsonBody(req, addLanguageSchema);
  const language = await ctx.repos.i18n.addLanguage(params.id, value.lang);

  await ctx.repos.audit.write({
    action: 'version.language_added',
    target_kind: 'survey_version',
    target_id: version.id,
    survey_id: version.survey_id,
    survey_version_id: version.id,
    summary: `added language ${language.lang}`,
    diff: { lang: language.lang },
    request_id: ctx.requestId,
  });

  return json({ survey_version_id: version.id, language }, { status: 201, requestId: ctx.requestId });
});
