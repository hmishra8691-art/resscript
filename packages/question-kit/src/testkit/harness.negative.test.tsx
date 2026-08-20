// @vitest-environment jsdom
/**
 * Negative controls for the conformance harness.
 *
 * Every test here takes a *conforming* plugin, breaks one thing about it, and asserts the harness
 * catches that specific break. A harness with no negative controls is indistinguishable from an
 * empty function: it passes everything, including the plugin whose export columns move when
 * somebody drags an option. This repository has shipped that shape of mistake twice — a
 * dependency-cruiser rule that matched nothing and a set of green tests over transposed SQL bind
 * parameters — which is why these exist before any plugin author sees the kit.
 *
 * The pattern: `collectPluginTests` returns the harness's cases instead of registering them, we run
 * them here, and we assert on *which* case failed and what it said.
 */

import { describe, expect, it } from 'vitest';
import type { ReactNode } from 'react';
import { collectPluginTests, item, type PluginTestSpec } from './index.js';
import { defineRenderer, type RendererProps } from '../contract/view.js';
import { TOUCH_TARGET_CLASS } from '../contract/a11y.js';
import { withComponents, type QuestionTypePlugin } from '../contract/plugin.js';
import { ok, type ResponseCodec } from '../contract/codec.js';
import type { QuestionTypePluginCore } from '../contract/plugin.js';
import type { VariableDeclaration } from '../contract/variables.js';
import type { ValidationIssue } from '../contract/validate.js';
import type { JsonSchema } from '../json-schema.js';
import type { AuthoredItem } from '../contract/items.js';

/* ========================================================================== */
/* A minimal conforming plugin, and the spec that passes for it                */
/* ========================================================================== */

interface ProbeConfig {
  readonly mode: 'plain';
}

interface ProbeAnswer {
  readonly code: number | null;
}

const PROBE_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['mode'],
  properties: { mode: { enum: ['plain'] } },
};

const probeCodec: ResponseCodec<ProbeConfig, ProbeAnswer> = {
  parse: (raw) => {
    if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
      const code = (raw as Record<string, unknown>)['code'];
      return ok({ code: typeof code === 'number' ? code : null });
    }
    return ok({ code: null });
  },
  toVariables: (answer, ctx) => ({ [ctx.name.self()]: answer.code }),
  fromVariables: (vars, ctx) => {
    const value = vars[ctx.name.self()];
    return { code: typeof value === 'number' ? value : null };
  },
  emptyAnswer: () => ({ code: null }),
};

const options: readonly AuthoredItem[] = [item('o1', 1), item('o2', 2), item('o3', 3)];

const ProbeRenderer = defineRenderer<ProbeConfig, ProbeAnswer>(
  ({ question, value, onChange, issues, ctx }: RendererProps<ProbeConfig, ProbeAnswer>): ReactNode => {
    const invalid = issues.length > 0;
    const selectedIndex = question.options.findIndex((option) => option.code === value?.code);
    const tabStop = selectedIndex >= 0 ? selectedIndex : 0;
    return (
      <div
        role="radiogroup"
        aria-labelledby={ctx.ids.labelId}
        aria-describedby={invalid ? ctx.ids.errorId : undefined}
        aria-invalid={invalid ? true : undefined}
      >
        {question.options.map((option, index) => (
          <label key={option.ref} className={TOUCH_TARGET_CLASS}>
            <input
              type="radio"
              name={ctx.ids.groupId}
              checked={option.code === value?.code}
              tabIndex={index === tabStop ? 0 : -1}
              onChange={() => onChange({ code: option.code })}
            />
            <span>{ctx.pipe(option.labelKey)}</span>
          </label>
        ))}
      </div>
    );
  },
);

