/**
 * The app shell: top bar, left nav, main content (UI §1.1).
 *
 * Four regions in the full editor; three here, because the survey tree and the bottom pane are
 * P1-03 and P1-07. The shape is the point: full-surface routes replace the MAIN region and keep
 * the top bar and the rail, so the user never loses their place. The tree slots into the rail
 * without moving anything else.
 *
 * Keyboard: `[` toggles the rail and `⌥1`/`⌥2` move focus between rail and main (UI §1.3).
 * Single-letter tree bindings are deliberately absent until the tree exists — a shortcut that
 * does nothing is worse than one that is missing.
 */

'use client';

import Link from 'next/link';
import { useEffect, useRef, type ReactNode } from 'react';
import { OrgSwitcherContainer } from './OrgSwitcherContainer';
import { UserMenu } from './UserMenu';
import { useUiStore } from '@/state/ui-store';

export interface Breadcrumb {
  readonly label: string;
  readonly href?: string;
}

export interface AppShellProps {
  readonly orgId: string | null;
  readonly breadcrumbs?: readonly Breadcrumb[];
  readonly children: ReactNode;
  /** Right-hand slot in the top bar: save state, problem counts, Preview/Publish from P1-08. */
  readonly actions?: ReactNode;
}

export function AppShell({ orgId, breadcrumbs = [], children, actions }: AppShellProps): React.JSX.Element {
  const railCollapsed = useUiStore((s) => s.railCollapsed);
  const toggleRail = useUiStore((s) => s.toggleRail);
  const railRef = useRef<HTMLElement>(null);
  const mainRef = useRef<HTMLElement>(null);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      const target = event.target as HTMLElement | null;
      const typing =
        target !== null &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if (typing) return;
      if (event.key === '[') {
        event.preventDefault();
        toggleRail();
      }
      if (event.altKey && event.key === '1') railRef.current?.focus();
      if (event.altKey && event.key === '2') mainRef.current?.focus();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [toggleRail]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <header
        style={{
          height: 'var(--rs-topbar-height)',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '0 8px',
          borderBottom: '1px solid var(--rs-border)',
          background: 'var(--rs-surface-raised)',
          flexShrink: 0,
        }}
      >
        <Link href={orgId === null ? '/' : '/' + orgId} style={{ fontWeight: 600 }}>
          ResScript
        </Link>
        <OrgSwitcherContainer />
        <nav aria-label="Breadcrumb" style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          {breadcrumbs.map((crumb, index) => (
            <span key={crumb.label + String(index)} className="rs-muted">
              {index > 0 ? <span aria-hidden="true"> / </span> : null}
              {crumb.href === undefined ? (
                <span aria-current="page">{crumb.label}</span>
              ) : (
                <Link href={crumb.href}>{crumb.label}</Link>
              )}
            </span>
          ))}
        </nav>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          {actions}
          <UserMenu />
        </div>
      </header>

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <nav
          ref={railRef}
          tabIndex={-1}
          aria-label="Primary"
          style={{
            width: railCollapsed ? 40 : 'var(--rs-rail-width)',
            borderRight: '1px solid var(--rs-border)',
            background: 'var(--rs-surface-raised)',
            padding: 4,
            overflowY: 'auto',
            flexShrink: 0,
          }}
        >
          <button
            type="button"
            className="rs-button"
            aria-expanded={!railCollapsed}
            aria-label={railCollapsed ? 'Expand navigation' : 'Collapse navigation'}
            onClick={toggleRail}
            style={{ width: '100%', marginBottom: 4 }}
          >
            {/* Collapses to an icon rail, never to zero: a zero-width rail strands the user. */}
            {railCollapsed ? '»' : '« Collapse'}
          </button>
          {orgId === null ? null : (
            <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 2 }}>
              {[
                { href: '/' + orgId, label: 'Overview', icon: '▤' },
                { href: '/' + orgId + '/projects', label: 'Projects', icon: '▣' },
                { href: '/' + orgId + '/settings/members', label: 'Members', icon: '☰' },
                { href: '/' + orgId + '/settings/invitations', label: 'Invitations', icon: '✉' },
              ].map((item) => (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    style={{
                      display: 'block',
                      height: 'var(--rs-row-height)',
                      lineHeight: 'var(--rs-row-height)',
                      padding: '0 4px',
                      borderRadius: 'var(--rs-radius)',
                    }}
                  >
                    <span aria-hidden="true">{item.icon} </span>
                    {railCollapsed ? null : item.label}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </nav>

        <main
          ref={mainRef}
          tabIndex={-1}
          style={{ flex: 1, minWidth: 0, overflow: 'auto', padding: 8 }}
        >
          {children}
        </main>
      </div>

      {/* One polite live region for save state and counts; components never create their own. */}
      <div aria-live="polite" role="status" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden' }} />
    </div>
  );
}
