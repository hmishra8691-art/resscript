/**
 * The compile job's database seam: read the authoring model, record a failure, or run the
 * publish transaction — all AS THE USER WHO PRESSED PUBLISH.
 *
 * ## The calling convention, which is the whole point of this file
 *
 * Migration 0009's header states it and warns that it is the one thing a reader will get wrong:
 *
 *   > the compile worker must assume the enqueuing user's identity (set request.jwt.claims from
 *   > ops.jobs.org_id / created_by, SET LOCAL ROLE authoring) before calling this. The capability
 *   > check below is then the same one the studio would have made, and the audit row names a
 *   > human. A worker calling it with no claims gets insufficient_privilege, which is correct:
 *   > "the system published this" is not an answer anyone accepts six months later.
 *
 * So every unit of work here runs inside ONE transaction on ONE connection that begins by
 * setting the claims and `SET LOCAL ROLE authoring`. That is a departure from `PgJobStore`, whose
 * every call is a single autocommit `SELECT ops.<fn>(…)` as the queue-owning role — and the
 * departure is the design, not an inconsistency: the queue is the worker's own table and the
 * survey is the tenant's. A `SessionFactory` is therefore the dependency rather than a
 * `SqlClient`, because `SET LOCAL` is meaningless without a transaction and a pool hands out a
 * different connection per `query()`.
 *
 * Two consequences worth stating because each is a thing somebody will try:
 *
 *  * **The role is not optional.** Running the reads as the connection's own (superuser, or the
 *    migration runner) role would make every RLS policy on `content.*` inert, and the compile job
 *    would happily compile a version the enqueuing user has no standing to see — an authorization
 *    check deleted by omission. `RESET ROLE` in a `finally` keeps a leaked role from turning the
 *    next unit of work into that.
 *  * **The failure path is DML, not a function.** 0009 §5 is explicit: `compile_state = 'failed'`
 *    with diagnostics is an ordinary UPDATE that 0004's `sv_update` policy already permits at the
 *    programmer floor, "because K §3 requires it to change nothing else". Adding a definer
 *    function for it would create a privileged write path for an operation whose entire
 *    specification is "write two columns". The UPDATE below therefore names exactly two columns,
 *    and `app.tg_version_guard` leaves both mutable on a frozen version — which is what makes a
 *    failed recompile of a live version safe: `status` is untouched, so A §7's "a failed publish
 *    always leaves the previously live artifact serving" holds by construction.
 *
 * ## Why the reads are ten statements and not one
 *
 * One `json_agg` mega-query would be one round trip, and it would also be one place where a
 * policy could be bypassed by a join the planner reorders, one shape nobody can read in a log,
 * and one column list that has to be re-derived every time 0007 grows a column. Ten narrow
 * `SELECT`s over `survey_version_id` — every one of which hits the same index — cost ten
 * round trips on one already-open connection, which is not the cost that matters for a job whose
 * budget is 5 seconds for 500 questions across 5 languages. (Nine until 0010 added
 * `content.redirects`, which is the shape this costs: one more table is one more narrow SELECT
 * and one more field on `AuthoringRows`, not a rewritten join.)
 */

import { AppError } from '@resscript/observability';

import type { JsonValue } from './json.js';
import type {
  AuthoringCellRow,
  AuthoringItemRow,
  AuthoringLanguageRow,
  AuthoringNodeRow,
  AuthoringRedirectRow,
  AuthoringRows,
  AuthoringRuleRow,
  AuthoringStringRow,
  AuthoringSurveyRow,
  AuthoringVariableRow,
  AuthoringVersionRow,
} from './authoring-model.js';

/* -------------------------------------------------------------------------- */
/* Sessions                                                                   */
/* -------------------------------------------------------------------------- */

export interface SqlSession {
  query<R extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: R[] }>;
}

/** Runs one unit of work inside one transaction on one connection. */
export interface SessionFactory {
  run<T>(fn: (session: SqlSession) => Promise<T>): Promise<T>;
}

