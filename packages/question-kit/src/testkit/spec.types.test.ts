/**
 * The type-level half of the harness contract: **"a plugin that does not export the required
 * fixtures does not compile"** (F §9).
 *
 * Every `@ts-expect-error` below is an assertion that runs in `pnpm typecheck`, not in `pnpm test`:
 * TypeScript fails the build if the marked line *stops* being an error. So if a required section of
 * `PluginTestSpec` ever becomes optional, or a fixture's config stops being checked against the
 * plugin's own `Config`, this file goes red — which is the only way "typed so a missing fixture set
 * is a compile error" is a claim rather than a wish.
 *
 * The calls are inside a function that is never invoked. They must be type-checked, and they must
 * not register a duplicate suite.
 */

import { describe, expect, it } from 'vitest';
import { definePluginTests, item, type PluginTestSpec } from './index.js';
import { singleSelect } from '../plugins/single-select/react.js';
import type { SingleSelectAnswer, SingleSelectConfig } from '../plugins/single-select/core.js';

const config: SingleSelectConfig = {
  display: 'vertical',
  columns: 1,
  other: { enabled: false, optionRef: null, maxLen: 200, required: true },
  allowDeselect: false,
};

const complete: PluginTestSpec<SingleSelectConfig, SingleSelectAnswer> = {
  fixtures: { minimal: { config, options: [item('o1', 1)] } },
  variableSnapshots: {
    expected: { minimal: ['Q1 response enum [1]'] },
    assertOrderIndependent: true,
    assertDeterministic: true,
    assertRenameCoherent: true,
    assertAnalysable: true,
  },
  render: {
    dirs: ['ltr'],
    devices: ['desktop'],
    states: { empty: {}, with_errors: {} },
    assertSsrHydrationClean: true,
    assertNoPhysicalDirectionLeak: true,
  },
  validation: [],
  assertValidationSidesAgree: true,
  codec: { roundTrip: {}, assertNoThrow: true, assertVariablesSubsetOfDeclared: true },
  a11y: {
    assertContractRolesPresent: true,
    assertSingleTabStopPerGroup: true,
    assertTouchTargets: true,
    assertNoLocalLiveRegion: true,
    assertErrorWiring: true,
  },
  staticChecks: [],
  composition: {
    asChildOf: [],
    asParentOf: [],
    assertChildNamespacing: false,
    assertTrustCompatibility: false,
  },
};

/** Never called. Its body is the assertion. */
export function typeLevelAssertions(): void {
  // A spec missing the fixture set entirely.
  // @ts-expect-error - `fixtures` is required: F §9's central claim.
  definePluginTests(singleSelect, { ...complete, fixtures: undefined });

  // A spec missing the variable snapshots — the export-contract section.
  const { variableSnapshots: _snapshots, ...withoutSnapshots } = complete;
  // @ts-expect-error - `variableSnapshots` is required.
  definePluginTests(singleSelect, withoutSnapshots);

  // A spec missing the codec section.
  const { codec: _codec, ...withoutCodec } = complete;
  // @ts-expect-error - `codec` is required.
  definePluginTests(singleSelect, withoutCodec);

  // A spec missing the a11y section, which is where the CI-blocking gates live.
  const { a11y: _a11y, ...withoutA11y } = complete;
  // @ts-expect-error - `a11y` is required.
  definePluginTests(singleSelect, withoutA11y);

  // A spec missing the composition section.
  const { composition: _composition, ...withoutComposition } = complete;
  // @ts-expect-error - `composition` is required.
  definePluginTests(singleSelect, withoutComposition);

  // A render matrix missing the mandatory `with_errors` state.
  definePluginTests(singleSelect, {
    ...complete,
    // @ts-expect-error - `empty` and `with_errors` are required by name.
    render: { ...complete.render, states: { empty: {} } },
  });

  // A fixture config that is not this plugin's config.
  definePluginTests(singleSelect, {
    ...complete,
    // @ts-expect-error - a fixture is typed against the plugin's own Config.
    fixtures: { minimal: { config: { display: 'carousel' } } },
  });

  // A round-trip answer that is not this plugin's Answer.
  definePluginTests(singleSelect, {
    ...complete,
    // @ts-expect-error - a codec answer is typed against the plugin's own Answer.
    codec: { ...complete.codec, roundTrip: { minimal: [{ selected: 1 }] } },
  });

  // A validation case whose value is not this plugin's Answer.
  definePluginTests(singleSelect, {
    ...complete,
    // @ts-expect-error - a validation value is typed against the plugin's own Answer.
    validation: [{ fixture: 'minimal', value: { score: 3 }, required: true, expect: [] }],
  });
}

describe('the spec type', () => {
  it('exists to be checked by tsc, and the function above is never run', () => {
    // The assertions in this file are compile-time. This test documents that and keeps the file
    // from looking like an empty suite to anyone reading the test report.
    expect(typeof typeLevelAssertions).toBe('function');
  });

  it('accepts a complete spec', () => {
    expect(Object.keys(complete).sort()).toEqual([
      'a11y',
      'assertValidationSidesAgree',
      'codec',
      'composition',
      'fixtures',
      'render',
      'staticChecks',
      'validation',
      'variableSnapshots',
    ]);
  });
});
