/**
 * Version history and rollback tests.
 *
 * The acceptance assertion is the confirmation naming BOTH artifact hashes — the one going away and
 * the one coming back, in full. A rollback has no visible effect in the studio (nothing compiles,
 * nothing is copied; a token is repointed at bytes already addressed by their own sha256), so the
 * confirmation is the only place a user can check that the operation is the one they meant.
 *
 * The other load-bearing ones: the control is offered on `can_roll_back` and nothing else, because
 * that flag IS `app.rollback_version`'s refusals; and the floor comes from `ROLLBACK_FLOOR`.
 */

import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ROLLBACK_FLOOR } from '@/server/publish';
import { VersionHistory, type VersionHistoryProps } from '@/components/publish/VersionHistory';
import type { VersionHistoryEntryView } from '@/lib/api-types';

afterEach(cleanup);

const LIVE_HASH = 'c0ffee11223344556677889900aabbccddeeff00112233445566778899aabbcc';
const ARCHIVED_HASH = '9f2c881122334455667788990011223344556677889900aabbccddeeff001122';

const liveVersion: VersionHistoryEntryView = {
  id: '01J000000000000000000LIVE1',
  version_no: 12,
  status: 'production',
  compile_state: 'compiled',
  artifact_hash: LIVE_HASH,
  artifact_bytes: 184_320,
  revision: 9,
  created_at: '2026-08-14T09:00:00Z',
  frozen_at: '2026-08-14T10:00:00Z',
  published_at: '2026-08-14T10:01:00Z',
  can_roll_back: false,
};

const archivedVersion: VersionHistoryEntryView = {
  id: '01J00000000000000000ARCH07',
  version_no: 7,
  status: 'archived',
  compile_state: 'compiled',
  artifact_hash: ARCHIVED_HASH,
  artifact_bytes: 181_004,
  revision: 4,
  created_at: '2026-07-02T09:00:00Z',
  frozen_at: '2026-07-02T11:00:00Z',
  published_at: '2026-07-02T11:05:00Z',
  can_roll_back: true,
};

const draftVersion: VersionHistoryEntryView = {
  id: '01J0000000000000000DRAFT13',
  version_no: 13,
  status: 'draft',
  compile_state: 'none',
  artifact_hash: null,
  artifact_bytes: null,
  revision: 1,
  created_at: '2026-08-20T09:00:00Z',
  frozen_at: null,
  published_at: null,
  can_roll_back: false,
};

function renderHistory(overrides: Partial<VersionHistoryProps> = {}): {
  readonly onRollback: ReturnType<typeof vi.fn>;
} {
  const onRollback = vi.fn();
  const props: VersionHistoryProps = {
    surveyRef: 'SUR-0042',
    versions: [draftVersion, liveVersion, archivedVersion],
    liveVersionId: liveVersion.id,
    role: 'project_manager',
    onRollback,
    ...overrides,
  };
  render(<VersionHistory {...props} />);
  return { onRollback };
}

describe('VersionHistory', () => {
  it('lists the version number, both state axes, the artifact and the timestamps', () => {
    renderHistory();
    const row = screen.getByTestId('version-row-7');
    expect(row).toHaveTextContent('7');
    expect(row).toHaveTextContent('archived');
    expect(row).toHaveTextContent('compiled');
    expect(row).toHaveTextContent('2026-07-02T09:00:00Z');
    expect(row).toHaveTextContent('2026-07-02T11:05:00Z');
    // Abbreviated on the row, with the full value in the DOM and selectable.
    expect(within(row).getByText('9f2c88112233…')).toBeDefined();
    expect(within(row).getByTestId('artifact-hash-full-' + ARCHIVED_HASH)).toHaveTextContent(
      ARCHIVED_HASH,
    );
    expect(screen.getByTestId('version-live-12')).toHaveTextContent('live');
  });

  it('names both artifact hashes in the rollback confirmation', async () => {
    renderHistory();
    const user = userEvent.setup();

    await user.click(screen.getByTestId('rollback-7'));

    const confirmation = screen.getByTestId('rollback-confirmation');
    expect(within(confirmation).getByTestId('rollback-from-hash')).toHaveTextContent(LIVE_HASH);
    expect(within(confirmation).getByTestId('rollback-to-hash')).toHaveTextContent(ARCHIVED_HASH);
    // And both versions by number, so the sentence is checkable without decoding a hash.
    const sentence = within(confirmation).getByTestId('rollback-confirmation-hashes');
    expect(sentence).toHaveTextContent('version 12');
    expect(sentence).toHaveTextContent('version 7');
  });

  it('rolls back to the version the confirmation named, and only on confirmation', async () => {
    const { onRollback } = renderHistory();
    const user = userEvent.setup();

    await user.click(screen.getByTestId('rollback-7'));
    expect(onRollback).not.toHaveBeenCalled();

    await user.click(screen.getByTestId('rollback-cancel'));
    expect(onRollback).not.toHaveBeenCalled();
    expect(screen.queryByTestId('rollback-confirmation')).toBeNull();

    await user.click(screen.getByTestId('rollback-7'));
    await user.click(screen.getByTestId('rollback-confirm'));
    expect(onRollback).toHaveBeenCalledWith(archivedVersion.id);
  });

  it('disables rollback below the floor and names the role it needs', () => {
    renderHistory({ role: 'programmer' });
    expect(screen.getByTestId('rollback-7')).toBeDisabled();
    const reason = screen.getByTestId('version-history-rollback-reason');
    expect(reason).toHaveTextContent(ROLLBACK_FLOOR);
    expect(reason).toHaveTextContent('programmer');
    expect(ROLLBACK_FLOOR).toBe('project_manager');
  });

  it('offers the control only where the API said it can be offered', () => {
    renderHistory();
    // The flag is the authority; the hint next to a missing control explains it from the row's own
    // visible columns.
    expect(screen.queryByTestId('rollback-13')).toBeNull();
    expect(screen.getByTestId('rollback-blocked-13')).toHaveTextContent(
      'only an archived version can be restored',
    );
    expect(screen.getByTestId('rollback-blocked-12')).toHaveTextContent('already live');
  });

  it('says there is nothing to roll back from when no version is live', () => {
    renderHistory({ versions: [draftVersion, archivedVersion], liveVersionId: null });
    expect(screen.getByTestId('version-history-no-live')).toHaveTextContent(
      'nothing to roll back from',
    );
    // No incumbent means no second hash, so there is no confirmation to render at all.
    expect(screen.queryByTestId('rollback-confirmation')).toBeNull();
  });

  it('renders a version with no artifact as having none, not as a dash', () => {
    renderHistory();
    const row = screen.getByTestId('version-row-13');
    expect(row).toHaveTextContent('none');
  });

  it('says when the panel is not the whole history', () => {
    renderHistory({ truncated: true });
    expect(screen.getByTestId('version-history-truncated')).toBeDefined();
  });

  it('surfaces a refusal inline', () => {
    renderHistory({ error: 'no production version to roll back from' });
    expect(screen.getByRole('alert')).toHaveTextContent('no production version');
  });
});
