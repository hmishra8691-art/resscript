/**
 * Accept an invitation.
 *
 * The token arrives in the URL (`/accept-invite?token=…`) because that is what an emailed link
 * can carry, and it is POSTed to `/api/v1/invitations/accept` — the one endpoint where the org
 * comes from the token rather than from the JWT, because the caller is not a member yet.
 *
 * The token is never stored client-side and never appended to a subsequent navigation: after a
 * successful accept the user is sent to the org they just joined.
 */

'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { ApiError, apiFetch } from '@/lib/api-client';

function AcceptInviteForm(): React.JSX.Element {
  const params = useSearchParams();
  const [token, setToken] = useState(params.get('token') ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const result = await apiFetch<{ org_id: string; role: string }>('/invitations/accept', {
        method: 'POST',
        body: { token },
      });
      window.location.assign('/' + result.data.org_id);
    } catch (err: unknown) {
      setBusy(false);
      if (err instanceof ApiError && err.status === 401) {
        setError('Sign in first, then open the invitation link again.');
        return;
      }
      // 404 covers wrong, revoked and expired tokens alike: distinguishing them tells a
      // guesser they are close.
      setError('That invitation is not valid any more.');
    }
  }

  return (
    <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <label htmlFor="token">Invitation token</label>
      <input
        id="token"
        className="rs-input"
        required
        value={token}
        onChange={(e) => setToken(e.target.value)}
      />
      {error === null ? null : (
        <p role="alert" style={{ color: 'var(--rs-danger)' }}>
          {error}
        </p>
      )}
      <button className="rs-button" data-variant="primary" type="submit" disabled={busy}>
        {busy ? 'Accepting…' : 'Accept invitation'}
      </button>
      <p className="rs-muted">
        Not signed in? <Link href="/login">Sign in</Link> first — an invitation is accepted by a
        real account, never by a link alone.
      </p>
    </form>
  );
}

export default function AcceptInvitePage(): React.JSX.Element {
  return (
    <main style={{ maxWidth: 420, margin: '80px auto' }}>
      <h1 style={{ fontSize: 18, marginBottom: 8 }}>Join an organization</h1>
      {/* `useSearchParams` requires a Suspense boundary in the App Router. */}
      <Suspense fallback={<p className="rs-muted">Loading…</p>}>
        <AcceptInviteForm />
      </Suspense>
    </main>
  );
}
