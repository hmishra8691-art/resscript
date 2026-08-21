/**
 * What the compiled pages must get right.
 *
 * Three properties are load-bearing and each is asserted where the wrong answer is visible rather
 * than where it is convenient.
 *
 * **Labels are resolved per language.** The German fixture bundle is deliberately incomplete, so
 * the test asserts both halves: a translated label differs from the base one, and an untranslated
 * one falls back — which is the pair that distinguishes "resolved per language" from "resolved
 * once and copied".
 *
 * **`position` is 0-based and dense.** The fixture writes 1-based positions with gaps relative to
 * the array (`position: code`), so an emitter that copied the field would produce `[1, 2, 3]` and
 * one that densified would produce `[0, 1, 2]`. `code` is asserted alongside, because the whole
 * point of the two fields being separate is that densifying one must not touch the other.
 *
 * **`inline_rules` excludes what it must.** Three rules, one per class: same-page (inlined),
 * cross-page (inlined nowhere), and one writing a hidden variable (inlined nowhere). Asserting only
 * the positive case would pass on an emitter that inlined everything, which is the failure mode
 * that costs ADR-004's divergence metric rather than a fetch.
 */

import { describe, expect, it } from 'vitest';
import type { CompiledPage, CompiledQuestion } from '@resscript/schema';

import { compileFixture, type Fixture } from './__fixtures__/artifact.js';
import { pagePath } from './pages.js';

describe('buildPages', () => {
  it('emits one tree per carried language, base first', () => {
    const { pages } = compileFixture({ languages: ['de'] });

    expect(pages.languages).toEqual(['en', 'de']);
    expect(pages.baseLanguage).toBe('en');
    expect(Object.keys(pages.byLanguage).sort()).toEqual(['de', 'en']);
  });

  it('emits exactly the pages the flow can reach, keyed by page id', () => {
    const { pages, graph, ids } = compileFixture();

    expect(Object.keys(pages.byLanguage['en'] ?? {}).sort()).toEqual([ids.page1, ids.page2].sort());
    expect(graph.pageOrder).toHaveLength(2);
  });

  it('resolves labels into the respondent language, falling back per policy where absent', () => {
    const fixture = compileFixture({ languages: ['de'] });
    const en = questionOf(fixture, 'en', fixture.ids.page1, fixture.ids.q1);
    const de = questionOf(fixture, 'de', fixture.ids.page1, fixture.ids.q1);

    expect(en.label).toBe('Pick one');
    expect(de.label).toBe('[de] Pick one');
    expect(de.instruction).toBe('[de] Choose the closest');
    // `q1.o1` is translated, `q1.o2` is not — so the second option falls back to the base text.
    expect(de.options?.[0]?.label).toBe('[de] Yes');
    expect(de.options?.[1]?.label).toBe('No');
  });

  it('densifies position to the 0-based array index and leaves code alone', () => {
    const fixture = compileFixture();
    const q5 = questionOf(fixture, 'en', fixture.ids.page1, fixture.ids.q5);

    expect(q5.options?.map((item) => item.position)).toEqual([0, 1, 2]);
    expect(q5.options?.map((item) => item.code)).toEqual([1, 2, 3]);
  });

  it('carries the resolved plugin key as question_type, and the authored string when unresolved', () => {
    const fixture = compileFixture({ withPlugins: true });

    expect(questionOf(fixture, 'en', fixture.ids.page1, fixture.ids.q1).question_type).toBe(
      'single_select@1',
    );
    // `numeric` is not a first-party core, so it does not resolve. `CMP-0400` reports it; the page
    // keeps the authored string rather than dropping the question.
    expect(questionOf(fixture, 'en', fixture.ids.page2, fixture.ids.q7).question_type).toBe('numeric');
  });

  it('makes config, validation, masks and emits required rather than optional', () => {
    const fixture = compileFixture();
    const q1 = questionOf(fixture, 'en', fixture.ids.page1, fixture.ids.q1);
    const q5 = questionOf(fixture, 'en', fixture.ids.page1, fixture.ids.q5);

    expect(q1.config).toEqual({});
    expect(q1.validation).toEqual([]);
    expect(q1.masks).toEqual([]);
    expect(q1.emits.length).toBeGreaterThan(0);
    expect(q5.masks).toHaveLength(1);
    expect(q5.config).not.toEqual({});
  });

  it('omits an axis the question does not declare rather than emitting an empty one', () => {
    const fixture = compileFixture();
    const q1 = questionOf(fixture, 'en', fixture.ids.page1, fixture.ids.q1);

    expect(q1.options).toHaveLength(2);
    expect(Object.keys(q1)).not.toContain('rows');
    expect(Object.keys(q1)).not.toContain('columns');
  });

  it('carries the block path and the page settings', () => {
    const fixture = compileFixture();
    const page = pageOf(fixture, 'en', fixture.ids.page1);

    expect(page.block_path).toEqual([fixture.ids.block]);
    expect(page.settings).toEqual({ layout: 'stacked', back_allowed: true });
    expect(pageOf(fixture, 'en', fixture.ids.page2).settings).toEqual({});
  });
});

