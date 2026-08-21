/**
 * One SEVERITY GROUP of compile diagnostics, as its own section.
 *
 * WHY THIS IS NOT ONE LIST WITH SEVERITY ICONS. An error and a warning are not two shades of the
 * same thing: an error means the publish cannot happen at all (the gate writes no artifact — C §17),
 * and a warning means it can happen the moment a human takes responsibility for it (03 §17's
 * recorded acknowledgement). A single list sorted by severity puts those two facts in the same
 * visual container and asks the reader to recover the difference from a glyph, which defeats the
 * one thing this gate is for: a programmer should be able to tell AT A GLANCE whether they are
 * blocked or merely being asked to sign something. So the caller renders this component twice, and
 * the section heading — not a colour, not an icon — is what carries the meaning (UI §11: colour is
 * never the sole carrier).
 *
 * WHY ACKNOWLEDGEMENT LIVES HERE AND THE STATE DOES NOT. The checkbox and the note belong next to
 * the warning they are about; a batch "acknowledge all" control at the bottom of a list is a
 * signature on something nobody read. But the STATE is the dialog's, because the dialog is what
 * submits it and what already knows which keys the version carries from a previous publish. This
 * component is prop-driven for the same reason `MemberRoleEditor` is: it is testable without a
 * QueryClient, and the policy lives in the container.
 *
 * WHY THE KEY IS `acknowledgementKey(d)` AND NOT A LOCAL INDEX. That function is the compiler's
 * definition of "the same warning" — code + JSON pointer + sorted detail — and the worker compares
 * the submitted keys with it. A key computed here from the code and a node id would be a SECOND
 * definition, coarser than the gate's, and would survive an edit that changed what the warning was
 * about: an acknowledgement the author never gave. The list therefore imports it.
 */

'use client';

import { useId } from 'react';
import { acknowledgementKey, type CompileDiagnostic, type CompileSeverity } from '@resscript/compiler/diagnostics';
import { formatDiagnostic, type FormattedDiagnostic } from '@/components/publish/format-diagnostic';

/** One author's signature-in-progress: the checkbox, and 03 §17's recorded note. */
export interface AcknowledgementState {
  readonly acknowledged: boolean;
  readonly note: string;
}

export interface DiagnosticListProps {
  readonly severity: CompileSeverity;
  readonly diagnostics: readonly CompileDiagnostic[];
  /** Keyed by `acknowledgementKey`. Absent entries are unacknowledged with no note. */
  readonly acknowledgements?: ReadonlyMap<string, AcknowledgementState>;
  readonly onAcknowledge?: (key: string, acknowledged: boolean) => void;
  readonly onNoteChange?: (key: string, note: string) => void;
  /**
   * Keys already recorded on the version by an earlier publish. Rendered as recorded rather than
   * as a fresh checkbox: `app.tg_version_guard` seals `acknowledged_warnings` on a frozen version,
   * which is what makes it evidence, and re-asking for a signature already on file trains the
   * author to click.
   */
  readonly recorded?: readonly string[];
  readonly disabled?: boolean;
  /** Shown in place of the list when there is nothing in this group. */
  readonly emptyText?: string;
}

const HEADINGS: { readonly [K in CompileSeverity]: string } = {
  error: 'Errors',
  warning: 'Warnings',
  info: 'Notes',
};

const CONSEQUENCE: { readonly [K in CompileSeverity]: string } = {
  error: 'Publish cannot proceed until every one of these is fixed. No artifact is written.',
  warning:
    'Publish can proceed once each of these is acknowledged. The acknowledgement and its note ' +
    'are recorded against the version and audited.',
  info: 'Nothing here blocks a publish.',
};