/** The subset of `pg.Pool` needed to check out a connection. Declared structurally, as `SqlClient` is. */
export interface PoolLike {
  connect(): Promise<SqlSession & { release(): void }>;
}

/**
 * The production factory: check out a connection, `BEGIN`, run, `COMMIT` or `ROLLBACK`.
 *
 * `ROLLBACK` on any throw is what makes "a failed publish always leaves the previously live
 * artifact serving" true even when the failure happens between `app.publish_version` returning
 * and this function's own bookkeeping — the definer function is atomic in itself, and this makes
 * the unit of work around it atomic too.
 */
export function poolSessions(pool: PoolLike): SessionFactory {
  return {
    run: async <T>(fn: (session: SqlSession) => Promise<T>): Promise<T> => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        try {
          const out = await fn(client);
          await client.query('COMMIT');
          return out;
        } catch (err: unknown) {
          await client.query('ROLLBACK');
          throw err;
        }
      } finally {
        client.release();
      }
    },
  };
}

/**
 * A factory over a connection the CALLER owns and has already put in a transaction.
 *
 * This exists for the integration suite, and it is not a shortcut: a test that let the store
 * `COMMIT` would leave published versions, artifact rows and — worse — `runtime.survey_tokens`
 * rows in a database that the next run then has to reason about, and `tokens_live_key` would make
 * the second run fail for reasons that have nothing to do with the code. `SAVEPOINT` gives the
 * store real transactional semantics (a throw inside the unit of work rolls that unit back and
 * nothing else) while leaving the outer `ROLLBACK` in the test's hands.
 */
export function savepointSessions(session: SqlSession): SessionFactory {
  let depth = 0;
  return {
    run: async <T>(fn: (inner: SqlSession) => Promise<T>): Promise<T> => {
      depth += 1;
      const name = `rs_publish_${String(depth)}`;
      await session.query(`SAVEPOINT ${name}`);
      try {
        const out = await fn(session);
        await session.query(`RELEASE SAVEPOINT ${name}`);
        return out;
      } catch (err: unknown) {
        await session.query(`ROLLBACK TO SAVEPOINT ${name}`);
        throw err;
      }
    },
  };
}

/* -------------------------------------------------------------------------- */
/* The seam                                                                   */
/* -------------------------------------------------------------------------- */

/** Who the job is acting as. Both values come from `ops.jobs`, never from the payload. */
export interface JobIdentity {
  readonly orgId: string;
  readonly userId: string;
}

export interface PublishRequest {
  readonly versionId: string;
  readonly artifactHash: string;
  readonly artifactBytes: number;
  readonly targetStatus: 'staging' | 'production';
  readonly diagnostics: readonly JsonValue[];
  /** `acknowledgementKey()` values, written to `survey_versions.acknowledged_warnings`. */
  readonly acknowledgedWarnings: readonly string[];
  /** The warnings this compile actually raised and the author had already accepted. */
  readonly acknowledgedNow: readonly JsonValue[];
  readonly requestId: string;
}

/** `app.publish_version`'s jsonb return, mapped. */
export interface PublishOutcome {
  readonly token: string;
  readonly surveyId: string;
  readonly surveyVersionId: string;
  readonly artifactHash: string;
  readonly status: string;
  readonly isTest: boolean;
  readonly demotedVersionId: string | null;
  readonly previousArtifactHash: string | null;
}

export interface PublishStore {
  /** `null` when the version is invisible to the enqueuing user — a 404, never an error. */
  loadAuthoringRows(identity: JobIdentity, versionId: string): Promise<AuthoringRows | null>;
  recordCompileFailure(
    identity: JobIdentity,
    input: { readonly versionId: string; readonly diagnostics: readonly JsonValue[] },
  ): Promise<void>;
  publish(identity: JobIdentity, input: PublishRequest): Promise<PublishOutcome>;
}

