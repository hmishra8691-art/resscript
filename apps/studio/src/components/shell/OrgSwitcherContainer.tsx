/**
 * Wires `OrgSwitcher` to the API. Split from the component so the component stays testable
 * without a QueryClient, and so the switch's side effect — a full reload — lives in one place.
 */

'use client';

import { useRouter } from 'next/navigation';
import { OrgSwitcher } from './OrgSwitcher';
import { useOrgs, useSwitchOrg } from '@/lib/queries';
import { browserSupabase } from '@/lib/supabase-browser';

export function OrgSwitcherContainer(): React.JSX.Element {
  const orgs = useOrgs();
  const switchOrg = useSwitchOrg();
  const router = useRouter();

  return (
    <OrgSwitcher
      orgs={orgs.data?.data ?? []}
      activeOrgId={orgs.data?.active_org_id ?? null}
      isSwitching={switchOrg.isPending}
      onCreate={() => router.push('/orgs/new')}
      onSwitch={(orgId) => {
        switchOrg.mutate(orgId, {
          onSuccess: async () => {
            // The new claim only reaches the browser with a new access token, so the whole app
            // is reloaded rather than a cache being invalidated. A partial refresh would leave
            // React state describing org A while requests resolved in org B. Fetch that new
            // token BEFORE reloading — the previous version reloaded on the still-stale token,
            // so every request on the destination org still carried the old org's (or no org's)
            // claims and every RLS-checked write 404'd as "resource not found".
            await browserSupabase()?.auth.refreshSession();
            window.location.assign('/' + orgId);
          },
        });
      }}
    />
  );
}
