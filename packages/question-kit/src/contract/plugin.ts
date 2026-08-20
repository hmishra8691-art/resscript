/**
 * `QuestionTypePlugin` — Deliverable F §1, the contract the whole platform rests on.
 *
 * A question type is a plugin that translates *a UI idea* into *a set of variable declarations
 * plus a way to render and parse them*. Every field below exists because omitting it would
 * force `if (question_type === 'matrix')` into code that must not contain it.
 *
 * ## The one structural change from F §1's sketch, and why
 *
 * F §1 lists `editor` and `renderer` on the same interface as `declareVariables`, `validate`
 * and `codec`. Keeping them on one object would mean the compiler, the exporter and the
 * server-side validation pass all import a module graph containing React components — React in
 * the worker, and (once the runtime imports the same object) React and the *editor* in the
 * respondent bundle.
 *
 * So the interface is split at exactly that seam:
 *
 *  - `QuestionTypePluginCore` — metadata, config schema, `declareVariables`, `validate`, the
 *    codec, export contribution, the a11y contract, static checks, migrations. Pure data and
 *    pure functions. This is what the compiler, the exporter and the API boundary import.
 *  - `QuestionTypePlugin` — the core plus `editor`, `renderer` and `hooks`. This is what studio
 *    and the runtime renderer import.
 *
 * `QuestionTypePlugin extends QuestionTypePluginCore`, so every consumer that wants the whole
 * thing still has one type, and F §1's interface is recovered exactly by the extension. The
 * registry is generic over the core, which is why the same registry code serves all four
 * consumers in F §7.
 */

import type { JsonObject } from '@resscript/schema';
import type { JsonSchema } from '../json-schema.js';
import type { AuthoredQuestion, DefaultConfigContext, StaticCheckContext } from './authored.js';
import type { A11yContract } from './a11y.js';
import type { ResponseCodec } from './codec.js';
import type { PluginDiagnostic } from './diagnostics.js';
import type { ExportContribution } from './export.js';
import type { PluginHooks } from './hooks.js';
import type { PluginMeta } from './meta.js';
import type { ValidateContext, ValidationIssue } from './validate.js';
import type { EditorComponent, RendererComponent } from './view.js';
import type { VariableDeclContext, VariableDeclaration } from './variables.js';

/**
 * Config migrations between majors of one plugin (F §5.1).
 *
 * Applied to the *authoring* model on load; **never** applied to a published artifact
 * (schema §18). A live tracker on `matrix@3` renders with `matrix@3` for as long as it can
 * collect data, which is the entire point of pinning the version in the manifest.
 */
export interface ConfigMigration {
  readonly fromMajor: number;
  readonly toMajor: number;
  /** Pure. May not lose information. May not depend on anything outside the question. */
  migrate(question: AuthoredQuestion<JsonObject>): AuthoredQuestion<JsonObject>;
  /**
   * Must hold for every config fixture: the variables declared before and after the migration
   * are identical. When it does not hold, publish emits a mandatory, acknowledged warning
   * listing the column changes (schema §17) — the moment a client's column layout can move has
   * to be a decision someone made on the record.
   */
  readonly variablePreserving: boolean;
}

/**
 * The non-visual half of a plugin. Importable — and imported — without React.
 */
export interface QuestionTypePluginCore<Config = unknown, Answer = unknown> {
  readonly meta: PluginMeta;

  /** JSON Schema (draft 2020-12) for `question.config`. Compiled and cached at boundaries. */
  readonly configSchema: JsonSchema;

  /** Defaults applied when the editor inserts a new question of this type. */
  defaultConfig(ctx: DefaultConfigContext): Config;

  /**
   * THE method. Pure, total, deterministic. Given the authored question, return the variables
   * it emits. Called by the compiler (to build the variable manifest) and by the studio (to
   * show the programmer their export columns while editing). Never by the exporter — the
   * exporter reads the manifest, which is this function's frozen output.
   *
   * Must not read the network, the clock or randomness. Must be stable under reordering of
   * randomizable items: variable identity follows `code`/`ref`, never display position.
   */
  declareVariables(ctx: VariableDeclContext<Config>): readonly VariableDeclaration[];