/* -------------------------------------------------------------------------- */
/* SQL                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The statements, in one place, so a migration review can diff them against 0007/0008/0009/0010.
 *
 * Named-argument notation on every function call, for the reason `pg-job-store.ts` gives at
 * length: two same-typed parameters transposed positionally is a silent bug, and 0009's
 * `publish_version` has three `jsonb` parameters in a row.
 *
 * `deleted_at IS NULL` on the four soft-deletable tables, and NOT as an optimization. B §4.1
 * makes `deleted_at` the editor's undo buffer; a soft-deleted question that reached the compiler
 * would be emitted into a page, and a soft-deleted rule would keep firing in field. The
 * `content.*` SELECT policies deliberately do not filter it (`apps/studio`'s registry read makes
 * the same note), because the editor needs to read its own undo buffer.
 */
export const PUBLISH_SQL = {
  claims:
    "SELECT set_config('request.jwt.claims', " +
    "json_build_object('sub', $1::uuid, 'role', 'authoring', " +
    "'app_metadata', json_build_object('active_org_id', $2::text))::text, true) AS claims",

  version:
    'SELECT id, org_id, survey_id, version_no, status::text AS status, ' +
    'compile_state::text AS compile_state, schema_version, artifact_hash, artifact_bytes, ' +
    'entitlement_reqs, compile_diagnostics, acknowledged_warnings, revision ' +
    'FROM app.survey_versions WHERE id = $1::app.ulid',

  survey:
    'SELECT id, ref, name, description, default_language, theme_id ' +
    'FROM app.surveys WHERE id = $1::app.ulid',

  nodes:
    'SELECT id, node_kind::text AS node_kind, parent_id, sort_key, ref, label_key, ' +
    'instruction_key, title_key, question_type, required, config, settings, validation, ' +
    'masks, scripts, flags, emits FROM content.nodes ' +
    'WHERE survey_version_id = $1::app.ulid AND deleted_at IS NULL ORDER BY sort_key, id',

  items:
    'SELECT id, question_id, item_kind::text AS item_kind, ref, code, label_key, sort_key, ' +
    'anchor, exclusive, behaviour, media_asset_id, value_override, custom_class, meta ' +
    'FROM content.question_items ' +
    'WHERE survey_version_id = $1::app.ulid AND deleted_at IS NULL ORDER BY sort_key, id',

  cells:
    'SELECT id, question_id, row_item_id, column_item_id, question_type, config, use_columns ' +
    'FROM content.question_cells WHERE survey_version_id = $1::app.ulid ORDER BY id',

  variables:
    'SELECT id, name, kind::text AS kind, vtype::text AS vtype, source_question_id, ' +
    'source_item_id, source_part, enum_domain, expression, storage, export_include, ' +
    'export_column, export_label_key, pii, persist, sort_key FROM content.variables ' +
    'WHERE survey_version_id = $1::app.ulid AND deleted_at IS NULL ORDER BY sort_key, id',

  languages:
    'SELECT lang, is_base, rtl, on_missing, block_publish_if_incomplete ' +
    'FROM content.languages WHERE survey_version_id = $1::app.ulid ORDER BY lang',

  strings:
    'SELECT lang, key, value, state::text AS state FROM content.i18n_strings ' +
    'WHERE survey_version_id = $1::app.ulid ORDER BY lang, key',

  rules:
    'SELECT id, kind::text AS kind, target_kind::text AS target_kind, target_node_id, ' +
    'target_item_id, target_variable_id, condition, effect, evaluation, authored_in, notes, ' +
    'sort_key FROM content.logic_rules ' +
    'WHERE survey_version_id = $1::app.ulid AND deleted_at IS NULL ORDER BY sort_key, id',

  // 0010's content.redirects. No `deleted_at` filter, and the omission is the table's rather
  // than this query's: a redirect row is not referenced by anything, so it needs no undo buffer
  // and the column does not exist. Ordered so the assembled map is deterministic — the artifact
  // hash is taken over canonical JSON, but `redirectsOf` builds objects in insertion order and
  // stableStringify sorts keys, so this ORDER BY costs nothing and removes a reason to wonder.
  redirects:
    'SELECT scope::text AS scope, scope_key, disposition, custom_key, url_template ' +
    'FROM content.redirects WHERE survey_version_id = $1::app.ulid ' +
    'ORDER BY scope, scope_key, disposition, custom_key',

  // 0009 §5's "deliberately NOT a function" path. Two columns and nothing else — no status, no
  // artifact_hash (0004's sv_compiled_needs_artifact would refuse a hash without a compile
  // anyway), no acknowledged_warnings (sealed on a frozen version by app.tg_version_guard).
  recordFailure:
    "UPDATE app.survey_versions SET compile_state = 'failed', compile_diagnostics = $2::jsonb " +
    'WHERE id = $1::app.ulid RETURNING id',

  publish:
    'SELECT app.publish_version(' +
    'p_version_id => $1::app.ulid, p_artifact_hash => $2::app.sha256, ' +
    'p_artifact_bytes => $3::bigint, p_target_status => $4::app.version_status, ' +
    'p_compile_diagnostics => $5::jsonb, p_acknowledged_warnings => $6::jsonb, ' +
    'p_request_id => $7::text) AS result',

  audit:
    'SELECT app.write_audit_event(' +
    'p_org_id => $1::app.ulid, p_action => $2::text, p_actor_kind => $3::text, ' +
    'p_actor_user_id => $4::uuid, p_target_kind => $5::text, p_target_id => $6::app.ulid, ' +
    'p_survey_id => $7::app.ulid, p_survey_version_id => $8::app.ulid, ' +
    'p_summary => $9::text, p_diff => $10::jsonb, p_request_id => $11::text) AS id',
} as const;