const probeCore: QuestionTypePluginCore<ProbeConfig, ProbeAnswer> = {
  meta: {
    id: 'probe',
    version: '1.0.0',
    displayName: 'probe.name',
    description: 'probe.desc',
    category: 'choice',
    icon: 'radio',
    entitlementKey: null,
    trust: 'first_party',
    composable: false,
    emitsData: true,
  },
  configSchema: PROBE_SCHEMA,
  defaultConfig: () => ({ mode: 'plain' }),
  declareVariables: (ctx) => [
    {
      name: ctx.name.self(),
      kind: 'response',
      type: 'enum',
      enumDomain: ctx.options.map((option) => ({ code: option.code, labelKey: option.labelKey })),
      source: { part: { kind: 'self' } },
      export: { include: true, column: ctx.name.self(), labelKey: `${ctx.ref}.label`, order: 0 },
      pii: false,
      persist: true,
    },
  ],
  validate: (ctx) =>
    ctx.required && (ctx.value?.code ?? null) === null
      ? [{ variableName: ctx.question.variables.self ?? null, messageKey: 'err.required', severity: 'error' }]
      : [],
  codec: probeCodec,
  exportContribution: {
    columnLabel: (_declaration, ctx) => ctx.t(ctx.question.label),
    valueLabels: () => [],
  },
  a11y: {
    interactionModel: 'radiogroup',
    requiredRoles: ['radiogroup', 'radio'],
    keys: ['Tab', 'ArrowUp', 'ArrowDown', 'Space'],
    minTouchTargetPx: 44,
    pointerDependent: false,
    rtlSafe: true,
  },
};

const probe: QuestionTypePlugin<ProbeConfig, ProbeAnswer> = withComponents(probeCore, {
  editor: () => null,
  renderer: ProbeRenderer,
});