export function DiagnosticList({
  severity,
  diagnostics,
  acknowledgements,
  onAcknowledge,
  onNoteChange,
  recorded = [],
  disabled = false,
  emptyText,
}: DiagnosticListProps): React.JSX.Element {
  const recordedKeys = new Set(recorded);
  const askForAcknowledgement = severity === 'warning' && onAcknowledge !== undefined;
  const outstanding = diagnostics.filter((diagnostic) => {
    const key = acknowledgementKey(diagnostic);
    if (recordedKeys.has(key)) return false;
    return acknowledgements?.get(key)?.acknowledged !== true;
  }).length;

  return (
    <section
      className="rs-card"
      aria-labelledby={severity + '-heading'}
      data-testid={'diagnostics-' + severity}
    >
      <h3 id={severity + '-heading'} style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
        <span>{HEADINGS[severity]}</span>
        {/* The count is in the heading, not only in the list: a collapsed section still has to
            answer "how many". */}
        <span data-testid={'diagnostics-' + severity + '-count'}>
          {String(diagnostics.length)}
        </span>
        {askForAcknowledgement && diagnostics.length > 0 ? (
          <span className="rs-muted" data-testid="diagnostics-warning-outstanding">
            {outstanding === 0
              ? 'all acknowledged'
              : String(outstanding) + ' not acknowledged'}
          </span>
        ) : null}
      </h3>
      {diagnostics.length === 0 ? (
        <p className="rs-muted">{emptyText ?? 'None.'}</p>
      ) : (
        <>
          <p className="rs-muted">{CONSEQUENCE[severity]}</p>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {diagnostics.map((diagnostic, index) => {
              const key = acknowledgementKey(diagnostic);
              return (
                <DiagnosticItem
                  // `acknowledgementKey` is the identity the API uses, so it is also the right
                  // React key: two diagnostics with the same key are the same warning.
                  key={key + '#' + String(index)}
                  diagnostic={diagnostic}
                  ackKey={key}
                  index={index}
                  {...(askForAcknowledgement && onAcknowledge !== undefined
                    ? { onAcknowledge }
                    : {})}
                  {...(onNoteChange === undefined ? {} : { onNoteChange })}
                  state={acknowledgements?.get(key) ?? null}
                  recorded={recordedKeys.has(key)}
                  disabled={disabled}
                />
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}

interface DiagnosticItemProps {
  readonly diagnostic: CompileDiagnostic;
  readonly ackKey: string;
  readonly index: number;
  readonly onAcknowledge?: (key: string, acknowledged: boolean) => void;
  readonly onNoteChange?: (key: string, note: string) => void;
  readonly state: AcknowledgementState | null;
  readonly recorded: boolean;
  readonly disabled: boolean;
}

function DiagnosticItem({
  diagnostic,
  ackKey,
  index,
  onAcknowledge,
  onNoteChange,
  state,
  recorded,
  disabled,
}: DiagnosticItemProps): React.JSX.Element {
  const noteId = useId();
  const checkboxId = useId();
  const formatted: FormattedDiagnostic = formatDiagnostic(diagnostic);
  const testId = 'diagnostic-' + diagnostic.severity + '-' + String(index);

  return (
    <li
      data-testid={testId}
      data-code={formatted.code}
      // The key is on the DOM node so an author reporting "the studio would not let me publish"
      // can be asked for it, and so a test can assert the identity without re-deriving it.
      data-ack-key={ackKey}
      style={{ borderTop: '1px solid var(--rs-border)', padding: '6px 0' }}
    >
      <div style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
        <code data-testid={testId + '-code'}>{formatted.code}</code>
        <span data-testid={testId + '-message'}>{formatted.message}</span>
      </div>
      {formatted.summary === null ? null : (
        <p data-testid={testId + '-summary'}>{formatted.summary}</p>
      )}
      {formatted.subjects.length === 0 ? null : (
        <dl
          data-testid={testId + '-subjects'}
          style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 10px', margin: '2px 0' }}
        >
          {formatted.subjects.map((subject) => (
            <div key={subject.label} style={{ display: 'flex', gap: 4 }}>
              <dt className="rs-muted">{subject.label}</dt>
              <dd style={{ margin: 0 }}>{subject.value}</dd>
            </div>
          ))}
        </dl>
      )}
      <div className="rs-muted" data-testid={testId + '-path'}>
        {formatted.path === '' ? 'the survey document' : formatted.path}
      </div>

      {recorded ? (
        <div data-testid={testId + '-recorded'}>
          Already acknowledged on this version. Sealed with the version, so it cannot be edited
          here.
        </div>
      ) : onAcknowledge === undefined ? null : (
        <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' }}>
          <input
            id={checkboxId}
            type="checkbox"
            data-testid={testId + '-ack'}
            checked={state?.acknowledged ?? false}
            disabled={disabled}
            onChange={(event) => onAcknowledge(ackKey, event.target.checked)}
          />
          <label htmlFor={checkboxId}>
            I accept this warning and take responsibility for publishing over it
          </label>
          <label htmlFor={noteId} className="rs-muted">
            Note
          </label>
          <input
            id={noteId}
            className="rs-input"
            type="text"
            data-testid={testId + '-note'}
            // Free text, and NOT required: `acknowledgedWarningSchema` makes `reason` optional
            // precisely because a required field is a field satisfied with a space.
            placeholder="why this is acceptable (recorded and audited)"
            value={state?.note ?? ''}
            disabled={disabled || onNoteChange === undefined}
            onChange={(event) => onNoteChange?.(ackKey, event.target.value)}
            style={{ minWidth: 260 }}
          />
        </div>
      )}
    </li>
  );
}
