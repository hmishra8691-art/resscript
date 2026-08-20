/**
 * Sign-up. Creating an account creates no organization: the next step is
 * `POST /api/v1/organizations`, which is the ONLY path that mints an `owner`
 * (`app.create_organization`), or accepting an invitation.
 */

'use client';

import Link from 'next/link';
import { useState } from 'react';
import { browserSupabase } from '@/lib/supabase-browser';

export default function SignUpPage(): React.JSX.Element {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setMessage(null);
    const client = browserSupabase();
    if (client === null) {
      setError('Authentication is not configured in this environment.');
      return;
    }
    setBusy(true);
    const { data, error: signUpError } = await client.auth.signUp({ email, password });
    setBusy(false);
    if (signUpError !== null) {
      setError(signUpError.message);
      return;
    }
    if (data.session === null) {
      setMessage('Check your email to confirm your address, then sign in.');
      return;
    }
    window.location.assign('/orgs/new');
  }

  return (
    <main style={{ maxWidth: 320, margin: '80px auto' }}>
      <h1 style={{ fontSize: 18, marginBottom: 8 }}>Create your ResScript account</h1>
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
          autoComplete="new-password"
          minLength={12}
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <p className="rs-muted">At least 12 characters.</p>
        {error === null ? null : (
          <p role="alert" style={{ color: 'var(--rs-danger)' }}>
            {error}
          </p>
        )}
        {message === null ? null : <p role="status">{message}</p>}
        <button className="rs-button" data-variant="primary" type="submit" disabled={busy}>
          {busy ? 'Creating…' : 'Create account'}
        </button>
      </form>
      <p className="rs-muted" style={{ marginTop: 8 }}>
        Already have an account? <Link href="/login">Sign in</Link>
      </p>
    </main>
  );
}
