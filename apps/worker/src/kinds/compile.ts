/**
 * The `compile` job: authoring model → artifact → publish transaction (roadmap P1-08).
 *
 * `noop.ts`'s header says the trivial job exists so that "the first `compile` job is not the
 * first time the harness is tested end to end". This is that job, and it walks the same five
 * mechanisms — typed payload, progress, a structured result, `ctx.signal`, a failure that is
 * classified rather than thrown blind — over work that matters.
 *
 * ## The order of operations, and why nothing may be reordered
 *
 *     load rows → assemble document → static gate → acknowledgement gate → upload → publish
 *
 * The last two are the pair that has to be in this order, and 0009 says so twice. The token row
 * is `NOT NULL` on `artifact_hash` ("the publish sequence is upload -> upsert token ->
 * compile_state, so the hash is always known by the time this row is written, and requiring it
 * here is what makes that ordering non-optional"), and `sv_compiled_needs_artifact` refuses
 * `compile_state = 'compiled'` without a hash. Publishing before the bytes are durable would
 * produce a version whose status says "production" and whose artifact is a 404 for a respondent a
 * panel vendor has already counted as an entrant.
 *
 * The first four are in this order because each one's diagnostics are only meaningful if the
 * previous one succeeded, which is the same argument `pipeline.ts` makes about its own stages.
 *
 * ## The three outcomes, and which of them is a failed job
 *
 *  1. **Compile errors.** The version gets `compile_state = 'failed'` and the diagnostics, by
 *     ordinary DML (0009 §5 is emphatic that this path has no RPC), NO ARTIFACT IS UPLOADED and
 *     nothing else on the row is touched — so A §7's "a failed publish always leaves the
 *     previously live artifact serving" holds because `status` was never in the statement. The
 *     JOB then fails, non-retryably: "publish failed" is what the author asked about, and
 *     retrying a forward reference three times would rewrite `compile_diagnostics` three times
 *     and delay the answer by the backoff schedule. The diagnostics live on the VERSION and not
 *     in `ops.jobs.error` because 0009's column comment says so — "the job is retained for a
 *     while and the version is retained forever, and 'why can I not publish this' outlives any
 *     queue" — so the error envelope carries counts and the first few codes, not the list.
 *  2. **Unacknowledged warnings.** The compile SUCCEEDED and there is a real artifact in memory,
 *     but 03 §17 requires the author to accept each warning before it ships. The job SUCCEEDS
 *     with `outcome: 'blocked'` and the unacknowledged list, because the studio's publish dialog
 *     has to render those warnings with acknowledgement controls — a failed job would put them in
 *     an error envelope, which is where a client looks for a problem with its request rather than
 *     for a list of things to sign off. NOTHING IS WRITTEN: no upload, no version row. Skipping
 *     the upload is deliberate — the artifact is content-addressed, so re-uploading it later
 *     costs nothing, and not uploading keeps "an object exists ⇒ some version named it" true,
 *     which is what makes an orphan in the bucket a bug rather than a normal occurrence.
 *  3. **Published.** `has()` the artifact's keys, `put()` only the misses, then one call to
 *     `app.publish_version` which writes the hash, the byte count, `compile_state`, the
 *     diagnostics, the acknowledgements, the status transition, the token repoint and the audit
 *     row in one transaction.
 *
 * ## Republishing unchanged content
 *
 * ADR-002 makes the storage key the sha256 of the artifact's own content, and `types.ts` explains
 * how `artifact_hash` and `compiled_at` are held out of the stored bytes so that the hash is
 * stable across days. The consequence is this job's cheapest and most-tested path: a republish of
 * an unchanged survey finds every key present, performs ZERO `put()`s, and calls
 * `app.publish_version` with the hash it already had. The roadmap's acceptance criterion —
 * "compiling the identical model a second time produces the identical hash and creates no new
 * object" — is therefore a property of this loop and is asserted on the store's call count, not
 * on the hash alone: a store that re-uploaded identical bytes would satisfy the hash half of the
 * criterion while failing the half that an object-lock policy depends on.
 *
 * ## `compile_state = 'compiling'` is never written, and that is a decision
 *
 * K §3 lists it (`none -> compiling -> compiled | failed`) and this job goes straight from
 * whatever the state was to `compiled` or `failed`. Writing it would take a third ordinary-DML
 * UPDATE, and every UPDATE of that row runs `app.tg_version_guard`, which increments `revision` —
 * so a compile would invalidate every open editor's `If-Match` twice before it had produced
 * anything. Worse, it is a state nothing clears: a worker that is OOM-killed at stage 3 leaves the
 * version reading `compiling` forever, and the component that would have to time it out is the
 * stalled-job sweeper, which owns `ops.jobs` and not `app.survey_versions`. "Is a compile running"
 * is already answered by the job row the studio is polling, which is the record that has a
 * heartbeat and a sweeper behind it. If the column is ever wanted, it belongs in
 * `app.publish_version`'s transaction or in a definer function that can also clear it — not in a
 * bare UPDATE from a process that can die.
 *
 * ## What this job deliberately does not do
 *
 * It does not read a clock (`compiledAt` is `ops.jobs.created_at`, so a retry of one job produces
 * the identical manifest), does not check entitlements (`billing` holds no plans table yet, and
 * `CompileInput` distinguishes "no plan to check" from "a plan that grants nothing" precisely so
 * that this is a skip and not a universal failure), does not compile a theme (P2-12; a hard-coded
 * stylesheet here would be a theme nobody can change), and does not roll back — `app.rollback_version`
 * is synchronous by design (H §2.4: "two column writes and a token update, not a compile") and is
 * called from the studio's route.
 */

