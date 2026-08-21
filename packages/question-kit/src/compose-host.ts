/**
 * The HOST side of composition — building the `delegate*` functions a composing plugin's codec
 * and validator call (F §3).
 *
 * `declare.ts` owns composition at compile time: `ctx.compose` resolves the child, validates its
 * config, scopes its namer and adopts its declarations. But declaration is one of FOUR moments a
 * mixed matrix touches its children — the other three are parse (a submit arrives), toVariables /
 * fromVariables (storage round-trip) and validate (the child's own rules run per cell). The
 * contract already reserves seams for those (`CodecContext.delegate*`,
 * `ValidateContext.delegateValidate`); this module is the ONE implementation of what sits behind
 * them, shared by the test kit today and by any host that runs a composing plugin's codec.
 *
 * Why one implementation matters: the child context built here must agree byte-for-byte with the
 * one `declare.ts` built at compile time — same schema defaults applied to the same config, same
 * `use_columns` hand-over, same scoped namer. Two constructions of "what does the child see"
 * would eventually disagree in exactly one place (a default applied on one path and not the
 * other), and the symptom would be a codec writing a variable name the manifest never declared.
 *
 * What this module deliberately does NOT re-enforce: the composition RULES (depth, trust, config
 * validity, namespace containment). Those ran at compile time, on the artifact's one true pass;
 * a submit-time repeat would be a second opinion that can only ever disagree by bug. The one
 * check kept is child RESOLUTION, because a registry that no longer carries the child's plugin
 * is a runtime condition, not a compile-time fact — and it throws, loudly, because a cell whose
 * plugin vanished mid-field is an operational failure, not a parse error.
 */

import type { JsonValue } from '@resscript/schema';
import { applySchemaDefaults, type JsonSchema } from './json-schema.js';
import { createScopedNamer, rescopePart, type NamerSpec } from './naming.js';
import { resolveQuestion } from './resolve.js';
import type { PluginRegistry } from './registry.js';
import type { AnyPluginCore } from './contract/plugin.js';
import type { AuthoredQuestion } from './contract/authored.js';
import type { AuthoredItem } from './contract/items.js';
import type { CodecContext, CodecError, Result } from './contract/codec.js';
import type { ValidationIssue, ValidationPhase, ValidationSide } from './contract/validate.js';
import type {
  CellControl,
  ComposeScope,
  VariableDeclaration,
  VariableDeclContext,
} from './contract/variables.js';

export interface ComposeDelegates {
  delegateParse(
    scope: ComposeScope,
    control: CellControl,
    raw: unknown,
  ): Result<unknown, CodecError>;
  delegateToVariables(
    scope: ComposeScope,
    control: CellControl,
    answer: unknown,
  ): Readonly<Record<string, JsonValue | null>>;
  delegateFromVariables(
    scope: ComposeScope,
    control: CellControl,
    vars: Readonly<Record<string, JsonValue | null>>,
  ): unknown;
  delegateValidate(
    scope: ComposeScope,
    control: CellControl,
    args: { readonly value: unknown; readonly required: boolean },
  ): readonly ValidationIssue[];
}

export interface ComposeDelegateOptions {
  /** The side/phase the PARENT's validate is running under; children inherit both. */
  readonly side?: ValidationSide;
  readonly phase?: ValidationPhase;
}

/** What one (scope, control) pair resolves to. Memoised per delegate set — see below. */
export interface ChildSeat {
  readonly plugin: AnyPluginCore;
  readonly codecCtx: CodecContext<unknown>;
  readonly declarations: readonly VariableDeclaration[];
  readonly resolved: ReturnType<typeof resolveQuestion<unknown>>;
}

/**
 * Resolve one composed child: the plugin, its scoped declarations, its resolved question and a
 * ready codec context. Exported on its own because the RENDER host needs the same construction
 * — a child renderer takes a `ResolvedQuestion`, and building it any other way than this is how
 * the rendered cell and the parsed cell drift apart.
 */
export function resolveComposedChild(
  question: AuthoredQuestion<unknown>,
  registry: PluginRegistry<AnyPluginCore>,
  scope: ComposeScope,
  control: CellControl,
): ChildSeat {
  const spec: NamerSpec = {
    ref: question.ref,
    loop: question.loop,
    options: question.options,
    rows: question.rows,
    columns: question.columns,
  };
  return buildSeat(question, spec, registry, scope, control);
}

