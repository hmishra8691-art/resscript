/**
 * The role-rank test that Deliverable K was written to force.
 *
 * Deliverable B ranked reviewer ABOVE analyst; Deliverable G ranked analyst above reviewer. Ship
 * B's enum with G's policy and a Reviewer — typically an external client contact — passes an
 * analyst-level check and can export response data including open-ends. That is a
 * data-protection incident arising purely from two documents being written independently.
 *
 * These assertions exist so that a local re-definition of the hierarchy anywhere in
 * `apps/studio` is a red test rather than a discovery in review.
 */

import { describe, expect, it } from 'vitest';
import { ORG_ROLES, ORG_ROLE_RANKS, roleRank } from '@resscript/schema';
import { meetsRole, requireRole } from '@/server/auth';
import { ASSIGNABLE_ROLES } from '@/components/members/MemberRoleEditor';

describe('role hierarchy', () => {
  it('matches Deliverable K §1 exactly', () => {
    expect(ORG_ROLE_RANKS).toEqual({
      owner: 70,
      admin: 60,
      project_manager: 50,
      programmer: 40,
      analyst: 30,
      reviewer: 20,
      viewer: 10,
      client: 5,
    });
  });

  it('ranks analyst ABOVE reviewer — the inversion K exists to prevent', () => {
    expect(roleRank('analyst')).toBeGreaterThan(roleRank('reviewer'));
    expect(meetsRole('analyst', 'reviewer')).toBe(true);
    expect(meetsRole('reviewer', 'analyst')).toBe(false);
  });

  it('has eight roles, not six', () => {
    // The P1-01 roadmap row says "six ranked roles"; K §1 is canonical and says eight
    // (project_manager and client were added). K wins where a document disagrees.
    expect(ORG_ROLES).toHaveLength(8);
    expect(ORG_ROLES).toContain('project_manager');
    expect(ORG_ROLES).toContain('client');
  });

  it('is strictly descending in the canonical order', () => {
    const ranks = ORG_ROLES.map(roleRank);
    for (let i = 1; i < ranks.length; i += 1) {
      expect(ranks[i - 1]).toBeGreaterThan(ranks[i] as number);
    }
  });

  it('client is the floor, so has_role(client) reads as "is a member at all"', () => {
    for (const role of ORG_ROLES) expect(meetsRole(role, 'client')).toBe(true);
  });
});

describe('requireRole', () => {
  it('rejects an under-privileged role with forbidden and names the requirement', () => {
    expect.assertions(4);
    try {
      requireRole('viewer', 'programmer');
    } catch (err: unknown) {
      const error = err as { code: string; status: number; details: readonly { code: string; message: string }[] };
      expect(error.code).toBe('forbidden');
      expect(error.status).toBe(403);
      expect(error.details).toContainEqual({ path: null, code: 'role_required', message: 'programmer' });
      expect(error.details).toContainEqual({ path: null, code: 'role_actual', message: 'viewer' });
    }
  });

  it('rejects a null role — a forged active_org_id has no membership row', () => {
    expect(() => requireRole(null, 'client')).toThrowError(/not a member/);
  });

  it('accepts an exactly-equal role and anything above it', () => {
    expect(() => requireRole('programmer', 'programmer')).not.toThrow();
    expect(() => requireRole('owner', 'programmer')).not.toThrow();
  });
});

describe('the role editor offers exactly the assignable roles', () => {
  it('excludes owner and is ordered by descending rank', () => {
    expect(ASSIGNABLE_ROLES).not.toContain('owner');
    expect(ASSIGNABLE_ROLES).toHaveLength(ORG_ROLES.length - 1);
    const ranks = ASSIGNABLE_ROLES.map(roleRank);
    expect([...ranks].sort((a, b) => b - a)).toEqual(ranks);
    // The UI list must be a projection of the registry, not a parallel list.
    expect([...ASSIGNABLE_ROLES].sort()).toEqual([...ORG_ROLES].filter((r) => r !== 'owner').sort());
  });
});
