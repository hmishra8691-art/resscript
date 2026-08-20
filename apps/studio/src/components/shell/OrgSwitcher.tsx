/**
 * The org switcher.
 *
 * Presentational and prop-driven on purpose: switching orgs is an AUTH operation (it re-mints
 * the token), so the component must not own the mutation — it reports the intent and the
 * container performs it. That also makes it directly testable without a QueryClient.
 *
 * Orgs the token cannot name render as their id. That is not a placeholder bug: RLS restricts
 * `app.organizations` reads to `id = app.current_org()`, so the name of an org you are not
 * currently acting in is genuinely not readable. Showing the id is honest; inventing a label
 * would not be.
 */

'use client';

import { useId, useState } from 'react';
import type { OrgMembershipView } from '@/lib/api-types';

export interface OrgSwitcherProps {
  readonly orgs: readonly OrgMembershipView[];
  readonly activeOrgId: string | null;
  readonly onSwitch: (orgId: string) => void;
  readonly onCreate?: () => void;
  readonly isSwitching?: boolean;
}

export function OrgSwitcher({
  orgs,
  activeOrgId,
  onSwitch,
  onCreate,
  isSwitching = false,
}: OrgSwitcherProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const active = orgs.find((o) => o.org_id === activeOrgId);
  const label = active === undefined ? 'No organization' : (active.name ?? active.org_id);

  return (
    <div style={{ position: 'relative' }}>
      <button
        type="button"
        className="rs-button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={menuId}
        disabled={isSwitching}
        onClick={() => setOpen((v) => !v)}
        // Escape closes without moving focus elsewhere — a menu that traps focus is a menu
        // keyboard users cannot leave.
        onKeyDown={(event) => {
          if (event.key === 'Escape') setOpen(false);
        }}
      >
        <span data-testid="org-switcher-label">{label}</span>
        {active === undefined ? null : <span className="rs-muted"> · {active.role}</span>}
        <span aria-hidden="true"> ▾</span>
      </button>
      {open ? (
        <ul
          id={menuId}
          role="listbox"
          aria-label="Organizations"
          className="rs-card"
          style={{ position: 'absolute', zIndex: 20, minWidth: 240, marginTop: 2, listStyle: 'none' }}
        >
          {orgs.map((org) => (
            <li key={org.org_id} role="none">
              <button
                type="button"
                role="option"
                aria-selected={org.org_id === activeOrgId}
                className="rs-button"
                style={{ width: '100%', textAlign: 'left', border: 'none', background: 'transparent' }}
                onClick={() => {
                  setOpen(false);
                  // Switching to the org you are already in is a no-op, not a token re-mint.
                  if (org.org_id !== activeOrgId) onSwitch(org.org_id);
                }}
              >
                {org.name ?? org.org_id}
                <span className="rs-muted"> · {org.role}</span>
                {org.org_id === activeOrgId ? <span aria-hidden="true"> ✓</span> : null}
              </button>
            </li>
          ))}
          {onCreate === undefined ? null : (
            <li role="none">
              <button
                type="button"
                className="rs-button"
                style={{ width: '100%', textAlign: 'left', border: 'none', background: 'transparent' }}
                onClick={() => {
                  setOpen(false);
                  onCreate();
                }}
              >
                + New organization
              </button>
            </li>
          )}
        </ul>
      ) : null}
    </div>
  );
}