describe('inline_rules', () => {
  it('inlines a rule whose trigger and target are both on the page', () => {
    const fixture = compileFixture();
    const page1 = pageOf(fixture, 'en', fixture.ids.page1);

    // The display rule hiding Q5 on a probe of Q1: both cells live on page 1.
    expect(page1.inline_rules.map((rule) => rule.target_id)).toContain(fixture.ids.q5);
  });

  it('inlines the mask synthesized from the question, whose items cell is page-local', () => {
    const fixture = compileFixture();
    const page1 = pageOf(fixture, 'en', fixture.ids.page1);

    expect(page1.inline_rules.some((rule) => rule.kind === 'mask')).toBe(true);
  });

  it('inlines a cross-page rule on neither page', () => {
    const fixture = compileFixture();
    const page1 = pageOf(fixture, 'en', fixture.ids.page1);
    const page2 = pageOf(fixture, 'en', fixture.ids.page2);

    // The rule hiding Q7 (page 2) on a probe of Q1 (page 1) cannot be evaluated from either page's
    // state alone.
    expect(page1.inline_rules.map((rule) => rule.target_id)).not.toContain(fixture.ids.q7);
    expect(page2.inline_rules).toEqual([]);
  });

  it('inlines a rule writing a hidden variable nowhere, because that cell has no page', () => {
    const fixture = compileFixture();

    const targets = fixture.pages.languages.flatMap((language) =>
      Object.values(fixture.pages.byLanguage[language] ?? {}).flatMap((page) =>
        page.inline_rules.map((rule) => rule.target_id),
      ),
    );

    expect(targets).not.toContain(fixture.ids.hidden);
  });

  it('inlines the same rules into every language, byte-identically', () => {
    const fixture = compileFixture({ languages: ['de'] });

    expect(pageOf(fixture, 'de', fixture.ids.page1).inline_rules).toEqual(
      pageOf(fixture, 'en', fixture.ids.page1).inline_rules,
    );
  });

  it('emits an inlined rule identically to the same rule in logic.rules', () => {
    const fixture = compileFixture();
    const inlined = pageOf(fixture, 'en', fixture.ids.page1).inline_rules;

    for (const rule of inlined) {
      const central = fixture.artifactLogic.rules.find((candidate) => candidate.id === rule.id);
      expect(central).toEqual(rule);
    }
    expect(inlined.length).toBeGreaterThan(0);
  });

  it('keeps inlined rules in the canonical order logic.rules is in', () => {
    const fixture = compileFixture();
    const inlined = pageOf(fixture, 'en', fixture.ids.page1).inline_rules.map((rule) => rule.id);
    const central = fixture.artifactLogic.rules
      .map((rule) => rule.id)
      .filter((id) => inlined.includes(id));

    expect(inlined).toEqual(central);
  });
});

describe('pagePath', () => {
  it('is the one place the per-language layout is spelled', () => {
    expect(pagePath('de', 'pg_1')).toBe('pages/de/pg_1.json');
  });
});

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function pageOf(fixture: Fixture, language: string, pageId: string): CompiledPage {
  const page = fixture.pages.byLanguage[language]?.[pageId];
  if (page === undefined) throw new Error(`no page ${pageId} in ${language}`);
  return page;
}

function questionOf(
  fixture: Fixture,
  language: string,
  pageId: string,
  questionId: string,
): CompiledQuestion {
  const found = pageOf(fixture, language, pageId).questions.find((q) => q.id === questionId);
  if (found === undefined) throw new Error(`no question ${questionId} on ${pageId}`);
  return found;
}
