/**
 * Create an organization.
 *
 * This is the ONLY path by which an `owner` comes into existence: `app.organizations` has no
 * INSERT policy, `app.invitations` forbids `role = 'owner'`, and `app.create_organization`
 * inserts the org and its first owner in one transaction (which is also what makes the deferred
 * "at least one owner" trigger satisfiable).
 */

'use client';

import { useState } from 'react';
import { ApiError, apiFetch, newIdempotencyKey } from '@/lib/api-client';

/** Slug rules mirror `org_slug_fmt`, so the client refuses what the CHECK would refuse. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

export default function NewOrgPage(): React.JSX.Element {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const effectiveSlug = slugTouched ? slug : slugify(name);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setFieldError({});
    setBusy(true);
    try {
      const created = await apiFetch<{ id: string }>('/organizations', {
        method: 'POST',
        body: { name, slug: effectiveSlug },
        // A double-submit must not create two orgs, each with the caller as owner.
        idempotencyKey: newIdempotencyKey(),
      });
      window.location.assign('/' + created.data.id);
    } catch (err: unknown) {
      setBusy(false);
      if (err instanceof ApiError) {
        const slugMessage = err.detailFor('slug');
        if (slugMessage !== undefined) setFieldError({ slug: slugMessage });
        else setError(err.message);
        return;
      }
      setError('Could not create the organization.');
    }
  }

  return (
    <main style={{ maxWidth: 420, margin: '48px auto', padding: 8 }}>
      <h1 style={{ fontSize: 18, marginBottom: 8 }}>New organization</h1>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <label htmlFor="org-name">Name</label>
        <input
          id="org-name"
          className="rs-input"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <label htmlFor="org-slug">Slug</label>
        <input
          id="org-slug"
          className="rs-input"
          required
          value={effectiveSlug}
          aria-describedby="org-slug-hint"
          onChange={(e) => {
            setSlugTouched(true);
            setSlug(e.target.value);
          }}
        />
        <p id="org-slug-hint" className="rs-muted">
          Lowercase letters, digits and hyphens. Appears in URLs.
        </p>
        {fieldError['slug'] === undefined ? null : (
          <p role="alert" style={{ color: 'var(--rs-danger)' }}>
            {fieldError['slug']}
          </p>
        )}
        {error === null ? null : (
          <p role="alert" style={{ color: 'var(--rs-danger)' }}>
            {error}
          </p>
        )}
        <button className="rs-button" data-variant="primary" type="submit" disabled={busy}>
          {busy ? 'Creating…' : 'Create organization'}
        </button>
      </form>
      <p className="rs-muted" style={{ marginTop: 8 }}>
        You become this organization&apos;s owner. Ownership can only be transferred by an
        explicit, audited action — never by invitation.
      </p>
    </main>
  );
}