/* -------------------------------------------------------------------------- */
/* The Postgres implementation                                                */
/* -------------------------------------------------------------------------- */

export class PgPublishStore implements PublishStore {
  constructor(private readonly sessions: SessionFactory) {}

  /**
   * Set the claims and the role, run the body, always `RESET ROLE`.
   *
   * The reset is not defensive tidiness: `savepointSessions` reuses one connection across units
   * of work, so a leaked `authoring` role would make the NEXT unit run as a role whose claims
   * belong to the previous job. Making the reset unconditional means the identity is established
   * exactly once per unit and never inherited.
   */
  private async asUser<T>(
    identity: JobIdentity,
    fn: (session: SqlSession) => Promise<T>,
  ): Promise<T> {
    return this.sessions.run(async (session) => {
      await session.query(PUBLISH_SQL.claims, [identity.userId, identity.orgId]);
      await session.query('SET LOCAL ROLE authoring');
      try {
        return await fn(session);
      } finally {
        await session.query('RESET ROLE');
      }
    });
  }

  async loadAuthoringRows(
    identity: JobIdentity,
    versionId: string,
  ): Promise<AuthoringRows | null> {
    return this.asUser(identity, async (session) => {
      const version = (await session.query<Record<string, unknown>>(PUBLISH_SQL.version, [versionId]))
        .rows[0];
      // Zero rows is the RLS answer for "another org's version" AND for "no such version", and
      // 0004's suites insist the two be indistinguishable. The job maps this to a non-retryable
      // failure naming neither.
      if (version === undefined) return null;
      const surveyId = String(version['survey_id']);
      const survey = (await session.query<Record<string, unknown>>(PUBLISH_SQL.survey, [surveyId]))
        .rows[0];
      if (survey === undefined) return null;

      // SEQUENTIAL, not `Promise.all`. These share one connection, and `pg` serializes
      // concurrent `query()` calls on one client while warning that it will stop doing so
      // (`DeprecationWarning: Calling client.query() when the client is already executing a
      // query`). Overlapping them therefore buys nothing today and breaks on `pg@9`.
      const nodes = await session.query<Record<string, unknown>>(PUBLISH_SQL.nodes, [versionId]);
      const items = await session.query<Record<string, unknown>>(PUBLISH_SQL.items, [versionId]);
      const cells = await session.query<Record<string, unknown>>(PUBLISH_SQL.cells, [versionId]);
      const variables = await session.query<Record<string, unknown>>(PUBLISH_SQL.variables, [
        versionId,
      ]);
      const languages = await session.query<Record<string, unknown>>(PUBLISH_SQL.languages, [
        versionId,
      ]);
      const strings = await session.query<Record<string, unknown>>(PUBLISH_SQL.strings, [versionId]);
      const rules = await session.query<Record<string, unknown>>(PUBLISH_SQL.rules, [versionId]);
      const redirects = await session.query<Record<string, unknown>>(PUBLISH_SQL.redirects, [
        versionId,
      ]);

      return {
        version: versionRowOf(version),
        survey: surveyRowOf(survey),
        nodes: nodes.rows.map(nodeRowOf),
        items: items.rows.map(itemRowOf),
        cells: cells.rows.map(cellRowOf),
        variables: variables.rows.map(variableRowOf),
        languages: languages.rows.map(languageRowOf),
        strings: strings.rows.map(stringRowOf),
        rules: rules.rows.map(ruleRowOf),
        redirects: redirects.rows.map(redirectRowOf),
      };
    });
  }