import { AppError } from '@resscript/observability';
import {
  acknowledgementKey,
  compileErrors,
  compileSurvey,
  compileWarnings,
  type CompileDiagnostic,
} from '@resscript/compiler';

import { artifactKey, type ArtifactStore } from '../artifact-store.js';
import { assembleSurvey } from '../authoring-model.js';
import type { JsonObject, JsonValue } from '../json.js';
import { defineJob, payload as p, type JobContext, type JobDefinition } from '../registry.js';
import type { JobIdentity, PublishStore } from '../publish-store.js';

export const COMPILE_KIND = 'compile';

/* -------------------------------------------------------------------------- */
/* Payload                                                                    */
/* -------------------------------------------------------------------------- */

export type PublishTarget = 'staging' | 'production';

export interface CompilePayload {
  readonly surveyVersionId: string;
  /**
   * Where the version goes on success, or `null` for a DRY compile (H §2.4's
   * `POST /versions/:id/compile`: "produces diagnostics and an artifact but does not change
   * status"). 0009's `publish_version` refuses anything but staging/production ("draft and
   * review are authoring states; archived is reached by app.rollback_version"), so a non-null
   * payload cannot express a target the transaction would reject — and a null one never reaches
   * that function at all.
   */
  readonly targetStatus: PublishTarget | null;
  /**
   * `acknowledgementKey()` values the author has already accepted, sent by the studio's publish
   * dialog. Keys and not codes: a code acknowledged once would silence the same warning on every
   * other question in the survey, which is the acknowledgement flow quietly becoming a mute
   * button. `diagnostics.ts` explains why the key is code+path+detail rather than the message.
   */
  readonly acknowledgedWarnings: readonly string[];
}

/* -------------------------------------------------------------------------- */
/* Result                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * What lands in `ops.jobs.result`.
 *
 * Arrays here are MUTABLE, which breaks this repository's deep-`readonly` habit, and the reason
 * is the `JsonValue` domain rather than a preference: `JobDefinition<P, R extends JsonValue>`
 * needs every field assignable to `JsonValue`, and `readonly T[]` is not assignable to
 * `JsonValue[]`. `json.ts`'s header explains why the constraint is `JsonValue` and not `unknown`.
 * The values are never mutated after construction.
 */
export interface CompileWarningRecord extends JsonObject {
  code: string;
  path: string;
  message: string;
  acknowledgement_key: string;
}

