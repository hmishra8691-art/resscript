/**
 * `JobStatus` reads `{step, total, message}` — apps/worker's `JobProgress` keys, unrenamed.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { JobStatus } from '@/components/jobs/JobStatus';

afterEach(cleanup);

describe('JobStatus', () => {
  it('renders "step N of M" from the worker progress shape', () => {
    render(
      <JobStatus
        kind="publish"
        status="running"
        progress={{ step: 4, total: 7, message: 'compiling theme', updated_at: '2026-08-20T10:12:51Z' }}
      />,
    );
    expect(screen.getByText('step 4 of 7')).toBeDefined();
    expect(screen.getByText('compiling theme')).toBeDefined();
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '4');
    expect(bar).toHaveAttribute('aria-valuemax', '7');
    expect(bar).toHaveAttribute('aria-valuetext', 'step 4 of 7');
  });

  it('says "starting…" rather than "step 0 of 0" before the first heartbeat', () => {
    render(<JobStatus status="queued" progress={null} />);
    expect(screen.getByText('starting…')).toBeDefined();
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('always states the status in words, never colour alone', () => {
    render(<JobStatus status="failed" progress={null} />);
    expect(screen.getByTestId('job-status-label')).toHaveTextContent('failed');
  });
});
