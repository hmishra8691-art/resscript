/**
 * Test suite for page render (E §9).
 *
 * The tests that matter most are the ORDER ones. Each stage works in isolation — that is what
 * masking.test.ts and randomize.test.ts prove — and the render can still be wrong by composing
 * them in the wrong sequence. Randomize-then-mask passes every per-stage test and silently
 * breaks the shared-group guarantee.
 */

import { describe, it, expect } from 'vitest';
import { renderPage, type RenderCtx, type RenderItem, type RenderPage } from './render.js';
import type { Mask } from './masking.js';
import type { RandomizationSpec } from './randomize.js';

/* ---------------------------------------------------------------- *
 * Fixtures
 * ---------------------------------------------------------------- */

const SEED = 'a3f9c1d2e4b6a8f0c2d4e6b8a0f2c4d6';

const BRANDS: RenderItem[] = [
  { id: 'opt_coca', code: 1, ref: 'o1', label: 'Coca-Cola' },
  { id: 'opt_pepsi', code: 2, ref: 'o2', label: 'Pepsi' },
  { id: 'opt_sprite', code: 3, ref: 'o3', label: 'Sprite' },
  { id: 'opt_fanta', code: 4, ref: 'o4', label: 'Fanta' },
];

function page(over: Partial<RenderPage> = {}): RenderPage {
  return {
    id: 'pg_1',
    ref: 'P1',
    questions: [
      {
        id: 'qst_1',
        ref: 'Q1',
        question_type: 'single_select',
        required: true,
        label: 'Which brand?',
        options: BRANDS,
      },
    ],
    ...over,
  };
}

function ctx(over: Partial<RenderCtx> = {}): RenderCtx {
  return { vars: {}, ...over };
}

const brandMask = (when_empty: 'skip_question' | 'show_all' | 'terminate'): Mask => ({
  id: 'msk_brands',
  applies_to: 'options',
  mode: 'include',
  source: { kind: 'selected_in', variable_id: 'var_q1' },
  fallback: { when_empty },
});

const codesOf = (r: ReturnType<typeof renderPage>, qi = 0) =>
  r.questions[qi]?.options?.items.map(i => i.code) ?? [];

/* ---------------------------------------------------------------- *
 * Basic render
 * ---------------------------------------------------------------- */

describe('basic render', () => {
  it('renders a question with its items in declared order when nothing randomizes', () => {
    const r = renderPage(page(), SEED, ctx());

    expect(r.questions).toHaveLength(1);
    expect(codesOf(r)).toEqual([1, 2, 3, 4]);
    expect(r.skipped).toEqual([]);
  });

  it('carries the question metadata through', () => {
    const r = renderPage(page(), SEED, ctx());

    expect(r.questions[0]).toMatchObject({
      id: 'qst_1',
      ref: 'Q1',
      question_type: 'single_select',
      required: true,
      label: 'Which brand?',
    });
  });

  it('preserves item labels for the renderer', () => {
    const r = renderPage(page(), SEED, ctx());
    expect(r.questions[0]?.options?.items[0]?.label).toBe('Coca-Cola');
  });

  it('renders rows and columns independently of options', () => {
    const p = page({
      questions: [
        {
          id: 'qst_m',
          ref: 'QM',
          question_type: 'matrix',
          rows: BRANDS.slice(0, 2),
          columns: BRANDS.slice(2),
        },
      ],
    });
    const r = renderPage(p, SEED, ctx());

    expect(r.questions[0]?.rows?.items.map(i => i.code)).toEqual([1, 2]);
    expect(r.questions[0]?.columns?.items.map(i => i.code)).toEqual([3, 4]);
    expect(r.questions[0]?.options).toBeUndefined();
  });

  it('a question with no items renders with no axes', () => {
    const p = page({
      questions: [{ id: 'qst_t', ref: 'QT', question_type: 'text', label: 'Your name?' }],
    });
    const r = renderPage(p, SEED, ctx());

    expect(r.questions[0]?.options).toBeUndefined();
    expect(r.skipped).toEqual([]);
  });

  it('defaults required to false when the artifact omits it', () => {
    const p = page({
      questions: [{ id: 'qst_x', ref: 'QX', question_type: 'text' }],
    });
    expect(renderPage(p, SEED, ctx()).questions[0]?.required).toBe(false);
  });
});

/* ---------------------------------------------------------------- *
 * Visibility
 * ---------------------------------------------------------------- */

