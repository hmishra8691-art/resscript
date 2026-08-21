/**
 * What the entitlement check must get right.
 *
 * The pair that carries the whole file is `entitlements: undefined` against `new Set()` on the same
 * survey: nothing and everything. If those two ever agree, either every fixture in the monorepo
 * fails to publish (undefined behaving like empty) or a free-tier org can publish a conjoint study
 * (empty behaving like undefined), and both are the kind of bug that ships.
 *
 * The second claim worth pinning is that a plugin-declared key is enforced even when
 * `survey.entitlement_reqs` does not mention it — `PluginMeta.entitlementKey`'s own comment says
 * that is the enforcement that matters, because a caller can edit the stored list and cannot edit
 * the plugin.
 *
 * Diagnostics are asserted by code and `detail`, never by message prose.
 */

import { describe, expect, it } from 'vitest';
import type { Survey } from '@resscript/schema';

import { deterministicIds } from '../../../schema/src/__fixtures__/mini.js';
import type { CompileDiagnostic } from '../diagnostics.js';
import {
  analyzeEntitlements,
  collectEntitlements,
  type PluginEntitlementIndex,
} from './entitlements.js';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

function surveyOf(reqs: readonly string[]): Survey {
  const ids = deterministicIds();
  return {
    meta: { id: ids.next('survey'), ref: 'ENT', name: 'Entitlement fixture' },
    schema_version: 2,
    settings: {
      navigation: { back_allowed: true },
      resume: { enabled: false, window_s: 3600, position: 'last_page' },
      progress_bar: { mode: 'none' },
      screenout: { show_message: false },
    },
    languages: {
      base: 'en',
      available: [{ code: 'en' }],
      bundles: { en: {} },
      policy: { on_missing: 'fallback_to_base', block_publish_if_incomplete: false },
    },
    variables: [],
    content: [],
    flow: { nodes: [] },
    logic_rules: [],
    entitlement_reqs: reqs,
  };
}

/** What `resolvePlugins` hands over, as the narrow interface this pass declares. */
function plugins(entries: readonly (readonly [string, string])[]): PluginEntitlementIndex {
  return { entitlementKeys: new Map(entries) };
}

const NO_PLUGINS: PluginEntitlementIndex = plugins([]);

function codes(diagnostics: readonly CompileDiagnostic[]): readonly string[] {
  return diagnostics.map((d) => d.code);
}

function detailOf(
  diagnostics: readonly CompileDiagnostic[],
  code: string,
): { readonly [key: string]: unknown } {
  const found = diagnostics.find((d) => d.code === code);
  if (found?.detail === undefined) throw new Error(`no ${code} with detail`);
  return found.detail;
}

/* -------------------------------------------------------------------------- */
/* undefined vs empty                                                         */
/* -------------------------------------------------------------------------- */

describe('undefined and an empty set are different', () => {
  it('checks nothing when entitlements is undefined', () => {
    expect(
      analyzeEntitlements({
        survey: surveyOf(['conjoint', 'maxdiff']),
        plugins: NO_PLUGINS,
      }),
    ).toEqual([]);
  });

  it('checks nothing when entitlements is explicitly undefined', () => {
    expect(
      analyzeEntitlements({
        survey: surveyOf(['conjoint']),
        entitlements: undefined,
        plugins: NO_PLUGINS,
      }),
    ).toEqual([]);
  });

  it('denies every requirement when the plan grants nothing', () => {
    const diagnostics = analyzeEntitlements({
      survey: surveyOf(['conjoint', 'maxdiff']),
      entitlements: new Set(),
      plugins: NO_PLUGINS,
    });

    // Sorted by key, one row per key.
    expect(codes(diagnostics)).toEqual(['CMP-0600', 'CMP-0600']);
    expect(diagnostics.map((d) => d.detail?.['entitlement_key'])).toEqual(['conjoint', 'maxdiff']);
    expect(diagnostics[0]?.severity).toBe('error');
    const detail = detailOf(diagnostics, 'CMP-0600');
    expect(detail['granted_count']).toBe(0);
    expect(detail['source_count']).toBe(1);
    expect(detail['sources']).toEqual([{ source: 'entitlement_reqs', source_id: '0' }]);
  });

  it('accepts a requirement the plan grants', () => {
    expect(
      analyzeEntitlements({
        survey: surveyOf(['conjoint']),
        entitlements: new Set(['conjoint', 'maxdiff']),
        plugins: NO_PLUGINS,
      }),
    ).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* The two sources                                                            */
/* -------------------------------------------------------------------------- */

describe('where a requirement comes from', () => {
  it("enforces a plugin's key even when the stored list omits it", () => {
    const diagnostics = analyzeEntitlements({
      survey: surveyOf([]),
      entitlements: new Set(['basic']),
      plugins: plugins([
        ['qst_a', 'conjoint'],
        ['qst_b', 'conjoint'],
      ]),
    });

    expect(codes(diagnostics)).toEqual(['CMP-0600']);
    const detail = detailOf(diagnostics, 'CMP-0600');
    expect(detail['entitlement_key']).toBe('conjoint');
    // One row for two questions: twelve conjoint questions is one purchase decision.
    expect(detail['source_count']).toBe(2);
    expect(detail['sources']).toEqual([
      { source: 'plugin', source_id: 'qst_a' },
      { source: 'plugin', source_id: 'qst_b' },
    ]);
  });

  it('merges the two sources into one row per key', () => {
    const diagnostics = analyzeEntitlements({
      survey: surveyOf(['conjoint']),
      entitlements: new Set(),
      plugins: plugins([['qst_a', 'conjoint']]),
    });

    expect(codes(diagnostics)).toEqual(['CMP-0600']);
    const detail = detailOf(diagnostics, 'CMP-0600');
    expect(detail['source_count']).toBe(2);
    expect(detail['sources']).toEqual([
      { source: 'entitlement_reqs', source_id: '0' },
      { source: 'plugin', source_id: 'qst_a' },
    ]);
    // The pointer is the authored row, which is where the author can act.
    expect(diagnostics[0]?.path).toBe('/entitlement_reqs/0');
  });
});

/* -------------------------------------------------------------------------- */
/* collectEntitlements                                                        */
/* -------------------------------------------------------------------------- */

describe('collectEntitlements', () => {
  it('is the sorted union of the stored list and every plugin key', () => {
    expect(
      collectEntitlements(
        surveyOf(['maxdiff', 'conjoint']),
        plugins([
          ['qst_a', 'conjoint'],
          ['qst_b', 'video_open_end'],
        ]),
      ),
    ).toEqual(['conjoint', 'maxdiff', 'video_open_end']);
  });

  it('is empty for a survey that requires nothing', () => {
    expect(collectEntitlements(surveyOf([]), NO_PLUGINS)).toEqual([]);
  });

  it('does not depend on the plugin resolution order', () => {
    const forwards = collectEntitlements(
      surveyOf([]),
      plugins([
        ['qst_a', 'b_feature'],
        ['qst_b', 'a_feature'],
      ]),
    );
    const backwards = collectEntitlements(
      surveyOf([]),
      plugins([
        ['qst_b', 'a_feature'],
        ['qst_a', 'b_feature'],
      ]),
    );
    expect(forwards).toEqual(backwards);
    expect(forwards).toEqual(['a_feature', 'b_feature']);
  });
});
