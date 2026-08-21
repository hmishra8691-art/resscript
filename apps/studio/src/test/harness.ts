/**
 * The route-handler test harness.
 *
 * Builds a two-org fixture that mirrors `ops.test_seed_two_orgs()` (0004's `test.sql` fixture)
 * closely enough that the same assertions read the same way in both suites: org A with an owner,
 * a project-scoped reviewer and a programmer; org B with its own owner and programmer; and a
 * user who belongs to nothing, which is the forged-claim case.
 *
 * `as` switches the acting user. Because the context resolver is replaced wholesale, a handler
 * under test authenticates exactly as the harness says and never touches Supabase.
 */

import { createCapturingLogger, type CapturedLogger } from '@resscript/observability';
import type { OrgRole } from '@resscript/schema';
import { claimsFrom } from '@/server/auth';
import { setContextResolver, type RequestContext, type TokenMinter } from '@/server/context';
import { createInMemoryRepos, MemoryDataset } from '@/server/repo/memory';
import type { Repos } from '@/server/repo/types';
import { registryRowsFor } from '@/test/registry-fixture';

export interface ActorSpec {
  readonly userId: string;
  /** What the TOKEN claims. A test can set this to another org's id to forge a claim. */
  readonly activeOrgId: string | null;
  readonly email?: string;
  readonly aal?: string;
}

export interface MintCall {
  readonly userId: string;
  readonly orgId: string;
  readonly role: OrgRole;
}

export interface Harness {
  readonly data: MemoryDataset;
  readonly mints: MintCall[];
  readonly logs: CapturedLogger;
  /** Fixed clock. Advance it explicitly where a test needs expiry or an ETag to move. */
  nowMs: number;
  as(actor: ActorSpec): void;
  reposFor(actor: ActorSpec): Repos;
  ids: {
    orgA: string;
    orgB: string;
    ownerA: string;
    programmerA: string;
    reviewerA: string;
    viewerA: string;
    ownerB: string;
    outsider: string;
    projectA: string;
    projectA2: string;
    projectB: string;
    surveyA: string;
    surveyB: string;
    draftA: string;
    draftB: string;
    jobA: string;
  };
}

