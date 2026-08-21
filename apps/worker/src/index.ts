/**
 * `@resscript/worker` — the background job harness (ADR-001: neither control plane nor data
 * plane; it does the slow work both defer, arch §3.2 publish and §3.4 export).
 *
 * This barrel exists so `apps/studio`'s API routes can import the ENQUEUE half (the registry's
 * job kinds, `withCorrelation`, `PgJobStore`) without importing the consumer loop. Publish is a
 * job, not a request (arch §3.2), so the studio needs `enqueue`; it must never start a consumer.
 */

export {
  Consumer,
  CORRELATION_KEYS,
  createConsumer,
  withCorrelation,
  type ConsumerOptions,
  type ConsumerStats,
} from './consumer.js';

export {
  createHealthHandler,
  createHealthServer,
  readiness,
  type HealthServer,
  type HealthServerOptions,
  type ReadinessReport,
} from './health.js';

export {
  defaultBackoffMs,
  isJobStatus,
  JOB_STATUSES,
  makeProgress,
  type EnqueueInput,
  type EnqueueResult,
  type FailOutcome,
  type JobErrorRecord,
  type JobProgress,
  type JobRow,
  type JobStatus,
  type JobStore,
} from './job-store.js';

export { asJsonObject, isJsonObject, jsonEquals, type JsonObject, type JsonValue } from './json.js';

export { MemoryJobStore, type MemoryJobStoreOptions } from './memory-job-store.js';

export { mapJobRow, PgJobStore, SQL, type SqlClient } from './pg-job-store.js';

export {
  defineJob,
  JobRegistry,
  payload,
  type ErasedJobDefinition,
  type JobContext,
  type JobDefinition,
  type JobHandler,
  type PayloadMap,
} from './registry.js';

export { NOOP_KIND, noopJob, type NoopPayload, type NoopResult } from './kinds/noop.js';

export {
  ARTIFACT_KEY_PREFIX,
  FsArtifactStore,
  MemoryArtifactStore,
  SupabaseArtifactStore,
  artifactKey,
  sha256Of,
  type ArtifactStore,
  type StorageBucketLike,
} from './artifact-store.js';

export {
  DEFAULT_SURVEY_SETTINGS,
  SYNTHETIC_END_ID,
  SYNTHETIC_START_ID,
  assembleSurvey,
  sequenceFlowNodeId,
  type AuthoringCellRow,
  type AuthoringItemRow,
  type AuthoringLanguageRow,
  type AuthoringNodeRow,
  type AuthoringRedirectRow,
  type AuthoringRows,
  type AuthoringRuleRow,
  type AuthoringStringRow,
  type AuthoringSurveyRow,
  type AuthoringVariableRow,
  type AuthoringVersionRow,
} from './authoring-model.js';

export {
  PUBLISH_SQL,
  PgPublishStore,
  poolSessions,
  savepointSessions,
  type JobIdentity,
  type PoolLike,
  type PublishOutcome,
  type PublishRequest,
  type PublishStore,
  type SessionFactory,
  type SqlSession,
} from './publish-store.js';

export {
  COMPILE_KIND,
  COMPILE_STAGES,
  compileJob,
  unconfiguredCompileEnvironment,
  type CompileEnvironment,
  type CompileJobResult,
  type CompilePayload,
  type CompileWarningRecord,
  type PublishTarget,
} from './kinds/compile.js';

export { buildRegistry, type WorkerDependencies, type WorkerPayloads } from './kinds/registry.js';
