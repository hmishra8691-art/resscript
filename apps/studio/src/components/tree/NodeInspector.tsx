/**
 * The node inspector — one node at a time, beside the tree (UI §1.1: "Main editor. One node at a
 * time. Whatever the tree selects, this edits.").
 *
 * The body is fetched LAZILY, per selection: §3.3 keeps options, validation, masks and scripts out
 * of the tree payload precisely so a 2,000-question outline stays a summary, and this is the
 * request that pays for one node's detail (`GET /nodes/{id}?include=…`).
 *
 * ## What is editable here, and what refuses
 *
 * `ref`, `label`, `instruction` and `required` are studio's own fields, edited here — never by a
 * plugin editor, which the patch allowlist enforces from the other side (`editor-bridge.ts`:
 * "Everything outside this list is studio's").
 *
 * `question_type` is READ-ONLY, and the control says why rather than being mysteriously inert:
 * API §2.5 rejects the change because a different type emits different variables, so the honest
 * operation is delete-and-recreate. A picker that offered the change and surfaced a 4xx would be
 * teaching the author that the API is arbitrary.
 *
 * ## Commit timing
 *
 * Text fields commit on blur; structural edits (add/move/delete an option, a plugin config patch)
 * fire immediately. That is UI §5.2's split, and the reason for the second half is stated there:
 * "a drag that has visibly completed must be persisted; deferring it means a refresh loses it".
 * The 400 ms debounce §5.2 also asks for wants the mutation queue that lands with it; blur is the
 * flush point that exists today, and it never loses a keystroke.
 */

'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError, apiFetch } from '@/lib/api-client';
import { EmittedVariablesPanel } from './EmittedVariablesPanel';
import { ItemsEditor } from './ItemsEditor';
import { QuestionEditorShell } from './QuestionEditorShell';
import { TypePicker, pluginFor } from './TypePicker';
import type { ItemMovePlan, ParsedItem } from './items-model';
import { applyItemMoveOptimistically, itemMoveBody } from './items-model';
import type { VersionWriter } from './useVersionWriter';
import type {
  EmittedVariable,
  EmittedVariableWire,
  ItemWire,
  NodeBody,
  NodeBodyWire,
  TreeRowWire,
} from './wire';
import { normalizeEmitted, normalizeNode, normalizeNodeResponse, rowsOf } from './wire';

const NODE_INCLUDE = '?include=items,cells,validation,masks,scripts,rules';

/**
 * Which questions get the option list — decided from the registry's CATEGORY, never from a type
 * id, so P1-04's "adding a plugin touches no studio file" survives this component too. Items are
 * a node-level resource (schema §5.1) that any question may carry, so a question that already has
 * items shows them regardless of its category.
 */
const ITEM_BEARING_CATEGORIES: readonly string[] = ['choice', 'grid', 'ranking', 'scale'];

export interface NodeInspectorProps {
  readonly nodeId: string;
  readonly writer: VersionWriter;
  readonly lang: string;
  readonly announce: (message: string) => void;
  readonly onRefuse: (reason: string) => void;
  /** Keep the tree row in step with a field the inspector just changed. */
  readonly onRowPatch: (nodeId: string, patch: Partial<TreeRowWire>) => void;
  /** Bumped by the pane to force a refetch — the conflict dialog's "reload" is one. */
  readonly reloadToken: number;
}

