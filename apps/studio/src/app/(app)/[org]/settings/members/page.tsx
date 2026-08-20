/**
 * Member list with inline role management.
 *
 * P1-01 acceptance: "changing a member from `programmer` to `viewer` causes their next save to
 * fail with a permission error and produces one `app.audit_log` row naming the actor, target and
 * old/new role." The audit row is written by the API; what this screen owes the user is an
 * honest failure when the change is refused, which is why the error renders against the row.
 */

'use client';

import { use } from 'react';
import { MemberList } from '@/components/members/MemberList';

export default function MembersPage({
  params,
}: {
  params: Promise<{ org: string }>;
}): React.JSX.Element {
  const { org } = use(params);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <h1 style={{ fontSize: 16 }}>Members</h1>
      <MemberList orgId={org} />
      <p className="rs-muted">
        An owner&apos;s role cannot be changed here. Ownership transfer is a separate audited
        action, and no invitation can grant it.
      </p>
    </div>
  );
}
