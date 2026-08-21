/**
 * `definePluginTests` — the conformance harness of Deliverable F §9.
 *
 * A plugin author writes one call. What runs is every gate in F §9's table that can be enforced
 * without a browser: the variable-declaration invariants (determinism, order independence, rename
 * coherence, analysability), SSR + hydration, the codec's round trip and its behaviour under
 * hostile input, client/server validation agreement, the a11y contract's mechanical parts, the
 * static-check catalogue and the composition rules.
 *
 * The harness is itself under test. `harness.negative.test.tsx` runs *deliberately broken* plugins
 * through it and asserts each one fails — because a conformance suite that passes everything is
 * indistinguishable from no suite, and this repository has already shipped one lint rule and one
 * set of green tests with that property.
 *
 * A plugin's test file must run in jsdom:
 *
 * ```ts
 * // @vitest-environment jsdom
 * definePluginTests(singleSelect, { … });
 * ```
 */

import { describe, expect, it } from 'vitest';
import { within } from '@testing-library/react';
import { declareVariablesFor, verifyDeclarations } from '../declare.js';
import { createRegistry, type PluginRegistry } from '../registry.js';
import {
  createCodecContext,
  createValidateContext,
  resolveQuestion,
  type ResolveOptions,
} from '../resolve.js';
import { createNamer } from '../naming.js';
import { applySchemaDefaults, compileSchema } from '../json-schema.js';
import type { AnyPluginCore, QuestionTypePlugin, QuestionTypePluginCore } from '../contract/plugin.js';
import type { AuthoredQuestion } from '../contract/authored.js';
import type { AuthoredItem } from '../contract/items.js';
import type { VariableDeclaration } from '../contract/variables.js';
import type { ValidationIssue } from '../contract/validate.js';
import type { JsonObject, JsonValue } from '@resscript/schema';
import { createComposeDelegates } from '../compose-host.js';
import { fixtureQuestion, type PluginFixture, type PluginTestSpec } from './spec.js';
import { testParentCore, type TestParentConfig } from './parent.js';
import {
  createRenderContext,
  groupTabStops,
  localLiveRegions,
  physicalDirectionLeaks,
  renderProbe,
  TEST_IDS,
  untargetedElements,
} from './render.js';

export * from './spec.js';
export { testParentCore } from './parent.js';
export {
  createRenderContext,
  physicalDirectionLeaks,
  renderProbe,
  TEST_IDS,
  untargetedElements,
} from './render.js';


/**
 * How the harness reaches the test framework.
 *
 * Injectable for exactly one reason, and it is the reason this file claims to be worth anything:
 * **the harness has to be provable.** `harness.negative.test.tsx` runs deliberately broken plugins
 * through `collectPluginTests`, executes every case itself, and asserts the expected failures
 * appear. With `describe`/`it` hard-wired to vitest, a case that silently stopped asserting would
 * look exactly like a case that passes — which is the failure mode this repository has already
 * shipped twice (a lint rule that matched nothing, and 24 green tests over transposed SQL binds).
 */
export interface HarnessRunner {
  describe(name: string, body: () => void): void;
  it(name: string, body: () => void | Promise<void>): void;
}

const vitestRunner: HarnessRunner = { describe, it };

export interface CollectedCase {
  readonly name: string;
  run(): void | Promise<void>;
}

/**
 * Collect the harness's cases instead of registering them, so a caller can run them and inspect
 * the failures. Used by the harness's own negative controls.
 */
export function collectPluginTests<Config, Answer>(
  plugin: QuestionTypePlugin<Config, Answer>,
  spec: PluginTestSpec<NoInfer<Config>, NoInfer<Answer>>,
): readonly CollectedCase[] {
  const cases: CollectedCase[] = [];
  const path: string[] = [];
  definePluginTests(plugin, spec, {
    describe(name, body) {
      path.push(name);
      body();
      path.pop();
    },
    it(name, body) {
      const label = [...path, name].join(' > ');
      cases.push({ name: label, run: () => body() });
    },
  });
  return cases;
}

