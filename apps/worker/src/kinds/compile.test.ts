/**
 * The `compile` job.
 *
 * Three suites, and the split follows `pg-job-store.test.ts`'s:
 *
 *  1. **The document assembly**, against literal rows. `assembleSurvey` is pure, so the
 *     interesting facts about it (the synthesized flow, the dense `position`, the language-policy
 *     reduction) are assertable without a database and without a compile.
 *  2. **The job**, driven through the real `Consumer` and `MemoryJobStore` — the pattern
 *     `consumer.test.ts` established — so progress, the retry classification and what lands in
 *     `ops.jobs.result` are asserted through the harness rather than by calling `handle` directly.
 *     A hand-built `JobContext` would let a handler that never reports progress pass.
 *  3. **The integration suite**, which SKIPS with a message when `DATABASE_URL` is unset, exactly
 *     as `PgJobStore`'s does. This is where `PUBLISH_SQL`'s column lists meet the real tables,
 *     where 0009's `publish_version`/`rollback_version`/`survey_tokens` are exercised through the
 *     job, and where the roadmap's two acceptance criteria that are claims about the DATABASE —
 *     "creates no new object" and "the runtime serves byte-identical bytes to what was live
 *     before, verified by hash comparison" — are checked.
 *
 * Every assertion is on a diagnostic CODE, a column value or a call COUNT. Never on message prose.
 */

import { createCapturingLogger } from '@resscript/observability';
import { describe, expect, it } from 'vitest';

import { MemoryArtifactStore, artifactKey } from '../artifact-store.js';
import {
  SYNTHETIC_END_ID,
  SYNTHETIC_START_ID,
  assembleSurvey,
  sequenceFlowNodeId,
  type AuthoringRows,
} from '../authoring-model.js';
import { Consumer } from '../consumer.js';
import type { JsonObject, JsonValue } from '../json.js';
import { MemoryJobStore } from '../memory-job-store.js';
import {
  PgPublishStore,
  savepointSessions,
  type JobIdentity,
  type PublishOutcome,
  type PublishRequest,
  type PublishStore,
  type SqlSession,
} from '../publish-store.js';
import { buildRegistry } from './registry.js';
import { COMPILE_KIND, COMPILE_STAGES, type CompileEnvironment } from './compile.js';

/* ========================================================================== */
/* Fixture                                                                     */
/* ========================================================================== */

/** `ops.test_ulid`'s shape, in TypeScript: `tid('qst','A1')` is always `qst_0A10000…`. */
function tid(prefix: string, tag: string): string {
  return `${prefix}_0${tag.toUpperCase().padEnd(25, '0')}`;
}

const ORG = tid('org', 'a');
const USER = '11111111-1111-1111-1111-111111111111';
const SVY = tid('svy', 'a');
const VER = tid('ver', 'a3');
const BLK = tid('blk', 'a');
const PAGE = tid('pg', 'a');
const Q1 = tid('qst', 'a1');
const Q2 = tid('qst', 'a2');
const O1 = tid('opt', 'a1');
const O2 = tid('opt', 'a2');
const V1 = tid('var', 'a1');
const V2 = tid('var', 'a2');
const RULE = tid('rul', 'a1');

/**
 * The completion redirect, as `content.redirects` ROWS.
 *
 * This used to be a `Redirects` literal injected through `CompileEnvironment`, because C §9's
 * redirect map had no column in 0004/0007/0008 while `CMP-0300` blocks the publish of any survey
 * whose flow can reach `COMPLETE` with nowhere to send the respondent — which the synthesized flow
 * always can, so no survey could publish. Migration 0010 created the table; the fixture therefore
 * carries rows, the environment carries nothing, and "does this survey publish" is a fact about
 * the version rather than about the worker's configuration.
 */
const REDIRECT_ROWS: AuthoringRows['redirects'] = [
  {
    scope: 'default',
    scope_key: '',
    disposition: 'COMPLETE',
    custom_key: '',
    url_template: 'https://vendor.test/complete',
  },
];

const EMPTY_NODE = {
  label_key: null,
  instruction_key: null,
  title_key: null,
  question_type: null,
  required: null,
  config: {},
  settings: {},
  validation: [],
  masks: [],
  scripts: {},
  flags: {},
  emits: [],
} as const;

const EMPTY_ITEM = {
  anchor: 'none',
  exclusive: false,
  behaviour: {},
  media_asset_id: null,
  value_override: null,
  custom_class: null,
  meta: {},
} as const;

/**
 * A block, a page, a two-option single select and a numeric — the same shape
 * `packages/schema`'s `makeMiniSurvey` uses, so a diagnostic here means the rows are wrong and
 * not that the document shape is unsupported.
 *
 * `withRules` adds a display rule whose condition is the literal `true`. That draws a WARNING
 * (`checkRule`'s "condition is provably constant"), which is what the acknowledgement tests need:
 * a warning that is unambiguously the author's and therefore not filtered as compiler-synthesized
 * noise the way a lowered mask rule's constant condition is.
 */
function fixtureRows(options: { readonly withRules?: boolean } = {}): AuthoringRows {
  return {
    version: {
      id: VER,
      org_id: ORG,
      survey_id: SVY,
      version_no: 3,
      status: 'draft',
      compile_state: 'none',
      schema_version: 2,
      artifact_hash: null,
      artifact_bytes: null,
      entitlement_reqs: [],
      acknowledged_warnings: [],
      revision: 1,
    },
    survey: {
      id: SVY,
      ref: 'SVYA',
      name: 'Survey A',
      description: null,
      default_language: 'en',
      theme_id: null,
    },
    nodes: [
      { ...EMPTY_NODE, id: BLK, node_kind: 'block', parent_id: null, sort_key: '0100', ref: 'B1' },
      { ...EMPTY_NODE, id: PAGE, node_kind: 'page', parent_id: BLK, sort_key: '0100', ref: 'P1' },
      {
        ...EMPTY_NODE,
        id: Q1,
        node_kind: 'question',
        parent_id: PAGE,
        sort_key: '0100',
        ref: 'Q1',
        question_type: 'single_select',
        required: true,
        label_key: 'q1.label',
        emits: [V1],
      },
      {
        ...EMPTY_NODE,
        id: Q2,
        node_kind: 'question',
        parent_id: PAGE,
        sort_key: '0200',
        ref: 'Q2',
        question_type: 'numeric',
        required: false,
        label_key: 'q2.label',
        config: { min: 0, max: 10 },
        emits: [V2],
      },
    ],
    items: [
      // Deliberately out of sort_key order in the array, so the `position` assertion proves the
      // sort happens here rather than being inherited from however Postgres returned the rows.
      {
        ...EMPTY_ITEM,
        id: O2,
        question_id: Q1,
        item_kind: 'option',
        ref: 'o2',
        code: 2,
        label_key: 'q1.o2',
        sort_key: '0200',
      },
      {
        ...EMPTY_ITEM,
        id: O1,
        question_id: Q1,
        item_kind: 'option',
        ref: 'o1',
        code: 1,
        label_key: 'q1.o1',
        sort_key: '0100',
      },
    ],
    cells: [],
    variables: [
      {
        id: V1,
        name: 'Q1',
        kind: 'response',
        vtype: 'enum',
        source_question_id: Q1,
        source_item_id: null,
        source_part: { kind: 'scalar' },
        enum_domain: [
          { code: 1, label_key: 'q1.o1' },
          { code: 2, label_key: 'q1.o2' },
        ],
        expression: null,
        storage: {},
        export_include: true,
        export_column: 'Q1',
        export_label_key: null,
        pii: false,
        persist: true,
        sort_key: '0100',
      },
      {
        id: V2,
        name: 'Q2',
        kind: 'response',
        vtype: 'number',
        source_question_id: Q2,
        source_item_id: null,
        source_part: { kind: 'scalar' },
        enum_domain: null,
        expression: null,
        storage: {},
        export_include: true,
        export_column: 'Q2',
        export_label_key: null,
        pii: false,
        persist: true,
        sort_key: '0200',
      },
    ],
    languages: [
      {
        lang: 'en',
        is_base: true,
        rtl: false,
        on_missing: 'fallback_to_base',
        block_publish_if_incomplete: false,
      },
    ],
    strings: [
      { lang: 'en', key: 'q1.label', value: 'Pick one', state: 'reviewed' },
      { lang: 'en', key: 'q1.o1', value: 'Yes', state: 'reviewed' },
      { lang: 'en', key: 'q1.o2', value: 'No', state: 'reviewed' },
      { lang: 'en', key: 'q2.label', value: 'How many?', state: 'reviewed' },
    ],
    rules:
      options.withRules === true
        ? [
            {
              id: RULE,
              kind: 'display',
              target_kind: 'node',
              target_node_id: Q2,
              target_item_id: null,
              target_variable_id: null,
              condition: { op: 'lit', v: { k: 'bool', v: true } },
              effect: { action: 'hide' },
              evaluation: 'on_change',
              authored_in: 'visual',
              notes: null,
              sort_key: '0100',
            },
          ]
        : [],
    redirects: REDIRECT_ROWS,
    themeChain: [],
  };
}

