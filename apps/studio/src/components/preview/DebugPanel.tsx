/**
 * The debug panel (P1-11, E §14, UI §8).
 *
 * ## Where the data comes from — honestly
 *
 * The trace does NOT arrive over postMessage: the client bundle does not forward
 * `preview:trace` yet, and the iframe is cross-origin by design. What actually carries the
 * E §14.2 trace today is the `debug` field of the runtime's JSON responses for `is_test`
 * sessions — so this panel drives a PARALLEL test session over
 * `POST /versions/:id/debug-session`, a thin studio-side proxy that holds the `pt` token
 * server-side (the runtime sets no CORS headers, and the token must not reach the browser).
 * The iframe next door stays the eyeball surface; this is the instrument.
 *
 * ## What renders, and from which authority
 *
 *  - **Rule verdicts per cell** — `debug.trace`, verbatim: cell key, result, and each writer's
 *    `rule_id` + T/F/U verdict with collapse annotations. The trace deliberately carries rule
 *    ids and not pretty-printed source (`packages/logic/src/state.ts`: emitting a half-rendered
 *    source string would create a second, drifting printer), so that is what is shown.
 *  - **Randomization decisions** — `debug.orders`, keyed `<question id>.<axis>`, the exact map
 *    handed to the engine; plus the seed that produced them.
 *  - **Variable state** — reconstructed from what THIS panel drove into the session (submitted
 *    values and `setvars`), because the runtime's responses do not echo session vars back.
 *    PII variables (flags from `content.variables`, attached by the proxy on start) render as
 *    ●●●● — masked at the render, matching E's server-side redaction posture.
 *  - **Quota** — `debug.termination` and the final disposition. Phase 1 artifacts carry no
 *    quota plan (the runtime emits `quota.reserve_deferred`), so would_reserve/would_be_full
 *    render when the runtime starts sending them; the section says so instead of pretending.
 *  - **Page history** — the pages this session actually visited, in order.
 */

'use client';

import { useCallback, useState } from 'react';
import { ApiError, apiFetch } from '@/lib/api-client';
import type { DebugStepView, DebugTraceView, DebugVariableView } from '@/lib/api-types';

const SEED_SHAPE = /^[0-9a-f]{32}$/;

export interface DebugPanelProps {
  readonly versionId: string;
}

/** ●●●● for PII, decided by variable NAME against the registry flags the proxy attached. */
export function maskedValue(
  key: string,
  value: unknown,
  variables: readonly DebugVariableView[],
): string {
  if (variables.some((v) => v.pii && v.name === key)) return '●●●●';
  return typeof value === 'string' ? value : JSON.stringify(value) ?? 'undefined';
}

/**
 * The replay endpoint's answer, as this panel reads it. Declared locally rather than in
 * `lib/api-types.ts` for the reason the file header gives about wire types this session: the
 * shape belongs to the runtime's `GET /preview/:hash/replay/:session_id`, and only this
 * component consumes it. Fields the panel does not render are deliberately absent — reading
 * fewer fields than the endpoint sends is how a UI survives the endpoint growing.
 */
interface ReplayView {
  readonly session_id: string;
  readonly seed: string;
  readonly disposition?: string | null;
  readonly steps: readonly {
    readonly seq: number;
    readonly page_id?: string | null;
    readonly outcome: string;
    readonly questions?: readonly {
      readonly question_id: string;
      readonly ref?: string;
      readonly order?: Readonly<Record<string, readonly number[] | undefined>>;
    }[];
  }[];
}

interface SessionState {
  readonly sessionId: string;
  readonly variables: readonly DebugVariableView[];
  readonly currentPageId: string | null;
  readonly pageHistory: readonly string[];
  readonly vars: Readonly<Record<string, unknown>>;
  readonly lastDebug: DebugTraceView | null;
  readonly lastStep: DebugStepView;
  readonly disposition: { readonly disposition: string; readonly redirectUrl: string | null } | null;
}

