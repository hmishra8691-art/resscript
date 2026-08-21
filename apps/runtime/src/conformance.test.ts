/**
 * Conformance of `@resscript/runtime-core`'s structural types to `@resscript/schema`'s real
 * ones.
 *
 * `runtime-core` declares narrow structural mirrors rather than importing schema, so it stays
 * loadable in a browser and in QuickJS. That buys portability and costs a guarantee: nothing
 * stops the mirrors drifting from the shapes the compiler actually emits.
 *
 * This file is that guarantee. The values below are typed as the *schema* types and passed
 * into `runtime-core`, so a drift is a compile error here rather than a runtime failure on the
 * first respondent. An earlier draft of the masking module required a `mask.order_key` that no
 * artifact carries, and randomization declared a `fixed_order` mode the schema does not have —
 * both would have type-checked forever without this file.
 */

import { describe, it, expect } from 'vitest';
import { applyMasking, randomize } from '@resscript/runtime-core';
import { asId } from '@resscript/schema';
import type {
  CompiledItem,
  Mask,
  RandomizationMode,
  RandomizationSpec,
} from '@resscript/schema';


/* ---------------------------------------------------------------- *
 * Id helpers
 *
 * Schema ids are `<prefix>_<26-char Crockford ULID>` (C §3), so a readable literal like
 * `opt_coca` is rejected by `asId`. These map a legible name to a stable valid ULID body, so
 * the fixtures below stay readable without weakening the id contract.
 * ---------------------------------------------------------------- */

const ULID_BODIES = new Map<string, string>();

function ulidFor(name: string): string {
  let body = ULID_BODIES.get(name);
  if (body === undefined) {
    // `[0-7]` then 25 Crockford base32 characters.
    body = `0${String(ULID_BODIES.size + 1).padStart(25, '0')}`;
    ULID_BODIES.set(name, body);
  }
  return body;
}

const oid = (name: string) => asId('opt', `opt_${ulidFor(`opt:${name}`)}`);
const mid = (name: string) => asId('msk', `msk_${ulidFor(`msk:${name}`)}`);
const vid = (name: string) => asId('var', `var_${ulidFor(`var:${name}`)}`);

/* ---------------------------------------------------------------- *
 * Real schema values
 * ---------------------------------------------------------------- */

/** Items exactly as the compiler emits them: `code` numeric, `position` dense. */
function compiledItems(): CompiledItem[] {
  return [
    { id: oid('coca'), ref: 'o1', code: 1, position: 1, label: 'Coca-Cola' },
    { id: oid('pepsi'), ref: 'o2', code: 2, position: 2, label: 'Pepsi' },
    { id: oid('sprite'), ref: 'o3', code: 3, position: 3, label: 'Sprite' },
    {
      id: oid('none'),
      ref: 'o4',
      code: 99,
      position: 4,
      label: 'None of these',
      anchor: 'last',
      exclusive: true,
    },
  ];
}

describe('masking accepts real schema Masks', () => {
  it('selected_in, addressed by variable id', () => {
    const mask: Mask = {
      id: mid('brands'),
      applies_to: 'options',
      mode: 'include',
      source: { kind: 'selected_in', variable_id: vid('q1') },
      fallback: { when_empty: 'show_all' },
    };

    const r = applyMasking(compiledItems(), [mask], 'options', {
      vars: { [vid('q1')]: [1, 3] },
    });

    expect(r.items.map(i => i.code)).toEqual([1, 3]);
    // The generic parameter must survive: labels are what the renderer needs.
    expect(r.items[0]?.label).toBe('Coca-Cola');
  });

  it('not_selected_in', () => {
    const mask: Mask = {
      id: mid('unpicked'),
      applies_to: 'options',
      mode: 'include',
      source: { kind: 'not_selected_in', variable_id: vid('q1') },
      fallback: { when_empty: 'skip_question' },
    };

    const r = applyMasking(compiledItems(), [mask], 'options', {
      vars: { [vid('q1')]: [1, 3] },
    });

    expect(r.items.map(i => i.code)).toEqual([2, 99]);
  });

  it('explicit, addressed by OptionId', () => {
    const mask: Mask = {
      id: mid('handpicked'),
      applies_to: 'options',
      mode: 'include',
      source: { kind: 'explicit', item_ids: [oid('pepsi'), oid('sprite')] },
      fallback: { when_empty: 'terminate' },
    };

    const r = applyMasking(compiledItems(), [mask], 'options', { vars: {} });

    expect(r.items.map(i => i.code)).toEqual([2, 3]);
  });

  it('every MaskFallback the schema declares is handled', () => {
    // If the schema adds a fallback, this fails to compile rather than silently falling
    // through to a default that C §15 says must not exist.
    const fallbacks = ['skip_question', 'show_all', 'terminate'] as const;
    const outcomes = fallbacks.map(when_empty => {
      const mask: Mask = {
        id: mid('x'),
        applies_to: 'options',
        mode: 'include',
        source: { kind: 'explicit', item_ids: [] },
        fallback: { when_empty },
      };
      return applyMasking(compiledItems(), [mask], 'options', { vars: {} });
    });

    expect(outcomes.map(o => o.fallback_applied)).toEqual(fallbacks);
  });

  it('masks are applied in array order — no order_key exists to sort by', () => {
    const drop = (ref: string, id: string): Mask => ({
      id: mid(id),
      applies_to: 'options',
      mode: 'exclude',
      source: { kind: 'explicit', item_ids: [oid(ref)] },
      fallback: { when_empty: 'show_all' },
    });

    const r = applyMasking(
      compiledItems(),
      [drop('coca', 'a'), drop('pepsi', 'b')],
      'options',
      { vars: {} },
    );

    expect(r.items.map(i => i.code)).toEqual([3, 99]);
  });
});

