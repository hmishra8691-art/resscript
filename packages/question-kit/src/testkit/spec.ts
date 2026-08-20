/**
 * The shape of a plugin's test declaration — Deliverable F §9.
 *
 * `@resscript/question-kit-testkit` is "a harness, not a suggestion": `pnpm test` in a plugin
 * package runs it, and **a plugin that does not export the required fixtures does not compile.**
 * That sentence is the design constraint for this file: every section of F §9's object is a
 * *required* property, so omitting one is a type error rather than a silently skipped suite.
 * `spec.types.test.ts` pins that with a `@ts-expect-error` — if the requirement ever loosens, the
 * typecheck fails on the unused expectation.
 *
 * Two sections deviate from F §9, both because the version in the document cannot fail:
 *
 *  - **`variableSnapshots.expected` replaces `snapshotDir`.** A snapshot file that a test run
 *    creates on first execution passes vacuously the one time anyone is looking at it. An explicit
 *    expected list is written by the plugin author, reviewed in the PR that adds it, and cannot
 *    pass without matching. It plays the same role F §5 wants — the frozen export contract inside
 *    a major, diffed by CI — while being reviewable rather than generated.
 *  - **`render.themes` and the perf budget are absent.** Themes are the design layer's (P1-09) and
 *    a render-time budget measured in jsdom would measure jsdom. Declaring assertions we do not
 *    run is worse than not declaring them: the table in F §9 would claim coverage that does not
 *    exist.
 */

import type { JsonValue } from '@resscript/schema';
import type { AuthoredQuestion } from '../contract/authored.js';
import type { AuthoredItem } from '../contract/items.js';
import type { ValidationIssue } from '../contract/validate.js';
import type { CellOverride, LoopContext, QuestionFlagsView } from '../contract/variables.js';
import type { RenderDevice, TextDirection } from '../contract/view.js';
import type { ItemState } from '../resolve.js';

/** One authored state of the question. F §9's "every meaningfully distinct authored state". */
export interface PluginFixture<Config> {
  /** Defaults to `Q1`. Set it when a fixture is about naming (a loop, a rename). */
  readonly ref?: string;
  readonly config: Config;
  readonly required?: boolean;
  readonly options?: readonly AuthoredItem[];
  readonly rows?: readonly AuthoredItem[];
  readonly columns?: readonly AuthoredItem[];
  readonly cells?: readonly CellOverride[];
  readonly flags?: Partial<QuestionFlagsView>;
  readonly loop?: LoopContext;
  /** Mask / display-condition results, as the runtime would have evaluated them. */
  readonly itemStates?: Readonly<Record<string, ItemState>>;
}

export type FixtureMap<Config> = Readonly<Record<string, PluginFixture<Config>>>;

/**
 * The frozen export contract, one line per declared variable.
 *
 * `name kind type [codes]` — enough to catch a renamed column, a changed type, a reordered enum
 * domain or a lost variable, which is exactly F §5's table of what may not change inside a major.
 */
export type DeclarationSummary = string;

export interface VariableSnapshotSpec {
  /** Fixture name -> the declarations it must produce, in order. Every fixture needs an entry. */
  readonly expected: Readonly<Record<string, readonly DeclarationSummary[]>>;
  /** Reorder options/rows/columns and assert the declaration is IDENTICAL. */
  readonly assertOrderIndependent: boolean;
  /** Call twice, assert deep-equal. Catches hidden clock/random/global-state reads. */
  readonly assertDeterministic: boolean;
  /** Rename `ref` and assert every name changed exactly per schema §3's rule. */
  readonly assertRenameCoherent: boolean;
  /** Reject object/set-typed declarations with no scalar projection (F §4). */
  readonly assertAnalysable: boolean;
}

export interface RenderStateSpec<Answer> {
  readonly value?: Answer;
  readonly issues?: readonly ValidationIssue[];
  readonly itemStates?: Readonly<Record<string, ItemState>>;
}

/**
 * The render matrix. `empty` and `with_errors` are required by name, because they are the two
 * states where the a11y wiring is either present or absent and every other state is a variation on
 * one of them.
 */
export type RenderStateMap<Answer> = {
  readonly empty: RenderStateSpec<Answer>;
  readonly with_errors: RenderStateSpec<Answer>;
} & Readonly<Record<string, RenderStateSpec<Answer>>>;

export interface RenderSpec<Answer> {
  readonly dirs: readonly TextDirection[];
  readonly devices: readonly RenderDevice[];
  readonly states: RenderStateMap<Answer>;
  /** `renderToString` + hydrate, zero mismatch warnings. */
  readonly assertSsrHydrationClean: boolean;
  /** No physical `left`/`right` in inline styles or class tokens (F §8). */
  readonly assertNoPhysicalDirectionLeak: boolean;
}

export interface ValidationCase<Answer> {
  readonly fixture: string;
  readonly value: Answer | undefined;
  readonly required: boolean;
  /** Expected message keys, order-insensitive. */
  readonly expect: readonly string[];
  readonly expectFocus?: { readonly rowRef?: string; readonly columnRef?: string; readonly optionRef?: string };
  readonly siblings?: Readonly<Record<string, JsonValue>>;
}

