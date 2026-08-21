/**
 * Publish, compile status, version history and rollback (roadmap P1-08, API §2.4).
 *
 * The centre of this suite is K §1's ASYMMETRY, which migration 0009's header quotes as the reason
 * publish is a `SECURITY DEFINER` function at all: publish to production is `project_manager`
 * (rank 50), publish to staging is `programmer` (rank 40). Two floors on one endpoint, chosen from
 * the request body — which is what an RLS policy cannot do, because it sees an UPDATE and not an
 * intent. Every refusal must also leave an audit row, because a denied publish is somebody
 * attempting to change what respondents see.
 *
 * Assertions are on status codes, envelope CODES and stored rows. Never on message prose.
 */

import { describe, expect, it } from 'vitest';
import { POST as publishVersion } from '@/app/api/v1/versions/[id]/publish/route';
import { GET as getDiagnostics } from '@/app/api/v1/versions/[id]/diagnostics/route';
import { GET as getHistory } from '@/app/api/v1/surveys/[id]/history/route';
import { POST as rollbackSurvey } from '@/app/api/v1/surveys/[id]/rollback/route';
import { GET as getJob } from '@/app/api/v1/jobs/[id]/route';
import { createHarness, params, readJson, req, type Harness } from '@/test/harness';
import { seedPublishHistory, type PublishFixture } from '@/test/publish-fixture';

function envelopeCode(body: Record<string, unknown>): string {
  return (body['error'] as { code: string }).code;
}

function shipped(h: Harness): PublishFixture {
  return seedPublishHistory(h.data, {
    orgId: h.ids.orgA,
    projectId: h.ids.projectA,
    ownerId: h.ids.ownerA,
  });
}

function publishRequest(versionId: string, body: unknown, headers?: Record<string, string>): Request {
  return req(`/api/v1/versions/${versionId}/publish`, {
    method: 'POST',
    body,
    ...(headers === undefined ? {} : { headers }),
  });
}

/* ========================================================================== */
/* POST /versions/:id/publish                                                  */
/* ========================================================================== */

