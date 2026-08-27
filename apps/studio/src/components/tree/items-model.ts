/**
 * Options, rows and columns: the pure half — the reorder plan and the paste parser.
 *
 * ═══ CODE ≠ POSITION ═══
 *
 * Schema §5.1 calls confusing an option's `code` with its display position "a classic data
 * disaster", and `question-kit`'s `compareItemsForDeclaration` spells out the consequence:
 * declarations are ordered by `code`, so the export contract is a function of codes and of
 * nothing else. Dragging option 7 to the top of a brand list is a cosmetic edit; it must not
 * touch a single code.
 *
 * This file is where that survives or dies, so it is arranged so that the two cannot be
 * conflated even by accident:
 *
 *  - `planItemMove` returns `{after_id | before_id}` and has no access to a code at all;
 *  - `parsePastedItems` assigns codes only where the paste did not state one, and says so in its
 *    result rather than silently;
 *  - display order is the ARRAY order (which is what `GET /nodes/{id}/items` returns and what
 *    `POST /items/{id}/move` rewrites), never a locally-recomputed `position`. The editor shows
 *    the row number for order and an editable field for the code, one column each.
 *
 * Reordering is one `POST /items/{id}/move` per drag — the 60-option acceptance line — for the
 * same reason the node planner is one `POST /nodes/{id}/move` per drop: the fractional
 * `sort_key` (DB §4.6) makes it one row write, and a client that re-sequences the list throws
 * that away.
 */

import type { ItemKind, ItemWire } from './wire';
import { itemLabel } from './wire';

export interface ItemMovePlan {
  readonly item_id: string;
  readonly after_id?: string;
  readonly before_id?: string;
  readonly description: string;
}

export type ItemPlanOutcome =
  | { readonly ok: true; readonly plan: ItemMovePlan }
  | { readonly ok: false; readonly reason: string }
  | { readonly ok: 'noop' };

/** The request body for `POST /items/{id}/move`. No `code`, ever — see the file header. */
export function itemMoveBody(plan: ItemMovePlan): Record<string, unknown> {
  return {
    ...(plan.after_id === undefined ? {} : { after_id: plan.after_id }),
    ...(plan.before_id === undefined ? {} : { before_id: plan.before_id }),
  };
}

/**
 * Where a dragged option lands: dragging down takes the slot AFTER the target, dragging up the
 * slot BEFORE it. The same direction rule as the tree (`tree-model.ts`), so the two surfaces
 * behave the same and the keyboard buttons reuse it by passing the neighbour as the target.
 */
export function planItemMove(
  items: readonly ItemWire[],
  dragId: string,
  targetId: string,
): ItemPlanOutcome {
  if (dragId === targetId) return { ok: 'noop' };
  const from = items.findIndex((item) => item.id === dragId);
  const to = items.findIndex((item) => item.id === targetId);
  const drag = items[from];
  const target = items[to];
  if (drag === undefined || target === undefined) return { ok: false, reason: 'unknown option' };
  const after = from < to;
  return {
    ok: true,
    plan: {
      item_id: dragId,
      ...(after ? { after_id: targetId } : { before_id: targetId }),
      description: `${itemLabel(drag) || String(drag.code)} moved ${after ? 'after' : 'before'} ${
        itemLabel(target) || String(target.code)
      }`,
    },
  };
}

/** The optimistic order: a splice of the array, which is the display order. Codes untouched. */
export function applyItemMoveOptimistically(
  items: readonly ItemWire[],
  plan: ItemMovePlan,
): readonly ItemWire[] {
  const from = items.findIndex((item) => item.id === plan.item_id);
  const moving = items[from];
  if (moving === undefined) return items;
  const rest = items.filter((item) => item.id !== plan.item_id);
  const anchorId = plan.after_id ?? plan.before_id;
  const at = rest.findIndex((item) => item.id === anchorId);
  if (at < 0) return items;
  const insertAt = plan.after_id === undefined ? at : at + 1;
  return [...rest.slice(0, insertAt), moving, ...rest.slice(insertAt)];
}

/* -------------------------------------------------------------------------- */
/* The paste box                                                              */
/* -------------------------------------------------------------------------- */

export interface ParsedItem {
  readonly ref: string;
  readonly code: number;
  readonly label: string;
  /** True when the paste did not state a code and one was assigned by position. */
  readonly codeAssigned: boolean;
}

export interface ParsedPaste {
  readonly items: readonly ParsedItem[];
  readonly problems: readonly string[];
  readonly assignedCodes: number;
}

const REF_PREFIX: Readonly<Record<ItemKind, string>> = { option: 'o', row: 'r', column: 'c' };

/**
 * Parse a pasted list. `code<TAB>label` per line; a line without a tab is a bare label.
 *
 * TAB and not comma, deliberately: a spreadsheet column pasted into a textarea is
 * tab-separated, and brand names contain commas ("Ben & Jerry's, Inc."). Splitting on commas
 * would silently turn a label into a code for exactly the lists this box exists to import.
 *
 * A code the paste did not state is assigned by position, starting at `startCode` — and the
 * count comes back in `assignedCodes` so the UI can say so out loud instead of leaving the
 * author to discover that the tracker columns are now 1…60 in paste order.
 */
export function parsePastedItems(
  text: string,
  options: { readonly itemKind: ItemKind; readonly startCode: number },
): ParsedPaste {
  const problems: string[] = [];
  const items: ParsedItem[] = [];
  const seen = new Set<number>();
  let nextCode = options.startCode;
  const lines = text.split(/\r?\n/);

  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (line === '') continue;
    const tab = raw.indexOf('\t');
    let code: number;
    let label: string;
    let assigned = false;
    if (tab >= 0) {
      const head = raw.slice(0, tab).trim();
      label = raw.slice(tab + 1).trim();
      const parsed = Number(head);
      if (head === '' || !Number.isInteger(parsed)) {
        problems.push(`line ${String(index + 1)}: "${head}" is not a whole-number code`);
        continue;
      }
      code = parsed;
    } else {
      code = nextCode;
      label = line;
      assigned = true;
    }
    if (seen.has(code)) {
      problems.push(`line ${String(index + 1)}: code ${String(code)} appears twice`);
      continue;
    }
    seen.add(code);
    nextCode = Math.max(nextCode, code) + 1;
    items.push({
      ref: REF_PREFIX[options.itemKind] + String(code),
      code,
      label,
      codeAssigned: assigned,
    });
  }

  return { items, problems, assignedCodes: items.filter((item) => item.codeAssigned).length };
}

/** The next free code: max + 1, never `length + 1` — a deleted option must not free its code. */
export function nextItemCode(items: readonly ItemWire[]): number {
  return items.reduce((highest, item) => Math.max(highest, item.code), 0) + 1;
}
