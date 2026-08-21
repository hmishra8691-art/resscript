// @vitest-environment jsdom
/**
 * `consent` against the conformance harness.
 *
 * The two assertions this file exists for:
 *
 *  1. **The frozen contract is the PAIR** — `Q_consent boolean` + `Q_consent_at date` — with
 *     `pii` hard-false even when the author flags the question (the `flagged_pii` fixture pins
 *     the absence of the `(pii)` marker: redacting a consent record defeats it).
 *  2. **The codec writes only the boolean.** `Q_consent_at` is runtime-stamped because the
 *     codec has no clock (ADR-006); a diff that makes the property test below see a second key
 *     is a diff that put a wall clock in a deterministic path.
 */

import { describe, expect, it } from 'vitest';
import { definePluginTests, item } from '../../testkit/index.js';
import { declareVariablesFor } from '../../declare.js';
import { createCodecContext, resolveQuestion } from '../../resolve.js';
import { fixtureQuestion } from '../../testkit/spec.js';
import { consent } from './react.js';
import type { ConsentConfig } from './core.js';

const block: ConsentConfig = { statementKey: 'Q1.statement', declineBehavior: 'block' };
const record: ConsentConfig = { statementKey: 'Q1.statement', declineBehavior: 'record' };

definePluginTests(consent, {
  fixtures: {
    minimal: { config: block, required: true },
    record: { config: record, required: true },
    optional_record: { config: record },
    looped: {
      config: block,
      required: true,
      loop: { iterationVariableRef: 'WAVE', naming: '{ref}_{iteration}', iteration: 2 },
    },
    excluded_from_export: { config: block, required: true, flags: { excludeFromExport: true } },
    // The author's PII flag is deliberately NOT inherited — no `(pii)` marker below.
    flagged_pii: { config: block, required: true, flags: { pii: true } },
  },

  variableSnapshots: {
    expected: {
      minimal: ['Q1_consent response boolean', 'Q1_consent_at response date'],
      record: ['Q1_consent response boolean', 'Q1_consent_at response date'],
      optional_record: ['Q1_consent response boolean', 'Q1_consent_at response date'],
      // The suffix is part of the base name; the iteration wraps the whole thing (the `date`
      // range convention).
      looped: ['Q1_consent_2 response boolean', 'Q1_consent_at_2 response date'],
      excluded_from_export: [
        'Q1_consent response boolean (unexported)',
        'Q1_consent_at response date (unexported)',
      ],
      flagged_pii: ['Q1_consent response boolean', 'Q1_consent_at response date'],
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
      agreed: { value: { agreed: true } },
      declined: { value: { agreed: false } },
      with_errors: {
        value: { agreed: null },
        issues: [{ variableName: 'Q1_consent', messageKey: 'err.required', severity: 'error' }],
      },
    },
    assertSsrHydrationClean: true,
    assertNoPhysicalDirectionLeak: true,
  },

  validation: [
    { fixture: 'minimal', value: undefined, required: true, expect: ['err.required'] },
    { fixture: 'minimal', value: { agreed: null }, required: true, expect: ['err.required'] },
    // Block mode: an explicit decline fails the same key as untouched — one visual state, one
    // message (core.ts documents the rejected plugin-local-key alternative).
    { fixture: 'minimal', value: { agreed: false }, required: true, expect: ['err.required'] },
    { fixture: 'minimal', value: { agreed: true }, required: true, expect: [] },
    // Not required: block has nothing to block.
    { fixture: 'minimal', value: { agreed: false }, required: false, expect: [] },
    { fixture: 'minimal', value: undefined, required: false, expect: [] },
    // Record mode: declining is an answer; only "untouched" fails required.
    { fixture: 'record', value: { agreed: false }, required: true, expect: [] },
    { fixture: 'record', value: { agreed: null }, required: true, expect: ['err.required'] },
    { fixture: 'record', value: { agreed: true }, required: true, expect: [] },
  ],
  assertValidationSidesAgree: true,

  codec: {
    roundTrip: {
      minimal: [{ agreed: true }, { agreed: false }, { agreed: null }],
      record: [{ agreed: true }, { agreed: false }, { agreed: null }],
    },
    extraHostileInputs: [
      // Consent by coercion: none of these are an assertion anyone made.
      { agreed: 1 },
      { agreed: 'yes' },
      { agreed: 'true' },
      { agreed: {} },
      { agreed: [true] },
      // A forged timestamp riding alongside a real agreement must not survive parse.
      { agreed: true, consent_at: '2026-01-01' },
    ],
    assertNoThrow: true,
    assertVariablesSubsetOfDeclared: true,
  },

  a11y: {
    assertContractRolesPresent: true,
    assertSingleTabStopPerGroup: true,
    assertTouchTargets: true,
    assertNoLocalLiveRegion: true,
    assertErrorWiring: true,
  },

  staticChecks: [
    { fixture: 'minimal', expect: [] },
    { fixture: 'record', expect: [] },
    { fixture: 'optional_record', expect: [] },
    {
      fixture: 'minimal',
      mutate: (q) => ({ ...q, required: false }),
      expect: ['block_without_required'],
    },
    {
      fixture: 'minimal',
      mutate: (q) => ({ ...q, options: [item('o1', 1)] }),
      expect: ['options_ignored'],
    },
  ],

  composition: {
    // Not composable: companion variables have no cell-scoped name (`Q5r3_consent` has no
    // schema §4 part) — the nps limitation, verbatim. See `meta.composable` in core.ts.
    asChildOf: [],
    asParentOf: [],
    assertChildNamespacing: false,
    assertTrustCompatibility: false,
  },
});

/* -------------------------------------------------------------------------- */
/* Properties that are specific to this plugin                                 */
/* -------------------------------------------------------------------------- */

describe('consent codec and the runtime-stamped timestamp', () => {
  const question = fixtureQuestion('consent', { config: block, required: true });
  const declarations = declareVariablesFor(consent, question).declarations;
  const ctx = createCodecContext({
    question,
    resolved: resolveQuestion(question, declarations),
  });

  it('declares the pair but writes ONLY the boolean — consent_at is the runtime clock, not ours', () => {
    expect(declarations.map((declaration) => declaration.name)).toEqual(['Q1_consent', 'Q1_consent_at']);
    for (const answer of [{ agreed: true }, { agreed: false }, { agreed: null }]) {
      const vars = consent.codec.toVariables(answer, ctx);
      expect(Object.keys(vars)).toEqual(['Q1_consent']);
    }
  });

  it('both variables are hard non-PII whatever the question flags say', () => {
    const flagged = fixtureQuestion('consent', { config: block, flags: { pii: true } });
    for (const declaration of declareVariablesFor(consent, flagged).declarations) {
      expect(declaration.pii).toBe(false);
    }
  });

  it('a stray stored consent_at never leaks into the Answer on resume', () => {
    // fromVariables reads only the boolean: the timestamp is export/audit data, not UI state,
    // and an Answer carrying it could not round-trip (toVariables would have to drop or forge it).
    const back = consent.codec.fromVariables(
      { Q1_consent: true, Q1_consent_at: '2026-08-21' },
      ctx,
    );
    expect(back).toEqual({ agreed: true });
  });
});
