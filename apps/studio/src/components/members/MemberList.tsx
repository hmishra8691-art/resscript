/**
 * The member list with inline role management.
 *
 * Owns the mutation so `MemberRoleEditor` stays presentational. Errors are surfaced against the
 * row that produced them: a 403 from demoting the last admin is only actionable if the user can
 * see which row it refers to.
 */

'use client';

import { useState } from 'react';
import type { OrgRole } from '@resscript/schema';
import { ApiError } from '@/lib/api-client';
import { useMembers, useRemoveMember, useUpdateMemberRole } from '@/lib/queries';
import { MemberRoleEditor } from './MemberRoleEditor';

export function MemberList({ orgId }: { orgId: string | null }): React.JSX.Element {
  const members = useMembers(orgId);
  const updateRole = useUpdateMemberRole(orgId);
  const removeMember = useRemoveMember(orgId);
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [pendingUserId, setPendingUserId] = useState<string | null>(null);

  if (members.isLoading) return <p className="rs-muted">Loading members…</p>;
  if (members.isError) {
    const error = members.error;
    return (
      <p role="alert">
        {error instanceof ApiError && error.code === 'forbidden'
          ? 'Listing members requires the admin role.'
          : 'Could not load members.'}
      </p>
    );
  }

  const rows = members.data?.data ?? [];
  if (rows.length === 0) return <p className="rs-muted">No members yet.</p>;

  function apply(userId: string, role: OrgRole): void {
    setPendingUserId(userId);
    updateRole.mutate(
      { userId, role },
      {
        onError: (error) => {
          setErrors((prev) => ({
            ...prev,
            [userId]:
              error instanceof ApiError
                ? (error.detailFor('role') ?? error.message)
                : 'Could not change role',
          }));
        },
        onSuccess: () => {
          setErrors((prev) => {
            const next = { ...prev };
            delete next[userId];
            return next;
          });
        },
        onSettled: () => setPendingUserId(null),
      },
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {rows.map((member) => (
        <MemberRoleEditor
          key={member.user_id}
          userId={member.user_id}
          // `auth.users` is not readable by the `authoring` role, so the id is shown when the
          // email is not available rather than a blank cell.
          label={member.email ?? member.user_id}
          role={member.role}
          pending={pendingUserId === member.user_id}
          error={errors[member.user_id]}
          onChange={apply}
          onRemove={(userId) => {
            setPendingUserId(userId);
            removeMember.mutate(userId, {
              onError: (error) => {
                setErrors((prev) => ({
                  ...prev,
                  [userId]: error instanceof ApiError ? error.message : 'Could not remove member',
                }));
              },
              onSettled: () => setPendingUserId(null),
            });
          }}
        />
      ))}
    </div>
  );
}
