/**
 * Invitations: issue and list.
 *
 * The token is shown ONCE, in the creation response, because that is the only moment it exists
 * outside the email — the row stores `sha256(token)`. `owner` is absent from the role list: the
 * API rejects it (`role_not_invitable`) and `invitations_role_not_owner` rejects it again.
 */

'use client';

import { use, useState } from 'react';
import type { OrgRole } from '@resscript/schema';
import { ApiError } from '@/lib/api-client';
import { ASSIGNABLE_ROLES } from '@/components/members/MemberRoleEditor';
import { useCreateInvitation, useInvitations } from '@/lib/queries';

export default function InvitationsPage({
  params,
}: {
  params: Promise<{ org: string }>;
}): React.JSX.Element {
  const { org } = use(params);
  const invitations = useInvitations(org);
  const createInvitation = useCreateInvitation(org);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<OrgRole>('programmer');
  const [issuedToken, setIssuedToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <h1 style={{ fontSize: 16 }}>Invitations</h1>

      <form
        className="rs-card"
        style={{ display: 'flex', gap: 6, alignItems: 'flex-end' }}
        onSubmit={(event) => {
          event.preventDefault();
          setError(null);
          setIssuedToken(null);
          createInvitation.mutate(
            { email, role },
            {
              onSuccess: (invitation) => {
                setEmail('');
                setIssuedToken(invitation.token ?? null);
              },
              onError: (err) =>
                setError(
                  err instanceof ApiError
                    ? (err.detailFor('role') ?? err.detailFor('email') ?? err.message)
                    : 'Could not create the invitation',
                ),
            },
          );
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
          <label htmlFor="invite-email">Email</label>
          <input
            id="invite-email"
            className="rs-input"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <label htmlFor="invite-role">Role</label>
          <select
            id="invite-role"
            className="rs-select"
            value={role}
            onChange={(e) => setRole(e.target.value as OrgRole)}
          >
            {ASSIGNABLE_ROLES.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </div>
        <button className="rs-button" data-variant="primary" type="submit" disabled={createInvitation.isPending}>
          Send invitation
        </button>
      </form>

      {error === null ? null : (
        <p role="alert" style={{ color: 'var(--rs-danger)' }}>
          {error}
        </p>
      )}
      {issuedToken === null ? null : (
        <div className="rs-card" role="status">
          <p>
            Invitation created. This token is shown once — the database stores only its hash.
          </p>
          <code style={{ wordBreak: 'break-all' }}>{issuedToken}</code>
          <p className="rs-muted">Link: /accept-invite?token={issuedToken}</p>
        </div>
      )}

      <table className="rs-table">
        <thead>
          <tr>
            <th>Email</th>
            <th>Role</th>
            <th>Status</th>
            <th>Expires</th>
          </tr>
        </thead>
        <tbody>
          {(invitations.data?.data ?? []).map((invitation) => (
            <tr key={invitation.id}>
              <td>{invitation.email}</td>
              <td>{invitation.role}</td>
              <td>{invitation.status}</td>
              <td className="rs-muted">{invitation.expires_at.slice(0, 16).replace('T', ' ')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
