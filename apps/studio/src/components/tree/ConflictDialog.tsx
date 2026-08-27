/**
 * The optimistic-lock conflict dialog — the acceptance line "two browser tabs editing the same
 * survey produce a conflict dialog rather than a silent overwrite".
 *
 * It opens on `412 revision_conflict` and it is the END of the mutation: nothing is retried, and
 * there is no "force" button. The reasoning is in `useVersionWriter.ts`, and it is the same
 * sentence `packages/observability` attaches to the code — auto-retrying an optimistic-lock
 * failure is how you get the silent overwrite this dialog exists to prevent.
 *
 * Both sides are stated, because "someone else changed this" without saying what is a dead end:
 * MINE is the edit that was refused, in the words the tree announced it with; THEIRS is the
 * revision the server is now at. What is missing — who, and which nodes — is `changed_since` from
 * the error envelope (API §1.7), which `ApiError` does not carry to callers today; UI §5.3's
 * field-by-field merge needs it, and inventing the merge without it would be a guess with a
 * survey in it.
 */

'use client';

import type { ConflictInfo } from './useVersionWriter';

export interface ConflictDialogProps {
  readonly conflict: ConflictInfo;
  /** Take theirs: refetch the tree and the open node at the server's revision. */
  readonly onReload: () => void;
  /** Drop the refused edit and keep working from what is on screen. */
  readonly onDiscard: () => void;
}

export function ConflictDialog({ conflict, onReload, onDiscard }: ConflictDialogProps): React.JSX.Element {
  return (
    <section
      role="dialog"
      aria-modal="true"
      aria-label="Someone else changed this survey"
      className="rs-card"
      data-testid="conflict-dialog"
    >
      <h2 style={{ fontSize: 14 }}>Someone else changed this survey</h2>
      <p>
        Your edit was not applied. This survey version has one revision for all of its content, so
        another tab or another programmer writing anywhere in it lands here.
      </p>
      <table className="rs-table">
        <tbody>
          <tr>
            <th scope="row">Your change</th>
            <td data-testid="conflict-mine">{conflict.mine}</td>
          </tr>
          <tr>
            <th scope="row">Your revision</th>
            <td data-testid="conflict-my-revision">
              {conflict.myRevision === null ? 'unknown' : 'r' + String(conflict.myRevision)}
            </td>
          </tr>
          <tr>
            <th scope="row">Server revision</th>
            <td data-testid="conflict-their-revision">
              {conflict.currentRevision === null ? 'unknown' : 'r' + String(conflict.currentRevision)}
            </td>
          </tr>
        </tbody>
      </table>
      <div style={{ display: 'flex', gap: 4, marginTop: 8 }}>
        <button type="button" className="rs-button" data-testid="conflict-reload" onClick={onReload}>
          Reload their version
        </button>
        <button type="button" className="rs-button" data-testid="conflict-discard" onClick={onDiscard}>
          Discard my change
        </button>
      </div>
      <p className="rs-muted" style={{ marginTop: 4 }}>
        Re-applying your change over theirs is deliberately not offered: that is the silent
        overwrite this dialog exists to prevent. Reload, look at what changed, and redo the edit.
      </p>
    </section>
  );
}
