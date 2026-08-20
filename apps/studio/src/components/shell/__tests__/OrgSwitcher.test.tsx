/**
 * Org switcher component tests.
 *
 * The switcher is the surface where a tenancy mistake becomes visible, so the assertions are
 * about exactly that: it never reports an org the token cannot name, it reports the caller's
 * role, and switching to the current org does nothing (a token re-mint for no reason is an
 * audit row for no reason).
 */

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OrgSwitcher } from '@/components/shell/OrgSwitcher';
import type { OrgMembershipView } from '@/lib/api-types';

afterEach(cleanup);

const orgs: readonly OrgMembershipView[] = [
  { org_id: 'org_A', role: 'owner', name: 'Acme Research', slug: 'acme', is_active: true },
  // No name: the token is not scoped to this org, so `organizations_select` hides its row.
  { org_id: 'org_B', role: 'reviewer', name: null, slug: null, is_active: false },
];

describe('OrgSwitcher', () => {
  it('shows the active org name and the caller role', () => {
    render(<OrgSwitcher orgs={orgs} activeOrgId="org_A" onSwitch={vi.fn()} />);
    expect(screen.getByTestId('org-switcher-label')).toHaveTextContent('Acme Research');
    expect(screen.getByRole('button', { name: /Acme Research/ })).toHaveTextContent('owner');
  });

  it('falls back to the org id when RLS cannot name the org', async () => {
    render(<OrgSwitcher orgs={orgs} activeOrgId="org_A" onSwitch={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /Acme Research/ }));
    expect(screen.getByRole('option', { name: /org_B/ })).toBeDefined();
  });

  it('switches to another org and closes the menu', async () => {
    const onSwitch = vi.fn();
    render(<OrgSwitcher orgs={orgs} activeOrgId="org_A" onSwitch={onSwitch} />);
    await userEvent.click(screen.getByRole('button', { name: /Acme Research/ }));
    await userEvent.click(screen.getByRole('option', { name: /org_B/ }));
    expect(onSwitch).toHaveBeenCalledWith('org_B');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('does NOT re-mint a token for the org you are already in', async () => {
    const onSwitch = vi.fn();
    render(<OrgSwitcher orgs={orgs} activeOrgId="org_A" onSwitch={onSwitch} />);
    await userEvent.click(screen.getByRole('button', { name: /Acme Research/ }));
    await userEvent.click(screen.getByRole('option', { name: /Acme Research/ }));
    expect(onSwitch).not.toHaveBeenCalled();
  });

  it('is keyboard reachable and announces its state', async () => {
    render(<OrgSwitcher orgs={orgs} activeOrgId="org_A" onSwitch={vi.fn()} onCreate={vi.fn()} />);
    const trigger = screen.getByRole('button', { name: /Acme Research/ });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await userEvent.tab();
    expect(trigger).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('option', { name: /Acme Research/ })).toHaveAttribute('aria-selected', 'true');
    // Escape closes without trapping focus.
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('offers organization creation when the caller can create one', async () => {
    const onCreate = vi.fn();
    render(<OrgSwitcher orgs={orgs} activeOrgId="org_A" onSwitch={vi.fn()} onCreate={onCreate} />);
    await userEvent.click(screen.getByRole('button', { name: /Acme Research/ }));
    await userEvent.click(screen.getByRole('button', { name: /New organization/ }));
    expect(onCreate).toHaveBeenCalledOnce();
  });

  it('renders a no-organization state rather than an empty label', () => {
    render(<OrgSwitcher orgs={[]} activeOrgId={null} onSwitch={vi.fn()} />);
    expect(screen.getByTestId('org-switcher-label')).toHaveTextContent('No organization');
  });
});
