/**
 * One project: its surveys, plus create / rename / archive.
 *
 * Creating a survey also creates its `draft` version server-side (API §2.3), so the "Open"
 * link always resolves to something addressable.
 */

'use client';

import Link from 'next/link';
import { use, useState } from 'react';
import { ApiError } from '@/lib/api-client';
import { useCreateSurvey, useSurveys, useUpdateSurvey } from '@/lib/queries';

export default function ProjectPage({
  params,
}: {
  params: Promise<{ org: string; projectId: string }>;
}): React.JSX.Element {
  const { org, projectId } = use(params);
  const surveys = useSurveys(org, projectId);
  const createSurvey = useCreateSurvey(org, projectId);
  const updateSurvey = useUpdateSurvey(org);
  const [ref, setRef] = useState('');
  const [name, setName] = useState('');
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <nav aria-label="Breadcrumb">
        <Link href={'/' + org + '/projects'}>Projects</Link> <span aria-hidden="true">/</span>{' '}
        <span aria-current="page">{projectId}</span>
      </nav>
      <h1 style={{ fontSize: 16 }}>Surveys</h1>

      <form
        className="rs-card"
        style={{ display: 'flex', gap: 6, alignItems: 'flex-end' }}
        onSubmit={(event) => {
          event.preventDefault();
          setError(null);
          createSurvey.mutate(
            { ref, name },
            {
              onSuccess: () => {
                setRef('');
                setName('');
              },
              onError: (err) =>
                setError(
                  err instanceof ApiError ? (err.detailFor('ref') ?? err.message) : 'Could not create survey',
                ),
            },
          );
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <label htmlFor="survey-ref">Ref</label>
          <input id="survey-ref" className="rs-input" required value={ref} onChange={(e) => setRef(e.target.value)} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
          <label htmlFor="survey-name">Name</label>
          <input id="survey-name" className="rs-input" required value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <button className="rs-button" data-variant="primary" type="submit" disabled={createSurvey.isPending}>
          Create survey
        </button>
      </form>
      {error === null ? null : (
        <p role="alert" style={{ color: 'var(--rs-danger)' }}>
          {error}
        </p>
      )}

      <table className="rs-table">
        <thead>
          <tr>
            <th>Ref</th>
            <th>Name</th>
            <th>State</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {(surveys.data?.data ?? []).map((survey) => (
            <tr key={survey.id}>
              <td>
                <Link href={'/' + org + '/s/' + survey.id}>{survey.ref}</Link>
              </td>
              <td>
                {renaming?.id === survey.id ? (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      updateSurvey.mutate(
                        { id: survey.id, name: renaming.name },
                        { onSuccess: () => setRenaming(null) },
                      );
                    }}
                  >
                    <input
                      className="rs-input"
                      aria-label={'Rename ' + survey.ref}
                      value={renaming.name}
                      autoFocus
                      onChange={(e) => setRenaming({ id: survey.id, name: e.target.value })}
                    />
                  </form>
                ) : (
                  survey.name
                )}
              </td>
              <td>{survey.archived_at === null ? 'active' : 'archived'}</td>
              <td style={{ display: 'flex', gap: 4 }}>
                <button
                  type="button"
                  className="rs-button"
                  onClick={() => setRenaming({ id: survey.id, name: survey.name })}
                >
                  Rename
                </button>
                <button
                  type="button"
                  className="rs-button"
                  onClick={() =>
                    updateSurvey.mutate({ id: survey.id, archived: survey.archived_at === null })
                  }
                >
                  {/* Archive is a SOFT delete and frees the `ref`; a hard delete is a second,
                      deliberate act and is admin-only. */}
                  {survey.archived_at === null ? 'Archive' : 'Restore'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
