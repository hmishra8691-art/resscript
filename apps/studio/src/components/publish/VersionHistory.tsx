/**
 * Version history, and rollback — roadmap P1-08 Frontend: "version history with rollback", whose
 * acceptance wording is that the confirmation NAMES BOTH ARTIFACT HASHES.
 *
 * WHY BOTH HASHES, SPELLED IN FULL, IN THE CONFIRMATION. A rollback is the one studio action whose
 * effect is invisible in the studio: nothing is compiled, nothing is copied, and ADR-002 addresses
 * an artifact by the sha256 of its own content, so the entire operation is a survey token being
 * repointed from one hash to another. "Roll back to version 7?" is a question a user can only
 * answer by trusting the studio. "Version 7's artifact `9f2c…` will replace version 12's `4ab8…`"
 * is a question they can CHECK — against the hash the runtime is serving, against a hash in a QA
 * report, against the one in the audit row `app.rollback_version` writes. That is the difference
 * between a confirmation and a speed bump, and it is why the hashes are not abbreviated there even
 * though they are in the table.
 *
 * WHY `can_roll_back` IS NOT RECOMPUTED. It is exactly `app.rollback_version`'s three refusals plus
 * the survey-level one, computed by `GET /surveys/:id/history`. A client that re-derived the rule
 * would eventually offer a button the database refuses, which is the worst kind of UI bug: the user
 * did the right thing and got an error. The flag alone decides whether the control exists. The
 * *hint* next to a missing control is assembled from the row's own visible columns — status,
 * compile state, artifact hash — and is presentation of what is already on screen, not a second
 * copy of the rule. If the API ever ships a reason with the flag, the hint should become it.
 *
 * WHY THE FLOOR IS `project_manager` AND WHERE THAT COMES FROM. `ROLLBACK_FLOOR` in
 * `src/server/publish.ts`, whose comment is `app.rollback_version`'s own: "rollback changes what
 * respondents see, so it is the PM capability". Disabled with the reason next to it, never hidden
 * and never a 403 after the click.
 */

'use client';

import { useState } from 'react';
import type { OrgRole } from '@resscript/schema';
import { rollbackCapability } from '@/components/publish/capability';
import type { VersionHistoryEntryView } from '@/lib/api-types';

export interface VersionHistoryProps {
  readonly surveyRef: string;
  readonly versions: readonly VersionHistoryEntryView[];
  /** `live_version_id` — the version the survey token points at. `null` when nothing is live. */
  readonly liveVersionId: string | null;
  readonly role: OrgRole | null;
  readonly truncated?: boolean;
  readonly onRollback: (toVersionId: string) => void;
  readonly pendingVersionId?: string | null;
  readonly error?: string | undefined;
}

/** 12 hex characters — enough to recognise a hash on screen, never enough to act on blindly. */
const ABBREVIATED = 12;

