import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  CURRENT_SCHEMA_VERSION,
  MIGRATIONS,
  migrateAndParse,
  migrateToCurrent,
  type SurveyDocument,
} from './migrate.js';

function loadV1(): SurveyDocument {
  const text = readFileSync(new URL('./__fixtures__/survey-v1.json', import.meta.url), 'utf8');
  return JSON.parse(text) as SurveyDocument;
}

function pages(document: SurveyDocument): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const walk = (nodes: unknown): void => {
    if (!Array.isArray(nodes)) return;
    for (const node of nodes) {
      if (typeof node !== 'object' || node === null) continue;
      const record = node as Record<string, unknown>;
      if (record['type'] === 'page') out.push(record);
      walk(record['children']);
    }
  };
  walk(document['content']);
  return out;
}

describe('the migration registry', () => {
  it('is ordered and has no gaps in version numbering', () => {
    expect(MIGRATIONS.length).toBeGreaterThan(0);
    MIGRATIONS.forEach((migration, i) => {
      expect(migration.to, `migration ${i} must step exactly one version`).toBe(migration.from + 1);
      const previous = MIGRATIONS[i - 1];
      if (previous !== undefined) {
        expect(migration.from, 'migrations must be contiguous').toBe(previous.to);
      }
    });
    expect(MIGRATIONS[0]?.from).toBe(1);
    expect(MIGRATIONS.at(-1)?.to).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('describes every step, because the studio writes the description to the audit log', () => {
    for (const migration of MIGRATIONS) {
      expect(migration.describe.length).toBeGreaterThan(10);
    }
  });
});

describe('migrateToCurrent', () => {
  it('brings a v1 fixture up to the current version', () => {
    const result = migrateToCurrent(loadV1());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document['schema_version']).toBe(CURRENT_SCHEMA_VERSION);
    expect(result.applied).toEqual([2]);
  });

  it('fills in the two fields a v1 document cannot have', () => {
    const before = loadV1();
    expect(pages(before).every((p) => (p['settings'] as Record<string, unknown>)['min_time_action'] === undefined)).toBe(
      true,
    );

    const result = migrateToCurrent(before);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const migratedPages = pages(result.document);
    expect(migratedPages.length).toBeGreaterThan(10);
    for (const page of migratedPages) {
      expect((page['settings'] as Record<string, unknown>)['min_time_action']).toBe('flag');
    }

    const quotas = result.document['quotas'] as Record<string, unknown>;
    const policy = quotas['policy'] as Record<string, unknown>;
    // `survey` is the only honest answer for an existing survey: its counters have been
    // running across republishes all along. `version` would silently reset live quota counts.
    expect(policy['counter_scope']).toBe('survey');
  });

  it('is a no-op when applied twice', () => {
    const once = migrateToCurrent(loadV1());
    expect(once.ok).toBe(true);
    if (!once.ok) return;
    const twice = migrateToCurrent(once.document);
    expect(twice.ok).toBe(true);
    if (!twice.ok) return;
    expect(twice.document).toEqual(once.document);
    expect(twice.applied).toEqual([]);
  });

  it('is a no-op when a single migration function is applied twice', () => {
    const step = MIGRATIONS[0];
    expect(step).toBeDefined();
    if (step === undefined) return;
    const once = step.migrate(loadV1());
    expect(step.migrate(once)).toEqual(once);
  });

  it('does not mutate its input', () => {
    const document = loadV1();
    const before = JSON.stringify(document);
    migrateToCurrent(document);
    expect(JSON.stringify(document)).toBe(before);
  });

  it('produces a document that parses and validates', () => {
    const parsed = migrateAndParse(loadV1());
    expect(
      parsed.ok,
      `diagnostics: ${JSON.stringify(parsed.diagnostics.slice(0, 5))}`,
    ).toBe(true);
  });

  it('rejects a document with no schema_version', () => {
    const result = migrateToCurrent({ meta: {} });
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]?.code).toBe('SCH-0100');
  });

  it('rejects a non-integer schema_version', () => {
    const result = migrateToCurrent({ schema_version: '1' });
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]?.code).toBe('SCH-0101');
  });

  it('refuses a document from the future rather than silently dropping its fields', () => {
    const result = migrateToCurrent({ schema_version: CURRENT_SCHEMA_VERSION + 5 });
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]?.message).toContain('forward-only');
  });

  it('rejects a non-object document', () => {
    expect(migrateToCurrent(42).ok).toBe(false);
  });
});
