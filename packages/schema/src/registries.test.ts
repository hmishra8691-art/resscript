/**
 * Guards on the canonical registries (Deliverable K). These are the values that were
 * independently defined in more than one design document and disagreed; the tests assert the
 * resolutions that made the disagreement impossible.
 */

import { describe, expect, it } from 'vitest';

import {
  DISPOSITIONS,
  DISPOSITION_FACTS,
  FLOW_REACHABLE_DISPOSITIONS,
  ORG_ROLES,
  ORG_ROLE_RANKS,
  REDIRECT_REQUIRED_DISPOSITIONS,
  RESERVED_VARIABLE_NAMES,
  SURVEY_TOKEN_PATTERN,
  isReservedVariableName,
  roleRank,
} from './registries.js';

describe('roles (K §1)', () => {
  it('ranks analyst above reviewer — the inversion that would have leaked response data', () => {
    expect(roleRank('analyst')).toBeGreaterThan(roleRank('reviewer'));
  });

  it('has a strictly decreasing rank order and no duplicate ranks', () => {
    const ranks = ORG_ROLES.map(roleRank);
    expect(ranks).toEqual([...ranks].sort((a, b) => b - a));
    expect(new Set(ranks).size).toBe(ranks.length);
  });

  it('covers exactly the eight canonical roles', () => {
    expect(ORG_ROLES).toHaveLength(8);
    expect([...ORG_ROLES].sort()).toEqual([...Object.keys(ORG_ROLE_RANKS)].sort());
  });
});

describe('dispositions (K §2)', () => {
  it('drops PARTIAL, which conflated an open session with an abandoned one', () => {
    expect(DISPOSITIONS).not.toContain('PARTIAL');
  });

  it('has facts for every value', () => {
    for (const disposition of DISPOSITIONS) {
      expect(DISPOSITION_FACTS[disposition]).toBeDefined();
    }
  });

  it('requires no redirect for the inferred dispositions — nobody is there to redirect', () => {
    expect(REDIRECT_REQUIRED_DISPOSITIONS).not.toContain('ABANDONED');
    expect(REDIRECT_REQUIRED_DISPOSITIONS).not.toContain('TIMED_OUT');
    expect(REDIRECT_REQUIRED_DISPOSITIONS).not.toContain('IN_PROGRESS');
  });

  it('counts only COMPLETE toward a quota', () => {
    const counting = DISPOSITIONS.filter((d) => DISPOSITION_FACTS[d].counts_toward_quota);
    expect(counting).toEqual(['COMPLETE']);
  });

  it('lets a flow node produce only the dispositions a flow node can reach', () => {
    expect(FLOW_REACHABLE_DISPOSITIONS).toContain('SCREENOUT');
    expect(FLOW_REACHABLE_DISPOSITIONS).not.toContain('DUPLICATE');
    expect(FLOW_REACHABLE_DISPOSITIONS).not.toContain('ABANDONED');
  });
});

describe('survey token (K §5)', () => {
  it('is lowercase-only, because the token is a DNS label', () => {
    const re = new RegExp(SURVEY_TOKEN_PATTERN);
    expect(re.test('a'.repeat(26))).toBe(true);
    expect(re.test('A'.repeat(26))).toBe(false);
    expect(re.test('a'.repeat(25))).toBe(false);
  });
});

describe('reserved variable namespace (K §6)', () => {
  it('carries all 29 canonical names, deduplicated and lowercase', () => {
    expect(RESERVED_VARIABLE_NAMES).toHaveLength(29);
    expect(new Set(RESERVED_VARIABLE_NAMES).size).toBe(RESERVED_VARIABLE_NAMES.length);
    for (const name of RESERVED_VARIABLE_NAMES) {
      expect(name).toBe(name.toLowerCase());
      expect(isReservedVariableName(name)).toBe(true);
      expect(isReservedVariableName(name.toUpperCase())).toBe(true);
    }
  });

  it('does not reserve names that merely start with a reserved one', () => {
    expect(isReservedVariableName('respondent_id2')).toBe(false);
    expect(isReservedVariableName('my_disposition')).toBe(false);
  });
});
