/**
 * `GET|PATCH /api/v1/versions/:id`
 *
 * This is where optimistic concurrency lives (API §1.7). GET issues the `ETag`
 * `W/"<revision>.<ms>"`; PATCH requires `If-Match` and answers:
 *
 *   - `428 precondition_required` when the header is absent — never a silent success, because
 *     a client that does not participate in the lock is a client that overwrites a colleague;
 *   - `412 revision_conflict` when it does not match, carrying `current_revision` and
 *     `changed_since` so the studio's auto-retry (UI §5.3) can decide whether the collision
 *     touched the same nodes it did;
 *   - `409 frozen_version` on a non-draft, checked BEFORE the lock, because "clone a new draft
 *     to edit" is the actionable message and the revision is irrelevant to it.
 *
 * `status` is deliberately NOT writable here. Publishing runs a compiler, writes an artifact,
 * mints a token and fires a webhook; modelling it as a field update would lie about all four.
 */

import { AppError, frozenVersion } from '@resscript/observability';
import type { JsonValue } from '@resscript/schema';
import { requireRole } from '@/server/auth';
import { requireIfMatch, versionEtag } from '@/server/http/etag';
import { parseJsonBody, requireActiveOrg, route } from '@/server/http/handler';
import { json, revisionConflictResponse } from '@/server/http/respond';
import { updateVersionSchema } from '@/server/http/schemas';

export const GET = route<{ id: string }>(async (ctx, _req, params) => {
  requireRole(ctx.role, 'client');
  requireActiveOrg(ctx);
  const version = await ctx.repos.surveys.getVersion(params.id);
  if (version === null) throw new AppError('not_found', 'version not found');
  return json(version, {
    requestId: ctx.requestId,
    headers: { ETag: versionEtag(version.revision, ctx.now()) },
  });
});

export const PATCH = route<{ id: string }>(async (ctx, req, params) => {
  requireRole(ctx.role, 'programmer');
  requireActiveOrg(ctx);
  const current = await ctx.repos.surveys.getVersion(params.id);
  if (current === null) throw new AppError('not_found', 'version not found');
  // Frozen check first: ADR-002 says a non-draft version is immutable, and the API's job is to
  // say so in a way the editor can render.
  if (current.status !== 'draft') throw frozenVersion(current.id);

  const ifMatch = requireIfMatch(req);
  const { value } = await parseJsonBody(req, updateVersionSchema);
  const updated = await ctx.repos.surveys.updateVersion(params.id, ifMatch.revision, {
    ...(value.notes === undefined ? {} : { notes: value.notes }),
  });

  if (updated === null) {
    const latest = await ctx.repos.surveys.getVersion(params.id);
    const changed = await ctx.repos.audit.since(
      params.id,
      // The ETag's timestamp is what gives `changed_since` a range to query; the revision
      // alone would give none. This is why the ETag carries both.
      new Date(ifMatch.issuedAtMs).toISOString(),
    );
    return revisionConflictResponse({
      requestId: ctx.requestId,
      currentRevision: latest?.revision ?? current.revision,
      changedSince: changed.map(
        (row): JsonValue => ({
          action: row.action,
          actor: row.actor_user_id,
          at: row.created_at,
          target_id: row.target_id ?? null,
        }),
      ),
      expected: String(ifMatch.revision),
    });
  }

  await ctx.repos.audit.write({
    action: 'version.updated',
    target_kind: 'survey_version',
    target_id: updated.id,
    survey_id: updated.survey_id,
    survey_version_id: updated.id,
    summary: 'updated version notes',
    diff: { notes: { from: current.notes, to: updated.notes } },
    request_id: ctx.requestId,
  });

  return json(updated, {
    requestId: ctx.requestId,
    headers: { ETag: versionEtag(updated.revision, ctx.now()) },
  });
});
