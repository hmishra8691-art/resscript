/**
 * The org switcher as a full page — where a user with several orgs lands, and where a user
 * with none is told to create one.
 */

'use client';

import Link from 'next/link';
import { useOrgs, useSwitchOrg } from '@/lib/queries';
import { browserSupabase } from '@/lib/supabase-browser';

export default function OrgsPage(): React.JSX.Element {
  const orgs = useOrgs();
  const switchOrg = useSwitchOrg();

  if (orgs.isLoading) return <main style={{ padding: 16 }}>Loading…</main>;

  const rows = orgs.data?.data ?? [];
  const active = orgs.data?.active_org_id ?? null;

  return (
    <main style={{ maxWidth: 560, margin: '48px auto', padding: 8 }}>
      <h1 style={{ fontSize: 18, marginBottom: 8 }}>Your organizations</h1>
      {rows.length === 0 ? (
        <div className="rs-card">
          <p>You do not belong to an organization yet.</p>
          <Link className="rs-button" data-variant="primary" href="/orgs/new">
            Create one
          </Link>
        </div>
      ) : (
        <table className="rs-table">
          <thead>
            <tr>
              <th>Organization</th>
              <th>Your role</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((org) => (
              <tr key={org.org_id}>
                {/* Only the ACTIVE org has a readable name: `organizations_select` restricts
                    reads to `id = app.current_org()`. */}
                <td>{org.name ?? org.org_id}</td>
                <td>{org.role}</td>
                <td>
                  {org.org_id === active ? (
                    <Link className="rs-button" href={'/' + org.org_id}>
                      Open
                    </Link>
                  ) : (
                    <button
                      type="button"
                      className="rs-button"
                      disabled={switchOrg.isPending}
                      onClick={() =>
                        switchOrg.mutate(org.org_id, {
                          // The re-minted claim only reaches the browser via a fresh access
                          // token — refresh before navigating or the destination page's writes
                          // still carry the old (wrong-org) token (see orgs/new/page.tsx).
                          onSuccess: async () => {
                            await browserSupabase()?.auth.refreshSession();
                            window.location.assign('/' + org.org_id);
                          },
                        })
                      }
                    >
                      Switch
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="rs-muted" style={{ marginTop: 8 }}>
        Switching organization re-issues your access token, so a tab left open in another
        organization cannot act in this one.
      </p>
    </main>
  );
}