  async recordCompileFailure(
    identity: JobIdentity,
    input: { readonly versionId: string; readonly diagnostics: readonly JsonValue[] },
  ): Promise<void> {
    await this.asUser(identity, async (session) => {
      const { rows } = await session.query<{ id: string }>(PUBLISH_SQL.recordFailure, [
        input.versionId,
        JSON.stringify(input.diagnostics),
      ]);
      if (rows.length === 0) {
        // `sv_update` declined, which for a compile job means the enqueuing user has been
        // demoted below `programmer` since pressing Publish. Not retryable: the next attempt
        // gets the same answer, and the diagnostics are already in the job's own error record.
        throw new AppError('forbidden', 'the compile failure could not be recorded', {
          retryable: false,
          context: { survey_version_id: input.versionId, policy: 'sv_update' },
        });
      }
    });
  }

  async publish(identity: JobIdentity, input: PublishRequest): Promise<PublishOutcome> {
    return this.asUser(identity, async (session) => {
      const { rows } = await session.query<{ result: unknown }>(PUBLISH_SQL.publish, [
        input.versionId,
        input.artifactHash,
        input.artifactBytes,
        input.targetStatus,
        JSON.stringify(input.diagnostics),
        JSON.stringify(input.acknowledgedWarnings),
        input.requestId,
      ]);
      const result = rows[0]?.result;
      if (result === undefined || result === null || typeof result !== 'object') {
        throw new AppError('internal_error', 'app.publish_version returned no row');
      }
      const outcome = publishOutcomeOf(result as Record<string, unknown>);

      /**
       * The acknowledgement record, and why it is a SECOND audit row.
       *
       * `app.publish_version` already writes `version.published` with the submitted
       * `acknowledged_warnings` in its diff, and that is the transition record. This row answers
       * a different question — 03 §17's "who signed off on shipping THIS warning" — and it
       * carries the warnings THIS COMPILE ACTUALLY RAISED and the author had already accepted,
       * not the list the client sent. The distinction is the whole value: a stale key for a
       * warning that no longer fires must not read as a sign-off, and a key the author never
       * sent must not be inventable by the worker. Written through
       * `app.write_audit_event` because 0004 gave `app.audit_log` a SELECT policy and no INSERT
       * policy — this definer function is the only way a row gets in, which is what makes the
       * trail unforgeable by its own subject.
       */
      if (input.acknowledgedNow.length > 0) {
        await session.query(PUBLISH_SQL.audit, [
          identity.orgId,
          'version.warnings_acknowledged',
          'user',
          identity.userId,
          'survey_version',
          input.versionId,
          outcome.surveyId,
          input.versionId,
          `acknowledged ${String(input.acknowledgedNow.length)} compile warning(s) while ` +
            `publishing to ${input.targetStatus}`,
          JSON.stringify({
            warnings: input.acknowledgedNow,
            artifact_hash: input.artifactHash,
            target_status: input.targetStatus,
          }),
          input.requestId,
        ]);
      }

      return outcome;
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Row mappers                                                                */
/* -------------------------------------------------------------------------- */

function str(v: unknown): string {
  return typeof v === 'string' ? v : String(v ?? '');
}

function nullableStr(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/** `bigint`/`int8` arrive from `pg` as strings, because they do not fit a JS number. */
function int(v: unknown, fallback: number): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = Number.parseInt(v, 10);
    return Number.isNaN(n) ? fallback : n;
  }
  return fallback;
}

function nullableInt(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  return int(v, 0);
}

function bool(v: unknown, fallback = false): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function obj(v: unknown): { [key: string]: JsonValue } {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as { [key: string]: JsonValue })
    : {};
}

function nullableObj(v: unknown): { [key: string]: JsonValue } | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as { [key: string]: JsonValue })
    : null;
}

