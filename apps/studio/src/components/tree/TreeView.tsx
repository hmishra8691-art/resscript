/**
 * The survey tree — UI §3, "where logic becomes visible".
 *
 * The outline renders from ONE request (`GET /versions/{id}/tree`), including the rule
 * annotations: §3.1 is emphatic that rules belong under the node they affect, "not on hover, not
 * behind a disclosure", and §3.3 gives the tree `rule_summaries` per row precisely so the
 * annotation lines cost no extra fetch. What is NOT here is a question body — options, validation
 * and scripts arrive from `GET /nodes/{id}` when a row is selected (the inspector's job).
 *
 * ═══ DRAG, AND THE KEYBOARD THAT IS NOT AN AFTERTHOUGHT ═══
 *
 * Reordering uses the platform's own drag-and-drop (`draggable` + `dragstart`/`dragover`/`drop`)
 * because no drag library is a dependency of this app and P1-03 is not the milestone to add one.
 * Every gesture has an equal keyboard path — `⌥↑`/`⌥↓` to reorder, `⌥→`/`⌥←` to indent and
 * outdent (UI §1.3), plus visible Move-up/Move-down buttons on the focused row — and both paths
 * go through the same planner in `tree-model.ts`, so they cannot drift. This is the same floor
 * F §8 sets for question types: a pointer-only affordance is an incomplete affordance, and the
 * plugin kit refuses a plugin that ships one.
 *
 * Every accepted move and every refusal is announced through `announce`, which the pane routes to
 * one polite live region. Components do not create their own — two `aria-live` nodes on a page
 * means one is silently ignored, and which one is a screen-reader implementation detail (F §8).
 *
 * The tree is a real `role="tree"` with `aria-level`, `aria-expanded`, `aria-selected` and a
 * roving `tabindex`; selection follows focus, which is what makes "select the node, then act on
 * it" work identically for a mouse and for a keyboard.
 *
 * NOT here yet, deliberately: virtualization. §3.3 budgets a 2,000-row tree with
 * `@tanstack/react-virtual` over `flattenVisible`, and `flattenVisible` is written for it (it
 * returns a flat array with depths). Mounting it now would mean building the drag affordances
 * against a windowed list in the same change that establishes what the drag affordances ARE;
 * the flatten is the seam, and it is one component away.
 */

'use client';

import { useRef, useState } from 'react';
import type { MovePlan, PlanOutcome, TreeIndex } from './tree-model';
import { flattenVisible, planDrop, planKeyboardMove, type KeyboardMove } from './tree-model';
import type { RuleSummaryWire, TreeRowWire } from './wire';

/**
 * One annotation line. §3.1's ideal is `print(rule.condition)` — "the printer is the renderer" —
 * and the tree route serves the effect and the rule kind today; `src` renders the moment it is
 * there rather than waiting for it.
 */
function ruleLine(rule: RuleSummaryWire): string {
  return [rule.action ?? rule.effect ?? rule.kind ?? 'rule', rule.src ?? '']
    .filter((part) => part !== '')
    .join(' ');
}

const KIND_GLYPH: Readonly<Record<string, string>> = {
  block: '▣',
  page: '▤',
  question: '◉',
  text: '¶',
};

export interface TreeViewProps {
  readonly index: TreeIndex;
  readonly selectedId: string | null;
  readonly expanded: ReadonlySet<string>;
  readonly showDeleted: boolean;
  readonly readOnly: boolean;
  readonly onSelect: (nodeId: string) => void;
  readonly onToggle: (nodeId: string) => void;
  readonly onMove: (plan: MovePlan) => void;
  readonly onRefuse: (reason: string) => void;
  readonly onDelete: (nodeId: string) => void;
  readonly onUndelete: (nodeId: string) => void;
  readonly onDuplicate: (nodeId: string) => void;
}

