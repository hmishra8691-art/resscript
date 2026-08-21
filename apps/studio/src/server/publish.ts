/**
 * The two things the publish and rollback routes must agree with the database about: the
 * capability floor, and which status transitions exist.
 *
 * ## Why the floor is a table and not `requireRole(ctx.role, 'programmer')` in each route
 *
 * Deliverable K §1 puts `publish` on `project_manager` (rank 50) and `publish to staging` on
 * `programmer` (rank 40), and migration 0009's header quotes that asymmetry as THE reason publish
 * is a `SECURITY DEFINER` function rather than DML: "an RLS policy on app.survey_versions cannot
 * express that, because the policy sees an UPDATE and not an intent". The function has the intent
 * in its argument list, and so does the request body — so the API can and must make the same
 * distinction. A route that checked `programmer` for both would let a programmer queue a job that
 * `app.publish_version` then refuses with `insufficient_privilege`: the work is done, the queue
 * slot is spent, the studio shows a failed publish, and the user is told nothing they can act on.
 * A route that checked `project_manager` for both would break the workflow staging exists for.
 *
 * The floors live here rather than inline so that "is the API more permissive than the function"
 * is one table to compare against one `CASE` in one migration.
 *
 * ## Why the refusal is audited
 *
 * A denied publish is a security-relevant event in a way a denied read is not: it is somebody
 * attempting to change what respondents see. Security §12.3's inventory and K §1's floors are only
 * auditable after the fact if the denial leaves a row, and the row has to be written through
 * `app.write_audit_event` because 0004 gave `app.audit_log` a SELECT policy and NO INSERT policy —
 * "an actor who can write their own audit trail can rewrite history". So the refusal path goes
 * through the same definer function as the success path, and the actor cannot suppress it.
 *
 * The audit is written BEFORE the throw and is deliberately not conditional on the reason: a
 * viewer who cannot publish anything and a programmer who reached for production both produce a
 * row, because "who keeps trying to publish to production" is exactly the question the trail is
 * for. What it does NOT record is anything about the version beyond its id — a refused caller must
 * not learn from the audit summary what they could not learn from the response.
 *
 * ## Why the transition table is here
 *
 * `app.tg_version_guard` owns the lifecycle, and H §2.4 requires the API to answer `409
 * illegal_transition` BEFORE the job is queued. Both are needed: the trigger is the guarantee, and
 * this is the message an author can act on — a `draft → production` publish is a real mistake (the
 * review step was skipped) and "cannot transition from draft to production" is the sentence that
 * explains it. Restating the trigger's list is duplication, and it is the cheap kind: it is eight
 * pairs, it is asserted against by this milestone's route tests, and the alternative is enqueuing
 * a job whose only outcome is a `check_violation` a user reads as a bug.
 */

import { illegalTransition } from '@resscript/observability';
import type { OrgRole, VersionStatus } from '@resscript/schema';
import { requireRole } from './auth.js';
import type { RequestContext } from './context.js';

/** What the request body can ask for. `review` is not publishable — see `publishVersionSchema`. */
export type PublishTarget = 'staging' | 'production';

/**
 * K §1's floors, matching `app.publish_version`'s
 * `CASE WHEN p_target_status = 'production' THEN 'project_manager' ELSE 'programmer' END`.
 */
export const PUBLISH_FLOORS: Readonly<Record<PublishTarget, OrgRole>> = {
  staging: 'programmer',
  production: 'project_manager',
};

/** `app.rollback_version`: "rollback changes what respondents see", so it is the PM capability. */
export const ROLLBACK_FLOOR: OrgRole = 'project_manager';

/**
 * `app.tg_version_guard`'s permitted transitions, verbatim and in its order.
 *
 * `archived → production` is the rollback, which is why it is on the list and why rollback is not
 * a transition the publish endpoint can express.
 */
export const LEGAL_VERSION_TRANSITIONS: readonly (readonly [VersionStatus, VersionStatus])[] = [
  ['draft', 'review'],
  ['draft', 'staging'],
  ['review', 'staging'],
  ['review', 'draft'],
  ['staging', 'production'],
  ['staging', 'archived'],
  ['review', 'archived'],
  ['production', 'archived'],
  ['archived', 'production'],
];

export function isLegalTransition(from: VersionStatus, to: VersionStatus): boolean {
  // A republish of a version already in the target status is not a transition at all: the guard's
  // check is `OLD.status <> NEW.status`, so it never fires, and a recompile of a live version is
  // a supported operation (K §3: "a recompile of a production version does not change status").
  if (from === to) return true;
  return LEGAL_VERSION_TRANSITIONS.some(([a, b]) => a === from && b === to);
}

export interface AuditedGuardSubject {
  readonly surveyId: string;
  readonly surveyVersionId: string;
}

/**
 * Enforce a floor, and leave a row when it refuses.
 *
 * Returns nothing and throws on refusal, for the reason `requireRole` gives: "an authorization
 * check whose result can be ignored is an authorization check that will be".
 */
export async function requireCapabilityAudited(
  ctx: RequestContext,
  floor: OrgRole,
  action: string,
  subject: AuditedGuardSubject,
  diff: Readonly<Record<string, string>>,
): Promise<void> {
  try {
    requireRole(ctx.role, floor);
  } catch (err: unknown) {
    await ctx.repos.audit.write({
      action,
      target_kind: 'survey_version',
      target_id: subject.surveyVersionId,
      survey_id: subject.surveyId,
      survey_version_id: subject.surveyVersionId,
      summary: `refused: requires ${floor}`,
      diff: { ...diff, required_role: floor, actual_role: ctx.role ?? 'none' },
      request_id: ctx.requestId,
    });
    throw err;
  }
}

/** `409 illegal_transition`, with the pair in the message. */
export function assertLegalTransition(from: VersionStatus, to: VersionStatus): void {
  if (!isLegalTransition(from, to)) throw illegalTransition(from, to);
}