function arr(v: unknown): readonly JsonValue[] {
  return Array.isArray(v) ? (v as JsonValue[]) : [];
}

function strArr(v: unknown): readonly string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function versionRowOf(row: Record<string, unknown>): AuthoringVersionRow {
  return {
    id: str(row['id']),
    org_id: str(row['org_id']),
    survey_id: str(row['survey_id']),
    version_no: int(row['version_no'], 1),
    status: str(row['status']),
    compile_state: str(row['compile_state']),
    schema_version: int(row['schema_version'], 1),
    artifact_hash: nullableStr(row['artifact_hash']),
    artifact_bytes: nullableInt(row['artifact_bytes']),
    entitlement_reqs: strArr(row['entitlement_reqs']),
    acknowledged_warnings: arr(row['acknowledged_warnings']),
    revision: int(row['revision'], 1),
  };
}

function surveyRowOf(row: Record<string, unknown>): AuthoringSurveyRow {
  return {
    id: str(row['id']),
    ref: str(row['ref']),
    name: str(row['name']),
    description: nullableStr(row['description']),
    default_language: str(row['default_language']),
    theme_id: nullableStr(row['theme_id']),
  };
}

function nodeRowOf(row: Record<string, unknown>): AuthoringNodeRow {
  const kind = str(row['node_kind']);
  return {
    id: str(row['id']),
    node_kind:
      kind === 'block' || kind === 'page' || kind === 'question' || kind === 'text'
        ? kind
        : 'text',
    parent_id: nullableStr(row['parent_id']),
    sort_key: str(row['sort_key']),
    ref: nullableStr(row['ref']),
    label_key: nullableStr(row['label_key']),
    instruction_key: nullableStr(row['instruction_key']),
    title_key: nullableStr(row['title_key']),
    question_type: nullableStr(row['question_type']),
    required: typeof row['required'] === 'boolean' ? row['required'] : null,
    config: obj(row['config']),
    settings: obj(row['settings']),
    validation: arr(row['validation']),
    masks: arr(row['masks']),
    scripts: obj(row['scripts']),
    flags: obj(row['flags']),
    emits: strArr(row['emits']),
  };
}

function itemRowOf(row: Record<string, unknown>): AuthoringItemRow {
  const kind = str(row['item_kind']);
  return {
    id: str(row['id']),
    question_id: str(row['question_id']),
    item_kind: kind === 'row' || kind === 'column' ? kind : 'option',
    ref: str(row['ref']),
    code: int(row['code'], 0),
    label_key: nullableStr(row['label_key']),
    sort_key: str(row['sort_key']),
    anchor: str(row['anchor']),
    exclusive: bool(row['exclusive']),
    behaviour: obj(row['behaviour']),
    media_asset_id: nullableStr(row['media_asset_id']),
    value_override: nullableStr(row['value_override']),
    custom_class: nullableStr(row['custom_class']),
    meta: obj(row['meta']),
  };
}

