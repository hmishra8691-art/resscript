/**
 * A survey that has SHIPPED, plus the two members whose roles the publish floors distinguish.
 *
 * Opt-in rather than part of `createHarness()`, and the reason is the one `registry-fixture.ts`
 * demonstrates: the shared fixture is asserted on exhaustively by other suites ("the org has
 * exactly these members", "this project has exactly these surveys"), so a role or a survey added
 * to it for one milestone breaks four unrelated tests that were right. A fixture that only the
 * suite needing it installs keeps those assertions meaningful.
 *
 * The version shape is not a choice. `app.tg_version_guard` permits `archived → production` and
 * no other transition into production from a stopped version, so a rollback TARGET must be
 * `archived` with `compile_state = 'compiled'` and a hash, and there must be a separate
 * `production` version to roll back FROM. Reached here through `seedVersionAt`, which enforces
 * `sv_one_production` and `sv_compiled_needs_artifact` so the fixture cannot describe a state the
 * database refuses.
 */

import type { MemoryDataset } from '@/server/repo/memory';
import type { SurveyVersionRow } from '@/server/repo/types';

/** Fixed uuids, so a failing assertion names a role rather than a random id. */
export const PM_USER = '88888888-8888-8888-8888-888888888888';

export interface PublishFixture {
  readonly projectManager: string;
  readonly surveyId: string;
  /** The editable draft — version 1, what a publish-to-staging is aimed at. */
  readonly draft: SurveyVersionRow;
  /** A previous release, the only legal rollback target. */
  readonly archived: SurveyVersionRow;
  /** What respondents see now. */
  readonly production: SurveyVersionRow;
  readonly token: string;
}

export function seedPublishHistory(
  data: MemoryDataset,
  input: { readonly orgId: string; readonly projectId: string; readonly ownerId: string },
): PublishFixture {
  // K §1 puts publish-to-production and rollback on project_manager (50) and publish-to-staging on
  // programmer (40). The harness has a programmer; this adds the other side of that asymmetry.
  data.seedMember({ orgId: input.orgId, userId: PM_USER, role: 'project_manager', email: 'pm@a.test' });

  const { survey, draft } = data.seedSurvey({
    orgId: input.orgId,
    projectId: input.projectId,
    ref: 'SVYSHIP',
    name: 'Survey with history',
    createdBy: input.ownerId,
  });
  const archived = data.seedVersionAt({
    orgId: input.orgId,
    surveyId: survey.id,
    versionNo: 2,
    createdBy: input.ownerId,
    status: 'archived',
  });
  const production = data.seedVersionAt({
    orgId: input.orgId,
    surveyId: survey.id,
    versionNo: 3,
    createdBy: input.ownerId,
    status: 'production',
  });
  const token = data.seedToken({
    // 26 lowercase base-36 characters, K §5's alphabet — the domain the real column enforces, so a
    // fixture token cannot be a shape `runtime.survey_token` would reject.
    token: 'k'.repeat(26),
    orgId: input.orgId,
    surveyId: survey.id,
    versionId: production.id,
    artifactHash: production.artifact_hash as string,
    status: 'production',
  });

  return {
    projectManager: PM_USER,
    surveyId: survey.id,
    draft,
    archived,
    production,
    token: token.token,
  };
}