describe('POST /api/v1/versions/:id/publish', () => {
  it('lets a programmer publish to staging and queues exactly one compile job', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    const response = await readJson(
      await publishVersion(
        publishRequest(h.ids.draftA, { target: 'staging' }),
        params({ id: h.ids.draftA }),
      ),
    );

    expect(response.status).toBe(202);
    expect(response.headers.get('Retry-After')).toBe('2');
    const job = response.body['job'] as Record<string, unknown>;
    expect(job['kind']).toBe('compile');
    expect(job['status']).toBe('queued');
    expect(response.headers.get('Location')).toBe('/api/v1/jobs/' + String(job['id']));

    // The payload is what `apps/worker`'s `compileJob.parse` reads, in its exact snake_case keys.
    const row = h.data.jobs.find((j) => j.id === job['id']);
    expect(row?.survey_version_id).toBe(h.ids.draftA);
    // From the SESSION, never from the body: 0009's publish transaction reads `created_by` to
    // decide whether the caller may publish at all.
    expect(row?.created_by).toBe(h.ids.programmerA);
  });

  it('refuses a programmer publishing to production, and audits the refusal', async () => {
    const h = createHarness();
    const fixture = shipped(h);
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    const response = await readJson(
      await publishVersion(
        publishRequest(fixture.draft.id, { target: 'production' }),
        params({ id: fixture.draft.id }),
      ),
    );

    expect(response.status).toBe(403);
    expect(envelopeCode(response.body)).toBe('forbidden');
    // API §1.5: `details` names the required role.
    const details = (response.body['error'] as { details: { code: string; message: string }[] })
      .details;
    expect(details).toEqual(
      expect.arrayContaining([{ path: null, code: 'role_required', message: 'project_manager' }]),
    );

    // No job. A refused publish must not spend a queue slot.
    expect(h.data.jobs.filter((j) => j.status === 'queued')).toEqual([]);

    // And the refusal is on the record, through `app.write_audit_event` — the only writer, because
    // `app.audit_log` has a SELECT policy and no INSERT policy.
    const audit = h.data.audit.filter((a) => a.action === 'version.publish_refused');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      org_id: h.ids.orgA,
      actor_user_id: h.ids.programmerA,
      survey_version_id: fixture.draft.id,
    });
    expect(audit[0]?.diff).toMatchObject({
      target_status: 'production',
      required_role: 'project_manager',
      actual_role: 'programmer',
    });
  });

  it('lets a project_manager publish to production', async () => {
    const h = createHarness();
    const fixture = shipped(h);
    // `staging -> production` is the transition `app.tg_version_guard` permits; a draft cannot go
    // straight to production, which the next test pins.
    h.data.versions[h.data.versions.findIndex((v) => v.id === fixture.draft.id)] = {
      ...fixture.draft,
      status: 'staging',
      compile_state: 'compiled',
      artifact_hash: 'a'.repeat(64),
    };
    h.as({ userId: fixture.projectManager, activeOrgId: h.ids.orgA });
    const response = await readJson(
      await publishVersion(
        publishRequest(fixture.draft.id, { target: 'production' }),
        params({ id: fixture.draft.id }),
      ),
    );
    expect(response.status).toBe(202);
    expect(h.data.audit.filter((a) => a.action === 'version.publish_refused')).toEqual([]);
  });

  it('refuses a viewer both targets, and audits both refusals', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.viewerA, activeOrgId: h.ids.orgA });
    for (const target of ['staging', 'production'] as const) {
      const response = await readJson(
        await publishVersion(
          publishRequest(h.ids.draftA, { target }),
          params({ id: h.ids.draftA }),
        ),
      );
      expect(response.status).toBe(403);
    }
    const audit = h.data.audit.filter((a) => a.action === 'version.publish_refused');
    expect(audit).toHaveLength(2);
    expect(audit.map((a) => (a.diff as { target_status: string }).target_status).sort()).toEqual([
      'production',
      'staging',
    ]);
    expect(h.data.jobs.filter((j) => j.status === 'queued')).toEqual([]);
  });

  it('is 409 illegal_transition for draft to production, before any job is queued', async () => {
    const h = createHarness();
    const fixture = shipped(h);
    h.as({ userId: fixture.projectManager, activeOrgId: h.ids.orgA });
    const response = await readJson(
      await publishVersion(
        publishRequest(fixture.draft.id, { target: 'production' }),
        params({ id: fixture.draft.id }),
      ),
    );
    // `app.tg_version_guard` permits draft->review, draft->staging and staging->production, so the
    // review step cannot be skipped. Answered here rather than by the trigger, because a queued
    // job whose only outcome is a `check_violation` tells the author nothing.
    expect(response.status).toBe(409);
    expect(envelopeCode(response.body)).toBe('illegal_transition');
    expect(h.data.jobs.filter((j) => j.status === 'queued')).toEqual([]);
  });

  it("refuses target 'review', which app.publish_version cannot accept", async () => {
    const h = createHarness();
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    const response = await readJson(
      await publishVersion(
        publishRequest(h.ids.draftA, { target: 'review' }),
        params({ id: h.ids.draftA }),
      ),
    );
    // H §2.4 lists it; 0009 refuses it ("draft and review are authoring states"). Rejected at the
    // boundary rather than queued as a job that can only fail.
    expect(response.status).toBe(422);
    expect(envelopeCode(response.body)).toBe('validation_failed');
  });

  it('rejects an unknown body field rather than ignoring it', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    const response = await readJson(
      await publishVersion(
        publishRequest(h.ids.draftA, { target: 'staging', acknowledge_all: true }),
        params({ id: h.ids.draftA }),
      ),
    );
    // API §1.1: an ignored typo is a survey that quietly lacks a quota.
    expect(response.status).toBe(400);
    expect(envelopeCode(response.body)).toBe('unknown_field');
  });

  it("is not_found for another org's version, and leaves no audit row naming it", async () => {
    const h = createHarness();
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    const response = await readJson(
      await publishVersion(
        publishRequest(h.ids.draftB, { target: 'staging' }),
        params({ id: h.ids.draftB }),
      ),
    );
    expect(response.status).toBe(404);
    // A cross-tenant probe must not leave a row naming a survey the caller cannot see, which is
    // why the version is read before the capability check.
    expect(h.data.audit.filter((a) => a.survey_version_id === h.ids.draftB)).toEqual([]);
  });

  it('records the acknowledged warning keys and their notes in the audit trail', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    await publishVersion(
      publishRequest(h.ids.draftA, {
        target: 'staging',
        acknowledge_warnings: [
          { key: 'LGC-W030/logic_rules/0/condition', reason: 'intentional debug switch' },
          { key: 'LGC-U002/content/0' },
        ],
      }),
      params({ id: h.ids.draftA }),
    );

    // 03 §17: "who signed off on shipping this" must be answerable months later.
    const audit = h.data.audit.find((a) => a.action === 'version.publish_requested');
    expect(audit?.diff).toMatchObject({
      acknowledged_warnings: [
        { key: 'LGC-W030/logic_rules/0/condition', reason: 'intentional debug switch' },
        { key: 'LGC-U002/content/0', reason: null },
      ],
    });

    // The worker's payload carries KEYS only: it compares them with `acknowledgementKey()` and has
    // no use for a note.
    const job = h.data.jobs.find((j) => j.status === 'queued');
    expect(job?.survey_version_id).toBe(h.ids.draftA);
  });

  it('double-clicking Publish produces exactly one job row', async () => {
    // ACCEPTANCE (M0.4, relied on by P1-08): `jobs_idem_key`. The key is DERIVED, so a client that
    // sends no Idempotency-Key still gets one job.
    const h = createHarness();
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    const first = await readJson(
      await publishVersion(
        publishRequest(h.ids.draftA, { target: 'staging' }),
        params({ id: h.ids.draftA }),
      ),
    );
    const second = await readJson(
      await publishVersion(
        publishRequest(h.ids.draftA, { target: 'staging' }),
        params({ id: h.ids.draftA }),
      ),
    );

    expect(first.status).toBe(202);
    // 200, not 202: the second click attached to the running job rather than starting work, and
    // API §4 makes that distinction visible so the studio does not claim otherwise.
    expect(second.status).toBe(200);
    expect((second.body['job'] as { id: string }).id).toBe(
      (first.body['job'] as { id: string }).id,
    );
    // The harness seeds an unrelated running `compile` job, so this counts the rows THIS
    // endpoint made — identified by the key it derives.
    expect(
      h.data.jobs.filter((j) => j.idempotency_key?.startsWith('publish:') === true),
    ).toHaveLength(1);
  });

  it('replays the first response for a repeated Idempotency-Key', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    const headers = { 'Idempotency-Key': 'publish-once' };
    await publishVersion(
      publishRequest(h.ids.draftA, { target: 'staging' }, headers),
      params({ id: h.ids.draftA }),
    );
    const replay = await publishVersion(
      publishRequest(h.ids.draftA, { target: 'staging' }, headers),
      params({ id: h.ids.draftA }),
    );
    expect(replay.headers.get('Idempotent-Replay')).toBe('true');
  });

  it('the queued job is readable through GET /jobs/:id with the same projection', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    const created = await readJson(
      await publishVersion(
        publishRequest(h.ids.draftA, { target: 'staging' }),
        params({ id: h.ids.draftA }),
      ),
    );
    const id = (created.body['job'] as { id: string }).id;
    const polled = await readJson(await getJob(req('/x'), params({ id })));
    // One projection, so the studio's JobStatus component reads the same keys from both.
    expect(polled.body).toEqual(created.body['job']);
  });
});