export function createHarness(): Harness {
  // ONE clock for the fixture and the request context. See MemoryDataset's `clock`.
  const clock = { nowMs: Date.UTC(2026, 7, 20, 12, 0, 0) };
  const data = new MemoryDataset({ now: () => clock.nowMs });
  const mints: MintCall[] = [];
  const logs = createCapturingLogger({ service: 'studio-test', level: 'debug' });

  const ownerA = '11111111-1111-1111-1111-111111111111';
  const programmerA = '44444444-4444-4444-4444-444444444444';
  const reviewerA = '66666666-6666-6666-6666-666666666666';
  const viewerA = '77777777-7777-7777-7777-777777777777';
  const ownerB = '22222222-2222-2222-2222-222222222222';
  const outsider = '33333333-3333-3333-3333-333333333333';

  const orgA = data.seedOrg({ slug: 'org-a', name: 'Org A', ownerUserId: ownerA });
  const orgB = data.seedOrg({ slug: 'org-b', name: 'Org B', ownerUserId: ownerB });

  const projectA = data.seedProject({ orgId: orgA.id, ref: 'PRJA', name: 'Project A', createdBy: ownerA });
  const projectA2 = data.seedProject({ orgId: orgA.id, ref: 'PRJA2', name: 'Project A2', createdBy: ownerA });
  const projectB = data.seedProject({ orgId: orgB.id, ref: 'PRJB', name: 'Project B', createdBy: ownerB });

  data.seedMember({ orgId: orgA.id, userId: programmerA, role: 'programmer', email: 'prg@a.test' });
  // Project-scoped, which is what makes `can_see_project()` testable rather than vacuously true.
  data.seedMember({
    orgId: orgA.id,
    userId: reviewerA,
    role: 'reviewer',
    projectIds: [projectA.id],
    email: 'rev@a.test',
  });
  data.seedMember({ orgId: orgA.id, userId: viewerA, role: 'viewer', email: 'vwr@a.test' });

  const surveyA = data.seedSurvey({
    orgId: orgA.id,
    projectId: projectA.id,
    ref: 'SVYA',
    name: 'Survey A',
    createdBy: ownerA,
  });
  const surveyB = data.seedSurvey({
    orgId: orgB.id,
    projectId: projectB.id,
    ref: 'SVYB',
    name: 'Survey B',
    createdBy: ownerB,
  });

  // P1-07: the variable registry the `/v1/dsl/*` endpoints type-check against. Org A's draft
  // only, so "another org's version" is a real case rather than an empty registry that would
  // answer `ok: true` for source referencing nothing.
  data.seedRegistry(registryRowsFor(surveyA.draft.id));

  const jobA = data.seedJob({
    id: 'job_01JC8KX9Q2M4V7ZB3F0T5N6R8W',
    org_id: orgA.id,
    kind: 'compile',
    status: 'running',
    progress: { step: 4, total: 7, message: 'compiling theme', updated_at: '2026-08-20T10:12:51Z' },
  });

  const harness: Harness = {
    data,
    mints,
    logs,
    get nowMs(): number {
      return clock.nowMs;
    },
    set nowMs(next: number) {
      clock.nowMs = next;
    },
    ids: {
      orgA: orgA.id,
      orgB: orgB.id,
      ownerA,
      programmerA,
      reviewerA,
      viewerA,
      ownerB,
      outsider,
      projectA: projectA.id,
      projectA2: projectA2.id,
      projectB: projectB.id,
      surveyA: surveyA.survey.id,
      surveyB: surveyB.survey.id,
      draftA: surveyA.draft.id,
      draftB: surveyB.draft.id,
      jobA: jobA.id,
    },
    reposFor: (actor) =>
      createInMemoryRepos(data, { userId: actor.userId, activeOrgId: actor.activeOrgId }),
    as: (actor) => {
      setContextResolver(async (_req: Request): Promise<RequestContext> => {
        const repos = harness.reposFor(actor);
        const claims = claimsFrom(
          actor.userId,
          {
            active_org_id: actor.activeOrgId,
            orgs: [orgA.id, orgB.id].filter((id) =>
              data.members.some((m) => m.user_id === actor.userId && m.org_id === id),
            ),
            aal: actor.aal ?? 'aal2',
          },
          actor.email,
        );
        // The AUTHORITATIVE role is the membership row, exactly as `app.has_role()` reads it —
        // never the claim. A forged `active_org_id` therefore yields `null` here and every
        // guard denies.
        const role =
          actor.activeOrgId === null
            ? null
            : await repos.members.roleInOrg(actor.activeOrgId, actor.userId);
        const minter: TokenMinter = {
          setActiveOrg: async ({ userId, orgId, role: nextRole }) => {
            mints.push({ userId, orgId, role: nextRole });
          },
        };
        return {
          requestId: 'req_test',
          logger: logs.logger,
          claims,
          role,
          repos,
          minter,
          now: () => new Date(clock.nowMs),
        };
      });
    },
  };

  return harness;
}

export interface RequestSpec {
  readonly method?: string;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

/** A `Request` for a route handler. The base URL is irrelevant — nothing reads the host. */
export function req(path: string, spec: RequestSpec = {}): Request {
  const headers = new Headers(spec.headers ?? {});
  if (spec.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  return new Request('http://studio.test' + path, {
    method: spec.method ?? 'GET',
    headers,
    ...(spec.body === undefined ? {} : { body: JSON.stringify(spec.body) }),
  });
}

/** Next 15 hands route params to a handler as a Promise. */
export function params<P extends Record<string, string>>(value: P): { params: Promise<P> } {
  return { params: Promise.resolve(value) };
}

export interface ParsedBody {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly headers: Headers;
}

export async function readJson(response: Response): Promise<ParsedBody> {
  const text = await response.text();
  return {
    status: response.status,
    body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
    headers: response.headers,
  };
}
