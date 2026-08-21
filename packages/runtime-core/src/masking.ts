/**
 * Task 56: Masking and item resolution per Deliverable E §9.2.
 *
 * Determine which items (options/rows/columns) are shown to respondents.
 * Masking is applied *before* randomization (order matters per E §9.2).
 *
 * Sources:
 * - selected_in Qx: items whose codes match selections in previous question
 * - expression_per_item: custom condition evaluated with `item` bound
 * - code list: explicit inclusion/exclusion list
 *
 * Fallback when mask results in zero items:
 * - skip_question: don't show question, variables stay null
 * - show_all: revert to all items, emit event
 * - terminate: end survey with specified disposition
 */

export interface Item {
  code: string;
  label?: string;
}

export type MaskMode = 'include' | 'exclude';

export type SourceKind = 'selected_in' | 'code_list' | 'expression_per_item';

export type FallbackKind = 'skip_question' | 'show_all' | 'terminate';

export interface MaskSource {
  kind: SourceKind;
  variable_id?: string; // for selected_in
  codes?: string[]; // for code_list
  expression?: (item: Item, vars: Record<string, any>) => boolean; // for expression_per_item
}

export interface Mask {
  id: string;
  applies_to: 'options' | 'rows' | 'columns';
  mode: MaskMode;
  source: MaskSource;
  fallback: {
    when_empty: FallbackKind;
    disposition?: string; // for terminate mode
  };
  order_key: number; // for ordering application of masks
}

export interface MaskResult {
  items: Item[];
  fallback_applied?: FallbackKind;
  event?: string; // for logging
}

/**
 * Resolve the source items to include/exclude based on the source kind.
 */
function resolveSource(
  source: MaskSource,
  vars: Record<string, any>,
): Set<string> {
  if (source.kind === 'code_list') {
    return new Set(source.codes ?? []);
  }

  if (source.kind === 'selected_in') {
    const varId = source.variable_id;
    if (!varId) return new Set();

    const value = vars[varId];
    if (!value) return new Set();

    // If it's an array (multi-select), return the codes
    if (Array.isArray(value)) {
      return new Set(value.filter(v => typeof v === 'string'));
    }

    // If it's a single value, return it as a set
    if (typeof value === 'string' || typeof value === 'number') {
      return new Set([String(value)]);
    }

    return new Set();
  }

  if (source.kind === 'expression_per_item') {
    // Expression source is evaluated per-item during application
    return new Set();
  }

  return new Set();
}

/**
 * Apply a single mask to an item set.
 */
function applyMask(
  items: Item[],
  mask: Mask,
  vars: Record<string, any>,
): Item[] {
  const source = resolveSource(mask.source, vars);

  let result: Item[];

  if (mask.source.kind === 'expression_per_item' && mask.source.expression) {
    // For expression source, evaluate per-item
    result = items.filter(item => {
      const include = mask.source.expression!(item, vars);
      return mask.mode === 'include' ? include : !include;
    });
  } else {
    // For code-list and selected_in sources
    if (mask.mode === 'include') {
      result = items.filter(item => source.has(item.code));
    } else {
      result = items.filter(item => !source.has(item.code));
    }
  }

  return result;
}

/**
 * Apply all masks to items in order (E §9.2, ordered by order_key).
 * Returns the resulting items and any fallback that was applied.
 */
export function applyMasking(
  baseItems: Item[],
  masks: Mask[],
  vars: Record<string, any>,
): MaskResult {
  // Sort masks by order_key
  const sortedMasks = masks.slice().sort((a, b) => a.order_key - b.order_key);

  let items = baseItems;

  // Apply each mask in order
  for (const mask of sortedMasks) {
    items = applyMask(items, mask, vars);

    // If items is empty, handle fallback
    if (items.length === 0) {
      switch (mask.fallback.when_empty) {
        case 'skip_question':
          return {
            items: [],
            fallback_applied: 'skip_question',
            event: `mask.${mask.id}.fallback_skip_question`,
          };

        case 'show_all':
          return {
            items: baseItems,
            fallback_applied: 'show_all',
            event: `mask.${mask.id}.fallback_show_all`,
          };

        case 'terminate':
          return {
            items: [],
            fallback_applied: 'terminate',
            event: `mask.${mask.id}.fallback_terminate`,
          };
      }
    }
  }

  return { items };
}

/**
 * Unit test: include masking.
 */
export function testIncludeMasking(): boolean {
  const items: Item[] = [
    { code: 'a' },
    { code: 'b' },
    { code: 'c' },
    { code: 'd' },
  ];

  const mask: Mask = {
    id: 'msk_1',
    applies_to: 'options',
    mode: 'include',
    source: { kind: 'code_list', codes: ['a', 'c'] },
    fallback: { when_empty: 'show_all' },
    order_key: 0,
  };

  const result = applyMasking(items, [mask], {});
  const codes = result.items.map(i => i.code);

  return codes.length === 2 && codes[0] === 'a' && codes[1] === 'c';
}

/**
 * Unit test: exclude masking.
 */
export function testExcludeMasking(): boolean {
  const items: Item[] = [
    { code: 'a' },
    { code: 'b' },
    { code: 'c' },
    { code: 'd' },
  ];

  const mask: Mask = {
    id: 'msk_1',
    applies_to: 'options',
    mode: 'exclude',
    source: { kind: 'code_list', codes: ['b', 'd'] },
    fallback: { when_empty: 'show_all' },
    order_key: 0,
  };

  const result = applyMasking(items, [mask], {});
  const codes = result.items.map(i => i.code);

  return codes.length === 2 && codes[0] === 'a' && codes[1] === 'c';
}

/**
 * Unit test: selected_in masking.
 */
export function testSelectedInMasking(): boolean {
  const items: Item[] = [
    { code: 'coca' },
    { code: 'pepsi' },
    { code: 'sprite' },
  ];

  const mask: Mask = {
    id: 'msk_brands',
    applies_to: 'options',
    mode: 'include',
    source: { kind: 'selected_in', variable_id: 'var_q1' },
    fallback: { when_empty: 'show_all' },
    order_key: 0,
  };

  const vars = { var_q1: ['coca', 'sprite'] };
  const result = applyMasking(items, [mask], vars);
  const codes = result.items.map(i => i.code);

  return codes.length === 2 && codes[0] === 'coca' && codes[1] === 'sprite';
}

/**
 * Unit test: fallback when_empty.
 */
export function testFallbackWhenEmpty(): boolean {
  const items: Item[] = [
    { code: 'a' },
    { code: 'b' },
    { code: 'c' },
  ];

  const mask: Mask = {
    id: 'msk_1',
    applies_to: 'options',
    mode: 'include',
    source: { kind: 'code_list', codes: ['x', 'y'] }, // no match
    fallback: { when_empty: 'show_all' },
    order_key: 0,
  };

  const result = applyMasking(items, [mask], {});

  return (
    result.fallback_applied === 'show_all' &&
    result.items.length === 3 &&
    result.event === 'mask.msk_1.fallback_show_all'
  );
}
