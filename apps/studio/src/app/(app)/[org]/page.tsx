/**
 * Org overview: recent projects and surveys. A VIEW, so it ships almost no interactivity —
 * UI §2's RSC/client rule puts editors in client islands and views in server components; this
 * one stays a client component only because it reads the same TanStack Query cache the rest of
 * the shell uses, and a duplicate server fetch would double the request count on first paint.
 */

'use client';

import Link from 'next/link';
import { use } from 'react';
import { useProjects, useSurveys } from '@/lib/queries';

export default function OrgOverviewPage({
  params,
}: {
  params: Promise<{ org: string }>;
}): React.JSX.Element {
  const { org } = use(params);
  const projects = useProjects(org);
  const surveys = useSurveys(org);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <section>
        <h1 style={{ fontSize: 16, marginBottom: 4 }}>Projects</h1>
        {projects.isLoading ? (
          <p className="rs-muted">Loading…</p>
        ) : (projects.data?.data ?? []).length === 0 ? (
          <div className="rs-card">
            {/* UI §13.4: an empty state names the next action rather than saying "no data". */}
            <p>No projects yet. A project holds the surveys for one study.</p>
            <Link className="rs-button" data-variant="primary" href={'/' + org + '/projects'}>
              Create a project
            </Link>
          </div>
        ) : (
          <ul style={{ listStyle: 'none' }}>
            {(projects.data?.data ?? []).slice(0, 8).map((project) => (
              <li key={project.id}>
                <Link href={'/' + org + '/projects/' + project.id}>
                  {project.ref} · {project.name}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 style={{ fontSize: 16, marginBottom: 4 }}>Recent surveys</h2>
        {(surveys.data?.data ?? []).length === 0 ? (
          <p className="rs-muted">No surveys yet.</p>
        ) : (
          <ul style={{ listStyle: 'none' }}>
            {(surveys.data?.data ?? []).slice(0, 8).map((survey) => (
              <li key={survey.id}>
                <Link href={'/' + org + '/s/' + survey.id}>
                  {survey.ref} · {survey.name}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