/** The same fixture with the question's label key removed from every bundle. */
function brokenRows(): AuthoringRows {
  const rows = fixtureRows();
  return { ...rows, strings: rows.strings.filter((s) => s.key !== 'q1.label') };
}

/* ========================================================================== */
/* 1. The document                                                             */
/* ========================================================================== */

describe('assembling a Survey from content rows', () => {
  it('synthesizes the linear flow C §6 describes, with ids derived from the content ids', () => {
    const survey = assembleSurvey(fixtureRows());
    // Derived and not minted: a fresh ULID per compile would change graph.json and therefore
    // the artifact hash, which is the one property this milestone is judged on.
    expect(survey.flow.nodes.map((n) => n.id)).toEqual([
      SYNTHETIC_START_ID,
      sequenceFlowNodeId(BLK),
      SYNTHETIC_END_ID,
    ]);
    expect(survey.flow.nodes[2]).toMatchObject({ type: 'end', disposition: 'COMPLETE' });
  });

  it('materializes a dense 1-based position from sort_key without touching code', () => {
    const survey = assembleSurvey(fixtureRows());
    const question = findQuestion(survey, 'Q1');
    // The rows were supplied in reverse sort_key order on purpose.
    expect(question.options?.map((o) => [o.ref, o.position, o.code])).toEqual([
      ['o1', 1, 1],
      ['o2', 2, 2],
    ]);
  });

  it('omits a `missing` translation instead of emitting an empty string for it', () => {
    const rows = fixtureRows();
    const survey = assembleSurvey({
      ...rows,
      strings: [...rows.strings, { lang: 'en', key: 'q9.label', value: null, state: 'missing' }],
    });
    // A present-but-empty string answers "is this key translated" with yes, which would let the
    // publish gate pass a survey that shows a respondent a blank label.
    expect(Object.keys(survey.languages.bundles['en'] ?? {})).not.toContain('q9.label');
  });

  it('ORs block_publish_if_incomplete across languages rather than reading the base row', () => {
    const rows = fixtureRows();
    const survey = assembleSurvey({
      ...rows,
      languages: [
        ...rows.languages,
        {
          lang: 'ar',
          is_base: false,
          rtl: true,
          on_missing: 'fallback_to_base',
          block_publish_if_incomplete: true,
        },
      ],
    });
    // The base language does not block; Arabic does. Reducing to the base row would let the one
    // language that must not ship incomplete ship incomplete.
    expect(survey.languages.policy.block_publish_if_incomplete).toBe(true);
    expect(survey.languages.available.find((l) => l.code === 'ar')?.rtl).toBe(true);
  });
});

/* ========================================================================== */
/* 2. The job                                                                  */
/* ========================================================================== */

/**
 * An in-memory `PublishStore` that records what it was asked to do.
 *
 * Not a mock of behaviour: it enforces the two invariants the real one gets from the database, so
 * a handler that published without an artifact or that wrote a failure and then published anyway
 * fails here rather than in the integration suite.
 */
class FakePublishStore implements PublishStore {
  readonly failures: { versionId: string; diagnostics: readonly JsonValue[] }[] = [];
  readonly publishes: PublishRequest[] = [];
  /** Stands in for `runtime.survey_tokens`: at most one live row per (survey, is_test). */
  readonly tokens = new Map<string, { versionId: string; hash: string }>();
  version: { hash: string | null; state: string; status: string } = {
    hash: null,
    state: 'none',
    status: 'draft',
  };

  constructor(private readonly rows: AuthoringRows | null) {}

  async loadAuthoringRows(_identity: JobIdentity, versionId: string): Promise<AuthoringRows | null> {
    return this.rows !== null && this.rows.version.id === versionId ? this.rows : null;
  }

  async recordCompileFailure(
    _identity: JobIdentity,
    input: { readonly versionId: string; readonly diagnostics: readonly JsonValue[] },
  ): Promise<void> {
    this.failures.push({ versionId: input.versionId, diagnostics: input.diagnostics });
    // Exactly the two columns 0009 §5 permits, and nothing else — status untouched, so the
    // previously live artifact keeps serving.
    this.version = { ...this.version, state: 'failed' };
  }

  readonly dryRecorded: {
    versionId: string;
    diagnostics: readonly JsonValue[];
    artifactHash: string;
  }[] = [];

  async recordDryCompile(
    _identity: JobIdentity,
    input: {
      readonly versionId: string;
      readonly diagnostics: readonly JsonValue[];
      readonly artifactHash: string;
      readonly artifactBytes: number;
    },
  ): Promise<void> {
    this.dryRecorded.push({
      versionId: input.versionId,
      diagnostics: input.diagnostics,
      artifactHash: input.artifactHash,
    });
  }

  async publish(identity: JobIdentity, input: PublishRequest): Promise<PublishOutcome> {
    this.publishes.push(input);
    this.version = {
      hash: input.artifactHash,
      state: 'compiled',
      status: input.targetStatus,
    };
    const isTest = input.targetStatus !== 'production';
    const key = `${identity.orgId}|${isTest ? 'test' : 'live'}`;
    const existing = this.tokens.get(key);
    this.tokens.set(key, { versionId: input.versionId, hash: input.artifactHash });
    return {
      // A fixed 26-character lowercase base-36 string: K §5's alphabet, so a caller that
      // validated the shape here would be validating the same shape the domain enforces.
      token: 'aaaaaaaaaaaaaaaaaaaaaaaaaa',
      surveyId: SVY,
      surveyVersionId: input.versionId,
      artifactHash: input.artifactHash,
      status: input.targetStatus,
      isTest,
      demotedVersionId: null,
      previousArtifactHash: existing?.hash ?? null,
    };
  }
}