export interface CompileJobResult extends JsonObject {
  /**
   * `published` = the publish transaction ran; `blocked` = warnings still need acknowledgement;
   * `checked` = a dry compile produced diagnostics and an artifact and moved nothing.
   */
  outcome: 'published' | 'blocked' | 'checked';
  survey_version_id: string;
  /** `null` on a dry compile — there was no target. */
  target_status: PublishTarget | null;
  artifact_hash: string;
  artifact_bytes: number;
  error_count: number;
  warning_count: number;
  /** Empty on `published`. On `blocked`, exactly what the publish dialog has to render. */
  unacknowledged: CompileWarningRecord[];
  /** Recorded so the job list can show "shipped with 2 accepted warnings" without a second read. */
  acknowledged_count: number;
  pages: number;
  languages: number;
  /**
   * The no-op evidence. `objects_written: 0` on a republish is the roadmap's "creates no new
   * object", observable from the job row months later without re-reading the bucket.
   */
  objects_written: number;
  objects_reused: number;
  /** Absent (null) on `blocked`, since no token was touched. */
  token: string | null;
  is_test: boolean | null;
  demoted_version_id: string | null;
  previous_artifact_hash: string | null;
}

/* -------------------------------------------------------------------------- */
/* Environment                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Everything the handler reaches for, injected.
 *
 * `JobContext` deliberately carries no store — `registry.ts` says why: "a handler that can call
 * `complete()` itself can complete a job it no longer owns" — so a job that needs more than its
 * payload gets it through a closure built at registration time. That also makes every assertion
 * in the suite reachable without Postgres and without a bucket.
 */
export interface CompileEnvironment {
  readonly store: PublishStore;
  readonly artifacts: ArtifactStore;
  /** Compiled theme CSS, when a deployment has one. See the header. */
  readonly themeCss?: string | null;
  /**
   * The org's plan features. `undefined` means "there is no plan to check against" and skips the
   * entitlement analysis; an empty `Set` means "this plan grants nothing" and fails every
   * requirement. `CompileInput` keeps them distinct on purpose and so does this.
   */
  readonly entitlements?: ReadonlySet<string> | undefined;
}

/**
 * The environment a worker with no `DATABASE_URL` gets.
 *
 * Every method fails immediately and names the variable. See `kinds/registry.ts` for why the kind
 * is registered anyway rather than omitted: a `compile` that is not claimable leaves publish jobs
 * queued forever, which presents to a user as a spinner and to an operator as silence.
 * Non-retryable, because three attempts against an unconfigured process produce three identical
 * failures and one useful one.
 */
export function unconfiguredCompileEnvironment(): CompileEnvironment {
  const refuse = (): never => {
    throw new AppError('unavailable', 'this worker cannot compile: DATABASE_URL is unset', {
      retryable: false,
      context: { kind: COMPILE_KIND },
    });
  };
  return {
    store: {
      loadAuthoringRows: async () => refuse(),
      recordCompileFailure: async () => refuse(),
      recordDryCompile: async () => refuse(),
      publish: async () => refuse(),
    },
    artifacts: {
      has: async () => refuse(),
      put: async () => refuse(),
      get: async () => refuse(),
    },
  };
}

/* -------------------------------------------------------------------------- */
/* The job                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The pipeline stages, as the studio renders them.
 *
 * A named list rather than six magic numbers, so `total` is derived and a stage cannot be added
 * without the denominator moving with it. M0.4 built the "step N of M" component against
 * `{step, total, message}`; this is its first real consumer, so the labels are written to be read
 * by a human watching a publish rather than by a log parser.
 */
export const COMPILE_STAGES: readonly string[] = [
  'reading the authoring model',
  'assembling the survey document',
  'running the static gate',
  'checking warning acknowledgements',
  'uploading the artifact',
  'publishing',
];

export function compileJob(env: CompileEnvironment): JobDefinition<CompilePayload, CompileJobResult> {
  return defineJob({
    parse: (raw): CompilePayload => {
      // An ABSENT or null `target_status` is the dry compile. Absent rather than a separate
      // `dry: true` flag: the payload then says exactly one thing about where the version goes,
      // and a payload carrying both a target and a dry flag would have a contradictory state.
      const rawTarget = raw['target_status'];
      let target: PublishTarget | null = null;
      if (rawTarget !== undefined && rawTarget !== null) {
        if (rawTarget !== 'staging' && rawTarget !== 'production') {
          throw new TypeError(
            `payload.target_status must be 'staging', 'production' or absent (dry), got ${JSON.stringify(rawTarget)}`,
          );
        }
        target = rawTarget;
      }
      return {
        surveyVersionId: p.requiredString(raw, 'survey_version_id'),
        targetStatus: target,
        acknowledgedWarnings: stringArray(raw['acknowledged_warnings'], 'acknowledged_warnings'),
      };
    },

    // A compile is deterministic: the same document and the same plugins produce the same
    // diagnostics, so an unrecognised throw is an infrastructure failure (a dropped connection,
    // a bucket 503) and not a survey the author can fix. Those are worth retrying; the two
    // outcomes that are NOT are raised as explicit non-retryable AppErrors below.
    handle: (ctx) => runCompile(ctx, env),
  });
}

