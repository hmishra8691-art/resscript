/**
 * Sign-in. No app shell (UI §2's `(auth)` group): a user who is not authenticated has no org,
 * so a shell with an org switcher in it would be furniture with nothing behind it.
 */

'use client';

import Link from 'next/link';
import { useState } from 'react';
import { browserSupabase } from '@/lib/supabase-browser';

export default function LoginPage(): React.JSX.Element {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    const client = browserSupabase();
    if (client === null) {
      setError('Authentication is not configured in this environment.');
      return;
    }
    setBusy(true);
    const { error: signInError } = await client.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (signInError !== null) {
      // The message is deliberately not "wrong password" vs "no such user": either one is an
      // account-enumeration oracle.
      setError('Those credentials did not work.');
      return;
    }
    window.location.assign('/orgs');
  }

  return (
    <main style={{ maxWidth: 320, margin: '80px auto' }}>
      <h1 style={{ fontSize: 18, marginBottom: 8 }}>Sign in to ResScript</h1>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <label htmlFor="email">Email</label>
        <input
          id="email"
          className="rs-input"
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <label htmlFor="password">Password</label>
        <input
          id="password"
          className="rs-input"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error === null ? null : (
          <p role="alert" style={{ color: 'var(--rs-danger)' }}>
            {error}
          </p>
        )}
        <button className="rs-button" data-variant="primary" type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      <p className="rs-muted" style={{ marginTop: 8 }}>
        No account? <Link href="/signup">Create one</Link>
      </p>
    </main>
  );
}
