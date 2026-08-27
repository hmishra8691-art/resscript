/**
 * The editor region: the tree in the rail, the selected node in the main pane (UI §1.1).
 *
 * This is the container — it owns the two things a tree editor cannot avoid owning: the row set
 * (optimistically updated, rolled back whole on a refusal) and the version's write path
 * (`useVersionWriter`, one ETag for every mutation in the version). Everything visual is a child
 * component that takes data and callbacks, which is why the drag planner and the patch translator
 * are testable without a DOM.
 *
 * ## Selection, expansion and the route that is not here yet
 *
 * UI §2 wants node selection to be a ROUTE (`edit/[nodeId]`) with the tree in a layout, so
 * back/forward and shareable links come free and the tree never remounts. That is a routing change
 * to `app/(app)/[org]/s/[surveyId]/`, and it is deliberately not bundled with the milestone that
 * establishes what the tree IS. Selection and expansion therefore live in this component's state
 * rather than half-living in `state/ui-store.ts`: the store's `selectedNodeId` and
 * `expandedNodeIds` are the right home once selection is a route (expansion is per version, which
 * the store does not model yet), and two owners of the same fact is the bug UI §4.1 forbids.
 *
 * ## Also deferred, and why it is a seam rather than a rewrite
 *
 * Virtualization and the `/` filter (§3.3's 2,000-row budget) both consume `flattenVisible`'s flat
 * array. Neither changes a single planner, a request shape or a callback, which is the test that
 * they are additions rather than redesigns.
 *
 * ## Soft delete is the undo buffer
 *
 * `DELETE /nodes/{id}` is soft (DB §4.1), and that is what makes undo correct over a normalized
 * model: the id survives, so every rule AST that referenced the node is still valid when
 * `POST /undelete` brings it back (UI §5.4). The deleted row is therefore kept in the row set with
 * its `deleted_at` set — hidden by default, shown dimmed by the toggle, and offered as an Undo in
 * the toast. It is an in-session buffer: a refetch shows whatever the route chooses to return.
 */

'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, apiFetch } from '@/lib/api-client';
import { ConflictDialog } from './ConflictDialog';
import { NodeInspector } from './NodeInspector';
import { TreeView } from './TreeView';
import { TypePicker } from './TypePicker';
import { useVersionWriter } from './useVersionWriter';
import type { MovePlan } from './tree-model';
import {
  applyMoveOptimistically,
  buildIndex,
  moveBody,
  planInsert,
  replaceRow,
  treeCounts,
} from './tree-model';
import type { NodeKind, TreeRowWire } from './wire';
import { nodeOf, rowsOf } from './wire';

const TREE_QUERY = '?fields=summary&include=rules,badges';

export interface SurveyTreePaneVersion {
  readonly id: string;
  readonly version_no: number;
  readonly status: string;
  readonly revision: number;
}

export interface SurveyTreePaneProps {
  readonly versions: readonly SurveyTreePaneVersion[];
  readonly defaultLanguage: string;
}

