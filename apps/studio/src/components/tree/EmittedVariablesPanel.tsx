/**
 * "Variables this question emits" — the panel that makes the export contract visible while the
 * question is being authored (roadmap P1-03 Frontend).
 *
 * The rows come from the SERVER, never from calling `declareVariables` in the browser. The
 * temptation is obvious — the plugin is right there, the function is pure — and it is the wrong
 * call: `content.variables` is written by the API on save (P1-03 backend: "variable recomputation
 * on question save, writing `nodes.emits`"), the compiled manifest is what an export actually
 * reads (ADR-002/ADR-007), and a client-side recomputation would be a SECOND opinion about the
 * column layout. When the two disagree, the panel is the one that lies, and the author finds out
 * from a client's tracker.
 *
 * So the panel renders what the node body and the write receipts (`variables_created`,
 * `variables_changed`) say, and it shows the export column rather than only the variable name,
 * because the column is the thing that ships. `pii` is called out as a word, not a colour
 * (UI §11), since it changes behaviour in six places (security §8.1).
 */

'use client';

import type { EmittedVariable } from './wire';

export interface EmittedVariablesPanelProps {
  readonly variables: readonly EmittedVariable[];
  /** Names from the last write's receipt, highlighted as "just created". */
  readonly recentlyCreated?: readonly string[];
}

export function EmittedVariablesPanel({
  variables,
  recentlyCreated = [],
}: EmittedVariablesPanelProps): React.JSX.Element {
  return (
    <section aria-label="Variables this question emits" data-testid="emits-panel">
      <h3 style={{ fontSize: 13 }}>Variables this question emits ({variables.length})</h3>
      {variables.length === 0 ? (
        <p className="rs-muted">
          None yet. The server writes these when the question is saved — they are the export
          columns, so an empty list here means an empty column set there.
        </p>
      ) : (
        <table className="rs-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Kind</th>
              <th>Type</th>
              <th>Export column</th>
              <th>PII</th>
            </tr>
          </thead>
          <tbody>
            {variables.map((variable) => (
              <tr key={variable.name} data-testid={'emits-row-' + variable.name}>
                <td>
                  {variable.name}
                  {recentlyCreated.includes(variable.name) ? (
                    <span className="rs-chip" title="created by your last save">
                      new
                    </span>
                  ) : null}
                </td>
                <td>{variable.kind}</td>
                <td>{variable.vtype}</td>
                <td>{variable.exportColumn ?? <span className="rs-muted">not exported</span>}</td>
                <td>{variable.pii ? <span className="rs-chip">PII</span> : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
