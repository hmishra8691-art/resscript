/**
 * Publish dialog tests.
 *
 * The load-bearing assertions are the four refusals and the acknowledgement identity:
 *
 *  - an error blocks the publish AND removes the warning section, because a signature next to a
 *    publish that cannot happen is a signature nobody read;
 *  - every warning must be acknowledged before the button enables, and the outstanding count is on
 *    screen while it is not;
 *  - the key submitted is `acknowledgementKey(diagnostic)` — asserted by CALLING that function in
 *    the test rather than by pasting its output, so a change to the compiler's definition of "the
 *    same warning" fails here instead of silently sending a key the worker will not match;
 *  - a `programmer` gets staging and not production, from `PUBLISH_FLOORS` rather than from a
 *    literal.
 */

import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acknowledgementKey, type CompileDiagnostic } from '@resscript/compiler/diagnostics';
import { PUBLISH_FLOORS } from '@/server/publish';
import {
  PublishDialog,
  type PublishDialogProps,
  type PublishRequest,
} from '@/components/publish/PublishDialog';

afterEach(cleanup);

const forwardRefError: CompileDiagnostic = {
  code: 'LGC-F001',
  severity: 'error',
  message: 'Rule R14 reads Q52 at page 18, and no path reaches that point with Q52 set.',
  path: '/logic/rules/3/condition',
  detail: {
    rule_id: 'R14',
    rule_target_id: 'Q41',
    blocking_variable_name: 'Q52',
    read_page_index: 17,
    read_flow_position: 31,
    write_question_ref: 'Q52',
    write_page_index: 23,
    write_flow_position: 44,
  },
};

const conditionalWarning: CompileDiagnostic = {
  code: 'LGC-F002',
  severity: 'warning',
  message: 'Rule R7 reads Q9, which is set on some paths that reach it and not on others.',
  path: '/logic/rules/1/condition',
  detail: { rule_id: 'R7', rule_target_id: 'Q3', blocking_variable_name: 'Q9' },
};

const bundleWarning: CompileDiagnostic = {
  code: 'CMP-0201',
  severity: 'warning',
  message: 'the de bundle is missing 12 of the 340 keys the en bundle declares',
  path: '/languages/bundles/de',
  detail: {
    language: 'de',
    base_language: 'en',
    base_key_count: 340,
    missing_count: 12,
    missing_keys: ['q1.label'],
    on_missing: 'show_key',
  },
};

function renderDialog(overrides: Partial<PublishDialogProps> = {}): {
  readonly onPublish: ReturnType<typeof vi.fn>;
} {
  const onPublish = vi.fn();
  const props: PublishDialogProps = {
    versionId: '01J0000000000000000000VERS',
    versionNo: 12,
    // `staging -> staging` is a republish (the guard's check is `OLD.status <> NEW.status`) and
    // `staging -> production` is legal, so neither target is refused by the transition table here
    // and the role floor is the only variable.
    status: 'staging',
    compileState: 'compiled',
    diagnostics: [],
    role: 'project_manager',
    onPublish,
    ...overrides,
  };
  render(<PublishDialog {...props} />);
  return { onPublish };
}