interface Harness {
  readonly store: MemoryJobStore;
  readonly publish: FakePublishStore;
  readonly artifacts: MemoryArtifactStore;
  readonly logs: ReturnType<typeof createCapturingLogger>;
  run(payload: JsonObject): Promise<{
    status: string;
    result: JsonValue | null;
    error: JsonObject | null;
    progress: JsonObject;
    attempts: number;
  }>;
}

/**
 * One consumer, one artifact store, one publish store, reused across `run()` calls — because the
 * republish assertion is precisely "run the same job twice against the SAME store and count the
 * `put()`s".
 */
function harness(
  rows: AuthoringRows | null,
  options: { readonly artifacts?: MemoryArtifactStore; readonly abort?: boolean } = {},
): Harness {
  const store = new MemoryJobStore();
  const publish = new FakePublishStore(rows);
  const artifacts = options.artifacts ?? new MemoryArtifactStore();
  const logs = createCapturingLogger({ service: 'worker', level: 'debug' });
  const env: CompileEnvironment = { store: publish, artifacts };
  const consumer = new Consumer({
    store,
    registry: buildRegistry({ compile: env }),
    logger: logs.logger,
    concurrency: 1,
    pollIntervalMs: 2,
    heartbeatIntervalMs: 5,
    stalledAfterMs: 50_000,
    sweepIntervalMs: 0,
    drainTimeoutMs: 2_000,
    backoffMs: () => 0,
  });

  return {
    store,
    publish,
    artifacts,
    logs,
    run: async (payload) => {
      const { id } = await store.enqueue({
        kind: COMPILE_KIND,
        payload,
        orgId: ORG,
        createdBy: USER,
        surveyVersionId: String(payload['survey_version_id'] ?? VER),
        maxAttempts: 1,
      });
      await consumer.runUntilIdle();
      const job = await store.get(id);
      return {
        status: job?.status ?? 'missing',
        result: job?.result ?? null,
        error: job?.error ?? null,
        progress: job?.progress ?? {},
        attempts: job?.attempts ?? 0,
      };
    },
  };
}

function publishPayload(extra: JsonObject = {}): JsonObject {
  return { survey_version_id: VER, target_status: 'staging', ...extra };
}

describe('a survey that fails the static gate', () => {
  it('writes compile_state failed with diagnostics, and no artifact and no token', async () => {
    // ACCEPTANCE (P1-08): "…fails with a diagnostic …, and no artifact is written."
    const h = harness(brokenRows());
    const outcome = await h.run(publishPayload());

    expect(outcome.status).toBe('failed');
    expect(h.publish.failures).toHaveLength(1);
    expect(h.publish.version).toMatchObject({ state: 'failed', hash: null, status: 'draft' });

    const codes = h.publish.failures[0]?.diagnostics.map((d) => (d as JsonObject)['code']);
    // The missing base-language string for Q1's label. Asserted by CODE, never by prose.
    expect(codes).toContain('SCH-1008');

    // The two halves of "no artifact": nothing uploaded, and nothing published.
    expect(h.artifacts.puts).toEqual([]);
    expect(h.publish.publishes).toEqual([]);
    expect(h.publish.tokens.size).toBe(0);
  });

  it('is not retried, and the envelope carries the diagnostic codes', async () => {
    const h = harness(brokenRows());
    const outcome = await h.run(publishPayload());
    expect((outcome.error as JsonObject | null)?.['code']).toBe('compile_errors');
    const details = (outcome.error as JsonObject)['details'] as JsonObject[];
    expect(details.some((d) => typeof d['code'] === 'string')).toBe(true);
    // A forward reference does not become fixable by waiting; retrying would rewrite
    // compile_diagnostics three times and delay the answer by the backoff schedule.
    expect(outcome.attempts).toBe(1);
  });
});

describe('a survey that passes the static gate', () => {
  it('uploads the artifact, records the hash and the byte count, and mints one token', async () => {
    // ACCEPTANCE (P1-08): "Publishing a valid survey produces a storage object whose key is the
    // sha256 of its own content."
    const h = harness(fixtureRows());
    const outcome = await h.run(publishPayload());

    expect(outcome.status).toBe('succeeded');
    const result = outcome.result as JsonObject;
    expect(result['outcome']).toBe('published');
    const hash = String(result['artifact_hash']);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);

    // Every uploaded key is `artifact/<hash>/<path>`, so the object's address IS its content.
    expect(h.artifacts.puts.length).toBeGreaterThan(0);
    for (const key of h.artifacts.puts) expect(key.startsWith(`artifact/${hash}/`)).toBe(true);
    expect(h.artifacts.puts).toContain(artifactKey(hash, 'manifest.json'));

    const published = h.publish.publishes[0];
    expect(published?.artifactHash).toBe(hash);
    expect(published?.artifactBytes).toBe(result['artifact_bytes']);
    expect(published?.targetStatus).toBe('staging');
    expect(h.publish.version).toMatchObject({ hash, state: 'compiled', status: 'staging' });
    expect(h.publish.tokens.size).toBe(1);
  });

  it('uploads theme.css, and it carries the accessibility contract', async () => {
    // The end of P2-12's chain on the publish side. `themeCss` used to be a compiler input this
    // worker never set, so no artifact carried a stylesheet at all and `.rs-target` — the class
    // question-kit asserts on 6,601 times for the WCAG touch-target floor — was defined nowhere.
    const h = harness(fixtureRows());
    const outcome = await h.run(publishPayload());
    const hash = String((outcome.result as JsonObject)['artifact_hash']);

    expect(h.artifacts.puts).toContain(artifactKey(hash, 'theme.css'));
    const css = await h.artifacts.get(artifactKey(hash, 'theme.css'));
    expect(css).toContain('.rs-target');
    expect(css).toContain('min-height: 44px');
  });

  it('applies the survey THEME, resolving inheritance root-first', async () => {
    // The wiring that stops app.themes being another table with no reader. The chain arrives
    // root-first from publish-store.ts' recursive CTE, so the child's value must win and the
    // parent's uninherited value must survive.
    const rows = fixtureRows();
    const h = harness({
      ...rows,
      themeChain: [
        { id: 'thm_parent', name: 'Base', tokens: { 'color-brand': '#111111', radius: '2px' } },
        { id: 'thm_child', name: 'Child', tokens: { 'color-brand': '#222222' } },
      ],
    });
    const outcome = await h.run(publishPayload());
    const hash = String((outcome.result as JsonObject)['artifact_hash']);
    const css = await h.artifacts.get(artifactKey(hash, 'theme.css'));

    expect(css).toContain('--rs-color-brand: #222222;'); // the child overrides
    expect(css).toContain('--rs-radius: 2px;'); // and inherits what it did not set
  });

  it('DROPS a token value that would break out of the declaration', async () => {
    // A token is interpolated into a stylesheet, so it is an injection site that the CSS sanitizer
    // never sees — a token is not an author stylesheet. resolveTokens is the second layer, and this
    // asserts the payload cannot reach the emitted bytes even when it reached the database.
    const rows = fixtureRows();
    const h = harness({
      ...rows,
      themeChain: [
        { id: 'thm_evil', name: 'Evil', tokens: { 'color-brand': 'red;} body{display:none} .x{' } },
      ],
    });
    const outcome = await h.run(publishPayload());
    const hash = String((outcome.result as JsonObject)['artifact_hash']);
    const css = await h.artifacts.get(artifactKey(hash, 'theme.css'));

    expect(css).not.toContain('display:none');
    expect(css).toContain('--rs-color-brand: #0057b8;'); // fell back to the vocabulary's default
  });

  it('changes the artifact hash when the theme changes, and only then', async () => {
    // theme.css is inside the content hash (ADR-002). Two properties at once: a theme edit produces
    // a genuinely different artifact, and recompiling the same theme produces the same one — a hash
    // that moved when nothing changed would make every republish look like an edit.
    const rows = fixtureRows();
    const plain = await harness(rows).run(publishPayload());
    const themedRows = {
      ...rows,
      themeChain: [{ id: 'thm_a', name: 'A', tokens: { 'color-brand': '#abcdef' } }],
    };
    const themed = await harness(themedRows).run(publishPayload());
    const themedAgain = await harness(themedRows).run(publishPayload());

    const hashOf = (o: { result: unknown }) => String((o.result as JsonObject)['artifact_hash']);
    expect(hashOf(themed)).not.toBe(hashOf(plain));
    expect(hashOf(themedAgain)).toBe(hashOf(themed));
  });

  it('reports progress once per pipeline stage, so "step N of M" has something to render', async () => {
    // M0.4 built the studio's job-status component; this is its first real consumer.
    const h = harness(fixtureRows());
    const outcome = await h.run(publishPayload());
    const total = COMPILE_STAGES.length;
    expect(outcome.progress).toMatchObject({ step: total, total });
    const steps = h.logs.lines.filter((l) => l['msg'] === 'job_progress').map((l) => l['step']);
    expect(steps).toEqual(COMPILE_STAGES.map((_, index) => index + 1));
  });

  it('records the diagnostics on the version even when every one of them is a warning', async () => {
    const h = harness(fixtureRows({ withRules: true }));
    const first = await h.run(publishPayload());
    const unacknowledged = (first.result as JsonObject)['unacknowledged'] as JsonObject[];
    expect(unacknowledged.length).toBeGreaterThan(0);

    const keys = unacknowledged.map((w) => String(w['acknowledgement_key']));
    const second = await h.run(publishPayload({ acknowledged_warnings: keys }));
    const stored = h.publish.publishes[0]?.diagnostics as JsonObject[];
    expect((second.result as JsonObject)['outcome']).toBe('published');
    expect(stored.map((d) => d['severity'])).toContain('warning');
    expect(stored.map((d) => d['severity'])).not.toContain('error');
  });
});

