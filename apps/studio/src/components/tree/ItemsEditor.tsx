/**
 * The option list — add, edit, reorder, delete, and the paste box.
 *
 * ═══ TWO COLUMNS THAT ARE NOT THE SAME COLUMN ═══
 *
 * `#` is display order. `Code` is the exported value. Schema §5.1 calls conflating them "a
 * classic data disaster", and the UI is where the conflation usually happens: a table that shows
 * one number per row teaches the author that dragging option 7 to the top renumbers it. So this
 * table shows BOTH, side by side, with the order column read-only (it is a consequence of the
 * list) and the code column an editable field (it is a decision). The reorder path physically
 * cannot touch a code — `itemMoveBody` has no access to one (`items-model.ts`).
 *
 * ═══ THE 60-BRAND PATH ═══
 *
 * Pasting a brand list is `POST /nodes/{id}/items:bulk` — ONE atomic request for the whole array
 * (API §2.5: "the paste-60-brands path. Atomic"), not sixty creates. `mode` is the author's
 * choice and it is spelled out rather than inferred: `replace` discards the codes that are there,
 * which for a tracker in field is a column change, and a UI that guessed would guess wrong on the
 * expensive one. Codes the paste did not state are assigned by position, and the box says how
 * many — silence there is how a tracker's columns quietly become 1…60 in paste order.
 *
 * Reordering is one `POST /items/{id}/move` per drag, with the same keyboard equivalent the tree
 * has (buttons plus `⌥↑`/`⌥↓`), for the same reasons — see `TreeView.tsx`'s header.
 */

'use client';

import { useState } from 'react';
import type { ItemMovePlan, ItemPlanOutcome, ParsedItem } from './items-model';
import { nextItemCode, parsePastedItems, planItemMove } from './items-model';
import { itemLabel, type ItemKind, type ItemWire } from './wire';

export interface ItemsEditorProps {
  readonly itemKind: ItemKind;
  readonly items: readonly ItemWire[];
  readonly readOnly: boolean;
  readonly onMove: (plan: ItemMovePlan) => void;
  readonly onPatchItem: (itemId: string, patch: Readonly<Record<string, unknown>>) => void;
  readonly onDeleteItem: (itemId: string) => void;
  readonly onAddItem: (item: { readonly ref: string; readonly code: number; readonly label: string }) => void;
  readonly onBulk: (mode: 'replace' | 'append', items: readonly ParsedItem[]) => void;
  readonly onRefuse: (reason: string) => void;
}

