/**
 * The export dialog (roadmap P1-12 Frontend: "Export dialog").
 *
 * ## Honest defaults, not enforcement
 *
 * Both checkboxes start FALSE — the same defaults `app.exports`' columns carry: PII off
 * (security §7.2) and test rows out (E §14.1, the P1-11 acceptance default shared with the
 * field dashboard). The PII checkbox is only RENDERED for a viewer whose role clears the
 * analyst floor — below it the whole dialog is a disabled Start with the reason, and offering
 * a PII toggle to someone who cannot export at all is noise. What this component must never
 * pretend to do is enforce the PII rule: the capability check is 0012's
 * `app.tg_exports_pii_guard` running IN the database on the INSERT (capability, never rank —
 * K §1), and a role-based render decision here is a courtesy, not a gate. A capable-looking
 * caller without the grant gets the trigger's 403, rendered inline next to the box that
 * caused it — who to ask, not a dead click.
 *
 * ## The history is the export's lifecycle, not the job's
 *
 * The list below the form renders `app.exports` rows (status, row_count, where it landed):
 * the row outlives the job that produced it, and 0012's enum comment draws exactly this line
 * ("retry mechanics live on the job, the export row records only the outcome"). While any row
 * is pending/running the list polls; it stops when everything is terminal, so a finished
 * history is not polled forever by a tab someone left open (the same rule as `useJob`).
 *
 * Like `PreviewPanel`, this pane owns its fetching; `role` arrives as a prop from the page,
 * which reads it off the org membership the same way `PublishDialog`'s container does.
 */

'use client';

import { useCallback, useEffect, useState } from 'react';
import type { OrgRole } from '@resscript/schema';
import { meetsRole } from '@/server/auth';
import { ApiError, apiFetch, newIdempotencyKey } from '@/lib/api-client';
import type { ExportView } from '@/lib/api-types';

export interface ExportDialogProps {
  readonly versionId: string;
  /** The viewer's role in the active org, as the membership row states it. */
  readonly role: OrgRole | null;
}

const POLL_MS = 2000;

export function ExportDialog({ versionId, role }: ExportDialogProps): React.JSX.Element {
  const [piiIncluded, setPiiIncluded] = useState(false);
  const [includeTest, setIncludeTest] = useState(false);
  const [exports, setExports] = useState<readonly ExportView[] | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The analyst floor gates the whole surface (`exports_insert`/`exports_select`, security
  // §7.1). PII is a CAPABILITY on top of it — see the header for why that is not checked here.
  const canExport = meetsRole(role, 'analyst');

  const load = useCallback(async (): Promise<void> => {
    try {
      const { data } = await apiFetch<{ exports: readonly ExportView[] }>(
        '/versions/' + versionId + '/exports',
      );
      setExports(data.exports);
    } catch (err: unknown) {
      // Below the floor the list legitimately 403s; the disabled form already explains why.
      if (!(err instanceof ApiError && err.status === 403)) {
        setError(err instanceof ApiError ? err.message : 'could not reach the studio API');
      }
      setExports([]);
    }
  }, [versionId]);

  useEffect(() => {
    setExports(null);
    setError(null);
    void load();
  }, [versionId, load]);

  // Poll only while something is actually moving — same stop rule as `useJob`.
  const active = exports?.some((e) => e.status === 'pending' || e.status === 'running') ?? false;
  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => {
      void load();
    }, POLL_MS);
    return (): void => {
      clearInterval(timer);
    };
  }, [active, load]);

  const start = async (): Promise<void> => {
    setPending(true);
    setError(null);
    try {
      await apiFetch('/versions/' + versionId + '/exports', {
        method: 'POST',
        body: { pii_included: piiIncluded, include_test: includeTest },
        // A retried request the client never saw the answer to must not be a second file.
        idempotencyKey: newIdempotencyKey(),
      });
      await load();
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : 'could not reach the studio API');
    } finally {
      setPending(false);
    }
  };

  return (
    <section aria-label="Export responses" data-testid="export-dialog">
      <div style={{ display: 'flex', gap: 12, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <input
            type="checkbox"
            data-testid="export-include-test"
            checked={includeTest}
            disabled={!canExport || pending}
            onChange={(event) => {
              setIncludeTest(event.target.checked);
            }}
          />
          include test responses
        </label>
        {/* Rendered only at the analyst floor — see the header. The grant itself is the
            database's question, answered on Start. */}
        {canExport ? (
          <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <input
              type="checkbox"
              data-testid="export-pii"
              checked={piiIncluded}
              disabled={pending}
              onChange={(event) => {
                setPiiIncluded(event.target.checked);
              }}
            />
            include PII values <span className="rs-muted">(requires a pii_access grant)</span>
          </label>
        ) : null}
        <button
          type="button"
          className="rs-button"
          data-variant="primary"
          data-testid="export-start"
          disabled={!canExport || pending}
          onClick={() => {
            void start();
          }}
        >
          {pending ? 'Starting…' : 'Start export'}
        </button>
        {/* Never hidden, always explained (F §7). */}
        {canExport ? null : (
          <span className="rs-muted" data-testid="export-floor-reason">
            exporting requires the analyst role or higher
            {role === null ? '' : ' (you are ' + role + ')'}
          </span>
        )}
      </div>

      {error === null ? null : (
        <p role="alert" data-testid="export-error">
          {error}
        </p>
      )}

      {exports === null ? (
        <p className="rs-muted">Loading export history…</p>
      ) : exports.length === 0 ? (
        <p className="rs-muted">No exports of this version yet.</p>
      ) : (
        <table className="rs-table" data-testid="export-history" style={{ marginTop: 8 }}>
          <thead>
            <tr>
              <th>Requested</th>
              <th>Status</th>
              <th>Rows</th>
              <th>PII</th>
              <th>Test rows</th>
              <th>File</th>
            </tr>
          </thead>
          <tbody>
            {exports.map((row) => (
              <tr key={row.id}>
                <td>{row.created_at}</td>
                <td>
                  {row.status}
                  {row.status === 'failed' && row.error != null ? (
                    <span className="rs-muted"> — {String((row.error as { message?: string }).message ?? '')}</span>
                  ) : null}
                </td>
                <td>{row.row_count ?? <span className="rs-muted">—</span>}</td>
                {/* Stated, never inferred: this cell is the audit answer 0012 stores. */}
                <td>{row.pii_included ? 'included' : 'no'}</td>
                <td>{row.include_test ? 'included' : 'no'}</td>
                <td>
                  {row.storage_key === null ? (
                    <span className="rs-muted">—</span>
                  ) : (
                    // A key into the worker's export store; the signed download URL is P5-02.
                    <code>{row.storage_key}</code>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
