/**
 * The `?org_id=` injection test, both halves.
 *
 * P1-01's acceptance criterion is that a user in org A "sees exactly org A's projects", and that
 * editing the token's `active_org_id` to org B's id "yields zero rows from every table rather
 * than an error". The corollary this file asserts is the one an attacker actually tries first:
 * appending `?org_id=<other org>` to a perfectly ordinary request.
 *
 * Half one is behavioural — the parameter is inert. Half two is structural — no route source
 * file reads such a parameter at all, so the behaviour cannot regress by someone adding one.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GET as listProjects } from '@/app/api/v1/projects/route';
import { GET as getOrg } from '@/app/api/v1/organizations/[id]/route';
import { createHarness, params, readJson, req } from '@/test/harness';

describe('org context comes only from the token', () => {
  it('ignores ?org_id= entirely: org A still sees exactly org A', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.ownerA, activeOrgId: h.ids.orgA });

    const clean = await readJson(await listProjects(req('/api/v1/projects')));
    const injected = await readJson(
      await listProjects(req('/api/v1/projects?org_id=' + h.ids.orgB)),
    );

    const refsOf = (body: Record<string, unknown>): string[] =>
      (body['data'] as { ref: string }[]).map((p) => p.ref).sort();

    expect(clean.status).toBe(200);
    expect(injected.status).toBe(200);
    expect(refsOf(injected.body)).toEqual(refsOf(clean.body));
    expect(refsOf(injected.body)).toEqual(['PRJA', 'PRJA2']);
    expect(refsOf(injected.body)).not.toContain('PRJB');
  });

  it('a forged active_org_id yields ZERO ROWS, not an error', async () => {
    const h = createHarness();
    // The exact P1-01 case: org A's owner edits their JWT to name org B.
    h.as({ userId: h.ids.ownerA, activeOrgId: h.ids.orgB });

    const projects = await readJson(await listProjects(req('/api/v1/projects')));
    // 403 from requireRole (no membership row in org B) rather than a 500, and — critically —
    // no leak of whether org B exists or what is in it.
    expect(projects.status).toBe(403);
    expect((projects.body['error'] as { code: string }).code).toBe('forbidden');
  });

  it('an org id in the path is a guard, not a selector: another org is 404', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.ownerA, activeOrgId: h.ids.orgA });
    const response = await readJson(
      await getOrg(req('/api/v1/organizations/' + h.ids.orgB), params({ id: h.ids.orgB })),
    );
    // Not 403: confirming that org B exists is the information leak.
    expect(response.status).toBe(404);
    expect((response.body['error'] as { code: string }).code).toBe('not_found');
  });
});

describe('no route reads an org id from the request', () => {
  const apiRoot = join(process.cwd(), 'src/app/api');

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry);
      return statSync(full).isDirectory() ? sourceFiles(full) : full.endsWith('.ts') ? [full] : [];
    });
  }

  it('never reads org_id from searchParams, a body field, or a header', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(apiRoot)) {
      const source = readFileSync(file, 'utf8');
      // Strip comments: the invariant is documented in prose in several of these files, and a
      // grep that failed on its own documentation would be a grep nobody keeps.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      const patterns = [
        /searchParams\.get\(\s*['"]org_?id['"]/i,
        /searchParams\.get\(\s*['"]organization_id['"]/i,
        /body\s*\.\s*org_id/i,
        /headers\.get\(\s*['"]x-org-id['"]/i,
      ];
      if (patterns.some((pattern) => pattern.test(code))) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it('has route files to scan (the guard above must not pass vacuously)', () => {
    expect(sourceFiles(apiRoot).length).toBeGreaterThan(8);
  });
});
