/**
 * `exportContribution` for the three Phase-1 plugins.
 *
 * The exporter never calls `declareVariables` — it reads the frozen manifest — but it *does* call
 * this, at the plugin version recorded in that manifest (F §7). So these labels are what a client
 * opens in SPSS or a labelled CSV, and a wrong one is a support ticket about somebody else's data
 * dictionary. F §9's harness has no export section, so this file is where the surface is covered.
 */

import { describe, expect, it } from 'vitest';
import { declareVariablesFor } from '../declare.js';
import { resolveQuestion } from '../resolve.js';
import { fixtureQuestion, item, type PluginFixture } from '../testkit/spec.js';
import { multiSelectCore } from './multi-select/core.js';
import { npsCore } from './nps/core.js';
import { singleSelectCore } from './single-select/core.js';
import type { ExportContext } from '../contract/export.js';
import type { QuestionTypePluginCore } from '../contract/plugin.js';
import type { VariableDeclaration } from '../contract/variables.js';

/** The export context: one language, labels resolved through `t`. */
function contextFor<Config>(
  plugin: QuestionTypePluginCore<Config, unknown>,
  // `NoInfer`, for the reason `definePluginTests` needs it: without it TypeScript infers `Config`
  // from the fixture literal (widening `'vertical'` to `string`) and then blames the plugin.
  fixture: PluginFixture<NoInfer<Config>>,
): {
  readonly declarations: readonly VariableDeclaration[];
  readonly ctx: ExportContext<Config>;
} {
  const question = fixtureQuestion(plugin.meta.id, fixture);
  const declarations = declareVariablesFor(plugin, question).declarations;
  const resolved = resolveQuestion(question, declarations);
  return {
    declarations,
    ctx: {
      question: resolved,
      config: question.config,
      lang: 'en',
      // Missing keys return the key: a blank column label is worse than an ugly one, because the
      // analyst cannot tell which column they are looking at.
      t: (key) => `«${key}»`,
    },
  };
}

const byName = (
  declarations: readonly VariableDeclaration[],
  name: string,
): VariableDeclaration => {
  const hit = declarations.find((declaration) => declaration.name === name);
  if (hit === undefined) throw new Error(`no declaration named ${name}`);
  return hit;
};

describe('single_select', () => {
  const { declarations, ctx } = contextFor(singleSelectCore, {
    config: {
      display: 'vertical',
      columns: 1,
      other: { enabled: true, optionRef: 'o9', maxLen: 200, required: true },
      allowDeselect: false,
    },
    options: [item('o1', 1), item('o9', 9, { otherSpecify: true })],
  });

  it('labels the scalar column with the question label', () => {
    expect(singleSelectCore.exportContribution.columnLabel(byName(declarations, 'Q1'), ctx)).toBe(
      '«Q1.label»',
    );
  });

  it('marks the verbatim column as the other-specify, not as a second copy of the question', () => {
    expect(
      singleSelectCore.exportContribution.columnLabel(byName(declarations, 'Q1_other'), ctx),
    ).toBe('«Q1.label» — other (specify)');
  });

  it('emits value labels for the enum and none for the verbatim', () => {
    expect(singleSelectCore.exportContribution.valueLabels(byName(declarations, 'Q1'), ctx)).toEqual([
      { code: 1, label: '«opt.o1»' },
      { code: 9, label: '«opt.o9»' },
    ]);
    expect(
      singleSelectCore.exportContribution.valueLabels(byName(declarations, 'Q1_other'), ctx),
    ).toEqual([]);
  });
});

describe('multi_select', () => {
  const { declarations, ctx } = contextFor(multiSelectCore, {
    config: {
      display: 'vertical',
      columns: 1,
      minSelected: 0,
      maxSelected: 0,
      other: { enabled: true, maxLen: 200, required: true },
    },
    options: [item('o1', 1), item('o9', 9, { otherSpecify: true })],
  });

  it('names each boolean column after its own option, so a fan-out is readable', () => {
    // "Q1 — Brand A" rather than five columns all labelled "Q1", which is the version an analyst
    // has to open the questionnaire to interpret.
    expect(multiSelectCore.exportContribution.columnLabel(byName(declarations, 'Q1r1'), ctx)).toBe(
      '«Q1.label» — «opt.o1»',
    );
  });

  it('labels the booleans as selected / not selected', () => {
    expect(multiSelectCore.exportContribution.valueLabels(byName(declarations, 'Q1r1'), ctx)).toEqual([
      { code: true, label: '«common.selected»' },
      { code: false, label: '«common.not_selected»' },
    ]);
  });

  it('falls back to the question label for the set view rather than inventing one', () => {
    expect(multiSelectCore.exportContribution.columnLabel(byName(declarations, 'Q1'), ctx)).toBe(
      '«Q1.label»',
    );
  });

  it('gives the set view the option domain, for a tool that can read a multi-response set', () => {
    expect(multiSelectCore.exportContribution.valueLabels(byName(declarations, 'Q1'), ctx)).toEqual([
      { code: 1, label: '«opt.o1»' },
      { code: 9, label: '«opt.o9»' },
    ]);
  });
});

describe('nps', () => {
  const { declarations, ctx } = contextFor(npsCore, {
    config: { lowLabelKey: 'low', highLabelKey: 'high', display: 'buttons' },
  });

  it('distinguishes the score column from the band column', () => {
    expect(npsCore.exportContribution.columnLabel(byName(declarations, 'Q1'), ctx)).toBe('«Q1.label»');
    expect(npsCore.exportContribution.columnLabel(byName(declarations, 'Q1_band'), ctx)).toBe(
      '«Q1.label» — NPS band',
    );
  });

  it('labels the band codes from schema’s domain, so 1 is always detractor', () => {
    expect(npsCore.exportContribution.valueLabels(byName(declarations, 'Q1_band'), ctx)).toEqual([
      { code: 1, label: '«sys.nps.detractor»' },
      { code: 2, label: '«sys.nps.passive»' },
      { code: 3, label: '«sys.nps.promoter»' },
    ]);
  });

  it('emits no value labels for the numeric score', () => {
    // 0..10 are their own labels; emitting eleven value labels would bloat every SPSS dictionary
    // for no information.
    expect(npsCore.exportContribution.valueLabels(byName(declarations, 'Q1'), ctx)).toEqual([]);
  });
});

describe('analysis metadata', () => {
  it('marks the NPS score as scale and the band as nominal', () => {
    const { declarations } = contextFor(npsCore, {
      config: { lowLabelKey: 'low', highLabelKey: 'high', display: 'buttons' },
    });
    // The measure level decides which analyses a cross-tab tool offers, and reconstructing it later
    // means guessing from the data.
    expect(byName(declarations, 'Q1').analysis?.measure).toBe('scale');
    expect(byName(declarations, 'Q1_band').analysis?.measure).toBe('nominal');
    expect(byName(declarations, 'Q1').analysis?.batteryRef).toBe('Q1');
  });

  it('marks a multi-select fan-out as one battery', () => {
    const { declarations } = contextFor(multiSelectCore, {
      config: {
        display: 'vertical',
        columns: 1,
        minSelected: 0,
        maxSelected: 0,
        other: { enabled: false, maxLen: 200, required: true },
      },
      options: [item('o1', 1), item('o2', 2)],
    });
    // SPSS gets a variable set and the cross-tab tool can offer "the Q1 battery" as one object.
    expect(byName(declarations, 'Q1r1').analysis?.batteryRef).toBe('Q1');
    expect(byName(declarations, 'Q1r2').analysis?.batteryRef).toBe('Q1');
  });
});
