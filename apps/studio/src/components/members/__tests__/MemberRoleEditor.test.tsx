/**
 * Member role editor component tests.
 *
 * The load-bearing assertions are about the ROLE LIST: it comes from `@resscript/schema`'s
 * canonical registry, it excludes `owner`, and it is ordered by descending rank with `analyst`
 * above `reviewer` — the inversion Deliverable K exists to prevent, asserted here at the UI
 * layer too because a dropdown is where a user forms their mental model of the hierarchy.
 */

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ORG_ROLES } from '@resscript/schema';
import { MemberRoleEditor } from '@/components/members/MemberRoleEditor';

afterEach(cleanup);

describe('MemberRoleEditor', () => {
  it('offers every canonical role except owner', () => {
    render(<MemberRoleEditor userId="u1" label="prg@a.test" role="programmer" onChange={vi.fn()} />);
    const options = screen.getAllByRole('option').map((option) => option.getAttribute('value'));
    expect(options).toEqual([...ORG_ROLES].filter((r) => r !== 'owner').map(String).sort((a, b) => {
      const rank = { admin: 60, project_manager: 50, programmer: 40, analyst: 30, reviewer: 20, viewer: 10, client: 5 } as Record<string, number>;
      return (rank[b] ?? 0) - (rank[a] ?? 0);
    }));
    expect(options).not.toContain('owner');
  });

  it('lists analyst above reviewer', () => {
    render(<MemberRoleEditor userId="u1" label="prg@a.test" role="programmer" onChange={vi.fn()} />);
    const options = screen.getAllByRole('option').map((option) => option.getAttribute('value'));
    expect(options.indexOf('analyst')).toBeLessThan(options.indexOf('reviewer'));
  });

  it('reports the rank next to the role, so the hierarchy is visible not folklore', () => {
    render(<MemberRoleEditor userId="u1" label="prg@a.test" role="programmer" onChange={vi.fn()} />);
    expect(screen.getByRole('option', { name: 'analyst (30)' })).toBeDefined();
    expect(screen.getByRole('option', { name: 'reviewer (20)' })).toBeDefined();
  });

  it('emits the change with the user id', async () => {
    const onChange = vi.fn();
    render(<MemberRoleEditor userId="u1" label="prg@a.test" role="programmer" onChange={onChange} />);
    await userEvent.selectOptions(screen.getByTestId('member-role-u1'), 'viewer');
    expect(onChange).toHaveBeenCalledWith('u1', 'viewer');
  });

  it('renders an owner as non-editable text, not a disabled select', () => {
    render(<MemberRoleEditor userId="u2" label="owner@a.test" role="owner" onChange={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.getByTestId('member-role-owner-u2')).toHaveTextContent('owner');
    expect(screen.queryByTestId('member-role-u2')).toBeNull();
    // No Remove button either: ownership transfer is a separate audited action.
    expect(screen.queryByTestId('member-remove-u2')).toBeNull();
  });

  it('surfaces a server-side refusal inline, against the row that caused it', () => {
    render(
      <MemberRoleEditor
        userId="u1"
        label="prg@a.test"
        role="programmer"
        onChange={vi.fn()}
        error="ownership is transferred by an explicit audited action"
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('audited action');
  });

  it('disables the control while a save is in flight', () => {
    render(<MemberRoleEditor userId="u1" label="prg@a.test" role="programmer" onChange={vi.fn()} pending />);
    expect(screen.getByTestId('member-role-u1')).toBeDisabled();
    expect(screen.getByText('saving…')).toBeDefined();
  });

  it('has an accessible name tying the control to the member', () => {
    render(<MemberRoleEditor userId="u1" label="prg@a.test" role="programmer" onChange={vi.fn()} />);
    expect(screen.getByLabelText('Role for prg@a.test')).toBeDefined();
  });
});
