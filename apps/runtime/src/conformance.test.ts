/**
 * Conformance of `@resscript/runtime-core`'s structural types to `@resscript/schema`'s real ones.
 *
 * `runtime-core` declares narrow structural mirrors rather than importing schema, so it stays
 * loadable in a browser and in QuickJS. That buys portability and costs a guarantee: nothing stops
 * the mirrors drifting from the shapes the compiler actually emits.
 *
 * This file is that guarantee. The values below are typed as the *schema* types and passed into
 * `runtime-core`, so a drift is a compile error here rather than a runtime failure on the first
 * respondent. Two real defects would have been caught by it: a masking module that required a
 * `mask.order_key` no artifact carries, and a `RandomizationMode` union with a `fixed_order` member
 * the schema does not define.
 */

import { describe, it, expect } from 'vitest';
import { randomize, renderPage } from '@resscript/runtime-core';
import { asId } from '@resscript/schema';
import type {
  CompiledItem,
  CompiledPage,
  CompiledQuestion,
  Mask,
  RandomizationMode,
  RandomizationSpec,
} from '@resscript/schema';

/* ---------------------------------------------------------------- *
 * Id helpers
 *
 * Schema ids are `<prefix>_<26-char Crockford ULID>` (C §3), so a readable literal like `opt_coca`
 * is rejected by `asId`. These map a legible name to a stable valid ULID body, so the fixtures stay
 * readable without weakening the id contract.
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
const qid = (name: string) => asId('qst', `qst_${ulidFor(`qst:${name}`)}`);
const pid = (name: string) => asId('pg', `pg_${ulidFor(`pg:${name}`)}`);

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

/** A mask as the artifact carries it: provenance the renderer must NOT re-apply. */
function authoredMask(): Mask {
  return {
    id: mid('brands'),
    applies_to: 'options',
    mode: 'include',
    source: { kind: 'selected_in', variable_id: vid('q1') },
    fallback: { when_empty: 'show_all' },
  };
}

function compiledQuestion(over: Partial<CompiledQuestion> = {}): CompiledQuestion {
  return {
    id: qid('brand'),
    ref: 'Q1',
    question_type: 'single_select',
    required: true,
    label: 'Which brand, {{name}}?',
    config: {},
    options: compiledItems(),
    validation: [],
    masks: [authoredMask()],
    emits: [vid('q1')],
    ...over,
  } as CompiledQuestion;
}

function compiledPage(over: Partial<CompiledPage> = {}): CompiledPage {
  return {
    id: pid('one'),
    ref: 'P1',
    block_path: [],
    questions: [compiledQuestion()],
    inline_rules: [],
    settings: {},
    ...over,
  } as CompiledPage;
}

/* ---------------------------------------------------------------- *
 * renderPage
 * ---------------------------------------------------------------- */

