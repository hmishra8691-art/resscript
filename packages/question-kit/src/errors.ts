/**
 * The kit's two error classes, and the rule about when a kit function may throw at all.
 *
 * Everything the *compiler* calls reports diagnostics rather than throwing (the same reason
 * `@resscript/schema`'s header gives: an editor must show every problem at once, and a CI gate
 * wants a list). The exception is a plugin doing something the contract forbids from inside its
 * own `declareVariables` — a namespace violation, an unnameable part, composing at depth 2.
 * Those cannot be *returned*, because control is inside plugin code at the time, so they are
 * thrown and caught by `declareVariablesFor`, which converts them into the diagnostic the
 * compiler expects. A plugin that catches one is hiding a data-integrity bug from the compiler,
 * which is why the codes are enumerated here rather than being free-form strings.
 */

/** Composition rule violations, F §3.1's numbered list plus the naming rules it implies. */
export type ComposeErrorCode =
  /** Rule 1: the child plugin is not in the registry. */
  | 'compose_unknown_plugin'
  /** Rule 1: the child exists but is not `meta.composable`. */
  | 'compose_not_composable'
  /** Rule 2: child trust exceeds parent trust — trust laundering. */
  | 'compose_trust_violation'
  /** Rule 3: the child's config does not validate against the child's own schema. */
  | 'compose_invalid_config'
  /** Rule 4: depth 1 only. A matrix inside a matrix cell makes loop naming ambiguous. */
  | 'compose_depth'
  /** Rule 5: a child declared a name outside its scoped prefix. */
  | 'plugin_namespace_violation'
  /** Rule 6: more than one `response` variable in a scalar cell. */
  | 'compose_multi_var_cell'
  /**
   * The child asked its scoped namer for a part that has no name in that scope.
   *
   * This is a real limitation of schema §4's part model rather than a plugin mistake, and it is
   * worth stating plainly: there is no part that names `Q5r3_band`. A companion suffix inside a
   * cell scope is unrepresentable, so a plugin that declares companion variables cannot be a
   * cell control — which is why `nps` ships with `composable: false`.
   */
  | 'compose_unnameable_part';

export class PluginComposeError extends Error {
  readonly code: ComposeErrorCode;
  readonly detail: Readonly<Record<string, string | number>>;

  constructor(
    code: ComposeErrorCode,
    message: string,
    detail: Readonly<Record<string, string | number>> = {},
  ) {
    super(message);
    this.name = 'PluginComposeError';
    this.code = code;
    this.detail = detail;
  }
}

/** Registration-time rejections. An id is forever, so these are refusals rather than warnings. */
export type RegistryErrorCode =
  | 'invalid_plugin_id'
  | 'invalid_version'
  | 'duplicate_registration'
  | 'invalid_a11y_contract'
  | 'unsupported_config_schema';

export class PluginRegistryError extends Error {
  readonly code: RegistryErrorCode;
  readonly pluginId: string;

  constructor(code: RegistryErrorCode, pluginId: string, message: string) {
    super(message);
    this.name = 'PluginRegistryError';
    this.code = code;
    this.pluginId = pluginId;
  }
}