function buildSeat(
  question: AuthoredQuestion<unknown>,
  spec: NamerSpec,
  registry: PluginRegistry<AnyPluginCore>,
  scope: ComposeScope,
  control: CellControl,
): ChildSeat {
  const resolvedPlugin = registry.resolveForCompile(control.question_type);
  if (resolvedPlugin === undefined) {
    // Loud by design (see the header): the artifact composed a plugin this process cannot
    // resolve. Parsing around it would store nulls for a cell the respondent answered.
    throw new Error(
      `compose host: cell control ${JSON.stringify(control.question_type)} is not registered`,
    );
  }
  const child = resolvedPlugin.plugin;
  const childConfig = applySchemaDefaults(child.configSchema as JsonSchema, control.config ?? {});
  const childItems: readonly AuthoredItem[] = control.use_columns === true ? question.columns : [];

  // The same context shape declare.ts's compose builds — the agreement the header promises.
  const scopedNamer = createScopedNamer(spec, scope);
  const childDeclCtx: VariableDeclContext<unknown> = {
    ref: question.ref,
    config: childConfig,
    required: question.required,
    options: childItems,
    rows: [],
    columns: [],
    cells: [],
    flags: question.flags,
    loop: question.loop,
    name: scopedNamer,
    compose: () => {
      throw new Error('a composed cell control may not itself compose (F §3.1 rule 4)');
    },
  };
  const declarations = child
    .declareVariables(childDeclCtx)
    .map((declaration) => ({
      ...declaration,
      source: { part: rescopePart(declaration.source.part, scope) },
    }));

  const childAuthored: AuthoredQuestion<unknown> = {
    ref: question.ref,
    questionType: control.question_type,
    label: question.label,
    instruction: null,
    required: question.required,
    config: childConfig,
    options: childItems,
    rows: [],
    columns: [],
    cells: [],
    flags: question.flags,
    loop: question.loop,
  };
  const resolved = resolveQuestion(childAuthored, declarations);

  const codecCtx: CodecContext<unknown> = {
    ref: question.ref,
    config: childConfig,
    question: resolved,
    // The SCOPED namer, not the question's own: the child's `self()` is its cell's name, which
    // is the entire mechanism that keeps codec keys equal to declared names inside a cell.
    name: scopedNamer,
    delegateParse: () => {
      throw new Error('a composed cell control may not itself compose (F §3.1 rule 4)');
    },
    delegateToVariables: () => {
      throw new Error('a composed cell control may not itself compose (F §3.1 rule 4)');
    },
    delegateFromVariables: () => {
      throw new Error('a composed cell control may not itself compose (F §3.1 rule 4)');
    },
  };

  return { plugin: child, codecCtx, declarations, resolved };
}

export function createComposeDelegates(
  question: AuthoredQuestion<unknown>,
  registry: PluginRegistry<AnyPluginCore>,
  options: ComposeDelegateOptions = {},
): ComposeDelegates {
  const spec: NamerSpec = {
    ref: question.ref,
    loop: question.loop,
    options: question.options,
    rows: question.rows,
    columns: question.columns,
  };

  // Memoised by scope identity: a grid's codec calls parse + toVariables + validate for the same
  // cell in one request, and rebuilding the child's declarations three times per cell turns a
  // 200-row grid submit into 600 declaration passes.
  const seats = new Map<string, ChildSeat>();

  function seatFor(scope: ComposeScope, control: CellControl): ChildSeat {
    const key =
      scope.kind === 'row'
        ? `r:${scope.rowRef}:${control.question_type}`
        : `c:${scope.rowRef}:${scope.columnRef}:${control.question_type}`;
    const hit = seats.get(key);
    if (hit !== undefined) return hit;
    const seat = buildSeat(question, spec, registry, scope, control);
    seats.set(key, seat);
    return seat;
  }

  return {
    delegateParse(scope, control, raw) {
      const seat = seatFor(scope, control);
      return seat.plugin.codec.parse(raw, seat.codecCtx as never);
    },
    delegateToVariables(scope, control, answer) {
      const seat = seatFor(scope, control);
      return seat.plugin.codec.toVariables(answer as never, seat.codecCtx as never);
    },
    delegateFromVariables(scope, control, vars) {
      const seat = seatFor(scope, control);
      return seat.plugin.codec.fromVariables(vars, seat.codecCtx as never);
    },
    delegateValidate(scope, control, args) {
      const seat = seatFor(scope, control);
      return seat.plugin.validate({
        question: seat.resolved as never,
        value: args.value as never,
        required: args.required,
        phase: options.phase ?? 'on_submit',
        side: options.side ?? 'server',
        read: () => undefined,
        delegateValidate: () => {
          throw new Error('a composed cell control may not itself compose (F §3.1 rule 4)');
        },
      });
    },
  };
}