/* ========================================================================== */
/* GET /versions/:id/diagnostics                                               */
/* ========================================================================== */

describe('GET /api/v1/versions/:id/diagnostics', () => {
  function withDiagnostics(h: Harness, versionId: string): void {
    const index = h.data.versions.findIndex((v) => v.id === versionId);
    const version = h.data.versions[index];
    if (version === undefined) throw new Error('no version');
    h.data.versions[index] = {
      ...version,
      compile_state: 'failed',
      compile_diagnostics: [
        { code: 'LGC-F001', severity: 'error', message: 'forward reference', path: '/logic_rules/0' },
        { code: 'LGC-W030', severity: 'warning', message: 'constant condition', path: '/logic_rules/1' },
        { code: 'LGC-W040', severity: 'warning', message: 'option never shown', path: '/content/0' },
      ],
      acknowledged_warnings: ['LGC-W030/logic_rules/1'],
    };
  }

  it('returns the stored list with the compile state it belongs to', async () => {
    const h = createHarness();
    withDiagnostics(h, h.ids.draftA);
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    const response = await readJson(
      await getDiagnostics(req('/x'), params({ id: h.ids.draftA })),
    );
    expect(response.status).toBe(200);
    // K §3's two axes. An empty list means "nothing to fix" only when compile_state says compiled,
    // and the client must not have to infer that from the list's length.
    expect(response.body['compile_state']).toBe('failed');
    expect(response.body['status']).toBe('draft');
    expect(response.body['summary']).toEqual({ total: 3, errors: 1, warnings: 2 });
    expect(response.body['acknowledged_warnings']).toEqual(['LGC-W030/logic_rules/1']);
  });

  it('filters by severity', async () => {
    const h = createHarness();
    withDiagnostics(h, h.ids.draftA);
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    const response = await readJson(
      await getDiagnostics(req('/x?severity=error'), params({ id: h.ids.draftA })),
    );
    const codes = (response.body['diagnostics'] as { code: string }[]).map((d) => d.code);
    expect(codes).toEqual(['LGC-F001']);
    // The summary is over the WHOLE list, so a filtered view still shows how much is left.
    expect(response.body['summary']).toEqual({ total: 3, errors: 1, warnings: 2 });
  });

  it('rejects an unknown severity rather than silently returning everything', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    const response = await readJson(
      await getDiagnostics(req('/x?severity=fatal'), params({ id: h.ids.draftA })),
    );
    expect(response.status).toBe(422);
    expect(envelopeCode(response.body)).toBe('validation_failed');
  });

  it('is readable by a client, who has to be told why a review link will not publish', async () => {
    const h = createHarness();
    withDiagnostics(h, h.ids.draftA);
    h.as({ userId: h.ids.reviewerA, activeOrgId: h.ids.orgA });
    expect((await getDiagnostics(req('/x'), params({ id: h.ids.draftA }))).status).toBe(200);
  });

  it("is not_found for another org's version", async () => {
    const h = createHarness();
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    expect((await getDiagnostics(req('/x'), params({ id: h.ids.draftB }))).status).toBe(404);
  });
});