/**
 * F §9's hostile input list, verbatim, given to every plugin for free.
 *
 * Two of these are load-bearing and easy to leave out of a hand-written list: the `__proto__`
 * payload (which `JSON.parse` produces as an ordinary own property, harmless until something
 * spreads it) and the 10,000-key object (which must be rejected on shape, before allocation).
 */
export const HOSTILE_INPUTS: readonly unknown[] = [
  null,
  undefined,
  0,
  '',
  '{}',
  [],
  { rows: null },
  { rows: { nope: 1 } },
  JSON.parse('{"rows":{"r1":{"__proto__":{"polluted":true}}}}') as unknown,
  { rows: Object.fromEntries(Array.from({ length: 10_000 }, (_u, i) => [`r${i}`, 1])) },
  deeplyNested(200),
  { rows: { r1: 'x'.repeat(1_000_000) } },
  { codes: Array.from({ length: 10_000 }, (_u, i) => i) },
  { score: Number.NaN },
  { score: Number.POSITIVE_INFINITY },
];

function deeplyNested(depth: number): unknown {
  let node: unknown = 1;
  for (let i = 0; i < depth; i += 1) node = { nested: node };
  return node;
}

/** One line per declaration: the frozen export contract, in a form a reviewer can read in a diff. */
export function summarizeDeclaration(declaration: VariableDeclaration): string {
  const domain =
    declaration.enumDomain === undefined
      ? ''
      : ` [${declaration.enumDomain.map((entry) => String(entry.code)).join(',')}]`;
  const derivation =
    declaration.kind === 'derived'
      ? ` <${
          declaration.derivation.kind === 'expression'
            ? declaration.derivation.expression.op
            : declaration.derivation.structural.computation
        }>`
      : '';
  const flags = [
    declaration.export.include ? undefined : 'unexported',
    declaration.pii ? 'pii' : undefined,
    declaration.persist ? undefined : 'transient',
  ].filter((flag): flag is string => flag !== undefined);
  return (
    `${declaration.name} ${declaration.kind} ${declaration.type}${domain}${derivation}` +
    (flags.length === 0 ? '' : ` (${flags.join(',')})`)
  );
}

function shuffleDeterministically<T>(items: readonly T[], salt: number): readonly T[] {
  // A fixed permutation, not a random one: a flaky order-independence test is a test that gets
  // retried rather than read. Reversal plus a rotation covers "first item moved" and "every item
  // moved", which are the two shapes a real reorder takes.
  const rotated = [...items].reverse();
  const at = salt % Math.max(rotated.length, 1);
  return [...rotated.slice(at), ...rotated.slice(0, at)];
}

function declarationsOf<Config>(
  plugin: QuestionTypePluginCore<Config, unknown>,
  question: AuthoredQuestion<Config>,
  registry?: PluginRegistry<AnyPluginCore>,
): readonly VariableDeclaration[] {
  const result = declareVariablesFor(
    plugin,
    question,
    registry === undefined ? {} : { registry },
  );
  const errors = result.diagnostics.filter((d) => d.severity === 'error');
  expect(errors.map((d) => `${d.code}: ${d.message}`)).toEqual([]);
  return result.declarations;
}

function namerFor<Config>(question: AuthoredQuestion<Config>) {
  return createNamer({
    ref: question.ref,
    loop: question.loop,
    options: question.options,
    rows: question.rows,
    columns: question.columns,
  });
}