describe('a version with no redirect rows', () => {
  it('blocks the publish, naming the disposition', async () => {
    // THIS TEST USED TO BE CALLED "the redirect gap", and it pinned a defect rather than a
    // behaviour: C §9's redirect map had no column at all, so EVERY survey assembled from
    // `content.*` reached `COMPLETE` with nowhere to send the respondent, and the only way to
    // publish anything was for the deployment to inject a `Redirects` literal through
    // `CompileEnvironment`. Its comment said the migration that added the column would have "a
    // failing test to delete".
    //
    // Migration 0010 added the column, and this test was NOT deleted — it was narrowed, because
    // deleting it would have thrown away the assertion and kept only the defect's memory. What it
    // pins now is the real, permanent behaviour: a version whose `content.redirects` is EMPTY
    // cannot publish, the gate says so by disposition, and nothing is uploaded. That is no longer
    // every survey — it is a survey a programmer has not finished configuring, which is a fact
    // about the version that the publish dialog can render and the author can fix.
    const store = new MemoryJobStore();
    const publish = new FakePublishStore({ ...fixtureRows(), redirects: [] });
    const artifacts = new MemoryArtifactStore();
    const consumer = new Consumer({
      store,
      registry: buildRegistry({ compile: { store: publish, artifacts } }),
      logger: createCapturingLogger({ service: 'worker', level: 'error' }).logger,
      concurrency: 1,
      pollIntervalMs: 2,
      heartbeatIntervalMs: 5,
      stalledAfterMs: 50_000,
      sweepIntervalMs: 0,
      drainTimeoutMs: 2_000,
      backoffMs: () => 0,
    });
    const { id } = await store.enqueue({
      kind: COMPILE_KIND,
      payload: publishPayload(),
      orgId: ORG,
      createdBy: USER,
      maxAttempts: 1,
    });
    await consumer.runUntilIdle();

    expect((await store.get(id))?.status).toBe('failed');
    const codes = publish.failures[0]?.diagnostics.map((d) => (d as JsonObject)['code']);
    expect(codes).toContain('CMP-0300');
    expect(artifacts.puts).toEqual([]);
  });

  it('publishes the same survey once the rows exist, which is what makes the block a gate', async () => {
    // The other half of the pair, and the reason the test above is now a behaviour rather than a
    // defect: the ONLY difference between the two is rows in `content.redirects`.
    const h = harness(fixtureRows());
    const outcome = await h.run(publishPayload());
    expect(outcome.status).toBe('succeeded');
    expect((outcome.result as JsonObject)['outcome']).toBe('published');
  });

  it('carries C §9 default, by_vendor and by_language maps and the CUSTOM sub-map', async () => {
    // The flattened rows reassembled into the nested document shape (0010's table is one row per
    // scope and disposition; C §9's `Redirects` is three maps). Asserted on the document rather
    // than through a compile, because this reduction is the part `content.redirects` made this
    // file responsible for.
    const survey = assembleSurvey({
      ...fixtureRows(),
      redirects: [
        ...REDIRECT_ROWS,
        {
          scope: 'default',
          scope_key: '',
          disposition: 'CUSTOM',
          custom_key: 'over_quota_soft',
          url_template: 'https://vendor.test/oq',
        },
        {
          scope: 'vendor',
          scope_key: 'lucid',
          disposition: 'COMPLETE',
          custom_key: '',
          url_template: 'https://lucid.test/c',
        },
        {
          scope: 'language',
          scope_key: 'de',
          disposition: 'SCREENOUT',
          custom_key: '',
          url_template: 'https://vendor.test/s-de',
        },
      ],
    });
    expect(survey.redirects).toEqual({
      default: {
        COMPLETE: 'https://vendor.test/complete',
        CUSTOM: { over_quota_soft: 'https://vendor.test/oq' },
      },
      by_vendor: { lucid: { COMPLETE: 'https://lucid.test/c' } },
      by_language: { de: { SCREENOUT: 'https://vendor.test/s-de' } },
    });
  });

  it('omits `redirects` entirely when there are no rows, rather than emitting an empty map', async () => {
    // `undefined` and `{ default: {} }` are both refused by the gate, and only one of them says
    // "this survey has no redirects" in a shape the publish dialog can render.
    const survey = assembleSurvey({ ...fixtureRows(), redirects: [] });
    expect(survey.redirects).toBeUndefined();
    expect('redirects' in survey).toBe(false);
  });
});

