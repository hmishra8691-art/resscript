/**
 * The `schema_version` harness — Deliverable C §18.
 *
 * Migrations are **forward-only, ordered, and pure**: each one is `(survey@vN) => survey@vN+1`
 * with no I/O, no clock and no randomness, so running them is reproducible and testable. A
 * stored survey is migrated in memory on load and written back at the next save.
 *
 * Published *artifacts* are never migrated. They are immutable and the runtime reads the last
 * N artifact schema versions directly, which is what lets a survey published 14 months ago
 * keep collecting data unchanged while the authoring model moves on. That property is
 * non-negotiable for tracker studies, and it is the reason this file only ever touches the
 * authoring document.
 *
 * Migrations operate on a loose document type rather than on `Survey`, because a v1 document is
 * *not* a `Survey` — that is the whole point of the version number. Typing them as `Survey`
 * would either force lies into the types or force every migration to be written after the
 * types have already moved on.
 */

import type { Diagnostic } from './diagnostics.js';
import { sortDiagnostics } from './diagnostics.js';
import type { ParseResult } from './serialize.js';
import { parseValue } from './serialize.js';

/** An in-flight survey document of unknown vintage. */
export type SurveyDocument = { readonly [key: string]: unknown };

export interface Migration {
  readonly from: number;
  readonly to: number;
  /** One line, present tense, for the audit log entry the studio writes on save. */
  readonly describe: string;
  readonly migrate: (document: SurveyDocument) => SurveyDocument;
}

/* -------------------------------------------------------------------------- */
/* v1 → v2                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Fill in two fields that Deliverable C requires and that v1 documents predate.
 *
 * Both are cases where the *absence* of a value is dangerous rather than merely untidy:
 *
 *  - `page.settings.min_time_action` — speeder detection needs to know whether a too-fast page
 *    is flagged for the quality score or blocked at submit. `flag` is the safe migration
 *    default: it starts scoring quality without suddenly refusing submissions on surveys that
 *    were fielding happily before the upgrade.
 *  - `quotas.policy.counter_scope` — C §8 says this has no safe default *for new surveys*, and
 *    the compiler demands an explicit value. For an existing survey there is exactly one
 *    honest answer: it has been counting with survey-wide counters all along, because that is
 *    what "the counters kept running across republishes" means. Writing `version` here would
 *    silently reset live quota counts, which is the failure mode C §8 warns about.
 *
 * Only-fills-what-is-missing is what makes the function idempotent: applying it twice is a
 * no-op, which the tests assert directly.
 */
function migrateV1ToV2(document: SurveyDocument): SurveyDocument {
  const next: Record<string, unknown> = { ...document, schema_version: 2 };

  const content = document['content'];
  if (Array.isArray(content)) {
    next['content'] = content.map(addMinTimeAction);
  }

  const quotas = document['quotas'];
  if (isObject(quotas)) {
    const policy = isObject(quotas['policy']) ? quotas['policy'] : {};
    next['quotas'] = {
      ...quotas,
      policy: {
        ...policy,
        counter_scope: policy['counter_scope'] ?? 'survey',
      },
    };
  }

  return next;
}

function addMinTimeAction(node: unknown): unknown {
  if (!isObject(node)) return node;
  const type = node['type'];
  const children = node['children'];

  if (type === 'page') {
    const settings = isObject(node['settings']) ? node['settings'] : {};
    return {
      ...node,
      settings: { ...settings, min_time_action: settings['min_time_action'] ?? 'flag' },
      ...(Array.isArray(children) ? { children } : {}),
    };
  }

  if (type === 'block' && Array.isArray(children)) {
    return { ...node, children: children.map(addMinTimeAction) };
  }

  return node;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/* -------------------------------------------------------------------------- */
/* The registry                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Ordered and contiguous: `MIGRATIONS[i].to === MIGRATIONS[i + 1].from`, and the last `to` is
 * `CURRENT_SCHEMA_VERSION`. A test asserts both, because a gap in the chain is the kind of
 * mistake that only shows up when an old survey is opened — months later, by a customer.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    from: 1,
    to: 2,
    describe: 'Default page.settings.min_time_action to "flag" and quotas.policy.counter_scope to "survey".',
    migrate: migrateV1ToV2,
  },
];

export const CURRENT_SCHEMA_VERSION = 2;

export type MigrateResult =
  | {
      readonly ok: true;
      readonly document: SurveyDocument;
      /** The versions actually stepped through, e.g. `[1, 2]`. Empty when already current. */
      readonly applied: readonly number[];
      readonly diagnostics: readonly Diagnostic[];
    }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

/**
 * Migrate a stored document up to `CURRENT_SCHEMA_VERSION`.
 *
 * A document already at the current version is returned untouched, so calling this on every
 * load is free and calling it twice is a no-op.
 */
export function migrateToCurrent(input: unknown): MigrateResult {
  if (!isObject(input)) {
    return {
      ok: false,
      diagnostics: [
        { code: 'SCH-0002', severity: 'error', message: 'Document root must be a survey object.', path: '' },
      ],
    };
  }

  const raw = input['schema_version'];
  if (raw === undefined) {
    return {
      ok: false,
      diagnostics: [
        {
          code: 'SCH-0100',
          severity: 'error',
          message: 'Document has no schema_version, so it cannot be migrated safely.',
          path: '/schema_version',
        },
      ],
    };
  }
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
    return {
      ok: false,
      diagnostics: [
        {
          code: 'SCH-0101',
          severity: 'error',
          message: `schema_version must be a positive integer, got ${JSON.stringify(raw)}.`,
          path: '/schema_version',
        },
      ],
    };
  }
  if (raw > CURRENT_SCHEMA_VERSION) {
    // A document from the future. Migrations are forward-only by design, so the only correct
    // behaviour is to refuse: opening it in an older studio would drop whatever the newer
    // version added, and the user would then save the loss back over their survey.
    return {
      ok: false,
      diagnostics: [
        {
          code: 'SCH-0103',
          severity: 'error',
          message: `schema_version ${raw} is newer than this build supports (${CURRENT_SCHEMA_VERSION}); migrations are forward-only.`,
          path: '/schema_version',
        },
      ],
    };
  }

  let document: SurveyDocument = input;
  const applied: number[] = [];
  for (let version = raw; version < CURRENT_SCHEMA_VERSION; ) {
    const migration = MIGRATIONS.find((m) => m.from === version);
    if (migration === undefined) {
      return {
        ok: false,
        diagnostics: [
          {
            code: 'SCH-0103',
            severity: 'error',
            message: `No migration registered from schema_version ${version}; the migration chain has a gap.`,
            path: '/schema_version',
          },
        ],
      };
    }
    document = migration.migrate(document);
    applied.push(migration.to);
    version = migration.to;
  }

  return { ok: true, document, applied, diagnostics: [] };
}

/** Migrate, then parse and validate. The path an importer and the studio's loader both take. */
export function migrateAndParse(input: unknown): ParseResult {
  const migrated = migrateToCurrent(input);
  if (!migrated.ok) return { ok: false, diagnostics: sortDiagnostics(migrated.diagnostics) };
  return parseValue(migrated.document);
}
