/**
 * Diagnostic list tests.
 *
 * What is pinned here is the SEPARATION and the identity: one section per severity with the count
 * in its heading, the acknowledgement key on the item so it can be quoted in a support thread, and
 * a diagnostic whose code this studio has never seen still rendering its code and its message. The
 * dialog's own suite covers the gate the list feeds.
 */

import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acknowledgementKey, type CompileDiagnostic } from '@resscript/compiler/diagnostics';
import { DiagnosticList } from '@/components/publish/DiagnosticList';

afterEach(cleanup);

const unknownCode: CompileDiagnostic = {
  code: 'CMP-9999',
  severity: 'warning',
  message: 'the theme declares a font nobody licensed',
  path: '/theme/font_family',
  detail: { font_family: 'Helvetica Neue' },
};

describe('DiagnosticList', () => {
  it('is one section per severity, with the count and the consequence in it', () => {
    render(
      <DiagnosticList
        severity="error"
        diagnostics={[
          { code: 'CMP-0001', severity: 'error', message: 'the flow declares no start node', path: '/flow' },
        ]}
      />,
    );
    const section = screen.getByTestId('diagnostics-error');
    expect(within(section).getByTestId('diagnostics-error-count')).toHaveTextContent('1');
    // The heading and the sentence carry the meaning — not a colour, not an icon.
    expect(section).toHaveTextContent('Errors');
    expect(section).toHaveTextContent('Publish cannot proceed');
    expect(screen.queryByTestId('diagnostics-warning')).toBeNull();
  });

  it('renders an unknown code with its code and its message, never blank', () => {
    render(<DiagnosticList severity="warning" diagnostics={[unknownCode]} />);
    const item = screen.getByTestId('diagnostic-warning-0');
    expect(within(item).getByTestId('diagnostic-warning-0-code')).toHaveTextContent('CMP-9999');
    expect(within(item).getByTestId('diagnostic-warning-0-message')).toHaveTextContent(
      'the theme declares a font nobody licensed',
    );
    expect(within(item).getByTestId('diagnostic-warning-0-subjects')).toHaveTextContent(
      'Helvetica Neue',
    );
  });

  it('emits the compiler acknowledgement key, and carries it on the item', async () => {
    const onAcknowledge = vi.fn();
    render(
      <DiagnosticList
        severity="warning"
        diagnostics={[unknownCode]}
        onAcknowledge={onAcknowledge}
        onNoteChange={vi.fn()}
      />,
    );
    const key = acknowledgementKey(unknownCode);
    expect(screen.getByTestId('diagnostic-warning-0')).toHaveAttribute('data-ack-key', key);

    await userEvent.setup().click(screen.getByTestId('diagnostic-warning-0-ack'));
    expect(onAcknowledge).toHaveBeenCalledWith(key, true);
  });

  it('offers no acknowledgement control on an error section', () => {
    render(
      <DiagnosticList
        severity="error"
        diagnostics={[{ ...unknownCode, severity: 'error' }]}
        onAcknowledge={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('diagnostic-error-0-ack')).toBeNull();
    expect(screen.queryByTestId('diagnostics-warning-outstanding')).toBeNull();
  });

  it('distinguishes an empty group from an uncompiled version through its caller text', () => {
    render(
      <DiagnosticList
        severity="error"
        diagnostics={[]}
        emptyText="Nothing has been compiled yet, so there are no errors to show."
      />,
    );
    expect(screen.getByTestId('diagnostics-error')).toHaveTextContent('Nothing has been compiled yet');
  });
});