const probeSpec: PluginTestSpec<ProbeConfig, ProbeAnswer> = {
  fixtures: { minimal: { config: { mode: 'plain' }, options, required: true } },
  variableSnapshots: {
    expected: { minimal: ['Q1 response enum [1,2,3]'] },
    assertOrderIndependent: true,
    assertDeterministic: true,
    assertRenameCoherent: true,
    assertAnalysable: true,
  },
  render: {
    dirs: ['ltr'],
    devices: ['desktop'],
    states: {
      empty: {},
      with_errors: {
        value: { code: null },
        issues: [{ variableName: 'Q1', messageKey: 'err.required', severity: 'error' }],
      },
    },
    assertSsrHydrationClean: true,
    assertNoPhysicalDirectionLeak: true,
  },
  validation: [{ fixture: 'minimal', value: undefined, required: true, expect: ['err.required'] }],
  assertValidationSidesAgree: true,
  codec: {
    roundTrip: { minimal: [{ code: 1 }, { code: null }] },
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
  staticChecks: [],
  composition: {
    asChildOf: [],
    asParentOf: [],
    assertChildNamespacing: false,
    assertTrustCompatibility: false,
  },
};

/* ========================================================================== */
/* Running the harness and collecting its verdicts                             */
/* ========================================================================== */

interface Failure {
  readonly name: string;
  readonly message: string;
}

async function runHarness<Config, Answer>(
  plugin: QuestionTypePlugin<Config, Answer>,
  spec: PluginTestSpec<Config, Answer>,
): Promise<readonly Failure[]> {
  const failures: Failure[] = [];
  for (const testCase of collectPluginTests(plugin, spec)) {
    try {
      await testCase.run();
    } catch (error: unknown) {
      // The *actual* value matters as much as the message: vitest's assertion message is a summary
      // ("expected [ Array(1) ] to deeply equal []") and the diagnostic code that proves *which*
      // rule fired lives in `actual`. Without it these controls could only assert "something
      // failed", which is a much weaker claim than "the right thing failed".
      const actual = (error as { actual?: unknown }).actual;
      failures.push({
        name: testCase.name,
        message:
          (error instanceof Error ? error.message : String(error)) +
          (actual === undefined ? '' : ` :: ${JSON.stringify(actual)}`),
      });
    }
  }
  return failures;
}

function withCore<Config, Answer>(
  plugin: QuestionTypePlugin<Config, Answer>,
  overrides: Partial<QuestionTypePluginCore<Config, Answer>>,
): QuestionTypePlugin<Config, Answer> {
  return { ...plugin, ...overrides };
}

/* ========================================================================== */

describe('the harness passes a conforming plugin', () => {
  it('reports no failures for the probe plugin', async () => {
    const failures = await runHarness(probe, probeSpec);
    expect(failures.map((failure) => `${failure.name}: ${failure.message}`)).toEqual([]);
  });

  it('runs a non-trivial number of cases', async () => {
    // Guards the guard: if `collectPluginTests` ever returned nothing, every negative control below
    // would "pass" by finding no failures in an empty list.
    expect(collectPluginTests(probe, probeSpec).length).toBeGreaterThan(20);
  });
});

describe('the harness rejects a plugin whose declareVariables is impure', () => {
  it('catches a hidden counter (non-determinism)', async () => {
    let calls = 0;
    const broken = withCore(probe, {
      declareVariables: (ctx) => {
        calls += 1;
        return [
          {
            name: ctx.name.self(),
            kind: 'response',
            type: 'enum',
            enumDomain: [{ code: calls, labelKey: 'x' }],
            source: { part: { kind: 'self' } },
            export: { include: true, column: ctx.name.self(), labelKey: 'l', order: 0 },
            pii: false,
            persist: true,
          },
        ];
      },
    });
    const failures = await runHarness(broken, probeSpec);
    expect(failures.some((f) => f.name.includes('deterministic'))).toBe(true);
  });

  it('catches a domain built from display position rather than code', async () => {
    const broken = withCore(probe, {
      declareVariables: (ctx) => [
        {
          name: ctx.name.self(),
          kind: 'response',
          type: 'enum',
          // The classic data disaster: the domain follows `position`, so dragging an option
          // silently renumbers the exported values.
          enumDomain: ctx.options.map((option) => ({ code: option.position, labelKey: option.labelKey })),
          source: { part: { kind: 'self' } },
          export: { include: true, column: ctx.name.self(), labelKey: 'l', order: 0 },
          pii: false,
          persist: true,
        },
      ],
    });
    const failures = await runHarness(broken, probeSpec);
    expect(failures.some((f) => f.name.includes('independent of authored item order'))).toBe(true);
  });

  it('catches a string-built name that its own part does not derive', async () => {
    const broken = withCore(probe, {
      declareVariables: (ctx) => [
        {
          name: `${ctx.ref}_score`,
          kind: 'response',
          type: 'number',
          source: { part: { kind: 'self' } },
          export: { include: true, column: `${ctx.ref}_score`, labelKey: 'l', order: 0 },
          pii: false,
          persist: true,
        },
      ],
    });
    const failures = await runHarness(broken, probeSpec);
    expect(
      failures.some((failure) => failure.message.includes('variable_name_not_derived')),
    ).toBe(true);
  });

  it('catches a name in the reserved system namespace', async () => {
    const broken = withCore(probe, {
      declareVariables: () => [
        {
          name: 'duration_s',
          kind: 'response',
          type: 'number',
          source: { part: { kind: 'meta', label: 'duration', suffix: 'duration_s' } },
          export: { include: true, column: 'duration_s', labelKey: 'l', order: 0 },
          pii: false,
          persist: true,
        },
      ],
    });
    const failures = await runHarness(broken, probeSpec);
    expect(failures.some((failure) => failure.message.includes('reserved_variable_name'))).toBe(true);
  });

  it('catches an object-only declaration set (F §4 analysability)', async () => {
    const broken = withCore(probe, {
      declareVariables: (ctx) => [
        {
          name: ctx.name.suffixed('raw'),
          kind: 'response',
          type: 'object',
          source: { part: { kind: 'meta', label: 'raw payload', suffix: 'raw' } },
          export: { include: true, column: ctx.name.suffixed('raw'), labelKey: 'l', order: 0 },
          pii: false,
          persist: true,
        },
      ],
    });
    const failures = await runHarness(broken, probeSpec);
    expect(
      failures.some((failure) => failure.message.includes('non_analysable_declaration')),
    ).toBe(true);
  });

  it('catches two declarations sharing a name', async () => {
    const broken = withCore(probe, {
      declareVariables: (ctx) => {
        const one: VariableDeclaration = {
          name: ctx.name.self(),
          kind: 'response',
          type: 'enum',
          enumDomain: [{ code: 1, labelKey: 'x' }],
          source: { part: { kind: 'self' } },
          export: { include: true, column: ctx.name.self(), labelKey: 'l', order: 0 },
          pii: false,
          persist: true,
        };
        return [one, { ...one, export: { ...one.export, include: false } }];
      },
    });
    const failures = await runHarness(broken, probeSpec);
    expect(
      failures.some((failure) => failure.message.includes('duplicate_variable_name')),
    ).toBe(true);
  });
});

describe('the harness rejects a broken codec', () => {
  it('catches a key that declareVariables never declared', async () => {
    const broken = withCore(probe, {
      codec: {
        ...probeCodec,
        toVariables: (answer, ctx) => ({
          [ctx.name.self()]: answer.code,
          // ADR-005 threat 3: an undeclared key is a manifest violation and a hard 400 in
          // production. Here it has to be a failed test.
          [`${ctx.ref}_secret`]: 1,
        }),
      },
    });
    const failures = await runHarness(broken, probeSpec);
    expect(failures.some((failure) => failure.message.includes('undeclared keys'))).toBe(true);
  });

  it('catches a parse that throws on hostile input', async () => {
    const broken = withCore(probe, {
      codec: {
        ...probeCodec,
        parse: (raw) => {
          // A plausible-looking bug: reading a property off a payload that may be null.
          const record = raw as { code: number };
          return ok({ code: record.code });
        },
      },
    });
    const failures = await runHarness(broken, probeSpec);
    expect(failures.some((failure) => failure.name.includes('hostile input'))).toBe(true);
  });

  it('catches a round trip that loses information', async () => {
    const broken = withCore(probe, {
      codec: { ...probeCodec, fromVariables: () => ({ code: null }) },
    });
    const failures = await runHarness(broken, probeSpec);
    expect(failures.some((failure) => failure.name.includes('round-trips'))).toBe(true);
  });
});

describe('the harness rejects client/server validation divergence', () => {
  it('catches an issue the client reports and the server does not', async () => {
    const broken = withCore(probe, {
      validate: (ctx): readonly ValidationIssue[] => {
        const issues: ValidationIssue[] = [];
        if (ctx.required && (ctx.value?.code ?? null) === null) {
          issues.push({ variableName: 'Q1', messageKey: 'err.required', severity: 'error' });
        }
        // ADR-004's divergence: a respondent blocked by an error the server does not agree exists.
        if (ctx.side === 'client') {
          issues.push({ variableName: 'Q1', messageKey: 'err.client_only', severity: 'error' });
        }
        return issues;
      },
    });
    const failures = await runHarness(broken, probeSpec);
    expect(failures.some((failure) => failure.name.includes('client agrees with server'))).toBe(true);
  });
});

describe('the harness rejects a renderer that breaks the F §8 contract', () => {
  const renderWith = (
    body: (props: RendererProps<ProbeConfig, ProbeAnswer>) => ReactNode,
  ): QuestionTypePlugin<ProbeConfig, ProbeAnswer> =>
    withComponents(probeCore, { editor: () => null, renderer: defineRenderer(body) });

  it('catches a hydration mismatch', async () => {
    const broken = renderWith(({ ctx }) => (
      <div role="radiogroup" aria-labelledby={ctx.ids.labelId}>
        <label className={TOUCH_TARGET_CLASS}>
          <input type="radio" tabIndex={0} />
          {/* The classic: a branch on the environment, so the client paints something the server
              never sent. */}
          <span>{typeof window === 'undefined' ? 'server' : 'client'}</span>
        </label>
      </div>
    ));
    const failures = await runHarness(broken, probeSpec);
    expect(failures.some((failure) => failure.name.includes('/ ltr / desktop /'))).toBe(true);
  });

  it('catches physical-direction leakage', async () => {
    const broken = renderWith(({ ctx }) => (
      <div role="radiogroup" aria-labelledby={ctx.ids.labelId}>
        <label className={TOUCH_TARGET_CLASS} style={{ marginLeft: 8 }}>
          <input type="radio" tabIndex={0} />
        </label>
      </div>
    ));
    const failures = await runHarness(broken, probeSpec);
    expect(failures.some((failure) => failure.message.includes('physical inline style'))).toBe(true);
  });

  it('catches a plugin-local live region', async () => {
    const broken = renderWith(({ ctx }) => (
      <div role="radiogroup" aria-labelledby={ctx.ids.labelId}>
        <div aria-live="polite">errors go here</div>
        <label className={TOUCH_TARGET_CLASS}>
          <input type="radio" tabIndex={0} />
        </label>
      </div>
    ));
    const failures = await runHarness(broken, probeSpec);
    expect(failures.some((failure) => failure.name.includes('/ ltr / desktop /'))).toBe(true);
  });

  it('catches a group that is one tab stop per option', async () => {
    const broken = renderWith(({ question, ctx }) => (
      <div role="radiogroup" aria-labelledby={ctx.ids.labelId}>
        {question.options.map((option) => (
          <label key={option.ref} className={TOUCH_TARGET_CLASS}>
            {/* No roving tabindex: a 60-option list becomes 60 tab stops. */}
            <input type="radio" />
          </label>
        ))}
      </div>
    ));
    const failures = await runHarness(broken, probeSpec);
    expect(failures.length).toBeGreaterThan(0);
  });

  it('catches a missing touch-target class', async () => {
    const broken = renderWith(({ ctx }) => (
      <div role="radiogroup" aria-labelledby={ctx.ids.labelId}>
        <label>
          <input type="radio" tabIndex={0} />
        </label>
      </div>
    ));
    const failures = await runHarness(broken, probeSpec);
    expect(failures.length).toBeGreaterThan(0);
  });

  it('catches a missing declared role', async () => {
    const broken = renderWith(({ ctx }) => (
      <div aria-labelledby={ctx.ids.labelId}>
        <label className={TOUCH_TARGET_CLASS}>
          <input type="radio" tabIndex={0} />
        </label>
      </div>
    ));
    const failures = await runHarness(broken, probeSpec);
    expect(
      failures.some((failure) => failure.message.includes('declared in the a11y contract')),
    ).toBe(true);
  });

  it('catches an error state with no aria-invalid or error description', async () => {
    const broken = renderWith(({ ctx }) => (
      <div role="radiogroup" aria-labelledby={ctx.ids.labelId}>
        <label className={TOUCH_TARGET_CLASS}>
          <input type="radio" tabIndex={0} />
        </label>
      </div>
    ));
    const failures = await runHarness(broken, probeSpec);
    expect(failures.some((failure) => failure.name.includes('with_errors'))).toBe(true);
  });
});

describe('the harness rejects an inconsistent spec', () => {
  it('catches an expected-variable list that does not match', async () => {
    const failures = await runHarness(probe, {
      ...probeSpec,
      variableSnapshots: {
        ...probeSpec.variableSnapshots,
        expected: { minimal: ['Q1 response text'] },
      },
    });
    expect(failures.some((failure) => failure.name.includes('exactly the expected variables'))).toBe(
      true,
    );
  });

  it('catches a fixture with no expectation at all', async () => {
    const failures = await runHarness(probe, {
      ...probeSpec,
      fixtures: {
        ...probeSpec.fixtures,
        extra: { config: { mode: 'plain' } as ProbeConfig, options },
      },
    });
    expect(failures.some((failure) => failure.name.includes('has a declared expectation'))).toBe(
      true,
    );
  });

  it('catches a validation case whose expectation is wrong', async () => {
    const failures = await runHarness(probe, {
      ...probeSpec,
      validation: [
        { fixture: 'minimal', value: undefined, required: true, expect: ['err.something_else'] },
      ],
    });
    expect(failures.some((failure) => failure.name.includes('case 0'))).toBe(true);
  });

  it('catches a composition declaration that contradicts meta.composable', async () => {
    const failures = await runHarness(probe, {
      ...probeSpec,
      composition: { ...probeSpec.composition, asChildOf: ['matrix'] },
    });
    expect(
      failures.some((failure) => failure.name.includes('matches meta.composable')),
    ).toBe(true);
  });
});
