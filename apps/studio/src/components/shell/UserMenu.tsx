/**
 * User menu: theme setting and sign-out.
 *
 * The theme is a three-way user setting (light / dark / system) and not a boolean, because
 * "follow the OS" is a distinct choice from "light" and collapsing them means a user who
 * switches their laptop to dark at 6pm finds the studio still bright (UI §11).
 */

'use client';

import { useEffect } from 'react';
import { browserSupabase } from '@/lib/supabase-browser';
import { useUiStore, type ThemeSetting } from '@/state/ui-store';

export function UserMenu(): React.JSX.Element {
  const theme = useUiStore((s) => s.theme);
  const setTheme = useUiStore((s) => s.setTheme);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove('dark', 'light');
    if (theme !== 'system') root.classList.add(theme);
  }, [theme]);

  return (
    <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
      <label htmlFor="theme-setting" className="rs-muted">
        Theme
      </label>
      <select
        id="theme-setting"
        className="rs-select"
        value={theme}
        onChange={(event) => setTheme(event.target.value as ThemeSetting)}
      >
        <option value="system">System</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
      <button
        type="button"
        className="rs-button"
        onClick={() => {
          const client = browserSupabase();
          if (client === null) {
            window.location.assign('/login');
            return;
          }
          void client.auth.signOut().then(() => window.location.assign('/login'));
        }}
      >
        Sign out
      </button>
    </div>
  );
}