export function ItemsEditor(props: ItemsEditorProps): React.JSX.Element {
  const { items, readOnly, itemKind } = props;
  const [dragId, setDragId] = useState<string | null>(null);
  const [paste, setPaste] = useState('');
  const [pasteMode, setPasteMode] = useState<'replace' | 'append'>('append');
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({});

  const attempt = (outcome: ItemPlanOutcome): void => {
    if (outcome.ok === true) props.onMove(outcome.plan);
    else if (outcome.ok === false) props.onRefuse(outcome.reason);
  };

  const moveBy = (itemId: string, offset: -1 | 1): void => {
    const at = items.findIndex((item) => item.id === itemId);
    const neighbour = items[at + offset];
    if (neighbour === undefined) {
      props.onRefuse(offset === -1 ? 'already first' : 'already last');
      return;
    }
    attempt(planItemMove(items, itemId, neighbour.id));
  };

  const parsed = paste.trim() === '' ? null : parsePastedItems(paste, { itemKind, startCode: nextItemCode(items) });

  return (
    <section aria-label="Options" data-testid="items-editor">
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
        <h3 style={{ fontSize: 13 }}>
          {itemKind === 'option' ? 'Options' : itemKind === 'row' ? 'Rows' : 'Columns'} (
          {items.length})
        </h3>
        <button
          type="button"
          className="rs-button"
          data-testid="item-add"
          disabled={readOnly}
          onClick={() => {
            const code = nextItemCode(items);
            props.onAddItem({
              ref: (itemKind === 'option' ? 'o' : itemKind === 'row' ? 'r' : 'c') + String(code),
              code,
              label: '',
            });
          }}
        >
          + option
        </button>
      </div>

      <table className="rs-table" data-testid="items-table">
        <thead>
          <tr>
            {/* Display order. Read-only BECAUSE it is a consequence of the list, not a field. */}
            <th title="display order — changing it never changes a code">#</th>
            {/* The exported value. Editable BECAUSE it is a decision the author owns. */}
            <th title="the exported value — independent of display order">Code</th>
            <th>Label</th>
            <th>Order</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {items.map((item, at) => (
            <tr
              key={item.id}
              data-testid={'item-row-' + item.id}
              draggable={!readOnly}
              onDragStart={(event) => {
                setDragId(item.id);
                event.dataTransfer?.setData('text/plain', item.id);
              }}
              onDragEnd={() => {
                setDragId(null);
              }}
              onDragOver={(event) => {
                if (dragId === null || dragId === item.id) return;
                event.preventDefault();
              }}
              onDrop={(event) => {
                event.preventDefault();
                const dragged = dragId ?? event.dataTransfer?.getData('text/plain') ?? '';
                setDragId(null);
                if (dragged === '' || readOnly) return;
                attempt(planItemMove(items, dragged, item.id));
              }}
              onKeyDown={(event) => {
                if (!event.altKey) return;
                if (event.key === 'ArrowUp') {
                  event.preventDefault();
                  moveBy(item.id, -1);
                }
                if (event.key === 'ArrowDown') {
                  event.preventDefault();
                  moveBy(item.id, 1);
                }
              }}
            >
              <td data-testid={'item-position-' + item.id}>{at + 1}</td>
              <td>
                <input
                  className="rs-input"
                  aria-label={'Code for ' + (itemLabel(item) || item.id)}
                  data-testid={'item-code-' + item.id}
                  type="number"
                  size={4}
                  disabled={readOnly}
                  value={drafts['code:' + item.id] ?? String(item.code)}
                  onChange={(event) => {
                    setDrafts({ ...drafts, ['code:' + item.id]: event.target.value });
                  }}
                  onBlur={(event) => {
                    const next = Number(event.target.value);
                    setDrafts((current) => {
                      const rest = { ...current };
                      delete rest['code:' + item.id];
                      return rest;
                    });
                    if (!Number.isInteger(next)) {
                      props.onRefuse('a code must be a whole number');
                      return;
                    }
                    if (next !== item.code) props.onPatchItem(item.id, { code: next });
                  }}
                />
              </td>
              <td>
                <input
                  className="rs-input"
                  aria-label={'Label for code ' + String(item.code)}
                  data-testid={'item-label-' + item.id}
                  disabled={readOnly}
                  value={drafts['label:' + item.id] ?? itemLabel(item)}
                  onChange={(event) => {
                    setDrafts({ ...drafts, ['label:' + item.id]: event.target.value });
                  }}
                  onBlur={(event) => {
                    const next = event.target.value;
                    setDrafts((current) => {
                      const rest = { ...current };
                      delete rest['label:' + item.id];
                      return rest;
                    });
                    if (next !== itemLabel(item)) props.onPatchItem(item.id, { label: next });
                  }}
                />
              </td>
              <td style={{ whiteSpace: 'nowrap' }}>
                <button
                  type="button"
                  className="rs-button"
                  aria-label={'Move code ' + String(item.code) + ' up'}
                  data-testid={'item-up-' + item.id}
                  disabled={readOnly}
                  onClick={() => {
                    moveBy(item.id, -1);
                  }}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="rs-button"
                  aria-label={'Move code ' + String(item.code) + ' down'}
                  data-testid={'item-down-' + item.id}
                  disabled={readOnly}
                  onClick={() => {
                    moveBy(item.id, 1);
                  }}
                >
                  ↓
                </button>
              </td>
              <td>
                <button
                  type="button"
                  className="rs-button"
                  aria-label={'Delete code ' + String(item.code)}
                  data-testid={'item-delete-' + item.id}
                  disabled={readOnly}
                  onClick={() => {
                    props.onDeleteItem(item.id);
                  }}
                >
                  ✕
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <details data-testid="items-paste">
        <summary>Paste a list</summary>
        <p className="rs-muted">
          One per line. <code>code⇥label</code> keeps your codes; a line with no tab gets the next
          free code. Display order and code are separate — reordering later never renumbers.
        </p>
        <textarea
          className="rs-input"
          aria-label="Paste options"
          data-testid="items-paste-text"
          rows={4}
          disabled={readOnly}
          value={paste}
          onChange={(event) => {
            setPaste(event.target.value);
          }}
        />
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <span className="rs-muted">Mode</span>
            <select
              className="rs-input"
              aria-label="Paste mode"
              data-testid="items-paste-mode"
              value={pasteMode}
              onChange={(event) => {
                setPasteMode(event.target.value === 'replace' ? 'replace' : 'append');
              }}
            >
              <option value="append">append — keep the options that are here</option>
              <option value="replace">replace — discard the current list and its codes</option>
            </select>
          </label>
          <button
            type="button"
            className="rs-button"
            data-testid="items-paste-apply"
            disabled={readOnly || parsed === null || parsed.items.length === 0}
            onClick={() => {
              if (parsed === null) return;
              props.onBulk(pasteMode, parsed.items);
              setPaste('');
            }}
          >
            Apply {parsed === null ? '' : String(parsed.items.length)}
          </button>
          {parsed === null ? null : (
            <span className="rs-muted" data-testid="items-paste-summary">
              {String(parsed.items.length)} parsed
              {parsed.assignedCodes === 0
                ? ', all with stated codes'
                : ', ' + String(parsed.assignedCodes) + ' with codes assigned by position'}
            </span>
          )}
        </div>
        {parsed === null || parsed.problems.length === 0 ? null : (
          <ul role="alert" data-testid="items-paste-problems">
            {parsed.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        )}
      </details>
    </section>
  );
}
