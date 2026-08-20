/**
 * Inline role editor for one member.
 *
 * The role list comes from `@resscript/schema`'s `ORG_ROLES` — the canonical registry — so the
 * dropdown cannot drift from the SQL enum or from the RLS policies. `owner` is filtered out
 * because ownership is transferred by an explicit audited action, never by a select box: the
 * API refuses it (`role_not_assignable`) and `members_update`'s policy refuses it again.
 *
 * Prop-driven so it is testable without a QueryClient, and so the optimistic-update policy
 * lives in the container rather than in the control.
 */

'use client';

import { useId, useState } from 'react';
import { ORG_ROLES, ORG_ROLE_RANKS, type OrgRole } from '@resscript/schema';

/** Descending by rank, so the most privileged option is first — matching K §1's table. */
export const ASSIGNABLE_ROLES: readonly OrgRole[] = [...ORG_ROLES]
  .filter((role) => role !== 'owner')
  .sort((a, b) => ORG_ROLE_RANKS[b] - ORG_ROLE_RANKS[a]);

export interface MemberRoleEditorProps {
  readonly userId: string;
  readonly label: string;
  readonly role: OrgRole;
  readonly onChange: (userId: string, role: OrgRole) => void;
  readonly onRemove?: (userId: string) => void;
  readonly disabled?: boolean;
  /** Rendered inline, from `ApiError.detailFor('role')` — never a toast that scrolls away. */
  readonly error?: string | undefined;
  readonly pending?: boolean;
}

export function MemberRoleEditor({
  userId,
  label,
  role,
  onChange,
  onRemove,
  disabled = false,
  error,
  pending = false,
}: MemberRoleEditorProps): React.JSX.Element {
  const selectId = useId();
  const [value, setValue] = useState<OrgRole>(role);
  const isOwner = role === 'owner';

  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
      <label htmlFor={selectId} style={{ minWidth: 220 }}>
        {label}
      </label>
      {isOwner ? (
        // An owner's role is not editable here at all, rather than editable-and-then-rejected.
        <span data-testid={'member-role-owner-' + userId}>owner</span>
      ) : (
        <select
          id={selectId}
          className="rs-select"
          aria-label={'Role for ' + label}
          data-testid={'member-role-' + userId}
          value={value}
          disabled={disabled || pending}
          onChange={(event) => {
            const next = event.target.value as OrgRole;
            setValue(next);
            onChange(userId, next);
          }}
        >
          {ASSIGNABLE_ROLES.map((option) => (
            <option key={option} value={option}>
              {option} ({ORG_ROLE_RANKS[option]})
            </option>
          ))}
        </select>
      )}
      {pending ? <span className="rs-muted">saving…</span> : null}
      {error === undefined ? null : (
        <span role="alert" style={{ color: 'var(--rs-danger)' }}>
          {error}
        </span>
      )}
      {onRemove === undefined || isOwner ? null : (
        <button
          type="button"
          className="rs-button"
          data-testid={'member-remove-' + userId}
          disabled={disabled || pending}
          onClick={() => onRemove(userId)}
        >
          Remove
        </button>
      )}
    </div>
  );
}
