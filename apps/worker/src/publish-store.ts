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
  AuthoringCodeAssetRow,
  AuthoringThemeRow,
  AuthoringVendorLimitRow,
  AuthoringVendorRow,
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
  /** The dry compile's success: diagnostics and the artifact's identity, status untouched. */
  recordDryCompile(
    identity: JobIdentity,
    input: {
      readonly versionId: string;
      readonly diagnostics: readonly JsonValue[];
      readonly artifactHash: string;
      readonly artifactBytes: number;
    },
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

  /*
   * A variable whose SOURCE is deleted is not part of the document, even though its own row lives on.
   *
   * This filtered `deleted_at` on the variable and not on the question it is sourced from, and the
   * two are deliberately different lifetimes. `POST /nodes/{id}/undelete` says why in as many
   * words: "a soft-deleted question keeps its emitted variables so an undelete does not have to
   * recreate columns with new ids" — the row surviving is the feature, because a restored question
   * must come back with the same export columns.
   *
   * But `nodes` is fetched with `deleted_at IS NULL`, so the question is absent from the assembled
   * document while its variable is present, and the compiler correctly reports `SCH-1004`:
   * "Variable QCSum is sourced from qst_01M136…, which is not a question in this survey." Deleting
   * one question therefore made a survey unpublishable, with a diagnostic that reads like a
   * corrupted reference rather than like "you deleted that question this afternoon".
   *
   * Found on a real survey: a question soft-deleted at 15:27 left four variables behind, and the
   * publish that had just been unblocked by the i18n repair failed on this instead.
   *
   * Both source columns are checked. `source_item_id` has the same shape — an option can be
   * soft-deleted while the variable it emitted survives — and it would produce the same dangling
   * reference through a different field.
   */
  variables:
    'SELECT v.id, v.name, v.kind::text AS kind, v.vtype::text AS vtype, v.source_question_id, ' +
    'v.source_item_id, v.source_part, v.enum_domain, v.expression, v.storage, v.export_include, ' +
    'v.export_column, v.export_label_key, v.pii, v.persist, v.sort_key ' +
    '  FROM content.variables v ' +
    ' WHERE v.survey_version_id = $1::app.ulid AND v.deleted_at IS NULL ' +
    '   AND (v.source_question_id IS NULL OR EXISTS (' +
    '         SELECT 1 FROM content.nodes n ' +
    '          WHERE n.survey_version_id = v.survey_version_id ' +
    '            AND n.id = v.source_question_id AND n.deleted_at IS NULL)) ' +
    '   AND (v.source_item_id IS NULL OR EXISTS (' +
    '         SELECT 1 FROM content.question_items i ' +
    '          WHERE i.survey_version_id = v.survey_version_id ' +
    '            AND i.id = v.source_item_id AND i.deleted_at IS NULL)) ' +
    ' ORDER BY v.sort_key, v.id',

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
  /**
   * 0024's content.vendors, joined to its inbound params.
   *
   * ONE query with a lateral aggregate rather than two reads and a join in TypeScript: these
   * queries are sequential on a shared client (see `loadAuthoringRows`), so a second round trip is a
   * second round trip, and assembling a 1-N relationship in SQL is what SQL is for.
   *
   * `variable_ref` comes from the JOIN, not from a stored name. 0024 stores `variable_id` because
   * that is what a foreign key can hold — content.variables enforces name uniqueness with a partial
   * expression index, which no FK can reference — and the DOCUMENT wants a ref (schema §9,
   * "because vendors are authored by hand"). Deriving it here is also what makes a variable rename
   * flow into the vendor configuration instead of dangling.
   */
  vendors:
    'SELECT v.id, v.ref, v.name, v.entry_url_template, v.max_completes, v.quota_plan_overrides, ' +
    '       v.hash_param, v.algorithm::text AS algorithm, v.secret_ref, v.signed_params, ' +
    '       v.max_skew_s, v.timestamp_param, v.nonce_param, ' +
    '       COALESCE(p.params, \'[]\'::jsonb) AS inbound_params ' +
    '  FROM content.vendors v ' +
    '  LEFT JOIN LATERAL (' +
    '    SELECT jsonb_agg(jsonb_build_object(' +
    '             \'param\', ip.param, \'variable_ref\', var.name, \'required\', ip.required) ' +
    '           ORDER BY ip.sort_key, ip.param) AS params ' +
    '      FROM content.vendor_inbound_params ip ' +
    '      JOIN content.variables var ' +
    '        ON var.survey_version_id = ip.survey_version_id AND var.id = ip.variable_id ' +
    '     WHERE ip.survey_version_id = v.survey_version_id AND ip.vendor_id = v.id' +
    '  ) p ON true ' +
    ' WHERE v.survey_version_id = $1::app.ulid ' +
    ' ORDER BY v.sort_key, v.ref',
  /**
   * 0019's content.code_assets: scripts, HTML templates and author CSS.
   *
   * `sha256` is the generated column, carried through so the compiler can compare a declared hash
   * against the one it computes rather than trusting either (see `scriptHashes`' header). Ordered
   * by `(kind, ref)` so the artifact's bytes are canonical — `buildManifest` sorts its binding
   * table by ref anyway, but `bundle.ts` writes one file per asset and a stable order here keeps
   * the whole artifact reproducible rather than only the parts that re-sort.
   */
  codeAssets:
    'SELECT id, kind::text AS kind, ref, source, sha256, ' +
    '       runs_on::text AS runs_on, scope::text AS scope, hooks ' +
    '  FROM content.code_assets ' +
    ' WHERE survey_version_id = $1::app.ulid ' +
    ' ORDER BY kind, ref',
  /** 0024's content.vendor_limits, which the artifact carries under `quotas.vendor_limits`. */
  vendorLimits:
    'SELECT v.ref AS vendor_ref, l.max_completes ' +
    '  FROM content.vendor_limits l ' +
    '  JOIN content.vendors v ' +
    '    ON v.survey_version_id = l.survey_version_id AND v.id = l.vendor_id ' +
    ' WHERE l.survey_version_id = $1::app.ulid ' +
    ' ORDER BY v.ref',
  /**
   * The theme's token layers, ROOT-FIRST, walking `parent_theme_id` up from the survey's theme.
   *
   * Root-first because that is the order `resolveTokens(...layers)` expects — nearest-last — so the
   * ordering decision is made once, here, in the query that knows the chain. A reversal in the
   * caller would be invisible until a child theme mysteriously failed to override its parent.
   *
   * A recursive CTE rather than a loop of round trips: the depth is bounded at 16 by 0021's trigger,
   * so this is one query with a known ceiling, and `ORDER BY depth DESC` puts the root first.
   *
   * Reads app.themes LIVE rather than content.version_theme, deliberately: this runs at PUBLISH, and
   * publishing is exactly the moment a client's current theme is supposed to be captured. The
   * snapshot is what the publish then WRITES, and it is what protects versions already in field —
   * see 0021's header.
   */
  themeTokens:
    'WITH RECURSIVE chain AS (' +
    '  SELECT t.id, t.parent_theme_id, t.tokens, t.name, 0 AS depth' +
    '    FROM app.themes t' +
    '    JOIN app.surveys s ON s.theme_id = t.id' +
    '    JOIN app.survey_versions v ON v.survey_id = s.id' +
    '   WHERE v.id = $1::app.ulid' +
    '  UNION ALL' +
    '  SELECT p.id, p.parent_theme_id, p.tokens, p.name, c.depth + 1' +
    '    FROM app.themes p JOIN chain c ON c.parent_theme_id = p.id' +
    '   WHERE c.depth < 16' +
    ') SELECT id, name, tokens, depth FROM chain ORDER BY depth DESC',

  // 0009 §5's "deliberately NOT a function" path. Two columns and nothing else — no status, no
  // artifact_hash (0004's sv_compiled_needs_artifact would refuse a hash without a compile
  // anyway), no acknowledged_warnings (sealed on a frozen version by app.tg_version_guard).
  recordFailure:
    "UPDATE app.survey_versions SET compile_state = 'failed', compile_diagnostics = $2::jsonb " +
    'WHERE id = $1::app.ulid RETURNING id',

  /**
   * The DRY compile's outcome: the diagnostics and the artifact's identity, and deliberately NOT
   * `status`. H §2.4's `POST /versions/:id/compile` is "a dry compile: produces diagnostics and
   * an artifact but does not change status", so this is ordinary DML under `sv_update` rather
   * than a call to `app.publish_version` — that function's whole job is moving the version, and
   * a "publish that does not publish" parameter on it would be a mode nobody can audit.
   *
   * `acknowledged_warnings` is untouched for the same reason: a signature belongs to the publish
   * a human pressed, and a dry run is not one.
   */
  recordDry:
    // `compiled`, which is the enum's own word for a successful compile (0004's
    // `app.compile_state`), and it is legal on a draft: `sv_compiled_needs_artifact` requires a
    // hash alongside it — which this statement writes in the same UPDATE — and
    // `sv_live_needs_compiled` constrains the other direction (a live status needs a compile),
    // not this one. A draft that has compiled cleanly is exactly what a dry run produces.
    "UPDATE app.survey_versions SET compile_state = 'compiled', compile_diagnostics = $2::jsonb, " +
    'artifact_hash = $3::app.sha256, artifact_bytes = $4::bigint ' +
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
      const themeChain = await session.query<Record<string, unknown>>(PUBLISH_SQL.themeTokens, [
        versionId,
      ]);
      const vendors = await session.query<Record<string, unknown>>(PUBLISH_SQL.vendors, [versionId]);
      const codeAssets = await session.query<Record<string, unknown>>(PUBLISH_SQL.codeAssets, [
        versionId,
      ]);
      const vendorLimits = await session.query<Record<string, unknown>>(PUBLISH_SQL.vendorLimits, [
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
        themeChain: themeChain.rows.map(themeRowOf),
        vendors: vendors.rows.map(vendorRowOf),
        codeAssets: codeAssets.rows.map(codeAssetRowOf),
        vendorLimits: vendorLimits.rows.map(vendorLimitRowOf),
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

  async recordDryCompile(
    identity: JobIdentity,
    input: {
      readonly versionId: string;
      readonly diagnostics: readonly JsonValue[];
      readonly artifactHash: string;
      readonly artifactBytes: number;
    },
  ): Promise<void> {
    await this.asUser(identity, async (session) => {
      const { rows } = await session.query<{ id: string }>(PUBLISH_SQL.recordDry, [
        input.versionId,
        JSON.stringify(input.diagnostics),
        input.artifactHash,
        input.artifactBytes,
      ]);
      if (rows.length === 0) {
        // Same reading as `recordCompileFailure`'s: `sv_update` declined, so the enqueuing user
        // has been demoted below `programmer` since pressing Check. Not retryable.
        throw new AppError('forbidden', 'the compile result could not be recorded', {
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

/**
 * One link in the theme inheritance chain.
 *
 * The token map is narrowed to `string -> string` here rather than passed through as `unknown`:
 * 0021's `content.is_token_map` already guarantees a flat string map at the storage boundary, and
 * re-checking it at the read boundary means a row written before that constraint existed — or by a
 * superuser script that bypassed it — cannot reach the CSS emitter as a nested object it would have
 * to defend against. Anything that is not a string is dropped, not coerced: `String({})` is
 * "[object Object]", which would be interpolated into a stylesheet as a token value.
 */
/**
 * One `content.code_assets` row.
 *
 * `hooks` is `text[]`, which node-postgres already hands back as a JS array; the filter is for the
 * NULL element a `text[]` can legally contain and an array-typed column can therefore deliver.
 * `runs_on` and `scope` are nullable because one table serves three kinds — 0019's CHECKs pin
 * which kind may set which — so they pass through as null rather than being defaulted here; the
 * mapping into `Survey.assets` is where a per-kind default belongs.
 */
function codeAssetRowOf(row: Record<string, unknown>): AuthoringCodeAssetRow {
  const rawHooks = row['hooks'];
  const hooks = Array.isArray(rawHooks)
    ? rawHooks.filter((h): h is string => typeof h === 'string')
    : [];
  return {
    id: str(row['id']),
    kind: str(row['kind']) as AuthoringCodeAssetRow['kind'],
    ref: str(row['ref']),
    source: str(row['source']),
    sha256: typeof row['sha256'] === 'string' ? row['sha256'] : null,
    runs_on: typeof row['runs_on'] === 'string'
      ? (row['runs_on'] as AuthoringCodeAssetRow['runs_on'])
      : null,
    scope: typeof row['scope'] === 'string'
      ? (row['scope'] as AuthoringCodeAssetRow['scope'])
      : null,
    hooks,
  };
}

function themeRowOf(row: Record<string, unknown>): AuthoringThemeRow {
  const raw = row['tokens'];
  const tokens: { [k: string]: string } = {};
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === 'string') tokens[k] = v;
    }
  }
  return { id: str(row['id']), name: str(row['name']), tokens };
}

/**
 * One vendor row, with its inbound params already aggregated by the query.
 *
 * The security fields are folded back into a nested `security` object only when the vendor is
 * actually signed. 0024's `vendors_security_all_or_none` CHECK means the three columns are either
 * all present or all absent, so testing one is testing all three — but it is tested on `secret_ref`
 * specifically, because that is the field whose absence means "unsigned" to a reader.
 */
function vendorRowOf(row: Record<string, unknown>): AuthoringVendorRow {
  const secretRef = row['secret_ref'];
  const params = Array.isArray(row['inbound_params']) ? row['inbound_params'] : [];
  return {
    id: str(row['id']),
    ref: str(row['ref']),
    name: str(row['name']),
    entry_url_template: row['entry_url_template'] === null ? null : str(row['entry_url_template']),
    max_completes: row['max_completes'] === null ? null : Number(row['max_completes']),
    quota_plan_overrides: Array.isArray(row['quota_plan_overrides'])
      ? (row['quota_plan_overrides'] as unknown[]).map(String)
      : [],
    inbound_params: params.map((raw) => {
      const p = raw as Record<string, unknown>;
      return {
        param: str(p['param']),
        variable_ref: str(p['variable_ref']),
        required: p['required'] === true,
      };
    }),
    ...(typeof secretRef === 'string' && secretRef !== ''
      ? {
          security: {
            hash_param: str(row['hash_param']),
            // Narrowed rather than cast, like `redirectRowOf`'s scope: the ENUM has exactly these
            // three labels, and defaulting the unreachable case keeps the load total.
            algorithm:
              str(row['algorithm']) === 'sha1'
                ? ('sha1' as const)
                : str(row['algorithm']) === 'md5'
                  ? ('md5' as const)
                  : ('sha256' as const),
            secret_ref: secretRef,
            signed_params: Array.isArray(row['signed_params'])
              ? (row['signed_params'] as unknown[]).map(String)
              : [],
            ...(row['max_skew_s'] === null ? {} : { max_skew_s: Number(row['max_skew_s']) }),
            ...(row['timestamp_param'] === null
              ? {}
              : { timestamp_param: str(row['timestamp_param']) }),
            ...(row['nonce_param'] === null ? {} : { nonce_param: str(row['nonce_param']) }),
          },
        }
      : {}),
  };
}

function vendorLimitRowOf(row: Record<string, unknown>): AuthoringVendorLimitRow {
  return { vendor_ref: str(row['vendor_ref']), max_completes: Number(row['max_completes']) };
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