describe('visibility', () => {
  it('a hidden question is skipped with reason hidden', () => {
    const r = renderPage(page(), SEED, ctx({ isQuestionVisible: () => false }));

    expect(r.questions).toEqual([]);
    expect(r.skipped).toEqual([{ question_id: 'qst_1', reason: 'hidden' }]);
  });

  it('hidden and masked_empty are distinguishable', () => {
    // E §9.2: a question dropped by an empty mask is `masked_empty`, NOT a respondent skip.
    // An analyst needs to tell "chose not to answer" from "logic left nothing to answer".
    const p = page({
      questions: [
        { id: 'qst_h', ref: 'QH', question_type: 'text' },
        {
          id: 'qst_m',
          ref: 'QM',
          question_type: 'single_select',
          options: BRANDS,
          masks: [brandMask('skip_question')],
        },
      ],
    });
    const r = renderPage(
      p,
      SEED,
      ctx({ vars: { var_q1: [] }, isQuestionVisible: id => id !== 'qst_h' }),
    );

    expect(r.skipped).toEqual([
      { question_id: 'qst_h', reason: 'hidden' },
      { question_id: 'qst_m', reason: 'masked_empty' },
    ]);
  });
});

/* ---------------------------------------------------------------- *
 * Masking
 * ---------------------------------------------------------------- */

describe('masking', () => {
  it('filters items to the mask', () => {
    const p = page({
      questions: [
        {
          id: 'qst_1',
          ref: 'Q1',
          question_type: 'multi_select',
          options: BRANDS,
          masks: [brandMask('show_all')],
        },
      ],
    });
    const r = renderPage(p, SEED, ctx({ vars: { var_q1: [1, 3] } }));

    expect(codesOf(r)).toEqual([1, 3]);
  });

  it('skip_question drops the question and records masked_empty', () => {
    const p = page({
      questions: [
        {
          id: 'qst_1',
          ref: 'Q1',
          question_type: 'multi_select',
          options: BRANDS,
          masks: [brandMask('skip_question')],
        },
      ],
    });
    const r = renderPage(p, SEED, ctx({ vars: { var_q1: [] } }));

    expect(r.questions).toEqual([]);
    expect(r.skipped).toEqual([{ question_id: 'qst_1', reason: 'masked_empty' }]);
  });

  it('show_all reverts to the base items and emits an event', () => {
    const p = page({
      questions: [
        {
          id: 'qst_1',
          ref: 'Q1',
          question_type: 'multi_select',
          options: BRANDS,
          masks: [brandMask('show_all')],
        },
      ],
    });
    const r = renderPage(p, SEED, ctx({ vars: { var_q1: [] } }));

    expect(codesOf(r)).toEqual([1, 2, 3, 4]);
    expect(r.events).toContainEqual({
      kind: 'mask.fallback_show_all',
      question_id: 'qst_1',
      detail: 'msk_brands',
    });
  });

  it('terminate surfaces the disposition to the caller', () => {
    const p = page({
      questions: [
        {
          id: 'qst_1',
          ref: 'Q1',
          question_type: 'multi_select',
          options: BRANDS,
          masks: [brandMask('terminate')],
        },
      ],
    });
    const r = renderPage(p, SEED, ctx({ vars: { var_q1: [] } }));

    expect(r.terminate).toEqual({ question_id: 'qst_1', mask_id: 'msk_brands' });
  });

  it('a mask on a different axis leaves options alone', () => {
    const rowsMask: Mask = { ...brandMask('skip_question'), applies_to: 'rows' };
    const p = page({
      questions: [
        {
          id: 'qst_1',
          ref: 'Q1',
          question_type: 'multi_select',
          options: BRANDS,
          masks: [rowsMask],
        },
      ],
    });
    const r = renderPage(p, SEED, ctx({ vars: { var_q1: [] } }));

    expect(codesOf(r)).toEqual([1, 2, 3, 4]);
  });
});

/* ---------------------------------------------------------------- *
 * Option state (E §9.2 step 4)
 * ---------------------------------------------------------------- */

