/**
 * "step N of M" — the job progress component.
 *
 * Reads `{step, total, message}` from `ops.jobs.progress`, which is `apps/worker`'s
 * `JobProgress` shape verbatim. That shape is fixed in the worker rather than left to each
 * handler for exactly this reason: a handler that invents `{done: 3, outOf: 7}` is a component
 * that renders nothing.
 *
 * A running job with no progress row yet renders "starting…" rather than "step 0 of 0", and a
 * stalled job (no heartbeat) is the worker supervisor's problem — `heartbeat_at` plus
 * `jobs_stalled_idx` turns a crashed worker into a visible `failed` job instead of a spinner
 * that never resolves, which is the support ticket that destroys trust.
 */

'use client';

import type { JobProgressView } from '@/lib/api-types';

export interface JobStatusProps {
  readonly status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  readonly progress: JobProgressView | null;
  readonly kind?: string;
}

export function JobStatus({ status, progress, kind }: JobStatusProps): React.JSX.Element {
  const terminal = status === 'succeeded' || status === 'failed' || status === 'cancelled';
  const pct =
    progress === null || progress.total <= 0
      ? null
      : Math.min(100, Math.round((progress.step / progress.total) * 100));

  return (
    <div className="rs-card" data-testid="job-status">
      <div style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
        {kind === undefined ? null : <strong>{kind}</strong>}
        {/* Colour is never the sole carrier of meaning: the status word is always present. */}
        <span data-testid="job-status-label">{status}</span>
        {progress === null ? (
          <span className="rs-muted">{terminal ? '' : 'starting…'}</span>
        ) : (
          <span>
            step {progress.step} of {progress.total}
          </span>
        )}
      </div>
      {progress === null ? null : (
        <>
          <div className="rs-muted">{progress.message}</div>
          <div
            role="progressbar"
            aria-label="Job progress"
            aria-valuemin={0}
            aria-valuemax={progress.total}
            aria-valuenow={progress.step}
            aria-valuetext={'step ' + String(progress.step) + ' of ' + String(progress.total)}
            style={{
              height: 4,
              marginTop: 4,
              background: 'var(--rs-surface-sunken)',
              borderRadius: 2,
            }}
          >
            <div
              style={{
                width: (pct ?? 0) + '%',
                height: '100%',
                background: 'var(--rs-accent)',
                borderRadius: 2,
              }}
            />
          </div>
        </>
      )}
    </div>
  );
}
