/**
 * The survey page — the editor region (P1-03's tree and node inspector) plus the bottom panes:
 * Preview (P1-11) and P1-12's Logic, Translations, Exports and Field.
 *
 * The geometry this page reserved for the tree is now occupied by it: rail for the tree, main for
 * the node editor, bottom pane tabbed (UI §1.1). Both version axes are still rendered as two
 * columns — `status` and `compile_state`, never collapsed into one "state" field (K §3) — and the
 * table moved above the editor region because the tree now needs the height the placeholder did
 * not.
 *
 * TWO version selections, on purpose. The bottom pane's select chooses what to PREVIEW (a
 * compiled artifact) and the rail's chooses what to EDIT (a draft). Sharing one selection would
 * mean either previewing an uncompiled draft or editing a frozen version by default, and the
 * second is a read-only editor the user did not ask for.
 */

'use client';

import Link from 'next/link';
import { use, useState } from 'react';
import { useOrgs, useSurvey } from '@/lib/queries';
import { useEntitlement } from '@/hooks/useEntitlement';
import { DebugPanel } from '@/components/preview/DebugPanel';
import { PreviewPanel } from '@/components/preview/PreviewPanel';
import { LanguageManager } from '@/components/i18n/LanguageManager';
import { ExportDialog } from '@/components/exports/ExportDialog';
import { FieldDashboard } from '@/components/field/FieldDashboard';
import { RulesPanel } from '@/components/rules/RulesPanel';
import { PublishPane } from '@/components/publish/PublishPane';
import { SurveyTreePane } from '@/components/tree/SurveyTreePane';

const PANES = [
  'Properties',
  'Logic',
  'Validation',
  'Code',
  'Problems',
  'Publish',
  'Preview',
  'Translations',
  'Exports',
  'Field',
] as const;

/**
 * Preview is P1-11's; Logic/Translations/Exports/Field are P1-12's. Properties is deliberately
 * NOT live: P1-03's node inspector renders in the main region, and a second copy of the same
 * fields in a tab is two editors for one node.
 */
const LIVE_PANES: readonly (typeof PANES)[number][] = [
  'Logic',
  'Publish',
  'Preview',
  'Translations',
  'Exports',
  'Field',
];

export default function SurveyPage({
  params,
}: {
  params: Promise<{ org: string; surveyId: string }>;
}): React.JSX.Element {
  const { org, surveyId } = use(params);
  const survey = useSurvey(surveyId);
  // The viewer's role in the active org, as the membership row states it — what the export
  // dialog's floor rendering and the language manager's disabled controls explain from.
  const orgs = useOrgs();
  const role = orgs.data?.data.find((m) => m.is_active)?.role ?? null;
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

      <section aria-label="Versions" style={{ flexShrink: 0 }}>
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
        <p className="rs-muted" style={{ marginTop: 4 }}>
          Advanced logic: {advancedLogic.enabled ? 'available' : 'not in your plan'}
        </p>
      </section>

      <div style={{ display: 'flex', gap: 8, flex: 1, minHeight: 0 }}>
        <SurveyTreePane versions={versions} defaultLanguage={survey.data.default_language} />
      </div>

      <section
        aria-label="Editor panes"
        className="rs-card"
        style={
          LIVE_PANES.includes(activePane) ? { flexShrink: 0 } : { height: 120, flexShrink: 0 }
        }
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
              disabled={!LIVE_PANES.includes(tab)}
              onClick={() => {
                setActivePane(tab);
              }}
            >
              {tab}
            </button>
          ))}
        </div>
        {LIVE_PANES.includes(activePane) && selectedVersionId !== null ? (
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
            {activePane === 'Preview' ? (
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
            ) : activePane === 'Logic' ? (
              // Rules are draft-writable only (content.tg_draft_only); the panel reads any
              // visible version and the API answers 409 frozen_version on a write.
              <RulesPanel versionId={selectedVersionId} />
            ) : activePane === 'Publish' ? (
              // P1-08's gate, reachable from the studio at last: the dialog was built and
              // unit-tested against props and had no container until PublishPane.
              <PublishPane
                versionId={selectedVersionId}
                surveyId={survey.data.id}
                role={role}
                versionNo={
                  survey.data.versions.find((v) => v.id === selectedVersionId)?.version_no ?? 0
                }
              />
            ) : activePane === 'Translations' ? (
              <LanguageManager versionId={selectedVersionId} role={role} />
            ) : activePane === 'Exports' ? (
              <ExportDialog versionId={selectedVersionId} role={role} />
            ) : (
              <FieldDashboard versionId={selectedVersionId} />
            )}
          </div>
        ) : (
          <p className="rs-muted" style={{ marginTop: 4 }}>
            The node inspector lives in the main region above (P1-03). Validation, Monaco and the
            QA panel arrive in P1-07 and P1-11.
          </p>
        )}
      </section>
    </div>
  );
}