async function runCompile(
  ctx: JobContext<CompilePayload>,
  env: CompileEnvironment,
): Promise<CompileJobResult> {
  const total = COMPILE_STAGES.length;
  const { surveyVersionId, targetStatus, acknowledgedWarnings } = ctx.payload;
  const identity = identityOf(ctx);

  /* ---- 1. the authoring model ------------------------------------------- */

  await stage(ctx, 1, total);
  const rows = await env.store.loadAuthoringRows(identity, surveyVersionId);
  if (rows === null) {
    // Zero rows from a policy-filtered read is the same answer as "no such version", and 0004's
    // suites insist the two stay indistinguishable — an error that distinguished them would be
    // an existence oracle across tenants. Non-retryable: the next attempt reads the same rows.
    throw new AppError('not_found', 'the survey version is not visible to the enqueuing user', {
      retryable: false,
      context: { survey_version_id: surveyVersionId, org_id: identity.orgId },
    });
  }

  /* ---- 2. the document -------------------------------------------------- */

  await stage(ctx, 2, total);
  // No injected anything: every field of the document comes from the version's own rows. Until
  // 0010 this call took a `redirects` fallback out of `CompileEnvironment`, because C §9's map had
  // no column and CMP-0300 blocks every survey without one — so "does this survey publish"
  // depended on worker configuration. `content.redirects` ended that.
  const survey = assembleSurvey(rows);

  /* ---- 3. the static gate ----------------------------------------------- */

  await stage(ctx, 3, total);
  const compiled = compileSurvey({
    survey,
    surveyVersionId,
    // The ENQUEUE time, not now(). A retry of one job then produces a byte-identical manifest,
    // and `compiled_at` is held out of the hashed bytes anyway (types.ts's addressing rule), so
    // this choice is about the in-memory artifact and the audit trail agreeing with each other.
    compiledAt: ctx.job.created_at.toISOString(),
    acknowledgedWarnings: [...acknowledgedWarnings],
    // The survey's theme, root-first, as the compiler's token layers. Loaded by
    // `loadAuthoringRows` (publish-store.ts' recursive CTE), which resolves the inheritance chain
    // in one query and returns it in the order `compileTheme` expects.
    //
    // An EMPTY chain is the normal case and is not a gap: a survey that pins no theme gets the
    // compiler's default vocabulary, which since P2-12 is a real stylesheet rather than nothing at
    // all. `env.themeCss` still overrides everything, for a caller holding bytes.
    themeTokens: rows.themeChain.map((link) => link.tokens),
    ...(env.themeCss === undefined || env.themeCss === null ? {} : { themeCss: env.themeCss }),
    ...(env.entitlements === undefined ? {} : { entitlements: env.entitlements }),
  });

  const errors = compileErrors(compiled.diagnostics);
  const warnings = compileWarnings(compiled.diagnostics);

  if (!compiled.ok) {
    // ORDINARY DML, no artifact, nothing else touched. See the header, outcome 1.
    await env.store.recordCompileFailure(identity, {
      versionId: surveyVersionId,
      diagnostics: compiled.diagnostics.map(diagnosticJson),
    });
    ctx.log.warn('compile_failed', {
      survey_version_id: surveyVersionId,
      error_count: errors.length,
      warning_count: warnings.length,
      codes: errors.slice(0, 10).map((d) => d.code),
    });
    throw new AppError(
      'compile_errors',
      `the static gate reported ${String(errors.length)} error(s); no artifact was written`,
      {
        retryable: false,
        // API §1.5's `compile_errors` shape. Capped: the full list is on the version row, which
        // is where 0009 says it belongs, and an envelope carrying 4,000 details is an envelope
        // nothing renders.
        details: errors.slice(0, 25).map((d) => ({
          path: d.path,
          code: d.code,
          message: d.message,
        })),
        context: {
          survey_version_id: surveyVersionId,
          error_count: errors.length,
          warning_count: warnings.length,
        },
      },
    );
  }

  const bundle = compiled.bundle;

  /* ---- 4. the acknowledgement gate -------------------------------------- */

  await stage(ctx, 4, total);
  const acknowledgedNow = warnings.filter((d) =>
    acknowledgedWarnings.includes(acknowledgementKey(d)),
  );

  // A dry run does not block on unacknowledged warnings: blocking is the publish gate's job, and
  // the whole point of checking without publishing is to SEE the warnings you have not signed.
  if (targetStatus !== null && compiled.unacknowledged.length > 0) {
    ctx.log.info('compile_blocked_on_warnings', {
      survey_version_id: surveyVersionId,
      unacknowledged: compiled.unacknowledged.length,
    });
    return {
      outcome: 'blocked',
      survey_version_id: surveyVersionId,
      target_status: targetStatus,
      artifact_hash: bundle.hash,
      artifact_bytes: bundle.bytes,
      error_count: 0,
      warning_count: warnings.length,
      unacknowledged: compiled.unacknowledged.map(warningRecord),
      acknowledged_count: acknowledgedNow.length,
      pages: bundle.artifact.graph.page_order.length,
      languages: Object.keys(bundle.artifact.i18n).length,
      objects_written: 0,
      objects_reused: 0,
      token: null,
      is_test: null,
      demoted_version_id: null,
      previous_artifact_hash: null,
    };
  }

  /* ---- 5. the bytes ----------------------------------------------------- */

  await stage(ctx, 5, total);
  let written = 0;
  let reused = 0;
  for (const file of bundle.files) {
    // Between files, not only between stages: a 12-language 2,000-question artifact is thousands
    // of objects, and a drain that has to wait for all of them is a deploy that times out.
    abortIfDraining(ctx, { file: file.path });
    const key = artifactKey(bundle.hash, file.path);
    if (await env.artifacts.has(key)) {
      reused += 1;
      continue;
    }
    await env.artifacts.put(key, file.bytes);
    written += 1;
  }

  /* ---- 6. the publish transaction, or the dry recorder -------------------- */

  await stage(ctx, 6, total);
  if (targetStatus === null) {
    await env.store.recordDryCompile(identity, {
      versionId: surveyVersionId,
      diagnostics: compiled.diagnostics.map(diagnosticJson),
      artifactHash: bundle.hash,
      artifactBytes: bundle.bytes,
    });
    ctx.log.info('compile_dry_run', {
      survey_version_id: surveyVersionId,
      artifact_hash: bundle.hash,
      warning_count: warnings.length,
      unacknowledged: compiled.unacknowledged.length,
    });
    return {
      // A dry run's own outcome word. Not 'published' (nothing moved) and not 'blocked' (nothing
      // was refused) — a studio that had to infer "did this change my version?" from a shared
      // outcome would eventually infer it wrong.
      outcome: 'checked',
      survey_version_id: surveyVersionId,
      target_status: null,
      artifact_hash: bundle.hash,
      artifact_bytes: bundle.bytes,
      error_count: 0,
      warning_count: warnings.length,
      unacknowledged: compiled.unacknowledged.map(warningRecord),
      acknowledged_count: acknowledgedNow.length,
      pages: bundle.artifact.graph.page_order.length,
      languages: Object.keys(bundle.artifact.i18n).length,
      objects_written: written,
      objects_reused: reused,
      token: null,
      is_test: null,
      demoted_version_id: null,
      previous_artifact_hash: null,
    };
  }

  const outcome = await env.store.publish(identity, {
    versionId: surveyVersionId,
    artifactHash: bundle.hash,
    artifactBytes: bundle.bytes,
    targetStatus,
    diagnostics: compiled.diagnostics.map(diagnosticJson),
    acknowledgedWarnings: [...acknowledgedWarnings],
    acknowledgedNow: acknowledgedNow.map((d) => warningRecord(d) as unknown as JsonValue),
    // `app.audit_log.request_id` gets the JOB id, not the HTTP request id of the enqueue — the
    // worker was never given the latter (`ops.jobs` carries no column for it). That is not a
    // broken chain: the studio's own `version.publish_requested` audit row carries both its
    // request id and this job id, so "which click produced this publish" is one join and the id a
    // customer can quote (the job id, which is what the studio's job view shows) resolves
    // directly.
    requestId: ctx.job.id,
  });

  ctx.log.info('compile_published', {
    survey_version_id: surveyVersionId,
    artifact_hash: bundle.hash,
    target_status: targetStatus,
    objects_written: written,
    objects_reused: reused,
  });

  return {
    outcome: 'published',
    survey_version_id: surveyVersionId,
    target_status: targetStatus,
    artifact_hash: bundle.hash,
    artifact_bytes: bundle.bytes,
    error_count: 0,
    warning_count: warnings.length,
    unacknowledged: [],
    acknowledged_count: acknowledgedNow.length,
    pages: bundle.artifact.graph.page_order.length,
    languages: Object.keys(bundle.artifact.i18n).length,
    objects_written: written,
    objects_reused: reused,
    token: outcome.token,
    is_test: outcome.isTest,
    demoted_version_id: outcome.demotedVersionId,
    previous_artifact_hash: outcome.previousArtifactHash,
  };
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Report a stage, having first checked the drain signal.
 *
 * Both in one function so that "honour `ctx.signal` between stages" cannot be satisfied for five
 * stages and forgotten for the sixth. The check comes BEFORE the progress write, so a job that
 * aborts does not first advertise a stage it never ran.
 */
async function stage(ctx: JobContext<CompilePayload>, step: number, total: number): Promise<void> {
  abortIfDraining(ctx, { step });
  await ctx.progress(step, total, COMPILE_STAGES[step - 1] ?? '');
}

/**
 * Cooperative cancellation, thrown as RETRYABLE.
 *
 * A drained compile has changed nothing yet if it aborts before stage 6, and the publish
 * transaction itself is atomic, so re-running the whole job is always safe — which is exactly the
 * condition under which retrying is the right answer. `noop.ts` makes the same call for the same
 * reason.
 */
function abortIfDraining(ctx: JobContext<CompilePayload>, context: JsonObject): void {
  if (!ctx.signal.aborted) return;
  throw new AppError('unavailable', 'compile aborted during drain', {
    retryable: true,
    context: { survey_version_id: ctx.payload.surveyVersionId, ...context },
  });
}

/**
 * Who the job acts as — from `ops.jobs`, never from the payload.
 *
 * 0009's calling convention makes this the security boundary of the whole milestone: the publish
 * capability check inside `app.publish_version` is `app.has_role()` against these claims, so a
 * payload field naming an org or a user would be a way to publish into another tenant. A job row
 * missing either value is refused here rather than sent to the database to be refused with
 * `insufficient_privilege`, because the second form is indistinguishable from a demotion and
 * would send an operator looking at the wrong thing.
 */
function identityOf(ctx: JobContext<CompilePayload>): JobIdentity {
  const orgId = ctx.job.org_id;
  const userId = ctx.job.created_by;
  if (orgId === null || userId === null) {
    throw new AppError('forbidden', 'a compile job must carry an org and a creating user', {
      retryable: false,
      context: { job_id: ctx.job.id, has_org: orgId !== null, has_user: userId !== null },
    });
  }
  return { orgId, userId };
}

function warningRecord(d: CompileDiagnostic): CompileWarningRecord {
  return {
    code: d.code,
    path: d.path,
    message: d.message,
    acknowledgement_key: acknowledgementKey(d),
  };
}

/**
 * A diagnostic as it is stored in `survey_versions.compile_diagnostics`.
 *
 * Written out field by field rather than spread, so that adding a field to `CompileDiagnostic`
 * is a deliberate change to the persisted shape. 0009's `sv_diagnostics_is_array` guarantees the
 * column holds an array; the objects in it are this shape and the publish dialog reads it.
 */
function diagnosticJson(d: CompileDiagnostic): JsonValue {
  return {
    code: d.code,
    severity: d.severity,
    message: d.message,
    path: d.path,
    ...(d.detail === undefined ? {} : { detail: d.detail as JsonValue }),
  };
}

function stringArray(value: JsonValue | undefined, field: string): readonly string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new TypeError(`payload.${field} must be an array of strings`);
  return value.map((entry, index) => {
    if (typeof entry !== 'string') {
      throw new TypeError(`payload.${field}[${String(index)}] must be a string`);
    }
    return entry;
  });
}
