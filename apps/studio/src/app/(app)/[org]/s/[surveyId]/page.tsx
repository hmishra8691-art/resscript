/**
 * The survey page — a PLACEHOLDER for the tree that lands in P1-03.
 *
 * It renders the version list (both axes: `status` and `compile_state`, never collapsed into
 * one "state" field) and reserves the layout the editor will occupy: rail for the tree, main
 * for the node editor, bottom pane for Properties/Logic/Validation/Code/Problems/Preview.
 *
 * Keeping the region here rather than adding it in P1-03 is deliberate — the shell's geometry
 * is what the tree slots into, and discovering the geometry is wrong while also building a
 * virtualized 2,000-row tree is two problems at once.
 */

'use client';

import Link from 'next/link';
import { use } from 'react';
import { useSurvey } from '@/lib/queries';
import { useEntitlement } from '@/hooks/useEntitlement';

export default function SurveyPage({
  params,
}: {
  params: Promise<{ org: string; surveyId: string }>;
}): React.JSX.Element {
  const { org, surveyId } = use(params);
  const survey = useSurvey(surveyId);
  // The seam, exercised so it cannot rot: the entitlement hook is called where the real gate
  // will be (arch §5 — one `billing.entitlement()` answer shared by UI, API and compiler).
  const advancedLogic = useEntitlement('advanced_logic');

  if (survey.isLoading) return <p className="rs-muted">Loading survey…</p>;
  if (survey.isError || survey.data === undefined) return <p role="alert">Survey not found.</p>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, height: '100%' }}>
      <nav aria-label="Breadcrumb">
        <Link href={'/' + org + '/projects/' + survey.data.project_id}>Project</Link>{' '}
        <span aria-hidden="true">/</span> <span aria-current="page">{survey.data.ref}</span>
      </nav>

      <header style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
        <h1 style={{ fontSize: 16 }}>{survey.data.name}</h1>
        <span className="rs-muted">{survey.data.ref}</span>
      </header>

      <div style={{ display: 'flex', gap: 8, flex: 1, minHeight: 0 }}>
        <section
          aria-label="Survey tree"
          className="rs-card"
          style={{ width: 260, flexShrink: 0, overflow: 'auto' }}
        >
          <h2 style={{ fontSize: 13, marginBottom: 4 }}>Structure</h2>
          <p className="rs-muted">
            The survey tree lands in P1-03. This rail is where it renders — blocks, pages,
            questions, and the inline logic annotations that make rules visible in place.
          </p>
        </section>

        <section aria-label="Versions" style={{ flex: 1, minWidth: 0 }}>
          <h2 style={{ fontSize: 13, marginBottom: 4 }}>Versions</h2>
          <table className="rs-table">
            <thead>
              <tr>
                <th>#</th>
                {/* Two orthogonal axes (K §3). A single "state" column is how a failed compile
                    gets shown as live. */}
                <th>Status</th>
                <th>Compile state</th>
                <th>Revision</th>
              </tr>
            </thead>
            <tbody>
              {survey.data.versions.map((version) => (
                <tr key={version.id}>
                  <td>{version.version_no}</td>
                  <td>{version.status}</td>
                  <td>{version.compile_state}</td>
                  <td className="rs-muted">r{version.revision}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="rs-muted" style={{ marginTop: 8 }}>
            Advanced logic: {advancedLogic.enabled ? 'available' : 'not in your plan'}
          </p>
        </section>
      </div>

      <section aria-label="Editor panes" className="rs-card" style={{ height: 120, flexShrink: 0 }}>
        <div role="tablist" aria-label="Bottom pane" style={{ display: 'flex', gap: 4 }}>
          {['Properties', 'Logic', 'Validation', 'Code', 'Problems', 'Preview'].map((tab, index) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={index === 0}
              tabIndex={index === 0 ? 0 : -1}
              className="rs-button"
              disabled
            >
              {tab}
            </button>
          ))}
        </div>
        <p className="rs-muted" style={{ marginTop: 4 }}>
          Node inspector, logic builder, Monaco and the QA panel arrive in P1-03, P1-07 and P1-11.
        </p>
      </section>
    </div>
  );
}