export function SurveyTreePane(props: SurveyTreePaneProps): React.JSX.Element {
  const { versions, defaultLanguage } = props;
  // The editor edits a DRAFT; the preview pane renders a compiled artifact. Two different
  // questions, so two different selections — the rail says which version it is editing rather
  // than inheriting the preview's choice and silently going read-only.
  const [versionId, setVersionId] = useState<string | null>(
    versions.find((version) => version.status === 'draft')?.id ?? versions[0]?.id ?? null,
  );
  const version = versions.find((entry) => entry.id === versionId) ?? null;
  const frozen = version !== null && version.status !== 'draft';

  const [rows, setRows] = useState<readonly TreeRowWire[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [showDeleted, setShowDeleted] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [undoNodeId, setUndoNodeId] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [newKind, setNewKind] = useState<NodeKind>('question');
  const [newRef, setNewRef] = useState('');
  const [newType, setNewType] = useState<string | null>(null);

  const writer = useVersionWriter(versionId ?? 'none', { frozen });

  const loadTree = useCallback(
    async (id: string): Promise<void> => {
      try {
        const response = await apiFetch<unknown>('/versions/' + id + '/tree' + TREE_QUERY);
        const loaded = rowsOf<TreeRowWire>(response.data);
        setRows(loaded);
        setLoadError(null);
        // §3.3's opening outline: root blocks expanded, pages collapsed.
        setExpanded(new Set(loaded.filter((row) => row.parent_id === null).map((row) => row.id)));
      } catch (err: unknown) {
        setRows(null);
        setLoadError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err));
      }
    },
    [],
  );

  useEffect(() => {
    if (versionId === null) return;
    setSelectedId(null);
    void loadTree(versionId);
  }, [versionId, loadTree]);

  const index = useMemo(() => buildIndex(rows ?? []), [rows]);
  const counts = useMemo(() => treeCounts(rows ?? []), [rows]);

  const announce = useCallback((text: string): void => {
    setMessage(text);
  }, []);

  /* ---- mutations ---------------------------------------------------------- */

  const move = useCallback(
    async (plan: MovePlan): Promise<void> => {
      const snapshot = rows;
      if (snapshot === null) return;
      // Optimistic: one row's `parent_id` and a provisional `sort_key`. Rolled back WHOLE on a
      // refusal — a partially rolled-back tree is how a node ends up rendered twice.
      setRows(applyMoveOptimistically(snapshot, plan));
      announce(plan.description);
      const result = await writer.write<unknown>('/nodes/' + plan.node_id + '/move', {
        method: 'POST',
        body: moveBody(plan),
        description: plan.description,
      });
      if (result === null) {
        setRows(snapshot);
        announce(plan.description + ' — not saved');
        return;
      }
      const node = nodeOf(result);
      if (node !== undefined) {
        setRows((current) =>
          current === null
            ? current
            : replaceRow(current, plan.node_id, {
                parent_id: node.parent_id ?? plan.parent_id,
                ...(node.sort_key === undefined ? {} : { sort_key: node.sort_key }),
              }),
        );
      }
    },
    [rows, writer, announce],
  );

  const remove = useCallback(
    async (nodeId: string): Promise<void> => {
      const snapshot = rows;
      if (snapshot === null) return;
      const row = index.byId.get(nodeId);
      // `cascade_rules=orphan`: the rules that target this node are kept, orphaned, so undo
      // restores a node whose logic is still attached. `delete` would make undo a lie.
      setRows(replaceRow(snapshot, nodeId, { deleted_at: new Date().toISOString() }));
      const result = await writer.write<unknown>(
        '/nodes/' + nodeId + '?cascade_rules=orphan',
        { method: 'DELETE', description: 'deleted ' + (row?.ref ?? nodeId) },
      );
      if (result === null) {
        setRows(snapshot);
        return;
      }
      if (selectedId === nodeId) setSelectedId(null);
      setUndoNodeId(nodeId);
      announce('deleted ' + (row?.ref ?? nodeId) + ' — undo is available');
    },
    [rows, index, writer, announce, selectedId],
  );

  const undelete = useCallback(
    async (nodeId: string): Promise<void> => {
      const snapshot = rows;
      if (snapshot === null) return;
      const row = index.byId.get(nodeId);
      setRows(replaceRow(snapshot, nodeId, { deleted_at: null }));
      const result = await writer.write<unknown>('/nodes/' + nodeId + '/undelete', {
        method: 'POST',
        description: 'restored ' + (row?.ref ?? nodeId),
      });
      if (result === null) {
        setRows(snapshot);
        return;
      }
      setUndoNodeId((current) => (current === nodeId ? null : current));
      announce('restored ' + (row?.ref ?? nodeId));
    },
    [rows, index, writer, announce],
  );

  const duplicate = useCallback(
    async (nodeId: string): Promise<void> => {
      const row = index.byId.get(nodeId);
      const ref = (row?.ref ?? 'NODE') + '_copy';
      const result = await writer.write<unknown>('/nodes/' + nodeId + '/duplicate', {
        method: 'POST',
        body: { ref },
        description: 'duplicated ' + (row?.ref ?? nodeId) + ' as ' + ref,
      });
      if (result === null) return;
      // A duplicate is a SUBTREE: rather than guess how the response nests it, refetch the
      // outline — one request, and the tree is the cheap payload (§3.3).
      if (versionId !== null) await loadTree(versionId);
      announce('duplicated ' + (row?.ref ?? nodeId) + ' as ' + ref);
    },
    [index, writer, versionId, loadTree, announce],
  );

  const add = useCallback(async (): Promise<void> => {
    const outcome = planInsert(index, selectedId, newKind);
    if (!outcome.ok) {
      announce(outcome.reason);
      return;
    }
    const ref = newRef.trim();
    if (ref === '') {
      announce('a ref is required — it is the handle every rule and export column is named from');
      return;
    }
    const result = await writer.write<unknown>(
      '/versions/' + (versionId ?? '') + '/nodes',
      {
        method: 'POST',
        body: {
          node_kind: newKind,
          parent_id: outcome.plan.parent_id,
          ...(outcome.plan.after_id === undefined ? {} : { after_id: outcome.plan.after_id }),
          ref,
          ...(newKind === 'question' && newType !== null ? { question_type: newType } : {}),
        },
        description: 'added ' + newKind + ' ' + ref,
      },
    );
    if (result === null) return;
    const node = nodeOf(result);
    if (node !== undefined) {
      setRows((current) => (current === null ? [node] : [...current, node]));
      setSelectedId(node.id);
      const parentId = outcome.plan.parent_id;
      if (parentId !== null) setExpanded((current) => new Set([...current, parentId]));
    } else if (versionId !== null) {
      await loadTree(versionId);
    }
    setNewRef('');
    announce('added ' + newKind + ' ' + ref);
  }, [index, selectedId, newKind, newRef, newType, writer, versionId, loadTree, announce]);

  /* ---- render ------------------------------------------------------------- */

  if (versionId === null) {
    return (
      <section aria-label="Survey tree" className="rs-card">
        <p className="rs-muted">This survey has no versions yet.</p>
      </section>
    );
  }

  const undoRow = undoNodeId === null ? null : (index.byId.get(undoNodeId) ?? null);

  return (
    <>
      <section
        aria-label="Survey tree"
        className="rs-card"
        style={{ width: 300, flexShrink: 0, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}
      >
        <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
          <h2 style={{ fontSize: 13 }}>Structure</h2>
          <label style={{ display: 'flex', gap: 4, alignItems: 'center', marginLeft: 'auto' }}>
            <span className="rs-muted">Editing</span>
            <select
              className="rs-input"
              aria-label="Version to edit"
              data-testid="tree-version"
              value={versionId}
              onChange={(event) => {
                setVersionId(event.target.value);
              }}
            >
              {versions.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  v{entry.version_no} — {entry.status} (r{entry.revision})
                </option>
              ))}
            </select>
          </label>
        </div>

        {writer.readOnly ? (
          <p role="alert" data-testid="tree-frozen">
            This version is frozen — clone a new draft to edit.
          </p>
        ) : null}
        {writer.error === null ? null : (
          <p role="alert" data-testid="tree-error">
            {writer.error}{' '}
            <button type="button" className="rs-button" onClick={writer.clearError}>
              dismiss
            </button>
          </p>
        )}
        {loadError === null ? null : (
          <p role="alert" data-testid="tree-load-error">
            {loadError}
          </p>
        )}

        <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <input
            type="checkbox"
            data-testid="tree-show-deleted"
            checked={showDeleted}
            onChange={(event) => {
              setShowDeleted(event.target.checked);
            }}
          />
          <span className="rs-muted">show deleted</span>
        </label>

        {rows === null ? (
          <p className="rs-muted">Loading tree…</p>
        ) : (
          <TreeView
            index={index}
            selectedId={selectedId}
            expanded={expanded}
            showDeleted={showDeleted}
            readOnly={writer.readOnly}
            onSelect={setSelectedId}
            onToggle={(nodeId) => {
              setExpanded((current) => {
                const next = new Set(current);
                if (next.has(nodeId)) next.delete(nodeId);
                else next.add(nodeId);
                return next;
              });
            }}
            onMove={(plan) => {
              void move(plan);
            }}
            onRefuse={announce}
            onDelete={(nodeId) => {
              void remove(nodeId);
            }}
            onUndelete={(nodeId) => {
              void undelete(nodeId);
            }}
            onDuplicate={(nodeId) => {
              void duplicate(nodeId);
            }}
          />
        )}

        <p className="rs-muted" data-testid="tree-counts">
          {counts.blocks} blocks · {counts.pages} pages · {counts.questions} questions ·{' '}
          {counts.rules} rules
        </p>

        <fieldset
          disabled={writer.readOnly}
          style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 4 }}
        >
          <legend className="rs-muted">Add</legend>
          <select
            className="rs-input"
            aria-label="Kind to add"
            data-testid="add-kind"
            value={newKind}
            onChange={(event) => {
              setNewKind(event.target.value as NodeKind);
            }}
          >
            <option value="block">block</option>
            <option value="page">page</option>
            <option value="question">question</option>
            <option value="text">text</option>
          </select>
          {newKind === 'question' ? (
            <TypePicker value={newType} onChange={setNewType} testId="add-type" />
          ) : null}
          <input
            className="rs-input"
            aria-label="New node ref"
            data-testid="add-ref"
            placeholder={newKind === 'question' ? 'Q1' : newKind === 'page' ? 'P1' : 'B1'}
            value={newRef}
            onChange={(event) => {
              setNewRef(event.target.value);
            }}
          />
          <button
            type="button"
            className="rs-button"
            data-testid="add-node"
            onClick={() => {
              void add();
            }}
          >
            Add {newKind}
          </button>
        </fieldset>
      </section>

      <section aria-label="Node editor" style={{ flex: 1, minWidth: 0, overflow: 'auto' }}>
        {/* One polite live region for the whole editor region: every accepted move, refusal and
            delete lands here, so a keyboard user hears the same thing a sighted user sees. */}
        <p aria-live="polite" role="status" data-testid="tree-announcement" className="rs-muted">
          {message ?? ''}
        </p>

        {undoRow === null ? null : (
          <p className="rs-card" data-testid="undo-toast">
            Deleted {undoRow.ref ?? undoNodeId}.{' '}
            <button
              type="button"
              className="rs-button"
              data-testid="undo-delete"
              onClick={() => {
                if (undoNodeId !== null) void undelete(undoNodeId);
              }}
            >
              Undo
            </button>
          </p>
        )}

        {writer.conflict === null ? null : (
          <ConflictDialog
            conflict={writer.conflict}
            onReload={() => {
              writer.dismissConflict();
              void loadTree(versionId);
              setReloadToken((token) => token + 1);
            }}
            onDiscard={writer.dismissConflict}
          />
        )}

        {selectedId === null ? (
          <p className="rs-muted">
            Select a node in the tree to edit it. {counts.questions} questions in this version.
          </p>
        ) : (
          <NodeInspector
            key={selectedId}
            nodeId={selectedId}
            writer={writer}
            lang={defaultLanguage}
            announce={announce}
            onRefuse={announce}
            onRowPatch={(nodeId, patch) => {
              setRows((current) => (current === null ? current : replaceRow(current, nodeId, patch)));
            }}
            reloadToken={reloadToken}
          />
        )}
      </section>
    </>
  );
}
