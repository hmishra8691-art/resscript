// @vitest-environment jsdom
/**
 * `content_media` against the conformance harness.
 *
 * The load-bearing assertions: `trackExposure` is the ONLY thing that makes this plugin declare
 * variables (the untracked fixtures pin `[]` exactly like `content_text`), the tracked pair is
 * the frozen `Q_viewed`/`Q_dwell_s` contract, and `missing_alt` is an ERROR while
 * `autoplay_discouraged` is a warning — the severity split is the deliverable's, and a flipped
 * severity here would ship unlabelled images.
 */

import { describe, expect, it } from 'vitest';
import { definePluginTests, item } from '../../testkit/index.js';
import { declareVariablesFor } from '../../declare.js';
import { fixtureQuestion } from '../../testkit/spec.js';
import { contentMedia } from './react.js';
import type { ContentMediaConfig } from './core.js';

const image: ContentMediaConfig = {
  kind: 'image',
  assetRef: 'asset_hero',
  altKey: 'Q1.alt',
  autoplay: false,
  trackExposure: false,
};
const video: ContentMediaConfig = { kind: 'video', assetRef: 'asset_clip', autoplay: false, trackExposure: false };
const audio: ContentMediaConfig = { kind: 'audio', assetRef: 'asset_jingle', autoplay: false, trackExposure: false };
const tracked: ContentMediaConfig = { ...image, trackExposure: true };

definePluginTests(contentMedia, {
  fixtures: {
    minimal: { config: image },
    video: { config: video },
    audio: { config: audio },
    tracked: { config: tracked },
    tracked_looped: {
      config: tracked,
      loop: { iterationVariableRef: 'AD', naming: '{ref}_{iteration}', iteration: 4 },
    },
    tracked_unexported: { config: tracked, flags: { excludeFromExport: true } },
  },

  variableSnapshots: {
    expected: {
      // Untracked stimuli own no columns — explicit emptiness, the content-node contract.
      minimal: [],
      video: [],
      audio: [],
      // The exposure pair. `response` kind is a stated contract compromise (the honest kind,
      // `system`, is the platform's) — see core.ts's header before "fixing" this line.
      tracked: ['Q1_viewed response boolean', 'Q1_dwell_s response number'],
      tracked_looped: ['Q1_viewed_4 response boolean', 'Q1_dwell_s_4 response number'],
      tracked_unexported: [
        'Q1_viewed response boolean (unexported)',
        'Q1_dwell_s response number (unexported)',
      ],
    },
    assertOrderIndependent: true,
    assertDeterministic: true,
    assertRenameCoherent: true,
    assertAnalysable: true,
  },

  render: {
    dirs: ['ltr', 'rtl'],
    devices: ['desktop', 'tablet', 'mobile'],
    states: {
      empty: {},
      // A stimulus has no error state (nothing respondent-fixable can go wrong); declared empty
      // rather than omitted, per the spec's required key.
      with_errors: {},
    },
    assertSsrHydrationClean: true,
    assertNoPhysicalDirectionLeak: true,
  },

  validation: [
    { fixture: 'minimal', value: undefined, required: false, expect: [] },
    { fixture: 'tracked', value: null, required: false, expect: [] },
    // `required` is compile-diagnosed (`required_ignored`), never respondent-enforced.
    { fixture: 'minimal', value: undefined, required: true, expect: [] },
  ],
  assertValidationSidesAgree: true,

  codec: {
    roundTrip: {
      minimal: [null],
      tracked: [null],
    },
    extraHostileInputs: [
      // A client asserting its own exposure: measured by the runtime, never accepted from the
      // wire — a respondent-writable "I saw it" is worthless telemetry.
      { viewed: true },
      { dwell_s: 3.2 },
      { viewed: true, dwell_s: 999999 },
    ],
    assertNoThrow: true,
    assertVariablesSubsetOfDeclared: true,
  },

  a11y: {
    assertContractRolesPresent: true,
    // The contract's flat list is empty because the role depends on `kind` (core.ts documents
    // why); the per-kind truth lives here. `video`/`audio` map to no ARIA role at all, so their
    // fixtures assert through the empty default.
    rolesByFixture: {
      minimal: ['img'],
      tracked: ['img'],
      tracked_looped: ['img'],
      tracked_unexported: ['img'],
    },
    assertSingleTabStopPerGroup: true,
    assertTouchTargets: true,
    assertNoLocalLiveRegion: true,
    assertErrorWiring: true,
  },

  staticChecks: [
    { fixture: 'minimal', expect: [] },
    { fixture: 'video', expect: [] },
    {
      fixture: 'minimal',
      // Destructured out rather than set to `undefined`: under `exactOptionalPropertyTypes`
      // those are different states, and "absent" is the one the editor's `remove` op produces.
      mutate: (q) => {
        const { altKey: _dropped, ...config } = q.config;
        return { ...q, config };
      },
      expect: ['missing_alt'],
    },
    {
      fixture: 'minimal',
      mutate: (q) => ({ ...q, config: { ...q.config, altKey: '   ' } }),
      expect: ['missing_alt'],
    },
    {
      fixture: 'minimal',
      mutate: (q) => ({ ...q, config: { ...q.config, assetRef: '' } }),
      expect: ['missing_asset'],
    },
    {
      fixture: 'video',
      mutate: (q) => ({ ...q, config: { ...q.config, autoplay: true } }),
      expect: ['autoplay_discouraged'],
    },
    {
      fixture: 'audio',
      mutate: (q) => ({ ...q, config: { ...q.config, autoplay: true } }),
      expect: ['autoplay_discouraged'],
    },
    // Autoplay on an image is inert, not diagnosable: there is nothing to play.
    {
      fixture: 'minimal',
      mutate: (q) => ({ ...q, config: { ...q.config, autoplay: true } }),
      expect: [],
    },
    {
      fixture: 'minimal',
      mutate: (q) => ({ ...q, required: true, options: [item('o1', 1)] }),
      expect: ['options_ignored', 'required_ignored'],
    },
  ],

  composition: {
    // Not composable: product ("a stimulus in a grid cell is not a control") and contract
    // (`Q5r3_viewed` has no schema §4 part) agree — see `meta.composable`.
    asChildOf: [],
    asParentOf: [],
    assertChildNamespacing: false,
    assertTrustCompatibility: false,
  },
});

/* -------------------------------------------------------------------------- */
/* Properties that are specific to this plugin                                 */
/* -------------------------------------------------------------------------- */

describe('content_media exposure telemetry', () => {
  it('trackExposure is the only gate: off declares nothing, on declares exactly the pair', () => {
    for (const [trackExposure, expected] of [
      [false, []],
      [true, ['Q1_viewed', 'Q1_dwell_s']],
    ] as const) {
      const question = fixtureQuestion('content_media', {
        config: { ...image, trackExposure },
      });
      const result = declareVariablesFor(contentMedia, question);
      expect(result.diagnostics).toEqual([]);
      expect(result.declarations.map((declaration) => declaration.name)).toEqual(expected);
    }
  });

  it('the telemetry pair is runtime-written: the codec never produces either key', () => {
    // The subset assertion in the harness already allows this; this test pins that it is not an
    // accident — a codec that started writing `Q1_viewed` would be accepting exposure claims
    // from the wire.
    const question = fixtureQuestion('content_media', { config: tracked });
    const declarations = declareVariablesFor(contentMedia, question).declarations;
    expect(declarations).toHaveLength(2);
    for (const declaration of declarations) {
      expect(declaration.kind).toBe('response');
      expect(declaration.source.part.kind).toBe('meta');
      expect(declaration.persist).toBe(true);
    }
  });
});