export function definePluginTests<Config, Answer>(
  plugin: QuestionTypePlugin<Config, Answer>,
  // `NoInfer` so `Config` comes from the plugin and never from the fixtures. Without it TypeScript
  // widens a fixture's `display: 'vertical'` to `string`, infers *that* as `Config`, and then
  // reports the plugin as the mismatch — an error message that points at the wrong file.
  spec: PluginTestSpec<NoInfer<Config>, NoInfer<Answer>>,
  runner: HarnessRunner = vitestRunner,
): void {
  const { describe, it } = runner;
  const fixtureNames = Object.keys(spec.fixtures);
  const questionOf = (name: string): AuthoredQuestion<Config> => {
    const fixture = spec.fixtures[name];
    if (fixture === undefined) throw new Error(`no fixture named ${JSON.stringify(name)}`);
    return fixtureQuestion(plugin.meta.id, fixture);
  };
  const fixtureOf = (name: string): PluginFixture<Config> => {
    const fixture = spec.fixtures[name];
    if (fixture === undefined) throw new Error(`no fixture named ${JSON.stringify(name)}`);
    return fixture;
  };
  // A composing parent gets ONE registry of its declared children, threaded through every
  // declaration call and every codec/validate context. Leaf plugins get `undefined` and the
  // harness behaves exactly as before this section existed.
  const hostRegistry = (() => {
    if (spec.host === undefined) return undefined;
    const registry = createRegistry<AnyPluginCore>();
    for (const core of spec.host.childCores) registry.register(core, { trust: 'first_party' });
    return registry;
  })();
  const hostDelegates = (question: AuthoredQuestion<Config>) =>
    hostRegistry === undefined
      ? undefined
      : createComposeDelegates(question as AuthoredQuestion<unknown>, hostRegistry);

  describe(`${plugin.meta.id}@${plugin.meta.version}`, () => {
    it('declares at least one fixture', () => {
      // A plugin with no fixtures would make every suite below vacuous, which is the failure mode
      // this whole file exists to prevent.
      expect(fixtureNames.length).toBeGreaterThan(0);
    });

    /* ---------------------------------------------------------------- */
    describe('registration and config schema', () => {
      it('registers: valid id, semver, coherent a11y contract, supported config schema', () => {
        const registry = createRegistry<AnyPluginCore>();
        const entry = registry.register(plugin, { trust: 'first_party' });
        expect(entry.key).toBe(`${plugin.meta.id}@${entry.semver.major}`);
        // Trust is the registry's to assign (F §6): whatever the object said, the source wins.
        expect(entry.meta.trust).toBe('first_party');
      });

      it('the renderer is server-render safe by declaration', () => {
        expect(plugin.renderer.ssr).toBe(true);
      });

      for (const asCellControl of [false, true]) {
        it(`defaultConfig validates against configSchema (asCellControl: ${String(asCellControl)})`, () => {
          const config = plugin.defaultConfig({ lang: 'en', ref: 'Q1', asCellControl });
          const compiled = compileSchema(plugin.configSchema);
          expect(compiled.unsupported).toEqual([]);
          const result = compiled.validate(config);
          expect(result.issues).toEqual([]);
        });
      }

      for (const name of fixtureNames) {
        it(`fixture "${name}" config validates, with defaults applied`, () => {
          const config = applySchemaDefaults(
            plugin.configSchema,
            fixtureOf(name).config as JsonValue,
          );
          const result = compileSchema(plugin.configSchema).validate(config);
          expect(result.issues).toEqual([]);
        });
      }
    });

    /* ---------------------------------------------------------------- */
    describe('declareVariables — the export contract', () => {
      for (const name of fixtureNames) {
        const expected = spec.variableSnapshots.expected[name];

        it(`fixture "${name}" has a declared expectation`, () => {
          // Adding a fixture without an expectation would leave it untested while looking covered.
          expect(expected, `variableSnapshots.expected is missing "${name}"`).toBeDefined();
        });

        it(`fixture "${name}" declares exactly the expected variables`, () => {
          const declarations = declarationsOf(plugin, questionOf(name), hostRegistry);
          expect(declarations.map(summarizeDeclaration)).toEqual(expected ?? []);
        });

        if (spec.variableSnapshots.assertDeterministic) {
          it(`fixture "${name}" is deterministic across two calls`, () => {
            const first = declarationsOf(plugin, questionOf(name), hostRegistry);
            const second = declarationsOf(plugin, questionOf(name), hostRegistry);
            // Deep equality, not summaries: a hidden clock or counter read would most likely show
            // up in a field the summary does not carry.
            expect(second).toEqual(first);
          });
        }

        if (spec.variableSnapshots.assertOrderIndependent) {
          it(`fixture "${name}" is independent of authored item order`, () => {
            const base = questionOf(name);
            const declarations = declarationsOf(plugin, base, hostRegistry);
            for (const salt of [1, 2, 3]) {
              const reordered: AuthoredQuestion<Config> = {
                ...base,
                options: reposition(shuffleDeterministically(base.options, salt)),
                rows: reposition(shuffleDeterministically(base.rows, salt)),
                columns: reposition(shuffleDeterministically(base.columns, salt)),
              };
              expect(
                declarationsOf(plugin, reordered, hostRegistry),
                `reordering items (salt ${salt}) changed the export contract`,
              ).toEqual(declarations);
            }
          });
        }

        if (spec.variableSnapshots.assertRenameCoherent) {
          it(`fixture "${name}" renames coherently`, () => {
            const base = questionOf(name);
            const before = declarationsOf(plugin, base, hostRegistry);
            const renamed: AuthoredQuestion<Config> = { ...base, ref: 'ZZ9' };
            const after = declarationsOf(plugin, renamed, hostRegistry);
            const namer = namerFor(renamed);

            expect(after.length).toBe(before.length);
            after.forEach((declaration, index) => {
              const previous = before[index];
              expect(previous).toBeDefined();
              // Provenance is untouched by a rename — that is what makes it a metadata edit.
              expect(declaration.source.part).toEqual(previous?.source.part);
              // Every name moved, and moved to exactly the name the rule derives.
              expect(declaration.name).not.toBe(previous?.name);
              expect(declaration.name).toBe(namer.of(declaration.source.part));
              // The export column follows the name when it was the default, which it always is at
              // declaration time; an author's override is applied later, by the registry.
              expect(declaration.export.column).toBe(declaration.name);
            });
          });
        }

        if (spec.variableSnapshots.assertAnalysable) {
          it(`fixture "${name}" passes every declaration invariant`, () => {
            const question = questionOf(name);
            const declarations = declarationsOf(plugin, question, hostRegistry);
            const problems = verifyDeclarations(declarations, {
              ref: question.ref,
              loop: question.loop,
              options: question.options,
              rows: question.rows,
              columns: question.columns,
            });
            expect(problems.map((p) => `${p.code}: ${p.message}`)).toEqual([]);
          });
        }
      }
    });

    /* ---------------------------------------------------------------- */
    describe('codec', () => {
      for (const [name, answers] of Object.entries(spec.codec.roundTrip)) {
        answers.forEach((answer, index) => {
          it(`fixture "${name}" answer ${index} round-trips through variables`, () => {
            const question = questionOf(name);
            const declarations = declarationsOf(plugin, question, hostRegistry);
            const resolved = resolveQuestion(question, declarations, itemStatesOf(fixtureOf(name)));
            const delegates = hostDelegates(question);
            const ctx = createCodecContext({
              question, resolved, ...(delegates === undefined ? {} : { delegates }),
            });
            const vars = plugin.codec.toVariables(answer, ctx);

            if (spec.codec.assertVariablesSubsetOfDeclared) {
              const declared = new Set(declarations.map((d) => d.name));
              const extra = Object.keys(vars).filter((key) => !declared.has(key));
              // ADR-005 threat 3: the server rejects any key outside the manifest, so a key here is
              // a hard 400 in production rather than an extra column.
              expect(extra, 'toVariables produced undeclared keys').toEqual([]);
            }

            const back = plugin.codec.fromVariables(vars, ctx);
            expect(back).toEqual(answer);
          });
        });
      }

      /**
       * Every fixture gets at least one round trip, whether or not the spec named an answer for it.
       *
       * `emptyAnswer` is the value written when a question was *shown and left blank* — which is a
       * different fact from "never shown" and is the single most common state in a real dataset. A
       * fixture with no declared answers would otherwise have its codec entirely untested.
       */
      for (const name of fixtureNames) {
        it(`fixture "${name}" round-trips its empty answer and writes only declared keys`, () => {
          const question = questionOf(name);
          const declarations = declarationsOf(plugin, question, hostRegistry);
          const resolved = resolveQuestion(question, declarations, itemStatesOf(fixtureOf(name)));
          const delegates = hostDelegates(question);
          const ctx = createCodecContext({
            question, resolved, ...(delegates === undefined ? {} : { delegates }),
          });
          const empty = plugin.codec.emptyAnswer(ctx);
          const declared = new Set(declarations.map((d) => d.name));
          const vars = plugin.codec.toVariables(empty, ctx);
          expect(Object.keys(vars).filter((key) => !declared.has(key))).toEqual([]);
          expect(plugin.codec.fromVariables(vars, ctx)).toEqual(empty);
        });
      }

      if (spec.codec.assertNoThrow) {
        const hostile = [...HOSTILE_INPUTS, ...(spec.codec.extraHostileInputs ?? [])];
        hostile.forEach((raw, index) => {
          it(`hostile input ${index} is rejected without throwing`, () => {
            const name = fixtureNames[0] ?? '';
            const question = questionOf(name);
            const declarations = declarationsOf(plugin, question, hostRegistry);
            const resolved = resolveQuestion(question, declarations, itemStatesOf(fixtureOf(name)));
            const delegates = hostDelegates(question);
            const ctx = createCodecContext({
              question, resolved, ...(delegates === undefined ? {} : { delegates }),
            });

            const result = plugin.codec.parse(raw, ctx);
            expect(typeof result.ok).toBe('boolean');
            if (result.ok) {
              // An accepted payload must also be *writable*: a parse that succeeds and a
              // toVariables that throws is the same outage one function later.
              const declared = new Set(declarations.map((d) => d.name));
              const vars = plugin.codec.toVariables(result.value, ctx);
              expect(Object.keys(vars).filter((key) => !declared.has(key))).toEqual([]);
            } else {
              expect(result.error.code).toBeTruthy();
            }
            // Prototype pollution: if any codec spread the `__proto__` payload into a fresh object,
            // this property would now exist on every object in the process.
            expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
          });
        });
      }
    });

    /* ---------------------------------------------------------------- */
    describe('validate', () => {
      spec.validation.forEach((testCase, index) => {
        it(`case ${index} (${testCase.fixture}) reports ${JSON.stringify(testCase.expect)}`, () => {
          const issues = runValidate(plugin, spec, testCase.fixture, testCase, 'server', hostRegistry);
          expect(issues.map((issue) => issue.messageKey).sort()).toEqual([...testCase.expect].sort());
          if (testCase.expectFocus !== undefined) {
            const focus = testCase.expectFocus;
            const matched = issues.some(
              (issue) =>
                (focus.rowRef === undefined || issue.focus?.rowRef === focus.rowRef) &&
                (focus.columnRef === undefined || issue.focus?.columnRef === focus.columnRef) &&
                (focus.optionRef === undefined || issue.focus?.optionRef === focus.optionRef),
            );
            expect(matched, `no issue carried focus ${JSON.stringify(focus)}`).toBe(true);
          }
        });

        if (spec.assertValidationSidesAgree) {
          it(`case ${index} (${testCase.fixture}) client agrees with server`, () => {
            const client = runValidate(plugin, spec, testCase.fixture, testCase, 'client', hostRegistry);
            const server = runValidate(plugin, spec, testCase.fixture, testCase, 'server', hostRegistry);
            const serverKeys = server.map((issue) => issue.messageKey);
            // The client may under-report (F §1.2's expensive-check exemption). It may not report
            // anything the server does not: that is ADR-004's divergence, and it shows up as a
            // respondent blocked by an error the server does not agree exists.
            for (const issue of client) {
              expect(serverKeys, `client-only issue ${issue.messageKey}`).toContain(issue.messageKey);
            }
          });
        }
      });
    });

    /* ---------------------------------------------------------------- */
    describe('render', () => {
      for (const name of fixtureNames) {
        for (const dir of spec.render.dirs) {
          for (const device of spec.render.devices) {
            for (const [stateName, state] of Object.entries(spec.render.states)) {
              it(`${name} / ${dir} / ${device} / ${stateName}`, async () => {
                const question = questionOf(name);
                const declarations = declarationsOf(plugin, question, hostRegistry);
                const resolved = resolveQuestion(question, declarations, {
                  itemStates: { ...fixtureOf(name).itemStates, ...state.itemStates },
                });
                const ctx = createRenderContext({
                  dir,
                  device,
                  ...(spec.host?.renderChild === undefined
                    ? {}
                    : { renderChild: spec.host.renderChild }),
                });
                const probe = await renderProbe(
                  plugin.renderer({
                    question: resolved,
                    value: state.value,
                    onChange: () => undefined,
                    issues: state.issues ?? [],
                    ctx,
                  }),
                );
                try {
                  if (spec.render.assertSsrHydrationClean) {
                    expect(probe.hydrationWarnings).toEqual([]);
                  }
                  if (spec.render.assertNoPhysicalDirectionLeak) {
                    expect(physicalDirectionLeaks(probe.container, dir)).toEqual([]);
                  }
                  if (spec.a11y.assertContractRolesPresent) {
                    const roles = spec.a11y.rolesByFixture?.[name] ?? plugin.a11y.requiredRoles;
                    for (const role of roles) {
                      expect(
                        within(probe.container).queryAllByRole(role, { hidden: true }).length,
                        `role "${role}" is declared in the a11y contract but absent from the output`,
                      ).toBeGreaterThan(0);
                    }
                  }
                  if (spec.a11y.assertSingleTabStopPerGroup) {
                    expect(groupTabStops(probe.container).length).toBeLessThanOrEqual(1);
                  }
                  if (spec.a11y.assertTouchTargets) {
                    expect(untargetedElements(probe.container)).toEqual([]);
                  }
                  if (spec.a11y.assertNoLocalLiveRegion) {
                    expect(localLiveRegions(probe.container)).toEqual([]);
                  }
                  if (spec.a11y.assertErrorWiring && (state.issues ?? []).length > 0) {
                    const flagged = probe.container.querySelector('[aria-invalid="true"]');
                    expect(flagged, 'an errored question must set aria-invalid').not.toBeNull();
                    expect(
                      flagged?.getAttribute('aria-describedby') ?? '',
                      'an errored question must point aria-describedby at the error id',
                    ).toContain(TEST_IDS.errorId);
                  }
                } finally {
                  probe.cleanup();
                }
              });
            }
          }
        }
      }
    });

    /* ---------------------------------------------------------------- */
    describe('static checks', () => {
      spec.staticChecks.forEach((testCase, index) => {
        it(`case ${index} (${testCase.fixture}) diagnoses ${JSON.stringify(testCase.expect)}`, () => {
          const base = questionOf(testCase.fixture);
          const question = testCase.mutate === undefined ? base : testCase.mutate(base);
          const diagnostics =
            plugin.staticChecks?.({ ...question, name: namerFor(question) }) ?? [];
          expect(diagnostics.map((d) => d.code).sort()).toEqual([...testCase.expect].sort());
          for (const diagnostic of diagnostics) {
            // A diagnostic with no path cannot be focused in the editor, which makes it a
            // notification rather than a fix.
            expect(diagnostic.message.length, 'a diagnostic needs a message').toBeGreaterThan(0);
          }
        });
      });
    });

    /* ---------------------------------------------------------------- */
    describe('composition', () => {
      it('the composition declaration matches meta.composable', () => {
        if (spec.composition.asChildOf.length > 0) expect(plugin.meta.composable).toBe(true);
        if (!plugin.meta.composable) expect(spec.composition.asChildOf).toEqual([]);
      });

      if (spec.composition.asParentOf.length > 0) {
        it('actually composes: without a registry, compose() is diagnosed', () => {
          const name = fixtureNames[0] ?? '';
          const result = declareVariablesFor(plugin, questionOf(name), {});
          expect(result.diagnostics.map((d) => d.code)).toContain(
            `QK-${plugin.meta.id}-compose_unknown_plugin`,
          );
        });
      }

      if (plugin.meta.composable && spec.composition.assertChildNamespacing) {
        it('as a child: every declared name stays inside its cell scope', () => {
          const registry = createRegistry<AnyPluginCore>();
          registry.register(plugin, { trust: 'first_party' });
          registry.register(testParentCore, { trust: 'first_party' });
          const parent = parentQuestion(plugin, fixtureOf(fixtureNames[0] ?? ''));
          const declarations = declarationsOf(testParentCore, parent, registry);
          expect(declarations.length).toBeGreaterThan(0);
          for (const declaration of declarations) {
            expect(declaration.name).toMatch(/^P1r[12](_[A-Za-z0-9_]+)?$/);
            expect(declaration.source.part.kind).toBe('cell');
          }
        });
      }

      if (plugin.meta.composable && spec.composition.assertTrustCompatibility) {
        it('as a child: a marketplace control cannot be composed into a first-party parent', () => {
          const registry = createRegistry<AnyPluginCore>();
          registry.register(plugin, { trust: 'marketplace', sha384: 'sha384-test' });
          registry.register(testParentCore, { trust: 'first_party' });
          const parent = parentQuestion(plugin, fixtureOf(fixtureNames[0] ?? ''));
          const result = declareVariablesFor(testParentCore, parent, { registry });
          expect(result.diagnostics.map((d) => d.code)).toContain(
            'QK-test_parent-compose_trust_violation',
          );
          // And nothing leaks through: a rejected composition must not produce half a variable set.
          expect(result.declarations).toEqual([]);
        });
      }
    });
  });
}

