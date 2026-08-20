/**
 * Surveys: creation with its draft version, rename, archive, and project scoping.
 */

import { describe, expect, it } from 'vitest';
import { GET as listSurveys, POST as createSurvey } from '@/app/api/v1/surveys/route';
import { GET as getSurvey, PATCH as patchSurvey } from '@/app/api/v1/surveys/[id]/route';
import { createHarness, params, readJson, req } from '@/test/harness';

describe('POST /api/v1/surveys', () => {
  it('creates the survey AND its draft version', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    const response = await readJson(
      await createSurvey(
        req('/api/v1/surveys', {
          method: 'POST',
          body: { project_id: h.ids.projectA, ref: 'TRACKER', name: 'Brand Tracker' },
        }),
      ),
    );
    expect(response.status).toBe(201);
    const survey = response.body['survey'] as { id: string; ref: string };
    const draft = response.body['draft_version'] as { status: string; compile_state: string; version_no: number };
    expect(survey.ref).toBe('TRACKER');
    // A survey with no version is not addressable, so the version is not optional.
    expect(draft).toMatchObject({ status: 'draft', compile_state: 'none', version_no: 1 });
    expect(h.data.versions.filter((v) => v.survey_id === survey.id)).toHaveLength(1);
  });

  it("refuses a project the caller cannot see, as not_found", async () => {
    const h = createHarness();
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    const response = await readJson(
      await createSurvey(
        req('/api/v1/surveys', {
          method: 'POST',
          // Org B's project. The composite FK (org_id, project_id) is what makes this
          // unrepresentable in the database; the API answers 404, not 403.
          body: { project_id: h.ids.projectB, ref: 'STOLEN', name: 'Stolen' },
        }),
      ),
    );
    expect(response.status).toBe(404);
    expect(h.data.surveys.some((s) => s.ref === 'STOLEN')).toBe(false);
  });
});

describe('GET /api/v1/surveys', () => {
  it('filters by project and respects per-project scoping', async () => {
    const h = createHarness();
    h.data.seedSurvey({
      orgId: h.ids.orgA,
      projectId: h.ids.projectA2,
      ref: 'SVYA2',
      name: 'Survey A2',
      createdBy: h.ids.ownerA,
    });

    h.as({ userId: h.ids.ownerA, activeOrgId: h.ids.orgA });
    const all = await readJson(await listSurveys(req('/api/v1/surveys')));
    expect((all.body['data'] as { ref: string }[]).map((s) => s.ref).sort()).toEqual(['SVYA', 'SVYA2']);

    const filtered = await readJson(await listSurveys(req('/api/v1/surveys?project_id=' + h.ids.projectA2)));
    expect((filtered.body['data'] as { ref: string }[]).map((s) => s.ref)).toEqual(['SVYA2']);

    // The reviewer is scoped to project A, so project A2's survey is invisible to them.
    h.as({ userId: h.ids.reviewerA, activeOrgId: h.ids.orgA });
    const scoped = await readJson(await listSurveys(req('/api/v1/surveys')));
    expect((scoped.body['data'] as { ref: string }[]).map((s) => s.ref)).toEqual(['SVYA']);
  });
});

describe('PATCH /api/v1/surveys/:id', () => {
  it('renames, archives, and audits with old/new values', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    const renamed = await readJson(
      await patchSurvey(
        req('/x', { method: 'PATCH', body: { name: 'Renamed survey' } }),
        params({ id: h.ids.surveyA }),
      ),
    );
    expect(renamed.body['name']).toBe('Renamed survey');

    const archived = await readJson(
      await patchSurvey(req('/x', { method: 'PATCH', body: { archived: true } }), params({ id: h.ids.surveyA })),
    );
    expect(archived.body['archived_at']).not.toBeNull();

    const rows = h.data.audit.filter((a) => a.target_id === h.ids.surveyA);
    expect(rows.map((r) => r.action)).toEqual(['survey.updated', 'survey.archived']);
    expect(rows[0]?.diff).toMatchObject({ name: { from: 'Survey A', to: 'Renamed survey' } });
  });

  it('refuses a ref change once a non-draft version exists', async () => {
    const h = createHarness();
    const index = h.data.versions.findIndex((v) => v.id === h.ids.draftA);
    const current = h.data.versions[index];
    if (current === undefined) throw new Error('fixture missing');
    h.data.versions[index] = { ...current, status: 'production', compile_state: 'compiled' };

    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    const response = await readJson(
      await patchSurvey(req('/x', { method: 'PATCH', body: { ref: 'RENAMED' } }), params({ id: h.ids.surveyA })),
    );
    expect(response.status).toBe(409);
    expect((response.body['error'] as { code: string }).code).toBe('illegal_transition');
  });

  it('reports both K §3 axes on read', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.viewerA, activeOrgId: h.ids.orgA });
    const response = await readJson(await getSurvey(req('/x'), params({ id: h.ids.surveyA })));
    const versions = response.body['versions'] as { status: string; compile_state: string }[];
    expect(versions[0]).toMatchObject({ status: 'draft', compile_state: 'none' });
  });
});
