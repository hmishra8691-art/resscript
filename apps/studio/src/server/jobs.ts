/**
 * The job resource, projected once.
 *
 * `GET /api/v1/jobs/:id` and the `202` bodies of every job-creating endpoint return the SAME
 * shape (API §4's job resource), and the studio's `JobStatus` component renders "step N of M" off
 * `progress`'s exact keys. One projection, so a new job-creating route cannot answer with a
 * near-miss that the component silently fails to render.
 *
 * `COMPILE_JOB_KIND` is the string and not an import. `apps/worker` owns the kind registry and
 * exports `COMPILE_KIND`, but `.dependency-cruiser.cjs` forbids app-to-app imports — the same rule
 * that made `JobProgressShape` a restatement in `repo/types.ts` rather than an import of
 * `apps/worker`'s `JobProgress`. What crosses the boundary here is a value of `ops.jobs.kind`,
 * whose format CHECK (`jobs_kind_fmt`) is the only contract the database has on it; migration 0003
 * made it free text precisely because "job kinds are an implementation detail of apps/worker".
 * If this ever needs to be shared it belongs in `@resscript/schema`, not in an app.
 */

import type { JobRow } from './repo/types.js';

/** `apps/worker`'s `COMPILE_KIND`. See the header for why it is a literal. */
export const COMPILE_JOB_KIND = 'compile';

/** `apps/worker`'s `EXPORT_KIND` (kinds/export.ts). A literal for the same reason. */
export const EXPORT_JOB_KIND = 'export';

export interface JobEnvelope {
  readonly id: string;
  readonly kind: string;
  readonly status: JobRow['status'];
  readonly progress: JobRow['progress'];
  readonly result: JobRow['result'];
  readonly error: JobRow['error'];
  readonly attempts: number;
  readonly max_attempts: number;
  readonly org_id: string | null;
  readonly project_id: string | null;
  readonly survey_version_id: string | null;
  readonly created_by: string | null;
  readonly created_at: string;
  readonly started_at: string | null;
  readonly finished_at: string | null;
  readonly heartbeat_at: string | null;
  readonly links: { readonly self: string };
}

export function jobEnvelope(job: JobRow): JobEnvelope {
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    // `{step, total, message, updated_at}` — `apps/worker`'s `JobProgress`, unrenamed. A handler
    // that renamed them to `{done, outOf}` would be a component that renders nothing.
    progress: job.progress,
    result: job.result,
    error: job.error,
    attempts: job.attempts,
    max_attempts: job.max_attempts,
    org_id: job.org_id,
    project_id: job.project_id,
    survey_version_id: job.survey_version_id,
    created_by: job.created_by,
    created_at: job.created_at,
    started_at: job.started_at,
    finished_at: job.finished_at,
    heartbeat_at: job.heartbeat_at,
    links: { self: '/api/v1/jobs/' + job.id },
  };
}

export function isTerminal(job: JobRow): boolean {
  return job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled';
}