describe('PublishDialog', () => {
  it('disables publish and shows no warning section while an error stands', () => {
    renderDialog({ diagnostics: [forwardRefError, conditionalWarning] });

    expect(screen.getByTestId('publish-submit')).toBeDisabled();
    expect(screen.getByTestId('diagnostics-error-count')).toHaveTextContent('1');
    // The warning exists in the input and is deliberately not rendered: the next compile may report
    // a different set, and an acknowledgement is recorded against the warning it was given for.
    expect(screen.queryByTestId('diagnostics-warning')).toBeNull();
    expect(screen.getByTestId('publish-warnings-suppressed')).toBeDefined();
    expect(screen.getByTestId('publish-blocked-reason')).toHaveTextContent('1 error(s) must be fixed');
  });

  it('renders each error with its code, the gate message and the objects it names', () => {
    renderDialog({ diagnostics: [forwardRefError] });
    const item = screen.getByTestId('diagnostic-error-0');
    expect(within(item).getByTestId('diagnostic-error-0-code')).toHaveTextContent('LGC-F001');
    expect(within(item).getByTestId('diagnostic-error-0-message')).toHaveTextContent(
      forwardRefError.message,
    );
    const summary = within(item).getByTestId('diagnostic-error-0-summary');
    expect(summary).toHaveTextContent('R14');
    expect(summary).toHaveTextContent('page 18');
    expect(summary).toHaveTextContent('page 24');
    expect(within(item).getByTestId('diagnostic-error-0-path')).toHaveTextContent(
      '/logic/rules/3/condition',
    );
  });

  it('keeps publish disabled until every warning is acknowledged, and says how many are left', async () => {
    renderDialog({ diagnostics: [conditionalWarning, bundleWarning] });
    const user = userEvent.setup();

    expect(screen.getByTestId('publish-submit')).toBeDisabled();
    expect(screen.getByTestId('diagnostics-warning-outstanding')).toHaveTextContent(
      '2 not acknowledged',
    );

    await user.click(screen.getByTestId('diagnostic-warning-0-ack'));
    expect(screen.getByTestId('publish-submit')).toBeDisabled();
    expect(screen.getByTestId('diagnostics-warning-outstanding')).toHaveTextContent(
      '1 not acknowledged',
    );
    expect(screen.getByTestId('publish-blocked-reason')).toHaveTextContent(
      '1 warning(s) still to acknowledge',
    );

    await user.click(screen.getByTestId('diagnostic-warning-1-ack'));
    expect(screen.getByTestId('publish-submit')).toBeEnabled();
    expect(screen.getByTestId('diagnostics-warning-outstanding')).toHaveTextContent(
      'all acknowledged',
    );

    // Un-ticking one is a withdrawn signature, and the gate closes again.
    await user.click(screen.getByTestId('diagnostic-warning-0-ack'));
    expect(screen.getByTestId('publish-submit')).toBeDisabled();
  });

  it('submits the compiler acknowledgement key and the recorded note, not a local identity', async () => {
    const { onPublish } = renderDialog({ diagnostics: [conditionalWarning] });
    const user = userEvent.setup();

    await user.click(screen.getByTestId('diagnostic-warning-0-ack'));
    await user.type(screen.getByTestId('diagnostic-warning-0-note'), 'screener branch is intended');
    await user.click(screen.getByTestId('publish-submit'));

    expect(onPublish).toHaveBeenCalledWith({
      target: 'staging',
      acknowledge_warnings: [
        {
          key: acknowledgementKey(conditionalWarning),
          reason: 'screener branch is intended',
        },
      ],
    });
    // The key is code + pointer + sorted detail, so it is not the code and not the message.
    const submitted: PublishRequest | undefined = onPublish.mock.calls[0]?.[0];
    const key = submitted?.acknowledge_warnings[0]?.key ?? '';
    expect(key).toContain('LGC-F002');
    expect(key).toContain('/logic/rules/1/condition');
    expect(key).not.toBe(conditionalWarning.message);
  });

  it('omits an empty note rather than sending a blank reason', async () => {
    const { onPublish } = renderDialog({ diagnostics: [conditionalWarning] });
    const user = userEvent.setup();

    await user.click(screen.getByTestId('diagnostic-warning-0-ack'));
    await user.click(screen.getByTestId('publish-submit'));

    expect(onPublish).toHaveBeenCalledWith({
      target: 'staging',
      acknowledge_warnings: [{ key: acknowledgementKey(conditionalWarning) }],
    });
  });

  it('does not re-ask for a warning already recorded on the version', () => {
    renderDialog({
      diagnostics: [conditionalWarning],
      recordedAcknowledgements: [acknowledgementKey(conditionalWarning)],
    });
    expect(screen.getByTestId('diagnostic-warning-0-recorded')).toBeDefined();
    expect(screen.queryByTestId('diagnostic-warning-0-ack')).toBeNull();
    expect(screen.getByTestId('publish-submit')).toBeEnabled();
  });

  it('gives a programmer staging and refuses production with the role that would be needed', () => {
    renderDialog({ role: 'programmer' });

    expect(screen.getByTestId('publish-target-staging')).toBeEnabled();
    const production = screen.getByTestId('publish-target-production');
    expect(production).toBeDisabled();
    const reason = screen.getByTestId('publish-target-production-reason');
    // Named from the floor table, so a change to K §1's asymmetry moves both at once.
    expect(reason).toHaveTextContent(PUBLISH_FLOORS.production);
    expect(reason).toHaveTextContent('programmer');
    expect(PUBLISH_FLOORS.staging).toBe('programmer');
  });

  it('refuses every target for a viewer, with the reason on each', () => {
    renderDialog({ role: 'viewer' });
    expect(screen.getByTestId('publish-target-staging')).toBeDisabled();
    expect(screen.getByTestId('publish-target-production')).toBeDisabled();
    expect(screen.getByTestId('publish-submit')).toBeDisabled();
    expect(screen.getByTestId('publish-blocked-reason')).toHaveTextContent(
      'publishing to staging requires the programmer role',
    );
  });

  it('names an illegal transition instead of letting the request 409', () => {
    // `draft -> production` is the mistake the review step exists to catch; the table that says so
    // is the one the route checks.
    renderDialog({ status: 'draft', role: 'admin' });
    expect(screen.getByTestId('publish-target-production')).toBeDisabled();
    expect(screen.getByTestId('publish-target-production-transition')).toHaveTextContent(
      'cannot transition from draft to production',
    );
    expect(screen.getByTestId('publish-target-staging')).toBeEnabled();
  });

  it('distinguishes "nothing to fix" from "nothing has been compiled"', () => {
    renderDialog({ compileState: 'none' });
    expect(screen.getByTestId('publish-compile-state-note')).toHaveTextContent(
      'never been compiled',
    );
    // And the publish is still offered: publishing is what runs the compiler.
    expect(screen.getByTestId('publish-submit')).toBeEnabled();
  });

  it('renders progress through the existing job-status component', () => {
    renderDialog({
      job: {
        id: '01J000000000000000000000JOB',
        kind: 'compile',
        status: 'running',
        progress: { step: 4, total: 7, message: 'emitting pages', updated_at: '2026-08-21T10:00:00Z' },
        attempts: 1,
        max_attempts: 5,
        created_at: '2026-08-21T09:59:00Z',
        finished_at: null,
      },
    });
    // "step N of M" comes from `JobStatus`, not from a second progress widget.
    expect(screen.getByTestId('job-status')).toBeDefined();
    expect(screen.getByText('step 4 of 7')).toBeDefined();
  });
});