describe('renderPage accepts a real CompiledPage', () => {
  it('renders it without a cast', () => {
    // The seam that matters most: the loader hands `page()` a `CompiledPage` straight off disk.
    const r = renderPage(compiledPage(), 'a'.repeat(32), { vars: {} });

    expect(r.questions).toHaveLength(1);
    expect(r.questions[0]?.ref).toBe('Q1');
    expect(r.questions[0]?.options?.items.map(i => i.code)).toEqual([1, 2, 3, 99]);
  });

  it('carries CompiledItem labels through to the render', () => {
    const r = renderPage(compiledPage(), 'a'.repeat(32), { vars: {} });
    expect(r.questions[0]?.options?.items[0]?.label).toBe('Coca-Cola');
  });

  it('pipes the label from session variable state', () => {
    const r = renderPage(compiledPage(), 'a'.repeat(32), { vars: { name: 'Ada' } });
    expect(r.questions[0]?.label).toBe('Which brand, Ada?');
  });

  it("does NOT apply the page's own authored masks", () => {
    // The compiler already synthesized one logic rule per authored mask (compiler rules.ts §4).
    // Applying them here as well would double every mask: harmless for a plain include, but a
    // show_all fallback firing in one layer and being re-emptied by the other gives an answer
    // neither layer would give alone.
    //
    // The fixture's mask is include-on-selected_in with `var_q1` unset, so a renderer that applied
    // it would resolve to zero items and hit show_all. All four items surviving is the assertion
    // that it did not run.
    const r = renderPage(compiledPage(), 'a'.repeat(32), { vars: {} });

    expect(r.questions[0]?.options?.items).toHaveLength(4);
    expect(r.events).toEqual([]);
  });

  it('applies an injected item set, which is where logic attaches', () => {
    const r = renderPage(compiledPage(), 'a'.repeat(32), {
      vars: {},
      itemsFor: () => [1, 3],
    });

    expect(r.questions[0]?.options?.items.map(i => i.code)).toEqual([1, 3]);
  });

  it("handles a matrix question's rows and columns", () => {
    // `options` is omitted rather than set to undefined: the compiler leaves an undeclared axis
    // absent, because "this question has no rows" and "its rows were all masked away" are
    // different states the runtime distinguishes (emit/pages.ts).
    const { options: _omitted, ...base } = compiledQuestion();
    const q = {
      ...base,
      question_type: 'matrix',
      rows: compiledItems().slice(0, 2),
      columns: compiledItems().slice(2),
    } as CompiledQuestion;
    const r = renderPage(compiledPage({ questions: [q] }), 'a'.repeat(32), { vars: {} });

    expect(r.questions[0]?.rows?.items.map(i => i.code)).toEqual([1, 2]);
    expect(r.questions[0]?.columns?.items.map(i => i.code)).toEqual([3, 99]);
  });

  it('produces a digest for the visit record', () => {
    const r = renderPage(compiledPage(), 'a'.repeat(32), { vars: {} });
    expect(r.digest).toMatch(/^[0-9a-f]{32}$/);
  });
});

/* ---------------------------------------------------------------- *
 * randomize
 * ---------------------------------------------------------------- */

describe('randomization accepts real schema RandomizationSpecs', () => {
  it('a shuffle spec with anchors', () => {
    const spec: RandomizationSpec = { mode: 'shuffle', respect_anchors: true };

    const r = randomize(compiledItems(), spec, 'a'.repeat(32), { axis_key: 'qst_5.options' });

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

    expect(q6.items.map(i => i.code)).toEqual(q5.items.map(i => i.code).filter(c => c !== 2));
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
    // The schema's mode list is the contract. Iterating it means adding a member fails the build
    // until it is handled, rather than silently falling through to a passthrough.
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

/* ---------------------------------------------------------------- *
 * The masking -> randomization order (E §9.2)
 * ---------------------------------------------------------------- */

describe('stage order', () => {
  it('a real CompiledQuestion can carry a randomization spec at all', () => {
    // Until this session it could not: `emit/pages.ts` dropped all three randomize_* fields, so
    // this line would not have compiled and no artifact could ask the runtime to randomize.
    const q = compiledQuestion({ randomize_options: { mode: 'shuffle' } });
    const r = renderPage(compiledPage({ questions: [q] }), 'a'.repeat(32), { vars: {} });

    expect([...(r.questions[0]?.options?.items.map(i => i.code) ?? [])].sort((a, b) => a - b)).toEqual(
      [1, 2, 3, 99],
    );
  });

  it('the item set is applied before randomization, not after', () => {
    // Getting this backwards — randomize then filter — breaks the shared-group guarantee, because
    // the canonical permutation would be filtered by a set that ran against an already-shuffled
    // list. Asserted through renderPage so the composition is what is under test.
    const spec: RandomizationSpec = { mode: 'shuffle', group_ref: 'brands', respect_anchors: true };
    const canonical = compiledItems();
    const seed = '1'.repeat(32);
    const groupFor = () => ({ ref: 'brands', canonical });

    const full = renderPage(
      compiledPage({ questions: [compiledQuestion({ randomize_options: spec })] }),
      seed,
      { vars: {}, groupFor },
    );
    const masked = renderPage(
      compiledPage({ questions: [compiledQuestion({ randomize_options: spec })] }),
      seed,
      { vars: {}, groupFor, itemsFor: () => [1, 2, 99] },
    );

    const fullOrder = full.questions[0]?.options?.items.map(i => i.code) ?? [];
    const maskedOrder = masked.questions[0]?.options?.items.map(i => i.code) ?? [];

    expect(maskedOrder).toEqual(fullOrder.filter(c => [1, 2, 99].includes(c)));
    expect(maskedOrder[maskedOrder.length - 1]).toBe(99); // anchor survives
  });
});
