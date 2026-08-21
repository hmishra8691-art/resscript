/**
 * Test suite for masking (task 56).
 *
 * Verifies E §9.2 requirements: mask modes, sources, fallback behavior.
 */

import { describe, it, expect } from 'vitest';
import {
  applyMasking,
  testIncludeMasking,
  testExcludeMasking,
  testSelectedInMasking,
  testFallbackWhenEmpty,
  type Item,
  type Mask,
} from './masking.js';

describe('include masking', () => {
  it('include mode keeps only specified codes', () => {
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

    expect(codes).toEqual(['a', 'c']);
  });

  it('built-in include test passes', () => {
    expect(testIncludeMasking()).toBe(true);
  });
});

describe('exclude masking', () => {
  it('exclude mode removes specified codes', () => {
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

    expect(codes).toEqual(['a', 'c']);
  });

  it('built-in exclude test passes', () => {
    expect(testExcludeMasking()).toBe(true);
  });
});

describe('selected_in masking', () => {
  it('selected_in filters items by previous question value', () => {
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

    expect(codes).toEqual(['coca', 'sprite']);
  });

  it('selected_in works with single value', () => {
    const items: Item[] = [{ code: '1' }, { code: '2' }, { code: '3' }];

    const mask: Mask = {
      id: 'msk_1',
      applies_to: 'options',
      mode: 'include',
      source: { kind: 'selected_in', variable_id: 'var_single' },
      fallback: { when_empty: 'show_all' },
      order_key: 0,
    };

    const vars = { var_single: '2' };
    const result = applyMasking(items, [mask], vars);

    expect(result.items.map(i => i.code)).toEqual(['2']);
  });

  it('built-in selected_in test passes', () => {
    expect(testSelectedInMasking()).toBe(true);
  });
});

describe('expression masking', () => {
  it('expression_per_item includes items matching condition', () => {
    const items: Item[] = [
      { code: 'a', label: 'Apple' },
      { code: 'b', label: 'Banana' },
      { code: 'c', label: 'Carrot' },
    ];

    const mask: Mask = {
      id: 'msk_expr',
      applies_to: 'options',
      mode: 'include',
      source: {
        kind: 'expression_per_item',
        expression: item => item.code !== 'b',
      },
      fallback: { when_empty: 'show_all' },
      order_key: 0,
    };

    const result = applyMasking(items, [mask], {});
    const codes = result.items.map(i => i.code);

    expect(codes).toEqual(['a', 'c']);
  });
});

describe('fallback handling', () => {
  it('fallback show_all reverts to all items', () => {
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

    expect(result.fallback_applied).toBe('show_all');
    expect(result.items).toEqual(items);
  });

  it('fallback skip_question returns empty', () => {
    const items: Item[] = [
      { code: 'a' },
      { code: 'b' },
      { code: 'c' },
    ];

    const mask: Mask = {
      id: 'msk_1',
      applies_to: 'options',
      mode: 'include',
      source: { kind: 'code_list', codes: ['x', 'y'] },
      fallback: { when_empty: 'skip_question' },
      order_key: 0,
    };

    const result = applyMasking(items, [mask], {});

    expect(result.fallback_applied).toBe('skip_question');
    expect(result.items).toEqual([]);
  });

  it('fallback terminate returns empty', () => {
    const items: Item[] = [
      { code: 'a' },
      { code: 'b' },
      { code: 'c' },
    ];

    const mask: Mask = {
      id: 'msk_1',
      applies_to: 'options',
      mode: 'include',
      source: { kind: 'code_list', codes: ['x', 'y'] },
      fallback: { when_empty: 'terminate', disposition: 'COMPLETE' },
      order_key: 0,
    };

    const result = applyMasking(items, [mask], {});

    expect(result.fallback_applied).toBe('terminate');
    expect(result.items).toEqual([]);
  });

  it('built-in fallback test passes', () => {
    expect(testFallbackWhenEmpty()).toBe(true);
  });
});

describe('multiple masks', () => {
  it('multiple masks applied in order_key sequence', () => {
    const items: Item[] = [
      { code: 'a' },
      { code: 'b' },
      { code: 'c' },
      { code: 'd' },
      { code: 'e' },
    ];

    // First mask: include a, b, c, d
    const mask1: Mask = {
      id: 'msk_1',
      applies_to: 'options',
      mode: 'exclude',
      source: { kind: 'code_list', codes: ['e'] },
      fallback: { when_empty: 'show_all' },
      order_key: 0,
    };

    // Second mask: exclude b
    const mask2: Mask = {
      id: 'msk_2',
      applies_to: 'options',
      mode: 'exclude',
      source: { kind: 'code_list', codes: ['b'] },
      fallback: { when_empty: 'show_all' },
      order_key: 1,
    };

    const result = applyMasking(items, [mask2, mask1], {}); // Apply in any order; masks should sort
    const codes = result.items.map(i => i.code);

    expect(codes).toEqual(['a', 'c', 'd']);
  });

  it('first mask with fallback_empty stops processing', () => {
    const items: Item[] = [
      { code: 'a' },
      { code: 'b' },
      { code: 'c' },
    ];

    // First mask: filter to non-existent items (triggers fallback show_all)
    const mask1: Mask = {
      id: 'msk_1',
      applies_to: 'options',
      mode: 'include',
      source: { kind: 'code_list', codes: ['x'] },
      fallback: { when_empty: 'show_all' },
      order_key: 0,
    };

    // Second mask: would further filter, but shouldn't be reached
    const mask2: Mask = {
      id: 'msk_2',
      applies_to: 'options',
      mode: 'exclude',
      source: { kind: 'code_list', codes: ['a'] },
      fallback: { when_empty: 'show_all' },
      order_key: 1,
    };

    const result = applyMasking(items, [mask1, mask2], {});

    // Should hit fallback_show_all and return all original items (not filtering by mask2)
    expect(result.fallback_applied).toBe('show_all');
    expect(result.items).toEqual(items);
  });
});
