/**
 * Project list and creation. The table is a client island so sorting and filtering do not cost
 * a round trip (UI §2).
 */

'use client';

import Link from 'next/link';
import { use, useState } from 'react';
import { ApiError } from '@/lib/api-client';
import { useCreateProject, useProjects } from '@/lib/queries';

export default function ProjectsPage({
  params,
}: {
  params: Promise<{ org: string }>;
}): React.JSX.Element {
  const { org } = use(params);
  const projects = useProjects(org);
  const createProject = useCreateProject(org);
  const [ref, setRef] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <h1 style={{ fontSize: 16 }}>Projects</h1>

      <form
        className="rs-card"
        style={{ display: 'flex', gap: 6, alignItems: 'flex-end' }}
        onSubmit={(event) => {
          event.preventDefault();
          setError(null);
          createProject.mutate(
            { ref, name },
            {
              onSuccess: () => {
                setRef('');
                setName('');
              },
              onError: (err) => {
                setError(
                  err instanceof ApiError ? (err.detailFor('ref') ?? err.message) : 'Could not create project',
                );
              },
            },
          );
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <label htmlFor="project-ref">Ref</label>
          <input
            id="project-ref"
            className="rs-input"
            required
            value={ref}
            onChange={(e) => setRef(e.target.value)}
          />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
          <label htmlFor="project-name">Name</label>
          <input
            id="project-name"
            className="rs-input"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <button className="rs-button" data-variant="primary" type="submit" disabled={createProject.isPending}>
          {createProject.isPending ? 'Creating…' : 'Create project'}
        </button>
      </form>
      {error === null ? null : (
        <p role="alert" style={{ color: 'var(--rs-danger)' }}>
          {error}
        </p>
      )}

      {projects.isLoading ? (
        <p className="rs-muted">Loading…</p>
      ) : (
        <table className="rs-table">
          <thead>
            <tr>
              <th>Ref</th>
              <th>Name</th>
              <th>Client</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {(projects.data?.data ?? []).map((project) => (
              <tr key={project.id}>
                <td>
                  <Link href={'/' + org + '/projects/' + project.id}>{project.ref}</Link>
                </td>
                <td>{project.name}</td>
                <td>{project.client_name ?? '—'}</td>
                <td className="rs-muted">{project.updated_at.slice(0, 10)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {projects.data?.page.has_more === true ? (
        // Keyset pagination: the next page is fetched with the opaque cursor, never a page
        // number, because a project created while you read shifts every offset.
        <p className="rs-muted">More projects available — cursor: {projects.data.page.next_cursor}</p>
      ) : null}
    </div>
  );
}