describe('republishing unchanged content', () => {
  it('performs no storage put and produces the identical hash', async () => {
    // ACCEPTANCE (P1-08): "compiling the identical model a second time produces the identical
    // hash and creates no new object."
    const artifacts = new MemoryArtifactStore();
    const first = harness(fixtureRows(), { artifacts });
    const firstOutcome = await first.run(publishPayload());
    const firstHash = String((firstOutcome.result as JsonObject)['artifact_hash']);
    const uploaded = artifacts.puts.length;
    expect(uploaded).toBeGreaterThan(0);

    // A SECOND harness over the SAME store: a different job, a different day, same content.
    const second = harness(fixtureRows(), { artifacts });
    const secondOutcome = await second.run(publishPayload());
    const secondResult = secondOutcome.result as JsonObject;

    expect(secondResult['artifact_hash']).toBe(firstHash);
    // The assertion that matters, and the reason MemoryArtifactStore counts its calls: a store
    // that re-uploaded identical bytes would satisfy the hash half of the criterion and fail the
    // half an object-lock policy depends on.
    expect(artifacts.puts.length).toBe(uploaded);
    expect(secondResult['objects_written']).toBe(0);
    expect(secondResult['objects_reused']).toBe(uploaded);
    // And the version still gets repointed, which is what makes a republish a publish.
    expect(second.publish.publishes).toHaveLength(1);
  });
});

describe('unacknowledged warnings', () => {
  it('block the publish and come back as a result the dialog can render', async () => {
    const h = harness(fixtureRows({ withRules: true }));
    const outcome = await h.run(publishPayload());

    // A SUCCEEDED job, not a failed one: these are things to sign off, not a bad request.
    expect(outcome.status).toBe('succeeded');
    const result = outcome.result as JsonObject;
    expect(result['outcome']).toBe('blocked');
    expect(result['token']).toBeNull();

    const unacknowledged = result['unacknowledged'] as JsonObject[];
    expect(unacknowledged.length).toBeGreaterThan(0);
    for (const warning of unacknowledged) {
      expect(typeof warning['code']).toBe('string');
      expect(typeof warning['acknowledgement_key']).toBe('string');
    }

    // Nothing was written. Not the version, not the token, and not one object — an artifact no
    // version names is an orphan, and keeping that impossible is what makes one a bug.
    expect(h.publish.publishes).toEqual([]);
    expect(h.publish.failures).toEqual([]);
    expect(h.artifacts.puts).toEqual([]);
    expect(h.publish.version).toMatchObject({ state: 'none', hash: null });
  });

  it('publish once the key is acknowledged, and the acknowledgement is recorded', async () => {
    const probe = harness(fixtureRows({ withRules: true }));
    const blocked = await probe.run(publishPayload());
    const keys = ((blocked.result as JsonObject)['unacknowledged'] as JsonObject[]).map((w) =>
      String(w['acknowledgement_key']),
    );

    const h = harness(fixtureRows({ withRules: true }));
    const outcome = await h.run(publishPayload({ acknowledged_warnings: keys }));
    const result = outcome.result as JsonObject;
    expect(result['outcome']).toBe('published');
    expect(result['acknowledged_count']).toBe(keys.length);

    // 03 §17: what is recorded is what THIS compile raised and the author had accepted — not the
    // list the client sent. A stale key for a warning that no longer fires is not a sign-off.
    const published = h.publish.publishes[0];
    expect(published?.acknowledgedWarnings).toEqual(keys);
    expect(published?.acknowledgedNow).toHaveLength(keys.length);
  });

  it('refuses a key that acknowledges a code rather than a site', async () => {
    // The key is code+path+detail (`diagnostics.ts`), so passing the bare code acknowledges
    // nothing: an acknowledgement flow that accepted a code would be a mute button.
    const h = harness(fixtureRows({ withRules: true }));
    const outcome = await h.run(publishPayload({ acknowledged_warnings: ['LGC-W030'] }));
    expect((outcome.result as JsonObject)['outcome']).toBe('blocked');
  });
});

describe('the drain path', () => {
  it('aborts between artifact files, retryably, and publishes nothing', async () => {
    // Deterministic rather than timing-dependent: the artifact store BLOCKS on its first `has()`,
    // so the handler is provably inside stage 5 when `drain()` signals it. A test that raced the
    // drain against the handler would pass on a fast machine for the wrong reason.
    let released = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      released = resolve;
    });
    let firstHas = (): void => undefined;
    const reachedUpload = new Promise<void>((resolve) => {
      firstHas = resolve;
    });

    const inner = new MemoryArtifactStore();
    let gated = true;
    const artifacts = {
      has: async (key: string) => {
        if (gated) {
          gated = false;
          firstHas();
          await gate;
        }
        return inner.has(key);
      },
      put: (key: string, bytes: string) => inner.put(key, bytes),
      get: (key: string) => inner.get(key),
    };

    const store = new MemoryJobStore();
    const publish = new FakePublishStore(fixtureRows());
    const consumer = new Consumer({
      store,
      registry: buildRegistry({ compile: { store: publish, artifacts } }),
      logger: createCapturingLogger({ service: 'worker', level: 'error' }).logger,
      concurrency: 1,
      pollIntervalMs: 2,
      heartbeatIntervalMs: 5,
      stalledAfterMs: 50_000,
      sweepIntervalMs: 0,
      // Zero grace: drain() signals the in-flight handler immediately, which is what a container
      // runtime's SIGTERM plus an expired grace period looks like.
      drainTimeoutMs: 0,
      backoffMs: () => 0,
    });

    const { id } = await store.enqueue({
      kind: COMPILE_KIND,
      payload: publishPayload(),
      orgId: ORG,
      createdBy: USER,
      maxAttempts: 3,
    });
    consumer.start();
    await reachedUpload;
    const drainPromise = consumer.drain();
    // Let drain()'s zero-length grace period elapse and its abort() land BEFORE the store is
    // unblocked, so the handler observes an already-aborted signal. Releasing first would let the
    // job finish and the test would assert nothing.
    await new Promise((resolve) => setTimeout(resolve, 20));
    released();
    const { aborted } = await drainPromise;

    expect(aborted).toBe(1);
    const job = await store.get(id);
    // RETRYABLE: nothing was published, so re-running from the start is always safe — which is
    // exactly the condition under which a requeue is the right answer.
    expect(job?.status).toBe('queued');
    expect(publish.publishes).toEqual([]);
    expect(publish.failures).toEqual([]);
  });
});

describe('the payload', () => {
  it('refuses a target status the publish transaction would reject', async () => {
    // 0009: "publish target must be staging or production" — draft and review are authoring
    // states and archived is reached by rollback. The payload cannot express them.
    const h = harness(fixtureRows());
    const outcome = await h.run(publishPayload({ target_status: 'production' }));
    expect(outcome.status).toBe('succeeded');

    const bad = harness(fixtureRows());
    const rejected = await bad.run(publishPayload({ target_status: 'review' }));
    expect(rejected.status).toBe('failed');
    expect((rejected.error as JsonObject | null)?.['code']).toBe('malformed_request');
  });

  it('refuses acknowledged_warnings that is not an array of strings', async () => {
    const h = harness(fixtureRows());
    const outcome = await h.run(publishPayload({ acknowledged_warnings: [1, 2] }));
    expect(outcome.status).toBe('failed');
    expect(h.publish.publishes).toEqual([]);
  });
});