describe('option state', () => {
  it('evaluates over the surviving items only', () => {
    // Step 4 runs after masking. A rule evaluated against a masked-out item wastes work and
    // can emit a verdict for an item the respondent never sees.
    const seen: number[] = [];
    const p = page({
      questions: [
        {
          id: 'qst_1',
          ref: 'Q1',
          question_type: 'multi_select',
          options: BRANDS,
          masks: [brandMask('show_all')],
        },
      ],
    });
    renderPage(
      p,
      SEED,
      ctx({
        vars: { var_q1: [2, 4] },
        optionState: (_q, _a, item) => {
          seen.push(item.code);
          return {};
        },
      }),
    );

    expect(seen).toEqual([2, 4]);
  });

  it('a disabled item is rendered but flagged', () => {
    const r = renderPage(
      page(),
      SEED,
      ctx({ optionState: (_q, _a, item) => ({ disabled: item.code === 2 }) }),
    );

    expect(codesOf(r)).toEqual([1, 2, 3, 4]);
    expect(r.questions[0]?.options?.disabled_codes).toEqual([2]);
  });

  it('a hidden item is removed from the render', () => {
    const r = renderPage(
      page(),
      SEED,
      ctx({ optionState: (_q, _a, item) => ({ hidden: item.code === 2 }) }),
    );

    expect(codesOf(r)).toEqual([1, 3, 4]);
  });

  it('hiding every item makes the question unanswerable and skips it', () => {
    const r = renderPage(page(), SEED, ctx({ optionState: () => ({ hidden: true }) }));

    expect(r.questions).toEqual([]);
    expect(r.skipped).toEqual([{ question_id: 'qst_1', reason: 'masked_empty' }]);
    expect(r.events).toContainEqual({ kind: 'option_state.all_hidden', question_id: 'qst_1' });
  });

  it('receives the axis so a rule can target rows separately from columns', () => {
    const axes: string[] = [];
    const p = page({
      questions: [
        {
          id: 'qst_m',
          ref: 'QM',
          question_type: 'matrix',
          rows: BRANDS.slice(0, 1),
          columns: BRANDS.slice(1, 2),
        },
      ],
    });
    renderPage(
      p,
      SEED,
      ctx({
        optionState: (_q, axis) => {
          axes.push(axis);
          return {};
        },
      }),
    );

    expect(axes).toEqual(['rows', 'columns']);
  });
});

/* ---------------------------------------------------------------- *
 * Randomization
 * ---------------------------------------------------------------- */