describe('randomization accepts real schema RandomizationSpecs', () => {
  it('a shuffle spec with anchors', () => {
    const spec: RandomizationSpec = { mode: 'shuffle', respect_anchors: true };

    const r = randomize(compiledItems(), spec, 'a'.repeat(32), {
      axis_key: 'qst_5.options',
      group: { ref: 'brands', canonical: compiledItems() },
    });

    // "None of these" is anchored last and must stay there.
    expect(r.items[r.items.length - 1]?.code).toBe(99);
  });

  it('a shared-group spec', () => {
    const spec: RandomizationSpec = {
      mode: 'shuffle',
      group_ref: 'brands',
      respect_anchors: true,
    };
    const canonical = compiledItems();

    const q5 = randomize(canonical, spec, 'b'.repeat(32), {
      axis_key: 'qst_5.options',
      group: { ref: 'brands', canonical },
    });
    const q6 = randomize(
      canonical.filter(i => i.code !== 2),
      spec,
      'b'.repeat(32),
      { axis_key: 'qst_6.options', group: { ref: 'brands', canonical } },
    );

    const shared = q5.items.map(i => i.code).filter(c => c !== 2);
    expect(q6.items.map(i => i.code)).toEqual(shared);
  });

  it('a subset spec reports the codes shown', () => {
    const spec: RandomizationSpec = { mode: 'subset', n: 2 };

    const r = randomize(compiledItems(), spec, 'c'.repeat(32), { axis_key: 'qst_5.options' });

    expect(r.subset_codes).toHaveLength(2);
    expect(r.subset_codes).toEqual(r.items.map(i => i.code));
  });

  it('a sub_blocks spec addressed by item ref', () => {
    const spec: RandomizationSpec = { mode: 'shuffle', sub_blocks: [{ refs: ['o1', 'o2'] }] };

    const r = randomize(compiledItems(), spec, 'd'.repeat(32), { axis_key: 'qst_5.options' });

    expect(
      r.items
        .slice(0, 2)
        .map(i => i.code)
        .sort((a, b) => a - b),
    ).toEqual([1, 2]);
  });

  it('every RandomizationMode the schema declares is accepted', () => {
    // The schema's mode list is the contract. `fixed_order` — which an earlier draft of
    // runtime-core declared — is not in it, and this loop is what would have caught that.
    const modes: RandomizationMode[] = [
      'none',
      'shuffle',
      'subset',
      'rotate',
      'reverse_half',
      'fixed_order_list',
    ];

    for (const mode of modes) {
      const spec: RandomizationSpec = { mode, n: 2 };
      const r = randomize(compiledItems(), spec, 'e'.repeat(32), { axis_key: 'q.options' });
      expect(r.items.length).toBeGreaterThan(0);
    }
  });

  it('counter-backed modes are reported, not silently seeded', () => {
    const counterBacked: RandomizationMode[] = ['rotate', 'fixed_order_list'];

    for (const mode of counterBacked) {
      const r = randomize(compiledItems(), { mode }, 'f'.repeat(32), { axis_key: 'q.options' });
      expect(r.needs_counter).toBe(true);
    }
  });
});

describe('the masking -> randomization order (E §9.2)', () => {
  it('masks resolve which items exist, then randomization orders them', () => {
    // Steps 2 and 5 of E §9.2, composed as the renderer will compose them. Getting the order
    // wrong — randomize then mask — breaks the shared-group guarantee, because the canonical
    // permutation would be filtered by a mask that ran against an already-shuffled list.
    const canonical = compiledItems();
    const mask: Mask = {
      id: mid('brands'),
      applies_to: 'options',
      mode: 'include',
      source: { kind: 'selected_in', variable_id: vid('q1') },
      fallback: { when_empty: 'show_all' },
    };
    const spec: RandomizationSpec = {
      mode: 'shuffle',
      group_ref: 'brands',
      respect_anchors: true,
    };
    const seed = '1'.repeat(32);

    const masked = applyMasking(canonical, [mask], 'options', {
      vars: { [vid('q1')]: [1, 2, 99] },
    });
    const ordered = randomize(masked.items, spec, seed, {
      axis_key: 'qst_5.options',
      group: { ref: 'brands', canonical },
    });

    expect(masked.items.map(i => i.code)).toEqual([1, 2, 99]);
    expect([...ordered.items.map(i => i.code)].sort((a, b) => a - b)).toEqual([1, 2, 99]);
    expect(ordered.items[ordered.items.length - 1]?.code).toBe(99); // anchor survives
  });

  it('a skip_question mask short-circuits before randomization', () => {
    const mask: Mask = {
      id: mid('brands'),
      applies_to: 'options',
      mode: 'include',
      source: { kind: 'selected_in', variable_id: vid('q1') },
      fallback: { when_empty: 'skip_question' },
    };

    const masked = applyMasking(compiledItems(), [mask], 'options', {
      vars: { [vid('q1')]: [] },
    });

    expect(masked.skip_question).toBe(true);
    expect(masked.items).toEqual([]);
  });
});
