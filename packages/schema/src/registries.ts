/**
 * Canonical registries — Deliverable K.
 *
 * WHY this file exists: four enumerations were independently defined in more than one design
 * document and three of them disagreed. Deliverable K declares itself the single owner and
 * names `packages/schema/src/registries.ts` as the source of truth that the SQL migrations,
 * the API validators and the client are generated from. Where any other document contradicts
 * what is written here, this file wins.
 *
 * Everything is `as const` and paired with a `readonly` array so a value list can be iterated
 * at runtime (validators, generators) while the type stays a closed union.
 */

/* -------------------------------------------------------------------------- */
/* K §1 — Role hierarchy                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Ranks are a convenience, not the authorization model. Two capabilities do not nest and
 * must never be checked by rank: PII in exports (analyst + explicit grant) and custom code
 * authoring (programmer only, never inherited by admin). See Deliverable K §1.
 */
export const ORG_ROLE_RANKS = {
  owner: 70,
  admin: 60,
  project_manager: 50,
  programmer: 40,
  analyst: 30,
  reviewer: 20,
  viewer: 10,
  client: 5,
} as const;

export type OrgRole = keyof typeof ORG_ROLE_RANKS;

export const ORG_ROLES: readonly OrgRole[] = [
  'owner',
  'admin',
  'project_manager',
  'programmer',
  'analyst',
  'reviewer',
  'viewer',
  'client',
];

export function roleRank(role: OrgRole): number {
  return ORG_ROLE_RANKS[role];
}

/* -------------------------------------------------------------------------- */
/* K §2 — Dispositions                                                        */
/* -------------------------------------------------------------------------- */

export const DISPOSITIONS = [
  'COMPLETE',
  'SCREENOUT',
  'QUOTA_FULL',
  'QUALITY',
  'DUPLICATE',
  'FRAUD',
  'TERMINATE',
  'CUSTOM',
  'IN_PROGRESS',
  'ABANDONED',
  'TIMED_OUT',
] as const;

export type Disposition = (typeof DISPOSITIONS)[number];

interface DispositionFacts {
  readonly terminal: boolean;
  readonly redirect_required: boolean;
  /** Whether reaching this disposition commits a quota reservation. */
  readonly counts_toward_quota: boolean;
  /** Whether a flow node can produce it, or the server infers it. */
  readonly reached_by: 'flow' | 'entry_check' | 'inferred' | 'session_open';
}

/**
 * `PARTIAL` is deliberately absent: it conflated "session still open" (`IN_PROGRESS`, holds
 * a reservation) with "will never return" (`ABANDONED`, must release it), and one value
 * cannot drive both behaviours.
 *
 * `ABANDONED` and `TIMED_OUT` require no redirect because nobody is there to redirect. This
 * is exactly the exclusion Deliverable C §17's "termination with no configured redirect"
 * compile error depends on, so the fact is encoded here rather than duplicated as an `if`.
 */
export const DISPOSITION_FACTS: Readonly<Record<Disposition, DispositionFacts>> = {
  COMPLETE: { terminal: true, redirect_required: true, counts_toward_quota: true, reached_by: 'flow' },
  SCREENOUT: { terminal: true, redirect_required: true, counts_toward_quota: false, reached_by: 'flow' },
  QUOTA_FULL: { terminal: true, redirect_required: true, counts_toward_quota: false, reached_by: 'flow' },
  QUALITY: { terminal: true, redirect_required: true, counts_toward_quota: false, reached_by: 'flow' },
  DUPLICATE: { terminal: true, redirect_required: true, counts_toward_quota: false, reached_by: 'entry_check' },
  FRAUD: { terminal: true, redirect_required: true, counts_toward_quota: false, reached_by: 'entry_check' },
  TERMINATE: { terminal: true, redirect_required: true, counts_toward_quota: false, reached_by: 'flow' },
  CUSTOM: { terminal: true, redirect_required: true, counts_toward_quota: false, reached_by: 'flow' },
  IN_PROGRESS: { terminal: false, redirect_required: false, counts_toward_quota: false, reached_by: 'session_open' },
  ABANDONED: { terminal: true, redirect_required: false, counts_toward_quota: false, reached_by: 'inferred' },
  TIMED_OUT: { terminal: true, redirect_required: false, counts_toward_quota: false, reached_by: 'inferred' },
};

