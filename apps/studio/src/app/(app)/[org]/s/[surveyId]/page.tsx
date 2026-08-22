/**
 * The survey page — a PLACEHOLDER for the tree that lands in P1-03, plus the one bottom pane
 * that exists today: Preview (P1-11).
 *
 * It renders the version list (both axes: `status` and `compile_state`, never collapsed into
 * one "state" field) and reserves the layout the editor will occupy: rail for the tree, main
 * for the node editor, bottom pane for Properties/Logic/Validation/Code/Problems/Preview.
 *
 * Keeping the region here rather than adding it in P1-03 is deliberate — the shell's geometry
 * is what the tree slots into, and discovering the geometry is wrong while also building a
 * virtualized 2,000-row tree is two problems at once. The Preview tab is live because P1-11
 * ships it: the sandboxed iframe and the debug session, side by side, against a version the
 * user picks from the list.
 */

'use client';

import Link from 'next/link';
import { use, useState } from 'react';
import { useSurvey } from '@/lib/queries';
import { useEntitlement } from '@/hooks/useEntitlement';
import { DebugPanel } from '@/components/preview/DebugPanel';
import { PreviewPanel } from '@/components/preview/PreviewPanel';

const PANES = ['Properties', 'Logic', 'Validation', 'Code', 'Problems', 'Preview'] as const;

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
  const [activePane, setActivePane] = useState<(typeof PANES)[number]>('Properties');
  const [previewVersionId, setPreviewVersionId] = useState<string | null>(null);

  if (survey.isLoading) return <p className="rs-muted">Loading survey…</p>;
  if (survey.isError || survey.data === undefined) return <p role="alert">Survey not found.</p>;

  const versions = survey.data.versions;
  // Default to the first version that could actually render — a compiled one — falling back to
  // whatever exists so the panel's own "compile first" refusal explains the rest.
  const selectedVersionId =
    previewVersionId ??
    versions.find((v) => v.compile_state === 'compiled')?.id ??
    versions[0]?.id ??
    null;

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
              {versions.map((version) => (
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

      <section
        aria-label="Editor panes"
        className="rs-card"
        style={activePane === 'Preview' ? { flexShrink: 0 } : { height: 120, flexShrink: 0 }}
      >
        <div role="tablist" aria-label="Bottom pane" style={{ display: 'flex', gap: 4 }}>
          {PANES.map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={tab === activePane}
              tabIndex={tab === activePane ? 0 : -1}
              className="rs-button"
              // Preview is P1-11's; the rest arrive with P1-03 and P1-07.
              disabled={tab !== 'Preview'}
              onClick={() => {
                setActivePane(tab);
              }}
            >
              {tab}
            </button>
          ))}
        </div>
        {activePane === 'Preview' && selectedVersionId !== null ? (
          <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <span className="rs-muted">Version</span>
              <select
                className="rs-input"
                value={selectedVersionId}
                onChange={(event) => {
                  setPreviewVersionId(event.target.value);
                }}
              >
                {versions.map((version) => (
                  <option key={version.id} value={version.id}>
                    v{version.version_no} — {version.status} / {version.compile_state}
                  </option>
                ))}
              </select>
            </label>
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <div style={{ flex: 2, minWidth: 320 }}>
                <PreviewPanel
                  versionId={selectedVersionId}
                  defaultLanguage={survey.data.default_language}
                />
              </div>
              <div style={{ flex: 1, minWidth: 320 }}>
                <DebugPanel versionId={selectedVersionId} />
              </div>
            </div>
          </div>
        ) : (
          <p className="rs-muted" style={{ marginTop: 4 }}>
            Node inspector, logic builder, Monaco and the QA panel arrive in P1-03, P1-07 and
            P1-11.
          </p>
        )}
      </section>
    </div>
  );
}