function cellRowOf(row: Record<string, unknown>): AuthoringCellRow {
  return {
    id: str(row['id']),
    question_id: str(row['question_id']),
    row_item_id: str(row['row_item_id']),
    column_item_id: nullableStr(row['column_item_id']),
    question_type: str(row['question_type']),
    config: obj(row['config']),
    use_columns: bool(row['use_columns']),
  };
}

function variableRowOf(row: Record<string, unknown>): AuthoringVariableRow {
  return {
    id: str(row['id']),
    name: str(row['name']),
    kind: str(row['kind']) as AuthoringVariableRow['kind'],
    vtype: str(row['vtype']) as AuthoringVariableRow['vtype'],
    source_question_id: nullableStr(row['source_question_id']),
    source_item_id: nullableStr(row['source_item_id']),
    source_part: nullableObj(row['source_part']),
    enum_domain: Array.isArray(row['enum_domain']) ? (row['enum_domain'] as JsonValue[]) : null,
    expression: (row['expression'] ?? null) as JsonValue | null,
    storage: obj(row['storage']),
    export_include: bool(row['export_include'], true),
    export_column: str(row['export_column']),
    export_label_key: nullableStr(row['export_label_key']),
    pii: bool(row['pii']),
    persist: bool(row['persist'], true),
    sort_key: str(row['sort_key']),
  };
}

function languageRowOf(row: Record<string, unknown>): AuthoringLanguageRow {
  return {
    lang: str(row['lang']),
    is_base: bool(row['is_base']),
    rtl: bool(row['rtl']),
    on_missing: str(row['on_missing']),
    block_publish_if_incomplete: bool(row['block_publish_if_incomplete'], true),
  };
}

function stringRowOf(row: Record<string, unknown>): AuthoringStringRow {
  return {
    lang: str(row['lang']),
    key: str(row['key']),
    value: nullableStr(row['value']),
    state: str(row['state']),
  };
}

function ruleRowOf(row: Record<string, unknown>): AuthoringRuleRow {
  const target = str(row['target_kind']);
  return {
    id: str(row['id']),
    kind: str(row['kind']) as AuthoringRuleRow['kind'],
    target_kind:
      target === 'node' || target === 'item' || target === 'variable' || target === 'survey'
        ? target
        : 'survey',
    target_node_id: nullableStr(row['target_node_id']),
    target_item_id: nullableStr(row['target_item_id']),
    target_variable_id: nullableStr(row['target_variable_id']),
    condition: obj(row['condition']),
    effect: obj(row['effect']),
    evaluation: str(row['evaluation']),
    authored_in: str(row['authored_in']),
    notes: nullableStr(row['notes']),
    sort_key: str(row['sort_key']),
  };
}

function redirectRowOf(row: Record<string, unknown>): AuthoringRedirectRow {
  const scope = str(row['scope']);
  return {
    // Narrowed rather than cast, like `nodeRowOf`'s node_kind: content.redirect_scope has exactly
    // these three labels, and defaulting the unreachable case to 'default' keeps the load total.
    // A fourth label would be a new arm in C §9's document shape, so it would need this file
    // changed anyway.
    scope: scope === 'vendor' || scope === 'language' ? scope : 'default',
    scope_key: str(row['scope_key']),
    disposition: str(row['disposition']),
    custom_key: str(row['custom_key']),
    url_template: str(row['url_template']),
  };
}

export function publishOutcomeOf(result: Record<string, unknown>): PublishOutcome {
  return {
    token: str(result['token']),
    surveyId: str(result['survey_id']),
    surveyVersionId: str(result['survey_version_id']),
    artifactHash: str(result['artifact_hash']),
    status: str(result['status']),
    isTest: bool(result['is_test']),
    demotedVersionId: nullableStr(result['demoted_version_id']),
    previousArtifactHash: nullableStr(result['previous_artifact_hash']),
  };
}