export function TreeView(props: TreeViewProps): React.JSX.Element {
  const { index, selectedId, expanded, showDeleted, readOnly } = props;
  const rows = flattenVisible(index, expanded, { showDeleted });
  const rowElements = useRef(new Map<string, HTMLDivElement>());
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropId, setDropId] = useState<string | null>(null);

  const focusRow = (nodeId: string | undefined): void => {
    if (nodeId === undefined) return;
    rowElements.current.get(nodeId)?.focus();
  };

  const attempt = (outcome: PlanOutcome): void => {
    if (outcome.ok === true) props.onMove(outcome.plan);
    else if (outcome.ok === false) props.onRefuse(outcome.reason);
    // `'noop'` is a legal gesture that changes nothing: no request, no complaint.
  };

  const keyboardMove = (nodeId: string, move: KeyboardMove): void => {
    if (readOnly) {
      props.onRefuse('this version is frozen');
      return;
    }
    attempt(planKeyboardMove(index, nodeId, move));
  };

  const onRowKeyDown = (event: React.KeyboardEvent<HTMLDivElement>, at: number): void => {
    const entry = rows[at];
    if (entry === undefined) return;
    const nodeId = entry.row.id;
    if (event.altKey) {
      const move: KeyboardMove | undefined =
        event.key === 'ArrowUp'
          ? 'up'
          : event.key === 'ArrowDown'
            ? 'down'
            : event.key === 'ArrowRight'
              ? 'indent'
              : event.key === 'ArrowLeft'
                ? 'outdent'
                : undefined;
      if (move === undefined) return;
      event.preventDefault();
      keyboardMove(nodeId, move);
      return;
    }
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        focusRow(rows[at + 1]?.row.id);
        break;
      case 'ArrowUp':
        event.preventDefault();
        focusRow(rows[at - 1]?.row.id);
        break;
      case 'ArrowRight':
        event.preventDefault();
        if (entry.hasChildren && !expanded.has(nodeId)) props.onToggle(nodeId);
        break;
      case 'ArrowLeft':
        event.preventDefault();
        if (entry.hasChildren && expanded.has(nodeId)) props.onToggle(nodeId);
        else focusRow(entry.row.parent_id ?? undefined);
        break;
      case 'Enter':
        event.preventDefault();
        props.onSelect(nodeId);
        break;
      default:
        break;
    }
  };

  if (rows.length === 0) {
    return (
      <p className="rs-muted" data-testid="tree-empty">
        No nodes yet. Add a block to start the questionnaire.
      </p>
    );
  }

  const firstId = rows[0]?.row.id;

  return (
    <div
      role="tree"
      aria-label="Survey structure"
      aria-multiselectable={false}
      data-testid="survey-tree"
    >
      {rows.map((entry, at) => {
        const row = entry.row;
        const selected = row.id === selectedId;
        const isDropTarget = dropId === row.id && dragId !== null && dragId !== row.id;
        return (
          <div
            key={row.id}
            ref={(element) => {
              if (element === null) rowElements.current.delete(row.id);
              else rowElements.current.set(row.id, element);
            }}
            role="treeitem"
            aria-level={entry.depth + 1}
            aria-selected={selected}
            {...(entry.hasChildren ? { 'aria-expanded': expanded.has(row.id) } : {})}
            tabIndex={selected || (selectedId === null && row.id === firstId) ? 0 : -1}
            data-testid={'tree-row-' + row.id}
            data-node-kind={row.kind}
            data-deleted={entry.deleted ? 'true' : undefined}
            draggable={!readOnly && !entry.deleted}
            onDragStart={(event) => {
              setDragId(row.id);
              // The id also rides on the transfer for the sake of real browsers (and for a drop
              // onto another surface later); the component reads its own state, so a synthetic
              // drop in a test needs no `dataTransfer`.
              event.dataTransfer?.setData('text/plain', row.id);
            }}
            onDragEnd={() => {
              setDragId(null);
              setDropId(null);
            }}
            onDragOver={(event) => {
              if (dragId === null || dragId === row.id) return;
              // Without `preventDefault` the browser refuses the drop outright.
              event.preventDefault();
              setDropId(row.id);
            }}
            onDragLeave={() => {
              setDropId((current) => (current === row.id ? null : current));
            }}
            onDrop={(event) => {
              event.preventDefault();
              const dragged = dragId ?? event.dataTransfer?.getData('text/plain') ?? '';
              setDragId(null);
              setDropId(null);
              if (dragged === '') return;
              if (readOnly) {
                props.onRefuse('this version is frozen');
                return;
              }
              attempt(planDrop(index, dragged, row.id));
            }}
            onKeyDown={(event) => {
              onRowKeyDown(event, at);
            }}
            onFocus={() => {
              // Selection follows focus: the mouse and the keyboard then act on the same row.
              if (!selected) props.onSelect(row.id);
            }}
            onClick={() => {
              props.onSelect(row.id);
            }}
            style={{
              display: 'flex',
              gap: 4,
              alignItems: 'center',
              flexWrap: 'wrap',
              minHeight: 'var(--rs-row-height)',
              paddingInlineStart: 4 + entry.depth * 14,
              borderRadius: 'var(--rs-radius)',
              borderTop: isDropTarget ? '2px solid var(--rs-border)' : '2px solid transparent',
              background: selected ? 'var(--rs-surface-raised)' : undefined,
              opacity: entry.deleted ? 0.5 : 1,
            }}
          >
            {entry.hasChildren ? (
              <button
                type="button"
                className="rs-button"
                aria-label={
                  (expanded.has(row.id) ? 'Collapse ' : 'Expand ') + (row.ref ?? row.kind)
                }
                onClick={(event) => {
                  event.stopPropagation();
                  props.onToggle(row.id);
                }}
              >
                {expanded.has(row.id) ? '▾' : '▸'}
              </button>
            ) : (
              <span style={{ width: 12 }} aria-hidden="true" />
            )}

            <span aria-hidden="true">{KIND_GLYPH[row.kind] ?? '•'}</span>
            <strong data-testid={'tree-ref-' + row.id}>{row.ref ?? '(unnamed)'}</strong>
            <span className="rs-muted" style={{ flex: 1, minWidth: 0 }}>
              {row.label_preview ?? ''}
            </span>

            <RowBadges row={row} />

            {entry.deleted ? (
              <>
                <span className="rs-chip" data-testid={'tree-deleted-' + row.id}>
                  deleted
                </span>
                <button
                  type="button"
                  className="rs-button"
                  data-testid={'tree-undo-' + row.id}
                  disabled={readOnly}
                  onClick={(event) => {
                    event.stopPropagation();
                    props.onUndelete(row.id);
                  }}
                >
                  Undo
                </button>
              </>
            ) : selected ? (
              <span style={{ display: 'flex', gap: 2 }}>
                {/* The keyboard equivalent of the drag, as controls rather than only as
                    shortcuts: a shortcut nobody can see is not an affordance. */}
                <button
                  type="button"
                  className="rs-button"
                  aria-label={'Move ' + (row.ref ?? row.kind) + ' up'}
                  data-testid={'tree-up-' + row.id}
                  disabled={readOnly}
                  onClick={(event) => {
                    event.stopPropagation();
                    keyboardMove(row.id, 'up');
                  }}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="rs-button"
                  aria-label={'Move ' + (row.ref ?? row.kind) + ' down'}
                  data-testid={'tree-down-' + row.id}
                  disabled={readOnly}
                  onClick={(event) => {
                    event.stopPropagation();
                    keyboardMove(row.id, 'down');
                  }}
                >
                  ↓
                </button>
                <button
                  type="button"
                  className="rs-button"
                  aria-label={'Duplicate ' + (row.ref ?? row.kind)}
                  data-testid={'tree-duplicate-' + row.id}
                  disabled={readOnly}
                  onClick={(event) => {
                    event.stopPropagation();
                    props.onDuplicate(row.id);
                  }}
                >
                  ⧉
                </button>
                <button
                  type="button"
                  className="rs-button"
                  aria-label={'Delete ' + (row.ref ?? row.kind)}
                  data-testid={'tree-delete-' + row.id}
                  disabled={readOnly}
                  onClick={(event) => {
                    event.stopPropagation();
                    props.onDelete(row.id);
                  }}
                >
                  ✕
                </button>
              </span>
            ) : null}

            {/* Annotation lines: the printed rule, under the node it governs (§3.1). */}
            {(row.rule_summaries ?? []).length === 0 ? null : (
              <ul
                style={{ flexBasis: '100%', listStyle: 'none', paddingInlineStart: 18 }}
                data-testid={'tree-rules-' + row.id}
              >
                {(row.rule_summaries ?? []).map((rule, ruleAt) => (
                  <li key={rule.id ?? String(ruleAt)} className="rs-muted">
                    <span aria-hidden="true">⇢ </span>
                    {ruleLine(rule)}
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * The badge row. Colour is never the only carrier (UI §11): each badge carries a glyph or a
 * word and a `title`, so "2 errors" reads the same to a screen reader as to an eye.
 */
function RowBadges({ row }: { readonly row: TreeRowWire }): React.JSX.Element {
  const errors = row.diagnostic_counts?.errors ?? 0;
  const warnings = row.diagnostic_counts?.warnings ?? 0;
  const rules = row.rule_summaries?.length ?? 0;
  const flags = Object.entries(row.flags ?? {}).filter(([, on]) => on);
  return (
    <span style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
      {row.question_type === null || row.question_type === undefined ? null : (
        <span className="rs-chip" data-testid={'tree-type-' + row.id}>
          {row.question_type}
        </span>
      )}
      {row.required === true ? (
        <span className="rs-chip" title="required" data-testid={'tree-required-' + row.id}>
          required
        </span>
      ) : null}
      {rules === 0 ? null : (
        <span
          className="rs-chip"
          title={rules === 1 ? '1 rule' : String(rules) + ' rules'}
          data-testid={'tree-rulecount-' + row.id}
        >
          ⇢ {rules}
        </span>
      )}
      {errors === 0 ? null : (
        <span className="rs-chip" title="errors" data-testid={'tree-errors-' + row.id}>
          ⚠ {errors}
        </span>
      )}
      {warnings === 0 ? null : (
        <span className="rs-chip" title="warnings" data-testid={'tree-warnings-' + row.id}>
          ⚑ {warnings}
        </span>
      )}
      {flags.map(([flag]) => (
        <span key={flag} className="rs-chip" title={'flag: ' + flag}>
          {flag}
        </span>
      ))}
    </span>
  );
}