export interface CodecSpec<Answer> {
  /** Fixture name -> answers that must survive `toVariables` -> `fromVariables` unchanged. */
  readonly roundTrip: Readonly<Record<string, readonly Answer[]>>;
  /** Extra hostile payloads on top of `HOSTILE_INPUTS`, which every plugin gets for free. */
  readonly extraHostileInputs?: readonly unknown[];
  /** Every hostile input yields a `CodecError` or a clean value. Never a throw. */
  readonly assertNoThrow: boolean;
  /** `toVariables` may only produce keys `declareVariables` declared (ADR-005 threat 3). */
  readonly assertVariablesSubsetOfDeclared: boolean;
}

export interface A11ySpec {
  /** `a11y.requiredRoles` must be present in the rendered output. */
  readonly assertContractRolesPresent: boolean;
  /**
   * Per-fixture role override.
   *
   * F §1.3 has one flat `requiredRoles` per plugin, which cannot be right for a type whose config
   * changes the ARIA pattern: `single_select` with `display: 'dropdown'` renders a `combobox`, not
   * a `radiogroup`, and asserting radiogroup against it would fail a correct renderer. The
   * override says so explicitly instead of weakening the assertion for every fixture.
   */
  readonly rolesByFixture?: Readonly<Record<string, readonly string[]>>;
  /** A radiogroup/checkboxgroup/grid is ONE tab stop with a roving tabindex (F §8). */
  readonly assertSingleTabStopPerGroup: boolean;
  /** Every interactive target carries the themed touch-target class. */
  readonly assertTouchTargets: boolean;
  /** No plugin-local `aria-live`: two live regions on a page means one is ignored (F §8). */
  readonly assertNoLocalLiveRegion: boolean;
  /** In the error state: `aria-invalid` set and `aria-describedby` pointing at the error id. */
  readonly assertErrorWiring: boolean;
}

export interface StaticCheckCase<Config> {
  readonly fixture: string;
  /** Mutate the authored question into the state that must be diagnosed. */
  readonly mutate?: (question: AuthoredQuestion<Config>) => AuthoredQuestion<Config>;
  /** Expected local codes (before the `QK-<pluginId>-` namespacing), order-insensitive. */
  readonly expect: readonly string[];
}

export interface CompositionSpec {
  /**
   * Parent ids this plugin is meant to work inside. Non-empty requires `meta.composable`; the
   * harness composes it under a synthetic parent and checks the namespace and trust rules, because
   * the real parent (`matrix`) is P1-05 and a promise about it should still be tested now.
   */
  readonly asChildOf: readonly string[];
  /** Child ids this plugin composes. Non-empty requires the plugin to call `ctx.compose`. */
  readonly asParentOf: readonly string[];
  readonly assertChildNamespacing: boolean;
  readonly assertTrustCompatibility: boolean;
}

/**
 * Every section is required. A plugin that omits one does not compile — F §9's central claim, and
 * the reason this is an interface with no optional members rather than a bag of switches.
 */
export interface PluginTestSpec<Config, Answer> {
  readonly fixtures: FixtureMap<Config>;
  readonly variableSnapshots: VariableSnapshotSpec;
  readonly render: RenderSpec<Answer>;
  readonly validation: readonly ValidationCase<Answer>[];
  /** Client may under-report, never disagree (ADR-004). */
  readonly assertValidationSidesAgree: boolean;
  readonly codec: CodecSpec<Answer>;
  readonly a11y: A11ySpec;
  readonly staticChecks: readonly StaticCheckCase<Config>[];
  readonly composition: CompositionSpec;
}

/** Turn a fixture into the authored question the kit's entry points take. */
export function fixtureQuestion<Config>(
  questionType: string,
  fixture: PluginFixture<Config>,
): AuthoredQuestion<Config> {
  return {
    ref: fixture.ref ?? 'Q1',
    questionType,
    label: `${fixture.ref ?? 'Q1'}.label`,
    instruction: null,
    required: fixture.required ?? false,
    config: fixture.config,
    options: fixture.options ?? [],
    rows: fixture.rows ?? [],
    columns: fixture.columns ?? [],
    cells: fixture.cells ?? [],
    flags: {
      pii: fixture.flags?.pii ?? false,
      excludeFromExport: fixture.flags?.excludeFromExport ?? false,
    },
    loop: fixture.loop ?? null,
  };
}

/** Build an authored item without repeating the optional fields at every call site. */
export function item(
  ref: string,
  code: number,
  extra: Partial<Omit<AuthoredItem, 'ref' | 'code'>> = {},
): AuthoredItem {
  return {
    ref,
    code,
    labelKey: extra.labelKey ?? `opt.${ref}`,
    position: extra.position ?? code,
    ...(extra.valueOverride === undefined ? {} : { valueOverride: extra.valueOverride }),
    ...(extra.exclusive === undefined ? {} : { exclusive: extra.exclusive }),
    ...(extra.otherSpecify === undefined ? {} : { otherSpecify: extra.otherSpecify }),
    ...(extra.anchor === undefined ? {} : { anchor: extra.anchor }),
    ...(extra.media === undefined ? {} : { media: extra.media }),
    ...(extra.meta === undefined ? {} : { meta: extra.meta }),
  };
}