describe('randomization', () => {
  const shuffled: RandomizationSpec = { mode: 'shuffle' };

  it('orders items when a spec is present', () => {
    const p = page({
      questions: [
        {
          id: 'qst_1',
          ref: 'Q1',
          question_type: 'single_select',
          options: BRANDS,
          randomize_options: shuffled,
        },
      ],
    });
    const r = renderPage(p, SEED, ctx());

    expect([...codesOf(r)].sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
  });

  it('is deterministic in the seed', () => {
    const p = page({
      questions: [
        {
          id: 'qst_1',
          ref: 'Q1',
          question_type: 'single_select',
          options: BRANDS,
          randomize_options: shuffled,
        },
      ],
    });

    expect(codesOf(renderPage(p, SEED, ctx()))).toEqual(codesOf(renderPage(p, SEED, ctx())));
    expect(codesOf(renderPage(p, SEED, ctx()))).not.toEqual(
      codesOf(renderPage(p, 'f'.repeat(32), ctx())),
    );
  });

  it('randomizes each axis under its own salt', () => {
    const p = page({
      questions: [
        {
          id: 'qst_m',
          ref: 'QM',
          question_type: 'matrix',
          rows: BRANDS,
          columns: BRANDS,
          randomize_rows: shuffled,
          randomize_columns: shuffled,
        },
      ],
    });
    const r = renderPage(p, SEED, ctx());

    expect(r.questions[0]?.rows?.items.map(i => i.code)).not.toEqual(
      r.questions[0]?.columns?.items.map(i => i.code),
    );
  });

  it('records a subset as a design write', () => {
    const p = page({
      questions: [
        {
          id: 'qst_1',
          ref: 'Q1',
          question_type: 'single_select',
          options: BRANDS,
          randomize_options: { mode: 'subset', n: 2 },
        },
      ],
    });
    const r = renderPage(p, SEED, ctx());

    expect(r.design_writes).toHaveLength(1);
    expect(r.design_writes[0]).toMatchObject({ question_id: 'qst_1', axis: 'options' });
    expect(r.design_writes[0]?.codes).toEqual(codesOf(r));
  });

  it('surfaces a counter-backed mode rather than seeding it', () => {
    const p = page({
      questions: [
        {
          id: 'qst_1',
          ref: 'Q1',
          question_type: 'single_select',
          options: BRANDS,
          randomize_options: { mode: 'rotate' },
        },
      ],
    });
    const r = renderPage(p, SEED, ctx());

    expect(r.events).toContainEqual({
      kind: 'randomize.needs_counter',
      question_id: 'qst_1',
      detail: 'options',
    });
  });

  it('surfaces a missing shared group', () => {
    const p = page({
      questions: [
        {
          id: 'qst_1',
          ref: 'Q1',
          question_type: 'single_select',
          options: BRANDS,
          randomize_options: { mode: 'shuffle', group_ref: 'brands' },
        },
      ],
    });
    const r = renderPage(p, SEED, ctx());

    expect(r.events).toContainEqual({
      kind: 'randomize.group_missing',
      question_id: 'qst_1',
      detail: 'options',
    });
  });
});

/* ---------------------------------------------------------------- *
 * THE ORDER (E §9.2)
 * ---------------------------------------------------------------- */

describe('stage order', () => {
  it('masks before randomizing, so a shared group survives differing masks', () => {
    // The load-bearing assertion. Randomize-then-mask passes every per-stage test and breaks
    // exactly this: two questions in a battery would disagree on brand order the moment their
    // masks differ.
    const groupSpec: RandomizationSpec = { mode: 'shuffle', group_ref: 'brands' };
    const groupFor = () => ({ ref: 'brands', canonical: BRANDS });

    const q5 = renderPage(
      page({
        questions: [
          {
            id: 'qst_5',
            ref: 'Q5',
            question_type: 'multi_select',
            options: BRANDS,
            randomize_options: groupSpec,
          },
        ],
      }),
      SEED,
      ctx({ groupFor }),
    );

    const q6 = renderPage(
      page({
        questions: [
          {
            id: 'qst_6',
            ref: 'Q6',
            question_type: 'multi_select',
            options: BRANDS,
            masks: [brandMask('show_all')],
            randomize_options: groupSpec,
          },
        ],
      }),
      SEED,
      ctx({ vars: { var_q1: [1, 3] }, groupFor }),
    );

    // Q6 saw a subset; its order must be the subsequence of Q5's full order.
    expect(codesOf(q6)).toEqual(codesOf(q5).filter(c => c === 1 || c === 3));
  });

  it('option state runs after masking and before randomization', () => {
    // A hidden item must be gone from the ordered output, and the mask must have run first.
    const p = page({
      questions: [
        {
          id: 'qst_1',
          ref: 'Q1',
          question_type: 'multi_select',
          options: BRANDS,
          masks: [brandMask('show_all')],
          randomize_options: { mode: 'shuffle' },
        },
      ],
    });
    const r = renderPage(
      p,
      SEED,
      ctx({
        vars: { var_q1: [1, 2, 3] },
        optionState: (_q, _a, item) => ({ hidden: item.code === 2 }),
      }),
    );

    expect([...codesOf(r)].sort((a, b) => a - b)).toEqual([1, 3]);
  });

  it('a terminate mask stops the page render', () => {
    const p = page({
      questions: [
        {
          id: 'qst_1',
          ref: 'Q1',
          question_type: 'multi_select',
          options: BRANDS,
          masks: [brandMask('terminate')],
        },
        { id: 'qst_2', ref: 'Q2', question_type: 'text' },
      ],
    });
    const r = renderPage(p, SEED, ctx({ vars: { var_q1: [] } }));

    expect(r.terminate?.question_id).toBe('qst_1');
    // Q2 still renders — the caller finalizes, and a half-rendered page would be a lie about
    // what the machine decided.
    expect(r.questions.map(q => q.id)).toEqual(['qst_2']);
  });
});

/* ---------------------------------------------------------------- *
 * Piping
 * ---------------------------------------------------------------- */

describe('piping', () => {
  it('interpolates the label', () => {
    const p = page({
      questions: [
        { id: 'qst_1', ref: 'Q1', question_type: 'text', label: 'Hello {{name}}!' },
      ],
    });
    const r = renderPage(p, SEED, ctx({ vars: { name: 'Ada' } }));

    expect(r.questions[0]?.label).toBe('Hello Ada!');
  });

  it('interpolates the instruction', () => {
    const p = page({
      questions: [
        {
          id: 'qst_1',
          ref: 'Q1',
          question_type: 'text',
          instruction: 'You picked {{q1.count}}',
        },
      ],
    });
    const r = renderPage(p, SEED, ctx({ vars: { q1: ['a', 'b'] } }));

    expect(r.questions[0]?.instruction).toBe('You picked 2');
  });

  it('uses the configured empty token for a null target', () => {
    const p = page({
      questions: [{ id: 'qst_1', ref: 'Q1', question_type: 'text', label: 'Hi {{name}}' }],
    });
    const r = renderPage(p, SEED, ctx({ vars: { name: null }, emptyToken: '—' }));

    expect(r.questions[0]?.label).toBe('Hi —');
  });

  it('escapes by output context, not by the author', () => {
    const p = page({
      questions: [{ id: 'qst_1', ref: 'Q1', question_type: 'text', label: 'Hi {{name}}' }],
    });
    const r = renderPage(
      p,
      SEED,
      ctx({ vars: { name: '<script>' }, escapeContext: 'html_text' }),
    );

    expect(r.questions[0]?.label).toBe('Hi &lt;script&gt;');
  });

  it('leaves a null label null rather than rendering "null"', () => {
    const p = page({ questions: [{ id: 'qst_1', ref: 'Q1', question_type: 'text' }] });
    expect(renderPage(p, SEED, ctx()).questions[0]?.label).toBeNull();
  });
});

/* ---------------------------------------------------------------- *
 * The digest (E §7.2)
 * ---------------------------------------------------------------- */

describe('render digest', () => {
  it('is stable for an identical render', () => {
    expect(renderPage(page(), SEED, ctx()).digest).toBe(renderPage(page(), SEED, ctx()).digest);
  });

  it('changes when the item set changes (a mask moved)', () => {
    const p = page({
      questions: [
        {
          id: 'qst_1',
          ref: 'Q1',
          question_type: 'multi_select',
          options: BRANDS,
          masks: [brandMask('show_all')],
        },
      ],
    });
    const a = renderPage(p, SEED, ctx({ vars: { var_q1: [1, 2] } })).digest;
    const b = renderPage(p, SEED, ctx({ vars: { var_q1: [1, 3] } })).digest;

    expect(a).not.toBe(b);
  });

  it('changes when the item ORDER changes', () => {
    // A reordered list is a different render as far as the respondent's answer is concerned.
    const p = page({
      questions: [
        {
          id: 'qst_1',
          ref: 'Q1',
          question_type: 'single_select',
          options: BRANDS,
          randomize_options: { mode: 'shuffle' },
        },
      ],
    });

    expect(renderPage(p, SEED, ctx()).digest).not.toBe(
      renderPage(p, '9'.repeat(32), ctx()).digest,
    );
  });

  it('changes when piped text changes', () => {
    // "the question it read changed" — E §7.2's third drift criterion.
    const p = page({
      questions: [{ id: 'qst_1', ref: 'Q1', question_type: 'text', label: 'Hi {{name}}' }],
    });

    expect(renderPage(p, SEED, ctx({ vars: { name: 'Ada' } })).digest).not.toBe(
      renderPage(p, SEED, ctx({ vars: { name: 'Bob' } })).digest,
    );
  });

  it('changes when visibility changes', () => {
    expect(renderPage(page(), SEED, ctx()).digest).not.toBe(
      renderPage(page(), SEED, ctx({ isQuestionVisible: () => false })).digest,
    );
  });

  it('changes when an item becomes disabled', () => {
    // Disabled state changes what the respondent can pick, so it is part of the render.
    expect(renderPage(page(), SEED, ctx()).digest).not.toBe(
      renderPage(page(), SEED, ctx({ optionState: () => ({ disabled: true }) })).digest,
    );
  });

  it('does not change for an unrelated variable', () => {
    // The whole point of the survival test in E §7.2: a postcode edit must not look like drift
    // on a page that does not read the postcode.
    expect(renderPage(page(), SEED, ctx({ vars: { postcode: 'SW1A' } })).digest).toBe(
      renderPage(page(), SEED, ctx({ vars: { postcode: 'SW1B' } })).digest,
    );
  });

  it('is a hex string, computable without node:crypto', () => {
    // runtime-core runs in the browser and in QuickJS.
    expect(renderPage(page(), SEED, ctx()).digest).toMatch(/^[0-9a-f]{32}$/);
  });
});

/* ---------------------------------------------------------------- *
 * Purity
 * ---------------------------------------------------------------- */

describe('purity', () => {
  it('does not mutate the page or the items', () => {
    const p = page();
    const before = JSON.stringify(p);
    renderPage(p, SEED, ctx({ optionState: () => ({ disabled: true }) }));

    expect(JSON.stringify(p)).toBe(before);
    expect(BRANDS.map(b => b.code)).toEqual([1, 2, 3, 4]);
  });

  it('identical inputs produce an identical render', () => {
    const p = page({
      questions: [
        {
          id: 'qst_1',
          ref: 'Q1',
          question_type: 'multi_select',
          options: BRANDS,
          masks: [brandMask('show_all')],
          randomize_options: { mode: 'shuffle', respect_anchors: true },
          label: 'Pick from {{q1.count}}',
        },
      ],
    });
    const c = ctx({ vars: { var_q1: [1, 2, 3], q1: ['x'] } });

    expect(renderPage(p, SEED, c)).toEqual(renderPage(p, SEED, c));
  });
});
