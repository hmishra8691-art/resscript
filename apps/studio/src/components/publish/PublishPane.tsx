/**
 * The publish container — the half `PublishDialog` deliberately does not have.
 *
 * The dialog's own header states the split: "Prop-driven, like every other control in
 * `components/`: the mutation, the polling and the invalidation belong to the container." Until
 * now there was no container, so P1-08's gate — the compiler's static analysis, the diagnostics
 * list, the warning acknowledgement — was reachable only through the API. The MVP journey spec
 * had to `test.fixme` the leg for exactly that reason; this file is what closes it.
 *
 * What a container is, here, and nothing more:
 *
 *  - READ the last compile's diagnostics (`GET /versions/:id/diagnostics`) and the version row
 *    (status, compile_state, acknowledged_warnings) — the four inputs the dialog refuses on.
 *  - POST the publish and hold the returned job id, polling it through `useJob` (the M0.4 widget
 *    the worker was built against; a second progress shape would be a second thing for the
 *    worker to satisfy).
 *  - INVALIDATE the version and its diagnostics when the job reaches a terminal state, because a
 *    succeeded publish changes `status`, `artifact_hash` and `compile_state`, and a stale row is
 *    how the editor stays writable on a frozen version.
 *
 * It decides nothing. Severity, acknowledgement identity, the role floor and legal transitions
 * are all the dialog's imports (and the route's, and `tg_version_guard`'s) — a container that
 * re-decided any of them would be a fourth opinion.
 *
 * A DRY COMPILE FIRST is offered separately (`POST /versions/:id/compile`): P1-08's own
 * distinction — "Dry compile: produces diagnostics and an artifact but does not change status".
 * Without it the only way to see a diagnostic is to attempt a publish, which trains authors to
 * treat a refused publish as the normal way to check their work.
 */

'use client';

import { useCallback, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { OrgRole } from '@resscript/schema';
import type { CompileDiagnostic } from '@resscript/compiler/diagnostics';
import { ApiError, apiFetch, newIdempotencyKey } from '@/lib/api-client';
import { queryKeys, useJob } from '@/lib/queries';
import { PublishDialog, type PublishRequest } from '@/components/publish/PublishDialog';
import type { DiagnosticsView } from '@/lib/api-types';

export interface PublishPaneProps {
  readonly versionId: string;
  /**
   * The survey whose version this is — the invalidation target. There is no `queryKeys.version`:
   * the version rows every other surface reads come from `GET /surveys/:id` (`SurveyDetailView`
   * carries them), so a publish invalidates the SURVEY key. Passing the id rather than deriving
   * it keeps this component from needing a second read to learn what it was already told.
   */
  readonly surveyId: string;
  /** The viewer's role in the active org, as the membership row states it. */
  readonly role: OrgRole | null;
  /** For the heading; the diagnostics envelope is about a compile and carries no version_no. */
  readonly versionNo?: number;
}

export function PublishPane({
  versionId,
  surveyId,
  role,
  versionNo: versionNoProp,
}: PublishPaneProps): React.JSX.Element {
  const queryClient = useQueryClient();
  // ONE read, not two: `GET /versions/:id/diagnostics` already carries the version's status,
  // compile_state, revision and acknowledged_warnings alongside the diagnostics — its own type
  // comment calls itself "a shape the gate owns". Fetching the version row separately would be
  // two reads that can disagree about which compile the diagnostics belong to.
  const [state, setState] = useState<DiagnosticsView | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const job = useJob(jobId);

  const load = useCallback(async (): Promise<void> => {
    try {
      const { data } = await apiFetch<DiagnosticsView>('/versions/' + versionId + '/diagnostics');
      setState(data);
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : 'could not reach the studio API');
    }
  }, [versionId]);

  useEffect(() => {
    setState(null);
    setJobId(null);
    setError(undefined);
    void load();
  }, [versionId, load]);

  // A terminal job means the version row moved (or did not, and the diagnostics say why).
  // Re-read both, and drop the caches every other surface reads the version through.
  const jobStatus = job.data?.status;
  useEffect(() => {
    if (jobStatus !== 'succeeded' && jobStatus !== 'failed' && jobStatus !== 'cancelled') return;
    void load();
    void queryClient.invalidateQueries({ queryKey: queryKeys.survey(surveyId) });
  }, [jobStatus, load, queryClient, surveyId]);

  const send = async (path: string, body?: PublishRequest): Promise<void> => {
    setPending(true);
    setError(undefined);
    try {
      const { data } = await apiFetch<{ job: { id: string } }>(path, {
        method: 'POST',
        ...(body === undefined ? {} : { body }),
        // A retried publish the client never saw the answer to must not be a second compile.
        idempotencyKey: newIdempotencyKey(),
      });
      setJobId(data.job.id);
    } catch (err: unknown) {
      // A 422 carrying compile errors is the gate working; render it where the author is
      // looking rather than as a toast that scrolls away.
      setError(err instanceof ApiError ? err.message : 'could not reach the studio API');
      await load();
    } finally {
      setPending(false);
    }
  };

  if (state === null) {
    return (
      <section aria-label="Publish" data-testid="publish-pane">
        <p className="rs-muted">{error ?? 'loading…'}</p>
      </section>
    );
  }

  return (
    <section aria-label="Publish" data-testid="publish-pane">
      <PublishDialog
        versionId={versionId}
        // The diagnostics envelope carries no version_no (it is about a compile, not a row);
        // the dialog uses it for the heading only, and the caller passes it when it has it.
        versionNo={versionNoProp ?? 0}
        status={state.status}
        compileState={state.compile_state}
        diagnostics={state.diagnostics}
        role={role}
        recordedAcknowledgements={state.acknowledged_warnings}
        job={job.data ?? null}
        pending={pending}
        error={error}
        onPublish={(request) => {
          void send('/versions/' + versionId + '/publish', request);
        }}
      />
      <p style={{ marginTop: 8 }}>
        <button
          type="button"
          className="rs-btn"
          data-testid="publish-dry-compile"
          disabled={pending}
          onClick={() => {
            void send('/versions/' + versionId + '/compile');
          }}
        >
          Check without publishing
        </button>{' '}
        <span className="rs-muted">
          Runs the same gate and reports the same diagnostics; the version does not move.
        </span>
      </p>
    </section>
  );
}
