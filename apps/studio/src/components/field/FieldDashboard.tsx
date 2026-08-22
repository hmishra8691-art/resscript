/**
 * The field dashboard (roadmap P1-12 Frontend: "Response counter and a simple field dashboard
 * (entries, completes, screenouts, dispositions)").
 *
 * Simple ON PURPOSE: one stat row and one disposition table, both rendering
 * `GET /versions/:id/field-stats` verbatim. Every number is server math — `entries`,
 * `completes` and `screenouts` are sums the route derives from the same grouping the table
 * shows, so the counter and the table cannot disagree — and the P4 dashboard (time series,
 * per-vendor splits, quota fill) is a different component against different functions, not a
 * growth ring on this one.
 *
 * The one control is the `is_test` toggle, OFF by default because that is the P1-11
 * acceptance line ("excluded from the default response count shown in studio") and the
 * server's own default — the checkbox asks for more, it never has to ask for less. The label
 * echoes `include_test` from the RESPONSE, not the checkbox state, so the numbers on screen
 * are always labeled as what the server actually counted.
 *
 * Dispositions render in K §2's registry order with the observed-only extras appended —
 * a stable order a fielding PM can scan daily, not an alphabetical shuffle.
 */

'use client';

import { useCallback, useEffect, useState } from 'react';
import { DISPOSITIONS } from '@resscript/schema';
import { ApiError, apiFetch } from '@/lib/api-client';
import type { FieldStatsView } from '@/lib/api-types';

export interface FieldDashboardProps {
  readonly versionId: string;
}

/** K §2's order first, anything the registry does not know (defensive) after. */
function orderedDispositions(byDisposition: Readonly<Record<string, number>>): readonly string[] {
  const known = (DISPOSITIONS as readonly string[]).filter((d) => byDisposition[d] !== undefined);
  const extras = Object.keys(byDisposition)
    .filter((d) => !(DISPOSITIONS as readonly string[]).includes(d))
    .sort();
  return [...known, ...extras];
}

export function FieldDashboard({ versionId }: FieldDashboardProps): React.JSX.Element {
  const [includeTest, setIncludeTest] = useState(false);
  const [stats, setStats] = useState<FieldStatsView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (withTest: boolean): Promise<void> => {
      try {
        const { data } = await apiFetch<FieldStatsView>(
          '/versions/' + versionId + '/field-stats' + (withTest ? '?include_test=true' : ''),
        );
        setStats(data);
        setError(null);
      } catch (err: unknown) {
        setStats(null);
        setError(
          err instanceof ApiError && err.status === 403
            ? 'field stats require the analyst role or higher'
            : err instanceof ApiError
              ? err.message
              : 'could not reach the studio API',
        );
      }
    },
    [versionId],
  );

  useEffect(() => {
    void load(includeTest);
  }, [versionId, includeTest, load]);

  if (error !== null) return <p role="alert">{error}</p>;
  if (stats === null) return <p className="rs-muted">Loading field stats…</p>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
      <div style={{ display: 'flex', gap: 16, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <Stat label="entries" value={stats.entries} testId="field-entries" />
        <Stat label="completes" value={stats.completes} testId="field-completes" />
        <Stat label="screenouts" value={stats.screenouts} testId="field-screenouts" />
        <label style={{ display: 'flex', gap: 4, alignItems: 'center', marginLeft: 'auto' }}>
          <input
            type="checkbox"
            data-testid="field-include-test"
            checked={includeTest}
            onChange={(event) => {
              setIncludeTest(event.target.checked);
            }}
          />
          include test sessions
        </label>
        <button
          type="button"
          className="rs-button"
          onClick={() => {
            void load(includeTest);
          }}
        >
          Refresh
        </button>
      </div>

      {/* Labeled from the RESPONSE: the numbers above are what the server says it counted. */}
      <p className="rs-muted" data-testid="field-scope">
        {stats.include_test
          ? 'Counting production AND test sessions.'
          : 'Test sessions are excluded — the studio default.'}
      </p>

      {stats.entries === 0 ? (
        <p className="rs-muted">No sessions yet for this version.</p>
      ) : (
        <table className="rs-table" data-testid="field-dispositions">
          <thead>
            <tr>
              <th>Disposition</th>
              <th>Sessions</th>
            </tr>
          </thead>
          <tbody>
            {orderedDispositions(stats.by_disposition).map((disposition) => (
              <tr key={disposition}>
                <td>{disposition}</td>
                <td>{stats.by_disposition[disposition]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  testId,
}: {
  readonly label: string;
  readonly value: number;
  readonly testId: string;
}): React.JSX.Element {
  return (
    <span data-testid={testId}>
      <strong style={{ fontSize: 16 }}>{value}</strong> <span className="rs-muted">{label}</span>
    </span>
  );
}