/** Dispositions a `termination` / `end` flow node may declare. */
export const FLOW_REACHABLE_DISPOSITIONS: readonly Disposition[] = DISPOSITIONS.filter(
  (d) => DISPOSITION_FACTS[d].reached_by === 'flow',
);

/** Dispositions a redirect map must cover. */
export const REDIRECT_REQUIRED_DISPOSITIONS: readonly Disposition[] = DISPOSITIONS.filter(
  (d) => DISPOSITION_FACTS[d].redirect_required,
);

/* -------------------------------------------------------------------------- */
/* K §3 — Version status vs compile state (two orthogonal axes)               */
/* -------------------------------------------------------------------------- */

export const VERSION_STATUSES = ['draft', 'review', 'staging', 'production', 'archived'] as const;
export type VersionStatus = (typeof VERSION_STATUSES)[number];

export const COMPILE_STATES = ['none', 'compiling', 'compiled', 'failed'] as const;
export type CompileState = (typeof COMPILE_STATES)[number];

/* -------------------------------------------------------------------------- */
/* K §4 — Preview / debug postMessage protocol                                */
/* -------------------------------------------------------------------------- */

export const PREVIEW_PROTOCOL = 'rs.preview/1';

export const PREVIEW_MESSAGE_TYPES = [
  'preview.init',
  'preview.set_device',
  'preview.navigate',
  'preview.replay',
  'debug.state',
  'debug.trace',
  'debug.quota',
  'debug.error',
  'runtime.ready',
] as const;
export type PreviewMessageType = (typeof PREVIEW_MESSAGE_TYPES)[number];

/* -------------------------------------------------------------------------- */
/* K §5 — Survey token alphabet                                               */
/* -------------------------------------------------------------------------- */

/**
 * Lowercase base-36, 26 characters (~134 bits). Lowercase because the token is a DNS label
 * (`<token>.run.<domain>`) and DNS is case-insensitive: a mixed-case alphabet lets two
 * distinct rows resolve to one origin, which would route respondents into the wrong study.
 */
export const SURVEY_TOKEN_PATTERN = '^[0-9a-z]{26}$';

/* -------------------------------------------------------------------------- */
/* K §6 — Reserved variable namespace                                         */
/* -------------------------------------------------------------------------- */

/**
 * The `system` variable kind is reserved: users can neither create nor shadow these names.
 * Adding to this list is a breaking change for any survey already using the name, so an
 * addition ships with a schema migration that renames the colliding user variable.
 *
 * Comparison is case-insensitive, matching Deliverable B's `variables_name_key` index on
 * `lower(name)` — `Respondent_Id` must be rejected too, or the database would reject on save
 * what the schema accepted at parse.
 */
export const RESERVED_VARIABLE_NAMES: readonly string[] = [
  'respondent_id',
  'session_id',
  'survey_id',
  'survey_version_id',
  'artifact_hash',
  'random_seed',
  'language',
  'country',
  'region',
  'device',
  'os_class',
  'browser_class',
  'user_agent_class',
  'ip_hash',
  'referrer',
  'entry_url',
  'source',
  'vendor_ref',
  'started_at',
  'last_activity_at',
  'completed_at',
  'duration_s',
  'page_count',
  'disposition',
  'is_test',
  'quality_score',
  'speeder_flag',
  'straightliner_flag',
  'duplicate_flag',
];

const RESERVED_LOOKUP: ReadonlySet<string> = new Set(RESERVED_VARIABLE_NAMES);

/** True when `name` collides with the reserved `system` namespace, case-insensitively. */
export function isReservedVariableName(name: string): boolean {
  return RESERVED_LOOKUP.has(name.toLowerCase());
}