export function VersionHistory({
  surveyRef,
  versions,
  liveVersionId,
  role,
  truncated = false,
  onRollback,
  pendingVersionId = null,
  error,
}: VersionHistoryProps): React.JSX.Element {
  const [confirming, setConfirming] = useState<string | null>(null);
  const capability = rollbackCapability(role);
  const live = versions.find((version) => version.id === liveVersionId) ?? null;
  const target = versions.find((version) => version.id === confirming) ?? null;

  return (
    <section className="rs-card" aria-labelledby="version-history-heading" data-testid="version-history">
      <h3 id="version-history-heading">Version history — {surveyRef}</h3>
      {capability.allowed ? null : (
        <p className="rs-muted" data-testid="version-history-rollback-reason">
          {capability.reason}
        </p>
      )}
      {live === null ? (
        <p className="rs-muted" data-testid="version-history-no-live">
          No version is live, so there is nothing to roll back from. Publish a version to
          production first.
        </p>
      ) : null}

      <table className="rs-table">
        <thead>
          <tr>
            <th scope="col">Version</th>
            {/* K §3: two orthogonal axes, so two columns. Never collapsed into one word. */}
            <th scope="col">Status</th>
            <th scope="col">Compile</th>
            <th scope="col">Artifact</th>
            <th scope="col">Created</th>
            <th scope="col">Published</th>
            <th scope="col">Rollback</th>
          </tr>
        </thead>
        <tbody>
          {versions.map((version) => {
            const isLive = version.id === liveVersionId;
            return (
              <tr key={version.id} data-testid={'version-row-' + String(version.version_no)}>
                <th scope="row">
                  {version.version_no}
                  {isLive ? (
                    <span data-testid={'version-live-' + String(version.version_no)}> (live)</span>
                  ) : null}
                </th>
                <td>{version.status}</td>
                <td>{version.compile_state}</td>
                <td>
                  <ArtifactHash hash={version.artifact_hash} bytes={version.artifact_bytes} />
                </td>
                <td>{version.created_at}</td>
                <td>{version.published_at ?? '—'}</td>
                <td>
                  {version.can_roll_back ? (
                    <button
                      type="button"
                      className="rs-button"
                      data-testid={'rollback-' + String(version.version_no)}
                      disabled={!capability.allowed || pendingVersionId !== null}
                      onClick={() => setConfirming(version.id)}
                    >
                      Roll back to this
                    </button>
                  ) : (
                    <span className="rs-muted" data-testid={'rollback-blocked-' + String(version.version_no)}>
                      {rollbackHint(version, live)}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {truncated ? (
        <p className="rs-muted" data-testid="version-history-truncated">
          This survey has more versions than this panel carries. The versions collection is the
          paginated read.
        </p>
      ) : null}

      {error === undefined ? null : (
        <p role="alert" data-testid="rollback-error" style={{ color: 'var(--rs-danger)' }}>
          {error}
        </p>
      )}

      {target === null || live === null ? null : (
        <RollbackConfirmation
          target={target}
          live={live}
          pending={pendingVersionId === target.id}
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            onRollback(target.id);
            setConfirming(null);
          }}
        />
      )}
    </section>
  );
}

/**
 * Abbreviated, with the full value one keystroke away.
 *
 * `<details>` rather than a tooltip: a `title` attribute is invisible to a keyboard user and
 * unselectable with a mouse, and the whole point of showing a hash is that somebody compares it
 * with another one — which means selecting and copying it.
 */
function ArtifactHash({
  hash,
  bytes,
}: {
  readonly hash: string | null;
  readonly bytes: number | null;
}): React.JSX.Element {
  if (hash === null) {
    return (
      <span className="rs-muted">
        {/* Not "—": an absent hash means no artifact was ever written for this version, which is
            the reason rollback refuses it. */}
        none
      </span>
    );
  }
  return (
    <details>
      <summary>
        <code>{hash.slice(0, ABBREVIATED)}…</code>
      </summary>
      <code data-testid={'artifact-hash-full-' + hash}>{hash}</code>
      {bytes === null ? null : <span className="rs-muted"> {String(bytes)} bytes</span>}
    </details>
  );
}

/**
 * The hint next to a rollback control that is not offered. Assembled from the row's own columns in
 * the order `app.rollback_version` checks them, so the first sentence a user reads is the first
 * thing they would have to change.
 */
function rollbackHint(
  version: VersionHistoryEntryView,
  live: VersionHistoryEntryView | null,
): string {
  if (live === null) return 'no live version';
  if (version.id === live.id) return 'already live';
  if (version.status !== 'archived') return 'only an archived version can be restored';
  if (version.compile_state !== 'compiled' || version.artifact_hash === null) {
    return 'no compiled artifact to serve';
  }
  return 'not available';
}

function RollbackConfirmation({
  target,
  live,
  pending,
  onCancel,
  onConfirm,
}: {
  readonly target: VersionHistoryEntryView;
  readonly live: VersionHistoryEntryView;
  readonly pending: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}): React.JSX.Element {
  return (
    <div
      role="alertdialog"
      aria-label={'Roll back to version ' + String(target.version_no)}
      className="rs-card"
      data-testid="rollback-confirmation"
    >
      <h4>Roll back to version {target.version_no}?</h4>
      {/* Both hashes, in full, in one sentence: the outgoing one and the returning one. Abbreviated
          hashes would make the two look alike, which is the failure this wording exists to prevent. */}
      <p data-testid="rollback-confirmation-hashes">
        The survey token stops serving version {live.version_no}, artifact{' '}
        <code data-testid="rollback-from-hash">{live.artifact_hash ?? 'none'}</code>, and serves
        version {target.version_no}, artifact{' '}
        <code data-testid="rollback-to-hash">{target.artifact_hash ?? 'none'}</code> instead.
      </p>
      <p className="rs-muted">
        Nothing is recompiled. Those bytes already exist and are addressed by that hash, so
        respondents see byte-identical content to what version {target.version_no} served before.
        Version {live.version_no} is archived, not deleted.
      </p>
      <div style={{ display: 'flex', gap: 6 }}>
        <button
          type="button"
          className="rs-button"
          data-variant="primary"
          data-testid="rollback-confirm"
          disabled={pending}
          onClick={onConfirm}
        >
          Roll back to version {target.version_no}
        </button>
        <button
          type="button"
          className="rs-button"
          data-testid="rollback-cancel"
          disabled={pending}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