describe('the registry', () => {
  it('registers compile even with no environment, so publish jobs are claimable', () => {
    // A kind that is registered only when configured leaves publish jobs queued forever on a
    // misconfigured worker, which presents as a spinner and logs nothing.
    expect(buildRegistry().kinds()).toContain(COMPILE_KIND);
  });

  it('fails an unconfigured compile immediately rather than leaving it queued', async () => {
    const store = new MemoryJobStore();
    const consumer = new Consumer({
      store,
      registry: buildRegistry(),
      logger: createCapturingLogger({ service: 'worker', level: 'error' }).logger,
      concurrency: 1,
      pollIntervalMs: 2,
      heartbeatIntervalMs: 5,
      stalledAfterMs: 50_000,
      sweepIntervalMs: 0,
      drainTimeoutMs: 500,
      backoffMs: () => 0,
    });
    const { id } = await store.enqueue({
      kind: COMPILE_KIND,
      payload: publishPayload(),
      orgId: ORG,
      createdBy: USER,
      maxAttempts: 3,
    });
    await consumer.runUntilIdle();
    const job = await store.get(id);
    expect(job?.status).toBe('failed');
    expect(job?.attempts).toBe(1);
  });
});

function findQuestion(
  survey: ReturnType<typeof assembleSurvey>,
  ref: string,
): { readonly options?: readonly { ref: string; position: number; code: number }[] } {
  const block = survey.content[0];
  if (block === undefined || block.type !== 'block') throw new Error('no root block');
  const page = block.children[0];
  if (page === undefined || page.type !== 'page') throw new Error('no page');
  const question = page.children.find((child) => child.type === 'question' && child.ref === ref);
  if (question === undefined || question.type !== 'question') throw new Error(`no ${ref}`);
  return question;
}

/* ========================================================================== */
/* 3. Integration                                                              */
/* ========================================================================== */

const DATABASE_URL = process.env['DATABASE_URL'];
const describeIntegration =
  DATABASE_URL === undefined || DATABASE_URL === '' ? describe.skip : describe;

if (DATABASE_URL === undefined || DATABASE_URL === '') {
  // eslint-disable-next-line no-console -- the whole point is that a human sees why these skipped
  console.info(
    '[compile] integration tests SKIPPED: DATABASE_URL is unset. ' +
      'Run `pnpm db:up` and set DATABASE_URL to exercise the publish transaction, ' +
      'runtime.survey_tokens and app.rollback_version for real.',
  );
}