/* ========================================================================== */
/* Helpers                                                                     */
/* ========================================================================== */

/**
 * Re-densify `position` after a reorder.
 *
 * The point of the order-independence test is that *display* order changed, which in the authoring
 * model means `position` changed. Shuffling the array while leaving positions untouched would test
 * a state the editor cannot produce.
 */
function reposition(items: readonly AuthoredItem[]): readonly AuthoredItem[] {
  return items.map((item, index) => ({ ...item, position: index + 1 }));
}

function itemStatesOf<Config>(fixture: PluginFixture<Config>): ResolveOptions {
  return fixture.itemStates === undefined ? {} : { itemStates: fixture.itemStates };
}

function runValidate<Config, Answer>(
  plugin: QuestionTypePlugin<Config, Answer>,
  spec: PluginTestSpec<Config, Answer>,
  fixtureName: string,
  testCase: { readonly value: Answer | undefined; readonly required: boolean; readonly siblings?: Readonly<Record<string, JsonValue>> },
  side: 'client' | 'server',
  hostRegistry?: PluginRegistry<AnyPluginCore>,
): readonly ValidationIssue[] {
  const fixture = spec.fixtures[fixtureName];
  if (fixture === undefined) throw new Error(`no fixture named ${JSON.stringify(fixtureName)}`);
  const question = fixtureQuestion(plugin.meta.id, fixture);
  const declarations = declarationsOf(plugin, question, hostRegistry);
  const resolved = resolveQuestion(question, declarations, itemStatesOf(fixture));
  return plugin.validate(
    createValidateContext({
      resolved,
      value: testCase.value,
      required: testCase.required,
      side,
      ...(testCase.siblings === undefined ? {} : { siblings: testCase.siblings }),
      ...(hostRegistry === undefined
        ? {}
        : {
            delegateValidate: createComposeDelegates(
              question as AuthoredQuestion<unknown>,
              hostRegistry,
              { side },
            ).delegateValidate,
          }),
    }),
  );
}

/**
 * A two-row parent whose cells are the plugin under test.
 *
 * The child's config is the fixture's own, which is what an editor would have written at insertion
 * time — a control with no config is a compile error, deliberately (see `TestParentConfig`).
 */
function parentQuestion<Config, Answer>(
  plugin: QuestionTypePlugin<Config, Answer>,
  childFixture: PluginFixture<Config>,
): AuthoredQuestion<TestParentConfig> {
  const columns = childFixture.options ?? [];
  return {
    ref: 'P1',
    questionType: 'test_parent',
    label: 'P1.label',
    instruction: null,
    required: false,
    config: {
      childType: plugin.meta.id,
      useColumns: columns.length > 0,
      childConfig: childFixture.config as unknown as JsonObject,
    },
    options: [],
    rows: [
      { ref: 'r1', code: 1, labelKey: 'row.r1', position: 1 },
      { ref: 'r2', code: 2, labelKey: 'row.r2', position: 2 },
    ],
    columns,
    cells: [],
    flags: { pii: false, excludeFromExport: false },
    loop: null,
  };
}