/* ========================================================================== */
/* GET /surveys/:id/history                                                    */
/* ========================================================================== */

describe('GET /api/v1/surveys/:id/history', () => {
  it('lists versions newest-first with their statuses and artifact hashes', async () => {
    const h = createHarness();
    const fixture = shipped(h);
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    const response = await readJson(
      await getHistory(req('/x'), params({ id: fixture.surveyId })),
    );

    expect(response.status).toBe(200);
    expect(response.body['live_version_id']).toBe(fixture.production.id);
    const versions = response.body['versions'] as Record<string, unknown>[];
    // Version order, not creation order: `version_no` is the number a user recognises.
    expect(versions.map((v) => v['version_no'])).toEqual([3, 2, 1]);
    expect(versions.map((v) => v['status'])).toEqual(['production', 'archived', 'draft']);
    expect(versions[0]?.['artifact_hash']).toBe(fixture.production.artifact_hash);
    // ADR-002: two versions of different content have different hashes, which is what makes the
    // rollback comparison below mean something.
    expect(versions[1]?.['artifact_hash']).not.toBe(versions[0]?.['artifact_hash']);
    expect(versions[2]?.['artifact_hash']).toBeNull();
  });

  it('marks exactly the versions app.rollback_version would accept', async () => {
    const h = createHarness();
    const fixture = shipped(h);
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    const response = await readJson(
      await getHistory(req('/x'), params({ id: fixture.surveyId })),
    );
    const flags = Object.fromEntries(
      (response.body['versions'] as { id: string; can_roll_back: boolean }[]).map((v) => [
        v.id,
        v.can_roll_back,
      ]),
    );
    // Only the archived-and-compiled one. Computing this server-side is what stops the panel
    // offering a button the database refuses.
    expect(flags[fixture.archived.id]).toBe(true);
    expect(flags[fixture.production.id]).toBe(false);
    expect(flags[fixture.draft.id]).toBe(false);
  });

  it('marks nothing rollback-able on a survey with no production version', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    const response = await readJson(await getHistory(req('/x'), params({ id: h.ids.surveyA })));
    expect(response.body['live_version_id']).toBeNull();
    expect(
      (response.body['versions'] as { can_roll_back: boolean }[]).every((v) => !v.can_roll_back),
    ).toBe(true);
  });

  it("is not_found for another org's survey", async () => {
    const h = createHarness();
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    expect((await getHistory(req('/x'), params({ id: h.ids.surveyB }))).status).toBe(404);
  });
});