export function NodeInspector(props: NodeInspectorProps): React.JSX.Element {
  const { nodeId, writer, lang } = props;
  const readOnly = writer.readOnly;
  const [node, setNode] = useState<NodeBody | null>(null);
  const [items, setItems] = useState<readonly ItemWire[]>([]);
  const [created, setCreated] = useState<readonly EmittedVariable[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [draftRef, setDraftRef] = useState<string | null>(null);
  const [draftLabel, setDraftLabel] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setNode(null);
    setError(null);
    setDraftRef(null);
    setDraftLabel(null);
    setCreated([]);
    apiFetch<unknown>('/nodes/' + nodeId + NODE_INCLUDE)
      .then((response) => {
        if (cancelled) return;
        const body = normalizeNodeResponse(response.data);
        if (body === null) {
          setError('the node response carried no node');
          return;
        }
        setNode(body);
        setItems(body.items);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [nodeId, props.reloadToken]);

  /** A node write: apply the server's node and its variable receipt. */
  const writeNode = useCallback(
    async (body: Readonly<Record<string, unknown>>, description: string): Promise<void> => {
      const before = node;
      if (before === null) return;
      const result = await writer.write<{
        node?: NodeBodyWire;
        variables_changed?: readonly EmittedVariableWire[];
        variables_created?: readonly EmittedVariableWire[];
      }>('/nodes/' + nodeId, { method: 'PATCH', body, description });
      if (result === null) {
        // Refused (frozen, or a conflict the dialog now owns). Nothing was applied optimistically
        // for a field edit, so there is nothing to roll back — the inputs still hold the draft.
        return;
      }
      const wire = result.node;
      if (wire !== undefined) {
        const next = normalizeNode(wire);
        // The PATCH response is the node ROW: no items on it, so the loaded ones are kept.
        setNode({ ...next, items: next.items.length > 0 ? next.items : before.items });
        /*
         * The outline shows the base-language TEXT, not the key.
         *
         * `next.label` is the node row's `label_key`, which since the `label_text` change is a key
         * like `label.qst_01H…` rather than the sentence the author typed. 09 §3.3 defines
         * `label_preview` as "first 80 chars of the base-language label", and the tree route
         * resolves it from `content.i18n_strings` — so echoing the key here would put an id in the
         * outline until the next full tree load quietly replaced it.
         *
         * When this write carried prose, that prose IS the new preview; otherwise fall back to the
         * row's own value, which is right for a `ref`-only or `required`-only edit.
         */
        const wrotePreview = typeof body['label_text'] === 'string' ? body['label_text'] : null;
        const preview = wrotePreview ?? next.label;
        props.onRowPatch(nodeId, {
          ref: next.ref,
          ...(preview === null ? {} : { label_preview: preview }),
          required: next.required,
        });
      }
      const receipt = result.variables_changed ?? result.variables_created ?? [];
      if (receipt.length > 0) setCreated(receipt.map((entry) => normalizeEmitted(entry)));
      props.announce(description);
    },
    [node, nodeId, writer, props],
  );

  const refetchItems = useCallback(async (): Promise<void> => {
    const response = await apiFetch<unknown>('/nodes/' + nodeId + '/items');
    setItems(rowsOf<ItemWire>(response.data, 'items'));
  }, [nodeId]);

  const moveItem = useCallback(
    async (plan: ItemMovePlan): Promise<void> => {
      const snapshot = items;
      setItems(applyItemMoveOptimistically(items, plan));
      const result = await writer.write<unknown>('/items/' + plan.item_id + '/move', {
        method: 'POST',
        body: itemMoveBody(plan),
        description: plan.description,
      });
      if (result === null) setItems(snapshot);
      else props.announce(plan.description);
    },
    [items, writer, props],
  );

  if (error !== null) return <p role="alert">{error}</p>;
  if (node === null) return <p className="rs-muted">Loading node…</p>;

  const plugin = pluginFor(node.questionType);
  const optionBearing =
    items.length > 0 ||
    (plugin !== undefined && ITEM_BEARING_CATEGORIES.includes(plugin.meta.category));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }} data-testid="node-inspector">
      <header style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <h2 style={{ fontSize: 14 }}>{node.ref ?? '(unnamed)'}</h2>
        <span className="rs-chip">{node.kind}</span>
        {node.deletedAt === null ? null : (
          <span className="rs-chip" data-testid="inspector-deleted">
            deleted
          </span>
        )}
      </header>

      {readOnly ? (
        <p role="alert" data-testid="inspector-read-only">
          This version is frozen — clone a new draft to edit.
        </p>
      ) : null}

      <div style={{ display: 'grid', gap: 4, maxWidth: 520 }}>
        <label style={{ display: 'grid', gap: 2 }}>
          <span className="rs-muted">Ref — the renameable handle</span>
          <input
            className="rs-input"
            data-testid="inspector-ref"
            disabled={readOnly}
            value={draftRef ?? node.ref ?? ''}
            onChange={(event) => {
              setDraftRef(event.target.value);
            }}
            onBlur={() => {
              const next = draftRef;
              setDraftRef(null);
              if (next === null || next === (node.ref ?? '')) return;
              // Renaming a ref renames the derived export columns (API §2.5), which is why the
              // receipt below is rendered rather than discarded.
              void writeNode({ ref: next }, `renamed ${node.ref ?? node.id} to ${next}`);
            }}
          />
        </label>

        <label style={{ display: 'grid', gap: 2 }}>
          <span className="rs-muted">Label</span>
          <textarea
            className="rs-input"
            data-testid="inspector-label"
            rows={2}
            disabled={readOnly}
            value={draftLabel ?? node.label ?? ''}
            onChange={(event) => {
              setDraftLabel(event.target.value);
            }}
            onBlur={() => {
              const next = draftLabel;
              setDraftLabel(null);
              if (next === null || next === (node.label ?? '')) return;
              // `label_text`, NOT `label`. `label` is the i18n KEY (03 §16 makes every string a
              // key into the base bundle); sending prose there stored the author's sentence AS the
              // key and left nothing in the bundle, so every label this pane wrote was a dangling
              // reference — twenty-one SCH-1008 errors on a four-question survey. `label_text`
              // has the server mint or reuse a key and write the base-language string in one
              // transaction.
              void writeNode({ label_text: next }, `relabelled ${node.ref ?? node.id}`);
            }}
          />
        </label>

        {node.questionType === null ? null : (
          <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <input
              type="checkbox"
              data-testid="inspector-required"
              disabled={readOnly}
              checked={node.required}
              onChange={(event) => {
                const required = event.target.checked;
                setNode({ ...node, required });
                void writeNode(
                  { required },
                  `${required ? 'required' : 'made optional'} ${node.ref ?? node.id}`,
                );
              }}
            />
            Required
          </label>
        )}

        {node.questionType === null ? null : (
          <div style={{ display: 'grid', gap: 2 }}>
            <span className="rs-muted">Question type</span>
            {/* Read-only on purpose — see the file header. */}
            <TypePicker value={node.questionType} disabled onChange={() => undefined} testId="inspector-type" />
            <p className="rs-muted" data-testid="inspector-type-locked">
              The type cannot be changed: a different type emits different variables, so the API
              rejects the edit. Delete this question and add one of the new type.
            </p>
          </div>
        )}
      </div>

      {Object.keys(node.config).length === 0 ? null : (
        <details data-testid="inspector-config">
          <summary>Config ({Object.keys(node.config).length} fields)</summary>
          <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 4 }}>
            {Object.entries(node.config).map(([key, value]) => (
              <div key={key} style={{ display: 'contents' }}>
                <dt className="rs-muted">{key}</dt>
                <dd>{JSON.stringify(value)}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}

      {node.questionType === null ? null : (
        <QuestionEditorShell
          node={{ ...node, items }}
          lang={lang}
          readOnly={readOnly}
          onRefuse={props.onRefuse}
          onPatch={(body) => {
            void writeNode(body, `changed ${node.ref ?? node.id}’s settings`);
          }}
        />
      )}

      {!optionBearing ? null : (
        <ItemsEditor
          itemKind="option"
          items={items}
          readOnly={readOnly}
          onRefuse={props.onRefuse}
          onMove={(plan) => {
            void moveItem(plan);
          }}
          onPatchItem={(itemId, patch) => {
            const snapshot = items;
            setItems(items.map((item) => (item.id === itemId ? { ...item, ...patch } : item)));
            void writer
              .write<unknown>('/items/' + itemId, {
                method: 'PATCH',
                body: patch,
                description: `edited option ${itemId}`,
              })
              .then((result) => {
                if (result === null) setItems(snapshot);
              });
          }}
          onDeleteItem={(itemId) => {
            const snapshot = items;
            setItems(items.filter((item) => item.id !== itemId));
            void writer
              .write<unknown>('/items/' + itemId, {
                method: 'DELETE',
                description: `deleted option ${itemId}`,
              })
              .then((result) => {
                if (result === null) setItems(snapshot);
              });
          }}
          onAddItem={(item) => {
            void writer
              .write<{ item?: ItemWire } | ItemWire>('/nodes/' + nodeId + '/items', {
                method: 'POST',
                body: { item_kind: 'option', ...item },
                description: `added option ${String(item.code)}`,
              })
              .then((result) => {
                if (result === null) return;
                void refetchItems();
              });
          }}
          onBulk={(mode, parsed: readonly ParsedItem[]) => {
            // ONE request for the whole array (API §2.5, "atomic"), not one per line.
            void writer
              .write<unknown>('/nodes/' + nodeId + '/items:bulk', {
                method: 'POST',
                body: {
                  item_kind: 'option',
                  mode,
                  items: parsed.map((item) => ({ ref: item.ref, code: item.code, label: item.label })),
                },
                description: `${mode === 'replace' ? 'replaced' : 'appended'} ${String(parsed.length)} options`,
              })
              .then((result) => {
                if (result === null) return;
                props.announce(
                  `${mode === 'replace' ? 'replaced' : 'appended'} ${String(parsed.length)} options`,
                );
                void refetchItems();
              });
          }}
        />
      )}

      {/* The stored set, with the last write's receipt layered over it: `variables_changed` is a
          SUBSET of what the question emits, so replacing the list with it would hide columns that
          did not change. */}
      <EmittedVariablesPanel
        variables={[
          ...node.emits.map(
            (variable) => created.find((entry) => entry.name === variable.name) ?? variable,
          ),
          ...created.filter((entry) => !node.emits.some((variable) => variable.name === entry.name)),
        ]}
        recentlyCreated={created.map((variable) => variable.name)}
      />
    </div>
  );
}
