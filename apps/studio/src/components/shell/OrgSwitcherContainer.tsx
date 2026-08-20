/**
 * Wires `OrgSwitcher` to the API. Split from the component so the component stays testable
 * without a QueryClient, and so the switch's side effect — a full reload — lives in one place.
 */

'use client';

import { useRouter } from 'next/navigation';
import { OrgSwitcher } from './OrgSwitcher';
import { useOrgs, useSwitchOrg } from '@/lib/queries';

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
          onSuccess: () => {
            // The new claim only reaches the browser with a new access token, so the whole app
            // is reloaded rather than a cache being invalidated. A partial refresh would leave
            // React state describing org A while requests resolved in org B.
            window.location.assign('/' + orgId);
          },
        });
      }}
    />
  );
}