/* ========================================================================== */
/* POST /surveys/:id/rollback                                                  */
/* ========================================================================== */

describe('POST /api/v1/surveys/:id/rollback', () => {
  function rollbackRequest(surveyId: string, body: unknown): Request {
    return req(`/api/v1/surveys/${surveyId}/rollback`, { method: 'POST', body });
  }

  it('repoints the token, leaves exactly one production version, and serves the same bytes', async () => {
    // ACCEPTANCE (P1-08): "rolling back to the previous version repoints artifact_hash and flips
    // archived -> production, and the runtime serves byte-identical bytes to what was live before,
    // verified by hash comparison in the test."
    const h = createHarness();
    const fixture = shipped(h);
    const hashBefore = fixture.archived.artifact_hash;
    h.as({ userId: fixture.projectManager, activeOrgId: h.ids.orgA });

    const response = await readJson(
      await rollbackSurvey(
        rollbackRequest(fixture.surveyId, { to_version_id: fixture.archived.id }),
        params({ id: fixture.surveyId }),
      ),
    );

    expect(response.status).toBe(200);
    expect(response.body['from_version_id']).toBe(fixture.production.id);
    expect(response.body['to_version_id']).toBe(fixture.archived.id);

    // `sv_one_production`: exactly one, and it is the target.
    const production = h.data.versions.filter(
      (v) => v.survey_id === fixture.surveyId && v.status === 'production',
    );
    expect(production.map((v) => v.id)).toEqual([fixture.archived.id]);
    expect(
      h.data.versions.find((v) => v.id === fixture.production.id)?.status,
    ).toBe('archived');

    // THE HASH COMPARISON. Nothing rewrote a version's artifact_hash — the target still names the
    // artifact it named while it was live — and the token now points at that hash. Byte-identity
    // follows from ADR-002's content addressing rather than from copying bytes.
    const token = h.data.tokens.find((t) => t.token === fixture.token);
    expect(token?.survey_version_id).toBe(fixture.archived.id);
    expect(token?.artifact_hash).toBe(hashBefore);
    expect(response.body['artifact_hash']).toBe(hashBefore);
    // The same URL, still: rotating a token would break every vendor link already in the field.
    expect(response.body['token']).toBe(fixture.token);
    expect(h.data.tokens.filter((t) => t.survey_id === fixture.surveyId)).toHaveLength(1);
  });

  it('refuses a programmer and audits the refusal', async () => {
    const h = createHarness();
    const fixture = shipped(h);
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    const response = await readJson(
      await rollbackSurvey(
        rollbackRequest(fixture.surveyId, { to_version_id: fixture.archived.id }),
        params({ id: fixture.surveyId }),
      ),
    );
    expect(response.status).toBe(403);
    // Rollback changes what respondents see, so K §1 makes it the project_manager capability and
    // not the programmer one — the same floor `app.rollback_version` checks.
    const audit = h.data.audit.filter((a) => a.action === 'version.rollback_refused');
    expect(audit).toHaveLength(1);
    expect(audit[0]?.diff).toMatchObject({ required_role: 'project_manager', actual_role: 'programmer' });
    // Nothing moved.
    expect(h.data.versions.find((v) => v.id === fixture.production.id)?.status).toBe('production');
  });

  it('refuses a viewer', async () => {
    const h = createHarness();
    const fixture = shipped(h);
    h.as({ userId: h.ids.viewerA, activeOrgId: h.ids.orgA });
    const response = await rollbackSurvey(
      rollbackRequest(fixture.surveyId, { to_version_id: fixture.archived.id }),
      params({ id: fixture.surveyId }),
    );
    expect(response.status).toBe(403);
    expect(h.data.audit.filter((a) => a.action === 'version.rollback_refused')).toHaveLength(1);
  });

  it('is 409 for a target that is not archived', async () => {
    const h = createHarness();
    const fixture = shipped(h);
    h.as({ userId: fixture.projectManager, activeOrgId: h.ids.orgA });
    const response = await readJson(
      await rollbackSurvey(
        rollbackRequest(fixture.surveyId, { to_version_id: fixture.draft.id }),
        params({ id: fixture.surveyId }),
      ),
    );
    // Promoting a draft is a publish, and the envelope says so rather than leaving the caller to
    // guess — exactly the HINT app.rollback_version carries.
    expect(response.status).toBe(409);
    expect(envelopeCode(response.body)).toBe('illegal_transition');
  });

  it('is 409 on a survey with nothing live to replace', async () => {
    const h = createHarness();
    const fixture = shipped(h);
    // Archive the live version, so the survey has two archived versions and no production one.
    const index = h.data.versions.findIndex((v) => v.id === fixture.production.id);
    const live = h.data.versions[index];
    if (live === undefined) throw new Error('no live version');
    h.data.versions[index] = { ...live, status: 'archived' };
    h.as({ userId: fixture.projectManager, activeOrgId: h.ids.orgA });
    const response = await readJson(
      await rollbackSurvey(
        rollbackRequest(fixture.surveyId, { to_version_id: fixture.archived.id }),
        params({ id: fixture.surveyId }),
      ),
    );
    expect(response.status).toBe(409);
    expect(envelopeCode(response.body)).toBe('illegal_transition');
  });

  it("is not_found for a target in a different survey", async () => {
    const h = createHarness();
    const fixture = shipped(h);
    h.as({ userId: fixture.projectManager, activeOrgId: h.ids.orgA });
    const response = await readJson(
      await rollbackSurvey(
        rollbackRequest(fixture.surveyId, { to_version_id: h.ids.draftA }),
        params({ id: fixture.surveyId }),
      ),
    );
    // "Not in this survey" and "does not exist" must read the same to a caller guessing ids.
    expect(response.status).toBe(404);
  });

  it('is not_found across a tenant boundary rather than forbidden', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.ownerB, activeOrgId: h.ids.orgB });
    const response = await rollbackSurvey(
      rollbackRequest(h.ids.surveyA, { to_version_id: h.ids.draftA }),
      params({ id: h.ids.surveyA }),
    );
    expect(response.status).toBe(404);
  });
});
