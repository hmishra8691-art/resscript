/**
 * Asserts that the `[org]` path segment matches the token's `active_org_id`.
 *
 * UI §2: "org appears as a path segment for shareable links, but it is NOT the authorization
 * input." Middleware performs the same check server-side before the page renders; this is the
 * client-side half, and it exists because a shareable link to org B pasted by a colleague must
 * offer to SWITCH rather than silently render org A's data under org B's URL.
 *
 * Nothing here is a security control. The security control is the JWT claim and the RLS policy:
 * even if this component were deleted, a request would return org A's rows because the token
 * says org A.
 */

'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { useOrgs, useSwitchOrg } from '@/lib/queries';

export function OrgGuard({ orgId, children }: { orgId: string; children: ReactNode }): React.JSX.Element {
  const orgs = useOrgs();
  const switchOrg = useSwitchOrg();

  if (orgs.isLoading) return <p className="rs-muted">Loading…</p>;

  const active = orgs.data?.active_org_id ?? null;
  if (active === null) {
    return (
      <div className="rs-card">
        <p>You are not a member of any organization yet.</p>
        <Link className="rs-button" href="/orgs/new">
          Create an organization
        </Link>
      </div>
    );
  }
  if (active !== orgId) {
    const isMember = (orgs.data?.data ?? []).some((o) => o.org_id === orgId);
    return (
      <div className="rs-card" role="alert">
        <p>
          This link points at a different organization than your session is scoped to.
        </p>
        {isMember ? (
          <button
            type="button"
            className="rs-button"
            data-variant="primary"
            disabled={switchOrg.isPending}
            onClick={() =>
              switchOrg.mutate(orgId, {
                onSuccess: () => window.location.reload(),
              })
            }
          >
            Switch to {orgId}
          </button>
        ) : (
          <Link className="rs-button" href={'/' + active}>
            Go to your organization
          </Link>
        )}
      </div>
    );
  }
  return <>{children}</>;
}