export function DebugPanel({ versionId }: DebugPanelProps): React.JSX.Element {
  const [session, setSession] = useState<SessionState | null>(null);
  const [seed, setSeed] = useState('');
  /** A recorded session's id, for replay (P1-11's acceptance: paste an id, step through it). */
  const [replayId, setReplayId] = useState('');
  const [replay, setReplay] = useState<ReplayView | null>(null);
  const [payloadText, setPayloadText] = useState('{}');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const post = useCallback(
    async (body: Readonly<Record<string, unknown>>): Promise<DebugStepView | null> => {
      setBusy(true);
      setError(null);
      try {
        const { data } = await apiFetch<DebugStepView>(
          '/versions/' + versionId + '/debug-session',
          { method: 'POST', body },
        );
        // Runtime refusals (stale_page, session_not_found…) pass through the proxy as their
        // original statuses, which apiFetch raises as ApiError — caught below and SHOWN,
        // because a refusal is debug information here, not a failure of the panel.
        return data;
      } catch (err: unknown) {
        setError(err instanceof ApiError ? err.code + ': ' + err.message : String(err));
        return null;
      } finally {
        setBusy(false);
      }
    },
    [versionId],
  );

  /**
   * Replay a RECORDED session — the P1-11 acceptance line, and the one action that reads rather
   * than drives: the runtime loads that session's seed and its stored events and re-runs the
   * pipeline, writing nothing. It refuses a session pinned to another artifact, so pasting an id
   * from a different survey is a 404 rather than a confusing trace.
   */
  const startReplay = useCallback(async (): Promise<void> => {
    setReplay(null);
    const result = await post({ action: 'replay', session_id: replayId.trim() });
    if (result === null) return;
    const asReplay = result as unknown as ReplayView;
    if (!Array.isArray(asReplay.steps)) {
      setError('the runtime answered without steps');
      return;
    }
    setReplay(asReplay);
  }, [post, replayId]);

  const start = useCallback(async (): Promise<void> => {
    const step = await post({
      action: 'start',
      ...(SEED_SHAPE.test(seed) ? { seed } : {}),
    });
    if (step === null) return;
    if (step.error !== undefined) {
      setError('runtime refused: ' + step.error.code);
      return;
    }
    setSession({
      sessionId: step.session_id ?? '',
      variables: step.variables ?? [],
      currentPageId: step.page?.page_id ?? null,
      pageHistory: step.page === undefined ? [] : [step.page.page_id],
      vars: {},
      lastDebug: step.debug ?? null,
      lastStep: step,
      disposition:
        step.disposition === undefined
          ? null
          : { disposition: step.disposition, redirectUrl: step.redirect_url ?? null },
    });
  }, [post, seed]);

  /** Fold one submit/setvars response into the session view. */
  const applyStep = useCallback(
    (step: DebugStepView, submitted: Readonly<Record<string, unknown>>): void => {
      setSession((previous) => {
        if (previous === null) return previous;
        const pageId = step.page?.page_id ?? null;
        const advanced = pageId !== null && pageId !== previous.currentPageId;
        return {
          ...previous,
          currentPageId: pageId ?? previous.currentPageId,
          pageHistory:
            advanced && pageId !== null
              ? [...previous.pageHistory, pageId]
              : previous.pageHistory,
          // A validation failure writes nothing (the runtime's no-op path), so the values only
          // fold in when the step was accepted.
          vars:
            step.validation_failed === undefined
              ? { ...previous.vars, ...submitted }
              : previous.vars,
          lastDebug: step.debug ?? previous.lastDebug,
          lastStep: step,
          disposition:
            step.disposition === undefined
              ? previous.disposition
              : { disposition: step.disposition, redirectUrl: step.redirect_url ?? null },
        };
      });
    },
    [],
  );

  const parsePayload = useCallback((): Readonly<Record<string, unknown>> | null => {
    try {
      const parsed: unknown = JSON.parse(payloadText);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        setError('the payload must be a JSON object');
        return null;
      }
      return parsed as Record<string, unknown>;
    } catch {
      setError('the payload is not valid JSON');
      return null;
    }
  }, [payloadText]);

  const submitPage = useCallback(async (): Promise<void> => {
    if (session === null || session.currentPageId === null) return;
    const values = parsePayload();
    if (values === null) return;
    const step = await post({
      action: 'submit',
      session_id: session.sessionId,
      page_id: session.currentPageId,
      values,
    });
    if (step !== null) applyStep(step, values);
  }, [session, parsePayload, post, applyStep]);

  const setVars = useCallback(async (): Promise<void> => {
    if (session === null) return;
    const vars = parsePayload();
    if (vars === null) return;
    const step = await post({ action: 'setvars', session_id: session.sessionId, vars });
    if (step !== null) applyStep(step, vars);
  }, [session, parsePayload, post, applyStep]);

  const debug = session?.lastDebug ?? null;
  const orders = debug?.orders ?? {};
  const orderScopes = Object.keys(orders);

  return (
    <div className="rs-card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <h3 style={{ fontSize: 13 }}>Debug session</h3>
        <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <span className="rs-muted">Seed</span>
          <input
            className="rs-input"
            value={seed}
            placeholder="32 hex chars to reproduce"
            size={34}
            onChange={(event) => {
              setSeed(event.target.value.trim().toLowerCase());
            }}
          />
        </label>
        <button
          type="button"
          className="rs-button"
          disabled={busy}
          onClick={() => {
            void start();
          }}
        >
          {session === null ? 'Start debug session' : 'Restart debug session'}
        </button>
      </div>

      {/* Replay: the acceptance line is "paste a session id and step through what that
          respondent saw", so the control is literally a field and a button. */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'end', flexWrap: 'wrap', marginTop: 8 }}>
        <label>
          <span className="rs-muted">Replay session</span>{' '}
          <input
            className="rs-input"
            data-testid="debug-replay-id"
            value={replayId}
            placeholder="ses_…"
            size={34}
            onChange={(event) => {
              setReplayId(event.target.value.trim());
            }}
          />
        </label>
        <button
          type="button"
          className="rs-button"
          data-testid="debug-replay-start"
          disabled={busy || !/^ses_[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(replayId.trim())}
          onClick={() => {
            void startReplay();
          }}
        >
          Replay
        </button>
      </div>

      {replay === null ? null : (
        <section data-testid="debug-replay" style={{ marginTop: 8 }}>
          <h4 style={{ margin: '4px 0' }}>
            Replay of <code>{replay.session_id}</code>
          </h4>
          <dl style={{ display: 'flex', gap: 16, flexWrap: 'wrap', margin: 0 }}>
            <div>
              <dt className="rs-muted">Seed</dt>
              <dd>
                <code data-testid="replay-seed">{replay.seed}</code>
              </dd>
            </div>
            <div>
              <dt className="rs-muted">Disposition</dt>
              <dd data-testid="replay-disposition">{replay.disposition ?? '—'}</dd>
            </div>
            <div>
              <dt className="rs-muted">Steps</dt>
              <dd>{replay.steps.length}</dd>
            </div>
          </dl>
          <table className="rs-table" data-testid="replay-steps">
            <thead>
              <tr>
                <th scope="col">seq</th>
                <th scope="col">page</th>
                <th scope="col">outcome</th>
                <th scope="col">orders as rendered</th>
              </tr>
            </thead>
            <tbody>
              {replay.steps.map((step) => (
                <tr key={String(step.seq)} data-testid={'replay-step-' + String(step.seq)}>
                  <td>{step.seq}</td>
                  <td>
                    <code>{step.page_id ?? '—'}</code>
                  </td>
                  <td>{step.outcome}</td>
                  <td>
                    {(step.questions ?? []).map((q) => (
                      <div key={q.question_id}>
                        <code>{q.ref ?? q.question_id}</code>{' '}
                        {Object.entries(q.order ?? {}).map(([axis, codes]) => (
                          <span key={axis} className="rs-muted">
                            {axis}: [{(codes ?? []).join(',')}]{' '}
                          </span>
                        ))}
                      </div>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {error === null ? null : <p role="alert">{error}</p>}

      {session === null ? (
        <p className="rs-muted">
          Drives a parallel test session against the same artifact and renders the full logic
          trace from its responses. The iframe on the left stays untouched.
        </p>
      ) : (
        <>
          <dl style={{ display: 'flex', gap: 16, flexWrap: 'wrap', margin: 0 }}>
            <div>
              <dt className="rs-muted">Session</dt>
              <dd>
                <code>{session.sessionId}</code>
              </dd>
            </div>
            <div>
              <dt className="rs-muted">Seed</dt>
              <dd>
                <code data-testid="debug-seed">{debug?.seed ?? '—'}</code>
              </dd>
            </div>
            <div>
              <dt className="rs-muted">Current page</dt>
              <dd data-testid="debug-current-page">{session.currentPageId ?? '—'}</dd>
            </div>
            <div>
              <dt className="rs-muted">Cells evaluated</dt>
              <dd>{debug?.cells_evaluated ?? 0}</dd>
            </div>
          </dl>

          {session.disposition === null ? null : (
            <p data-testid="debug-disposition">
              <strong>{session.disposition.disposition}</strong>{' '}
              {session.disposition.redirectUrl === null ? (
                <span className="rs-muted">no redirect configured</span>
              ) : (
                <code>{session.disposition.redirectUrl}</code>
              )}
            </p>
          )}

          {session.lastStep.validation_failed === undefined ? null : (
            <div>
              <h4 style={{ fontSize: 12 }}>Validation failures</h4>
              <ul>
                {session.lastStep.validation_failed.map((failure, index) => (
                  <li key={index}>
                    <code>{failure.question_id}</code>: {failure.message_key}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div>
            <h4 style={{ fontSize: 12 }}>Step the session</h4>
            <textarea
              className="rs-input"
              aria-label="Step payload (JSON)"
              rows={3}
              style={{ width: '100%', fontFamily: 'monospace' }}
              value={payloadText}
              onChange={(event) => {
                setPayloadText(event.target.value);
              }}
            />
            <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
              <button
                type="button"
                className="rs-button"
                disabled={busy || session.currentPageId === null}
                onClick={() => {
                  void submitPage();
                }}
              >
                Submit page
              </button>
              {/* Test-mode only, re-validated server-side against the variable manifest
                  (security §3.2) — an invented ref writes nothing and comes back `rejected`. */}
              <button
                type="button"
                className="rs-button"
                disabled={busy}
                onClick={() => {
                  void setVars();
                }}
              >
                Set vars
              </button>
            </div>
          </div>

          <div>
            <h4 style={{ fontSize: 12 }}>Variable state</h4>
            {Object.keys(session.vars).length === 0 ? (
              <p className="rs-muted">Nothing set by this session yet.</p>
            ) : (
              <table className="rs-table" data-testid="debug-vars">
                <thead>
                  <tr>
                    <th>Variable</th>
                    <th>Value</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(session.vars).map(([key, value]) => (
                    <tr key={key}>
                      <td>
                        <code>{key}</code>
                      </td>
                      {/* PII never renders in clear here, even though the operator typed it —
                          the panel is screen-shared in every QA call. */}
                      <td>{maskedValue(key, value, session.variables)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div>
            <h4 style={{ fontSize: 12 }}>Rule verdicts (per cell)</h4>
            {debug?.trace === undefined || debug.trace.length === 0 ? (
              <p className="rs-muted">No trace for the last step.</p>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table className="rs-table" data-testid="debug-trace">
                  <thead>
                    <tr>
                      <th>Cell</th>
                      <th>Result</th>
                      <th>Writers (rule = verdict)</th>
                      <th>Changed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {debug.trace.map((cell) => (
                      <tr key={cell.cell + String(cell.topo_pos)}>
                        <td>
                          <code>{cell.cell}</code>
                        </td>
                        <td>
                          <code>{JSON.stringify(cell.result)}</code>
                        </td>
                        <td>
                          {cell.writers.length === 0 ? (
                            <span className="rs-muted">—</span>
                          ) : (
                            cell.writers.map((writer, index) => (
                              <span key={index} style={{ marginRight: 8 }}>
                                <code>
                                  {writer.rule_id} = {writer.verdict}
                                </code>
                                {writer.collapsed === undefined ? null : (
                                  <span className="rs-muted">
                                    {' '}
                                    (U→{String(writer.collapsed.to)}: {writer.collapsed.reason})
                                  </span>
                                )}
                                {writer.suppressed === true ? (
                                  <span className="rs-muted"> (suppressed)</span>
                                ) : null}
                              </span>
                            ))
                          )}
                        </td>
                        <td>{cell.changed ? 'yes' : 'pruned'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div>
            <h4 style={{ fontSize: 12 }}>Randomization decisions</h4>
            {orderScopes.length === 0 ? (
              <p className="rs-muted">No randomized scopes on this page.</p>
            ) : (
              <table className="rs-table" data-testid="debug-orders">
                <thead>
                  <tr>
                    <th>Scope</th>
                    <th>Output order (indexes into the declared list)</th>
                  </tr>
                </thead>
                <tbody>
                  {orderScopes.map((scope) => (
                    <tr key={scope}>
                      <td>
                        <code>{scope}</code>
                      </td>
                      <td>
                        <code>{(orders[scope] ?? []).join(' → ')}</code>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="rs-muted">
              Deterministic from the seed above — restart with the same seed to reproduce.
            </p>
          </div>

          <div>
            <h4 style={{ fontSize: 12 }}>Quota &amp; termination</h4>
            {debug?.termination == null ? (
              <p className="rs-muted">
                No rule-driven termination on this page. Phase 1 artifacts carry no quota plan,
                so would_reserve / would_be_full will render here once the runtime starts
                sending them.
              </p>
            ) : (
              <p data-testid="debug-termination">
                Rule <code>{debug.termination.rule_id}</code> would terminate with{' '}
                <strong>{debug.termination.disposition}</strong>
                {debug.termination.custom_key === undefined ? null : (
                  <>
                    {' '}
                    (custom key <code>{debug.termination.custom_key}</code>)
                  </>
                )}
              </p>
            )}
          </div>

          <div>
            <h4 style={{ fontSize: 12 }}>Page history</h4>
            <ol data-testid="debug-page-history">
              {session.pageHistory.map((pageId, index) => (
                <li key={String(index) + pageId}>
                  <code>{pageId}</code>
                </li>
              ))}
            </ol>
          </div>
        </>
      )}
    </div>
  );
}
