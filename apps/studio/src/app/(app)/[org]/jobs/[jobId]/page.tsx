/**
 * Deep-linkable job progress — what a "publish failed" email links to (UI §2).
 *
 * Polls `GET /api/v1/jobs/:id` at API §4's 2 s interval and stops at a terminal status.
 */

'use client';

import { use } from 'react';
import { JobStatus } from '@/components/jobs/JobStatus';
import { useJob } from '@/lib/queries';

export default function JobPage({
  params,
}: {
  params: Promise<{ jobId: string }>;
}): React.JSX.Element {
  const { jobId } = use(params);
  const job = useJob(jobId);

  if (job.isLoading) return <p className="rs-muted">Loading job…</p>;
  if (job.isError || job.data === undefined) return <p role="alert">Job not found.</p>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 520 }}>
      <h1 style={{ fontSize: 16 }}>Job {job.data.id}</h1>
      <JobStatus status={job.data.status} progress={job.data.progress} kind={job.data.kind} />
      <p className="rs-muted">
        Attempt {job.data.attempts} of {job.data.max_attempts}
      </p>
    </div>
  );
}