  /**
   * Type-specific validation, beyond the schema-level rules in `question.validation`. Runs in
   * the client for immediate feedback and on the server as the authoritative pass (ADR-004).
   * Pure — same inputs, same issues, both sides.
   */
  validate(ctx: ValidateContext<Config, Answer>): readonly ValidationIssue[];

  /** Wire payload -> Answer, and Answer -> variable values. */
  readonly codec: ResponseCodec<Config, Answer>;

  /** How this type contributes to exports and labelling beyond the manifest defaults. */
  readonly exportContribution: ExportContribution<Config>;

  /** Declarative accessibility contract. Enforced by the test kit (F §9). */
  readonly a11y: A11yContract;

  /** Compile-time static checks the plugin wants to add. Optional. */
  staticChecks?(ctx: StaticCheckContext<Config>): readonly PluginDiagnostic[];

  /** Config migrations between majors of THIS plugin. */
  readonly migrations?: readonly ConfigMigration[];
}

/** The whole plugin: the core plus the two components and the client-side hooks. */
export interface QuestionTypePlugin<Config = unknown, Answer = unknown>
  extends QuestionTypePluginCore<Config, Answer> {
  /** Studio authoring UI for `config`, `options`, `rows`, `columns`, `cells`. */
  readonly editor: EditorComponent<Config>;
  /** Respondent-facing renderer. SSR + hydrate. See F §8 for the hard requirements. */
  readonly renderer: RendererComponent<Config, Answer>;
  /** Optional lifecycle hooks. All client-side, all UX-only (ADR-004). */
  readonly hooks?: Partial<PluginHooks<Config, Answer>>;
}

/**
 * The erased plugin types the registry stores.
 *
 * `unknown` rather than `any` for the core: every function on `QuestionTypePluginCore` is declared
 * with method syntax, which TypeScript compares bivariantly, so a
 * `QuestionTypePluginCore<SingleSelectConfig, SingleSelectAnswer>` is assignable here without a
 * cast — and a *consumer* holding the erased type cannot call `declareVariables` with a fabricated
 * config, because it has no way to produce an `unknown`-typed context that satisfies the parameter.
 * Config-specific work therefore has to go through the kit's own helpers (which validate against
 * `configSchema` first), which is exactly the funnel we want at an untrusted boundary.
 *
 * The full plugin erases to `never` instead, and the difference is not cosmetic: `editor` and
 * `renderer` are *call signatures*, which TypeScript checks contravariantly even under
 * `strictFunctionTypes`, so `EditorComponent<SingleSelectConfig>` is not an
 * `EditorComponent<unknown>` (it would accept a props object carrying any config at all). `never`
 * is the correct erasure for the same reason it is the right answer everywhere else: a holder of
 * the erased type can store and forward the component but cannot invent props for it.
 */
export type AnyPluginCore = QuestionTypePluginCore<unknown, unknown>;

/**
 * The components, erased separately from the core.
 *
 * `Config` is genuinely invariant on the full plugin: `defaultConfig` *returns* it (so the erasure
 * must be `unknown` or wider) while `editor`/`renderer` *accept* it inside a props object (so the
 * erasure must be `never` or narrower). No single type parameter satisfies both, which is why the
 * erased plugin is an intersection of two differently-erased halves rather than
 * `QuestionTypePlugin<unknown, unknown>` — that type exists but nothing can be assigned to it, and
 * a nominally-typed registry that nothing fits is a cast farm.
 */
export interface AnyPluginView {
  readonly editor: EditorComponent<never>;
  readonly renderer: RendererComponent<never, never>;
  readonly hooks?: Partial<PluginHooks<never, never>>;
}

export type AnyPlugin = AnyPluginCore & AnyPluginView;

/** Assemble a full plugin from its core and its components. Keeps the seam honest. */
export function withComponents<Config, Answer>(
  core: QuestionTypePluginCore<Config, Answer>,
  view: {
    readonly editor: EditorComponent<Config>;
    readonly renderer: RendererComponent<Config, Answer>;
    readonly hooks?: Partial<PluginHooks<Config, Answer>>;
  },
): QuestionTypePlugin<Config, Answer> {
  return {
    ...core,
    editor: view.editor,
    renderer: view.renderer,
    ...(view.hooks === undefined ? {} : { hooks: view.hooks }),
  };
}