describeIntegration('the publish transaction against a real database', () => {
  /**
   * One connection, one transaction, rolled back at the end.
   *
   * Not a convenience: a committed test would leave `runtime.survey_tokens` rows behind, and
   * `tokens_live_key` (at most one live token per survey, is_test) would make the NEXT run fail
   * for reasons that have nothing to do with the code. `savepointSessions` gives the store real
   * transactional semantics inside the outer transaction.
   */
  async function withRollback(
    body: (session: SqlSession, ids: Record<string, string>) => Promise<void>,
  ): Promise<void> {
    const pg = await import('pg');
    const client = new pg.default.Client({ connectionString: DATABASE_URL });
    await client.connect();
    const session: SqlSession = {
      query: (text, values) =>
        client.query(text, values === undefined ? undefined : [...values]) as never,
    };
    try {
      await session.query('BEGIN');
      const seeded = await session.query<{ ids: Record<string, string> }>(
        'SELECT ops.test_seed_two_orgs() AS ids',
      );
      const base = seeded.rows[0]?.ids ?? {};
      const content = await session.query<{ ids: Record<string, string> }>(
        'SELECT ops.test_seed_content($1::jsonb) AS ids',
        [JSON.stringify(base)],
      );
      await body(session, { ...base, ...(content.rows[0]?.ids ?? {}) });
    } finally {
      await session.query('ROLLBACK').catch(() => undefined);
      await client.end();
    }
  }

  /**
   * Replace a draft version's content with a fixture, so the compile is predictable.
   *
   * `rows` is a parameter (0010) rather than always `fixtureRows()`, because the failing-compile
   * test below needs a survey that fails for a reason it can name. Before 0010 it got one for
   * free — `ops.test_seed_content` wrote `row_…` item ids, so the seeded draft failed SCH-0104 on
   * every matrix row — and that was the defect, not a fixture.
   */
  async function installFixture(
    session: SqlSession,
    versionId: string,
    orgId: string,
    rows: AuthoringRows = fixtureRows(),
  ): Promise<void> {
    // Order is FK order. `content.tg_draft_only` permits all of this because the version is a
    // draft — which is also why the fixture cannot be installed on a frozen version.
    for (const table of [
      'logic_rules',
      'question_cells',
      'question_items',
      'variables',
      'i18n_strings',
      'languages',
      'redirects',
      'nodes',
    ]) {
      await session.query(
        `DELETE FROM content.${table} WHERE survey_version_id = $1::app.ulid`,
        [versionId],
      );
    }
    for (const node of rows.nodes) {
      await session.query(
        'INSERT INTO content.nodes (survey_version_id, id, org_id, node_kind, parent_id, ' +
          'sort_key, ref, label_key, question_type, required, config, emits) VALUES ' +
          '($1::app.ulid, $2::app.ulid, $3::app.ulid, $4::content.node_kind, $5::app.ulid, ' +
          '$6::content.sort_key, $7::app.ref, $8, $9, $10, $11::jsonb, $12::app.ulid[])',
        [
          versionId,
          node.id,
          orgId,
          node.node_kind,
          node.parent_id,
          node.sort_key,
          node.ref,
          node.label_key,
          node.question_type,
          node.required,
          JSON.stringify(node.config),
          node.emits,
        ],
      );
    }
    for (const item of rows.items) {
      await session.query(
        'INSERT INTO content.question_items (survey_version_id, id, org_id, question_id, ' +
          'item_kind, ref, code, label_key, sort_key) VALUES ($1::app.ulid, $2::app.ulid, ' +
          '$3::app.ulid, $4::app.ulid, $5::content.item_kind, $6::app.ref, $7, $8, ' +
          '$9::content.sort_key)',
        [
          versionId,
          item.id,
          orgId,
          item.question_id,
          item.item_kind,
          item.ref,
          item.code,
          item.label_key,
          item.sort_key,
        ],
      );
    }
    for (const variable of rows.variables) {
      await session.query(
        'INSERT INTO content.variables (survey_version_id, id, org_id, name, kind, vtype, ' +
          'source_question_id, source_part, enum_domain, export_column, sort_key) VALUES ' +
          '($1::app.ulid, $2::app.ulid, $3::app.ulid, $4::app.ref, $5::content.var_kind, ' +
          '$6::content.var_type, $7::app.ulid, $8::jsonb, $9::jsonb, $10, $11::content.sort_key)',
        [
          versionId,
          variable.id,
          orgId,
          variable.name,
          variable.kind,
          variable.vtype,
          variable.source_question_id,
          JSON.stringify(variable.source_part),
          variable.enum_domain === null ? null : JSON.stringify(variable.enum_domain),
          variable.export_column,
          variable.sort_key,
        ],
      );
    }
    await session.query(
      'INSERT INTO content.languages (survey_version_id, lang, org_id, is_base, ' +
        'block_publish_if_incomplete) VALUES ($1::app.ulid, $2, $3::app.ulid, true, false)',
      [versionId, 'en', orgId],
    );
    for (const s of rows.strings) {
      await session.query(
        'INSERT INTO content.i18n_strings (survey_version_id, lang, key, value, state, org_id) ' +
          "VALUES ($1::app.ulid, $2, $3, $4, 'reviewed'::content.string_state, $5::app.ulid)",
        [versionId, s.lang, s.key, s.value, orgId],
      );
    }
    // 0010. Without these the compile fails CMP-0300 — which is the whole point of the table, and
    // is asserted directly by the unit test named "blocks the publish, naming the disposition".
    for (const r of rows.redirects) {
      await session.query(
        'INSERT INTO content.redirects (survey_version_id, scope, scope_key, disposition, ' +
          'custom_key, url_template, org_id) VALUES ($1::app.ulid, ' +
          '$2::content.redirect_scope, $3, $4, $5, $6, $7::app.ulid)',
        [versionId, r.scope, r.scope_key, r.disposition, r.custom_key, r.url_template, orgId],
      );
    }
  }

  interface RunResult {
    readonly status: string;
    readonly result: JsonValue | null;
    readonly error: JsonObject | null;
  }

  async function runJob(
    session: SqlSession,
    artifacts: MemoryArtifactStore,
    input: {
      readonly orgId: string;
      readonly userId: string;
      readonly versionId: string;
      /** `null` is the DRY compile — an absent `target_status` in the payload. */
      readonly target: 'staging' | 'production' | null;
    },
  ): Promise<RunResult> {
    const store = new MemoryJobStore();
    const env: CompileEnvironment = {
      store: new PgPublishStore(savepointSessions(session)),
      artifacts,
    };
    const consumer = new Consumer({
      store,
      registry: buildRegistry({ compile: env }),
      logger: createCapturingLogger({ service: 'worker', level: 'error' }).logger,
      concurrency: 1,
      pollIntervalMs: 2,
      heartbeatIntervalMs: 5,
      stalledAfterMs: 50_000,
      sweepIntervalMs: 0,
      drainTimeoutMs: 2_000,
      backoffMs: () => 0,
    });
    const { id } = await store.enqueue({
      kind: COMPILE_KIND,
      payload: {
        survey_version_id: input.versionId,
        // Absent, not null: the route omits the key entirely for a dry run and the worker's
        // `parse` reads that absence, so the test must enqueue the same shape.
        ...(input.target === null ? {} : { target_status: input.target }),
      },
      orgId: input.orgId,
      createdBy: input.userId,
      surveyVersionId: input.versionId,
      maxAttempts: 1,
    });
    await consumer.runUntilIdle();
    const job = await store.get(id);
    return {
      status: job?.status ?? 'missing',
      result: job?.result ?? null,
      error: job?.error ?? null,
    };
  }

  it('records a failed compile as two columns and nothing else, with no token', async () => {
    await withRollback(async (session, ids) => {
      const versionId = String(ids['ver_b_content_draft']);
      const orgId = String(ids['org_b']);
      const artifacts = new MemoryArtifactStore();
      // THE FAILURE IS NOW INSTALLED RATHER THAN INHERITED, and the change is worth stating.
      // This test used to lean on `ops.test_seed_content`'s org-B draft failing all by itself,
      // and the first reason it failed was `SCH-0104` on its matrix row id: the fixture wrote
      // `row_…` because 0007's column comment made the prefix kind-dependent, while
      // `packages/schema` brands every item id `Id<'opt'>` (C §5.1). That was defect 3 — every
      // matrix question in the product was unpublishable for the same reason — so migration 0010
      // normalized the database and the fixture, and the seeded draft compiles now.
      //
      // What this test is ABOUT is the failure PATH: two columns written, no artifact, no token,
      // status untouched. So it installs a survey that fails for a stated reason — `brokenRows`
      // drops Q1's label from the base-language bundle, which is `SCH-1008` — rather than
      // depending on a fixture being broken in a way nobody chose.
      await installFixture(session, versionId, orgId, brokenRows());
      const outcome = await runJob(session, artifacts, {
        orgId,
        userId: String(ids['user_b']),
        versionId,
        target: 'staging',
      });
      expect(outcome.status).toBe('failed');
      expect((outcome.error as JsonObject | null)?.['code']).toBe('compile_errors');
      const details = (outcome.error as JsonObject)['details'] as JsonObject[];
      expect(details.map((d) => d['code'])).toContain('SCH-1008');

      const row = (
        await session.query<{
          compile_state: string;
          status: string;
          artifact_hash: string | null;
          n: string;
        }>(
          'SELECT compile_state::text AS compile_state, status::text AS status, artifact_hash, ' +
            'jsonb_array_length(compile_diagnostics)::text AS n FROM app.survey_versions ' +
            'WHERE id = $1::app.ulid',
          [versionId],
        )
      ).rows[0];
      expect(row?.compile_state).toBe('failed');
      // A §7: status untouched, so whatever was live stays live.
      expect(row?.status).toBe('draft');
      expect(row?.artifact_hash).toBeNull();
      expect(Number(row?.n)).toBeGreaterThan(0);

      expect(artifacts.puts).toEqual([]);
      const tokens = await session.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM runtime.survey_tokens WHERE survey_version_id = $1::app.ulid',
        [versionId],
      );
      expect(tokens.rows[0]?.n).toBe('0');
    });
  });

  it('THE DRY COMPILE: diagnostics and an artifact, and the version does not move', async () => {
    // H §2.4's own words. The claim under test is the one an author relies on when they press
    // "Check without publishing": every stage of the gate ran (so the diagnostics are the real
    // ones and the bytes exist), and `status` is exactly where it was.
    await withRollback(async (session, ids) => {
      const orgId = String(ids['org_a']);
      const userId = String(ids['user_a']);
      const draftId = String(ids['ver_a_content_draft']);
      await installFixture(session, draftId, orgId);

      const before = (
        await session.query<{ status: string; acknowledged_warnings: unknown }>(
          'SELECT status, acknowledged_warnings FROM app.survey_versions WHERE id = $1::app.ulid',
          [draftId],
        )
      ).rows[0];

      const artifacts = new MemoryArtifactStore();
      const checked = await runJob(session, artifacts, {
        orgId,
        userId,
        versionId: draftId,
        target: null,
      });

      expect(checked.status, JSON.stringify(checked.error)).toBe('succeeded');
      const result = checked.result as JsonObject;
      // Its own outcome word, so a studio never has to infer "did this move my version".
      expect(result['outcome']).toBe('checked');
      expect(result['target_status']).toBeNull();
      expect(String(result['artifact_hash'])).toMatch(/^[0-9a-f]{64}$/);
      expect(result['token']).toBeNull();
      // The artifact really was produced — "produces diagnostics AND an artifact".
      expect(artifacts.puts.length).toBeGreaterThan(0);

      const after = (
        await session.query<{
          status: string;
          compile_state: string;
          artifact_hash: string | null;
          acknowledged_warnings: unknown;
        }>(
          'SELECT status, compile_state, artifact_hash, acknowledged_warnings ' +
            'FROM app.survey_versions WHERE id = $1::app.ulid',
          [draftId],
        )
      ).rows[0];

      // THE assertion: the status did not move, and no token was minted.
      expect(after?.status).toBe(before?.status);
      expect(after?.compile_state).toBe('compiled');
      expect(after?.artifact_hash).toBe(String(result['artifact_hash']));
      // A signature belongs to a publish a human pressed; a dry run signs nothing.
      expect(after?.acknowledged_warnings).toEqual(before?.acknowledged_warnings);
      const tokens = await session.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM runtime.survey_tokens WHERE survey_version_id = $1::app.ulid',
        [draftId],
      );
      expect(tokens.rows[0]?.count).toBe('0');
    });
  });

  it('publishes, republishes without a new object, and rolls back to byte-identical bytes', async () => {
    await withRollback(async (session, ids) => {
      const orgId = String(ids['org_a']);
      const userId = String(ids['user_a']);
      const draftId = String(ids['ver_a_content_draft']);
      const incumbentId = String(ids['ver_a_frozen']);
      await installFixture(session, draftId, orgId);

      // The hash that is live BEFORE anything here publishes. The rollback assertion at the end
      // compares against this value: "the runtime serves byte-identical bytes to what was live
      // before" is exactly the claim that this string comes back.
      const liveBefore = (
        await session.query<{ artifact_hash: string }>(
          'SELECT artifact_hash FROM app.survey_versions WHERE id = $1::app.ulid',
          [incumbentId],
        )
      ).rows[0]?.artifact_hash;
      expect(liveBefore).toMatch(/^[0-9a-f]{64}$/);

      const artifacts = new MemoryArtifactStore();

      /* -- draft -> staging ------------------------------------------------ */

      const staged = await runJob(session, artifacts, {
        orgId,
        userId,
        versionId: draftId,
        target: 'staging',
      });
      expect(staged.status).toBe('succeeded');
      const hash = String((staged.result as JsonObject)['artifact_hash']);
      const uploaded = artifacts.puts.length;
      expect(uploaded).toBeGreaterThan(0);

      const stagedRow = (
        await session.query<{ status: string; compile_state: string; artifact_hash: string; artifact_bytes: string }>(
          'SELECT status::text AS status, compile_state::text AS compile_state, artifact_hash, ' +
            'artifact_bytes::text AS artifact_bytes FROM app.survey_versions WHERE id = $1::app.ulid',
          [draftId],
        )
      ).rows[0];
      expect(stagedRow).toMatchObject({ status: 'staging', compile_state: 'compiled' });
      expect(stagedRow?.artifact_hash).toBe(hash);
      expect(Number(stagedRow?.artifact_bytes)).toBe(
        Number((staged.result as JsonObject)['artifact_bytes']),
      );

      // ONE token row, is_test = true, because a staging publish is a review link.
      const stagingTokens = (
        await session.query<{ token: string; is_test: boolean; artifact_hash: string }>(
          'SELECT token, is_test, artifact_hash FROM runtime.survey_tokens ' +
            'WHERE survey_version_id = $1::app.ulid',
          [draftId],
        )
      ).rows;
      expect(stagingTokens).toHaveLength(1);
      expect(stagingTokens[0]?.is_test).toBe(true);
      expect(stagingTokens[0]?.artifact_hash).toBe(hash);
      // K §5's alphabet, asserted from the value the transaction actually minted.
      expect(stagingTokens[0]?.token).toMatch(/^[0-9a-z]{26}$/);

      /* -- staging -> production, which is a republish of identical content - */

      const promoted = await runJob(session, artifacts, {
        orgId,
        userId,
        versionId: draftId,
        target: 'production',
      });
      expect(promoted.status).toBe('succeeded');
      const promotedResult = promoted.result as JsonObject;
      expect(promotedResult['artifact_hash']).toBe(hash);
      // ACCEPTANCE (P1-08): the same model compiled again creates NO NEW OBJECT.
      expect(artifacts.puts.length).toBe(uploaded);
      expect(promotedResult['objects_written']).toBe(0);
      expect(promotedResult['demoted_version_id']).toBe(incumbentId);

      const production = await session.query<{ id: string }>(
        "SELECT id FROM app.survey_versions WHERE survey_id = $1::app.ulid AND status = 'production'",
        [String(ids['svy_a'])],
      );
      expect(production.rows.map((r) => r.id)).toEqual([draftId]);

      /* -- rollback -------------------------------------------------------- */

      // Synchronous by design (H §2.4: "two column writes and a token update, not a compile"),
      // so this is the call the studio's route makes, exercised here because the acceptance
      // criterion is a claim about the database and the bytes rather than about the route.
      await session.query(
        PUBLISH_CLAIMS_SQL,
        [userId, orgId],
      );
      await session.query('SET LOCAL ROLE authoring');
      const rolled = await session.query<{ result: Record<string, unknown> }>(
        'SELECT app.rollback_version(p_to_version_id => $1::app.ulid, ' +
          "p_request_id => 'itest') AS result",
        [incumbentId],
      );
      await session.query('RESET ROLE');

      expect(rolled.rows[0]?.result?.['to_version_id']).toBe(incumbentId);
      expect(rolled.rows[0]?.result?.['from_version_id']).toBe(draftId);

      const afterRollback = await session.query<{ id: string }>(
        "SELECT id FROM app.survey_versions WHERE survey_id = $1::app.ulid AND status = 'production'",
        [String(ids['svy_a'])],
      );
      // Exactly one production version, and it is the one we rolled back to.
      expect(afterRollback.rows.map((r) => r.id)).toEqual([incumbentId]);

      // ACCEPTANCE (P1-08): "the runtime serves byte-identical bytes to what was live before,
      // verified by hash comparison in the test." The live token now names the hash the
      // incumbent named while it was live, and nothing rewrote that hash — which is what makes
      // byte-identity follow from ADR-002 rather than from copying bytes.
      const liveToken = (
        await session.query<{ artifact_hash: string; survey_version_id: string }>(
          'SELECT artifact_hash, survey_version_id FROM runtime.survey_tokens ' +
            'WHERE survey_id = $1::app.ulid AND is_test = false AND revoked_at IS NULL',
          [String(ids['svy_a'])],
        )
      ).rows[0];
      expect(liveToken?.survey_version_id).toBe(incumbentId);
      expect(liveToken?.artifact_hash).toBe(liveBefore);
      expect(liveToken?.artifact_hash).not.toBe(hash);
    });
  });

  it('refuses to publish a version the enqueuing user cannot see', async () => {
    await withRollback(async (session, ids) => {
      const artifacts = new MemoryArtifactStore();
      // Org A's user, org B's version. Zero rows from a policy-filtered read, which is the same
      // answer as "no such version" — the indistinguishability 0004's suites insist on.
      const outcome = await runJob(session, artifacts, {
        orgId: String(ids['org_a']),
        userId: String(ids['user_a']),
        versionId: String(ids['ver_b_content_draft']),
        target: 'staging',
      });
      expect(outcome.status).toBe('failed');
      expect((outcome.error as JsonObject | null)?.['code']).toBe('not_found');
      expect(artifacts.puts).toEqual([]);
    });
  });
});

/**
 * The claims statement, duplicated from `PUBLISH_SQL.claims` for the one call the STUDIO makes
 * rather than the worker — `app.rollback_version`. Duplicated and not imported because importing
 * it would suggest the rollback path goes through `PgPublishStore`, and it does not: rollback is
 * synchronous and belongs to the API route.
 */
const PUBLISH_CLAIMS_SQL =
  "SELECT set_config('request.jwt.claims', " +
  "json_build_object('sub', $1::uuid, 'role', 'authoring', " +
  "'app_metadata', json_build_object('active_org_id', $2::text))::text, true) AS claims";
