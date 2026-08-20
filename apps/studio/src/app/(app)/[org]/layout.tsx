import type { ReactNode } from 'react';
import { AppShell } from '@/components/shell/AppShell';
import { OrgGuard } from '@/components/OrgGuard';

/**
 * The org layout.
 *
 * A LAYOUT and not a page, so navigating between projects, members and (from P1-03) the survey
 * tree never remounts the shell: App Router layouts survive child route changes, which is what
 * will keep a 2,000-row tree from being rebuilt on every navigation.
 *
 * `params.org` is a routing convenience for shareable links. It is NOT the authorization input:
 * middleware compares it against the token's `active_org_id` server-side, `OrgGuard` offers a
 * switch client-side, and every query resolves against the claim regardless of what the URL
 * says.
 */
export default async function OrgLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ org: string }>;
}): Promise<React.JSX.Element> {
  const { org } = await params;
  return (
    <AppShell orgId={org}>
      <OrgGuard orgId={org}>{children}</OrgGuard>
    </AppShell>
  );
}
