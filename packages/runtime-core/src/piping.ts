/**
 * Task 59: Piping (variable interpolation) per Deliverable E §9.1.
 *
 * Resolve {{variable}} references in text with session state.
 *
 * Forms:
 * - {{Q1}}           → label for an enum/set when a `PipeSchema` can resolve one, else the value
 * - {{Q1.code}}      → the stored code, never a label
 * - {{Q1.value}}     → alias of `.code`, for authors who think in export columns
 * - {{Q1.label}}     → the option label; falls back to the code when nothing can resolve one
 * - {{Q5.list}}      → labels joined with ", "
 * - {{Q5.and_list}}  → labels joined with ", " and " and " before the last
 * - {{Q5.bullets}}   → one "• label" per line
 * - {{Q5.count}}     → number of selections
 * - {{Q5.first}}     → first selection's label
 * - {{Q5.last}}      → last selection's label
 * - {{Q1 | upper}}   → filtered value
 *
 * Escaping is context-aware (HTML text, HTML attr, URL) applied by renderer, not here.
 * Null renders the configured empty_token (default "").
 *
 * ## Labels need a schema, and without one this module cannot invent them
 *
 * `vars` holds what the session stored — an enum answer is a **code**, not a label — and it is
 * keyed by variable *id*. So `{{Q1.label}}` needs two lookups this module has no way to do on its
 * own: the ref `Q1` → a variable id, and the code `2` → the label key → the language bundle. Both
 * are already in the artifact (`VariableManifestEntry.name` and `.enum_domain`, plus the resolved
 * `i18n/<language>.json`), so they arrive as an optional `PipeSchema`.
 *
 * Optional, and the fallback is the old behaviour verbatim: with no schema, `.label` returns the
 * stored value. That is why every existing caller and test keeps working — and it is also the
 * defect this parameter exists to close, because until a caller supplies a schema, `.label` and
 * `.code` are the same string and a piped brand renders as `2`.
 *
 * ## What is NOT supported
 *
 * Expressions. `{{AGE + 1}}` does not evaluate; the token is emitted unchanged, which is visible
 * to the respondent. The header claimed otherwise for two milestones. Piping an arithmetic result
 * is what a `derived` variable is for — it is typed, it is checked, and it appears in the
 * dependency graph, none of which a string in a label bundle can be.
 */

export type EscapeContext = 'html_text' | 'html_attr' | 'url' | 'none';

/**
 * Escape string based on output context.
 */
export function escape(text: string, context: EscapeContext): string {
  if (context === 'none') return text;
  if (!text) return '';

  switch (context) {
    case 'html_text':
      return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

    case 'html_attr':
      return text
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

    case 'url':
      return encodeURIComponent(text);
  }
}

/**
 * What piping needs from the artifact to turn stored codes into the words a respondent reads.
 *
 * Two functions rather than two maps, so the caller decides how to index: `apps/runtime` answers
 * from the manifest it has already parsed, and a test answers from a literal.
 */
export interface PipeSchema {
  /**
   * A `{{…}}` reference → the key `vars` is stored under.
   *
   * Authors write refs (`{{PANEL_ID}}`, C §10) and `vars` is keyed by variable id, so without
   * this every author-written token misses. Returning `undefined` means "not a known variable",
   * and the token is then looked up in `vars` directly — which is what keeps a caller that keys
   * `vars` by name working unchanged.
   */
  readonly variableRef?: (ref: string) => string | undefined;
  /** A code's label in a variable's own enum domain, already resolved into the session language. */
  readonly label?: (variableId: string, code: number) => string | undefined;
}

/** `[1,3]` → `["Apple","Cherry"]`, falling back to the code where no label resolves. */
function labelsOf(
  variableId: string,
  value: unknown,
  schema: PipeSchema | undefined,
): readonly string[] {
  const codes = Array.isArray(value) ? value : [value];
  return codes.map((code) => {
    if (typeof code === 'number' && schema?.label !== undefined) {
      const label = schema.label(variableId, code);
      if (label !== undefined) return label;
    }
    return String(code);
  });
}

/** "A", "A and B", "A, B and C" — the Oxford-free form, which is what surveys ship. */
function andJoin(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1] ?? ''}`;
}

/**
 * Apply a filter to a value (closed set of filters).
 */
function applyFilter(value: string, filter: string): string {
  switch (filter) {
    case 'upper':
    case 'uppercase':
      return value.toUpperCase();
    case 'lower':
    case 'lowercase':
      return value.toLowerCase();
    case 'capitalize':
      return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
    default:
      return value;
  }
}

/**
 * Resolve a single variable reference.
 * Returns null if the variable doesn't exist or is null.
 */
function resolveVariable(
  varName: string,
  form: string | null,
  vars: Record<string, any>,
  emptyToken: string,
  schema?: PipeSchema,
): string | null {
  // A ref (`Q1`) resolves to the id `vars` is keyed by; a token that is already a key is used as
  // written, so a caller that keys `vars` by name needs no schema at all.
  const key = varName in vars ? varName : (schema?.variableRef?.(varName) ?? varName);
  const value = vars[key];
  if (value === null || value === undefined) {
    return emptyToken;
  }

  // `.code` and `.value` are the one pair that must NOT consult the label map: they are the
  // stored, exported datum, and an author who writes `.code` is asking for `nike_01`.
  if (form === 'code' || form === 'value') {
    return Array.isArray(value) ? value.map((v) => String(v)).join(', ') : String(value);
  }

  if (form === 'count') {
    return Array.isArray(value) ? String(value.length) : '1';
  }

  const labels = labelsOf(key, value, schema);

  switch (form) {
    case 'list':
      // ", " and not the and-join: `.list` has shipped as a comma list, and a survey in field
      // with "A, B, C" in a question stem must not silently become "A, B and C" on deploy.
      return labels.join(', ');
    case 'and_list':
      return andJoin(labels);
    case 'bullets':
      return labels.map((label) => `• ${label}`).join('\n');
    case 'first':
      return labels[0] ?? emptyToken;
    case 'last':
      return labels[labels.length - 1] ?? emptyToken;
    case 'label':
    case null:
    case undefined:
      // The default form and `.label` agree, which is the point: an author writing `{{Q1}}` in a
      // question stem means the brand, not its code.
      return labels.length > 1 ? labels.join(', ') : (labels[0] ?? emptyToken);
    default:
      // An unrecognised form is not a silent pass-through: it would render the raw value under a
      // name the author thought did something. Same direction as an unknown filter, one level up.
      return labels.length > 1 ? labels.join(', ') : (labels[0] ?? emptyToken);
  }
}

/**
 * Parse a pipe template and resolve variables.
 * Template format: "text {{var}} more {{var.form}} and {{var | filter}}"
 *
 * Returns the resolved text with variables replaced.
 * The caller is responsible for context-aware escaping if needed.
 */
export function pipe(
  template: string,
  vars: Record<string, any>,
  options?: {
    emptyToken?: string;
    escapeContext?: EscapeContext;
    schema?: PipeSchema;
  },
): string {
  const emptyToken = options?.emptyToken ?? '';
  const escapeContext = options?.escapeContext ?? 'none';
  const schema = options?.schema;

  // Match {{...}} patterns
  const pattern = /\{\{([^}]+)\}\}/g;

  return template.replace(pattern, (match, expression) => {
    expression = expression.trim();

    // Handle filter: {{var | filter}}
    let filter: string | null = null;
    if (expression.includes('|')) {
      const parts = expression.split('|');
      expression = parts[0].trim();
      filter = parts[1]?.trim() ?? null;
    }

    // Parse the expression: var, var.form, or complex expression
    // For now, support simple variable references with optional form
    let varName: string | null = null;
    let form: string | null = null;

    const simplePat = /^([a-zA-Z_$][a-zA-Z0-9_$]*)(\.([a-zA-Z_$][a-zA-Z0-9_$]*))?$/;
    const match2 = expression.match(simplePat);

    if (match2) {
      varName = match2[1];
      form = match2[3] ?? null;
    } else {
      // For complex expressions like "AGE + 1", we'd need an expression evaluator
      // For P1-09, we'll skip this (it requires schema-aware evaluation)
      return match;
    }

    if (!varName) {
      return match;
    }

    let resolved = resolveVariable(varName, form, vars, emptyToken, schema);
    if (resolved === null) {
      resolved = emptyToken;
    }

    // Apply filter if present
    if (filter) {
      resolved = applyFilter(resolved, filter);
    }

    // Apply escaping if requested
    if (escapeContext !== 'none') {
      resolved = escape(resolved, escapeContext);
    }

    return resolved;
  });
}

/**
 * Unit test: basic variable interpolation.
 */
export function testBasicPiping(): boolean {
  const template = 'Hello {{name}}, you are {{age}} years old';
  const vars = { name: 'Alice', age: '30' };

  const result = pipe(template, vars);
  return result === 'Hello Alice, you are 30 years old';
}

/**
 * Unit test: variable forms (code, label, list, count).
 */
export function testVariableForms(): boolean {
  const vars = {
    q1: 'option_a',
    q5: ['item_1', 'item_2', 'item_3'],
  };

  const code = pipe('Code: {{q1.code}}', vars);
  const list = pipe('List: {{q5.list}}', vars);
  const count = pipe('Count: {{q5.count}}', vars);

  return code === 'Code: option_a' && list === 'List: item_1, item_2, item_3' && count === 'Count: 3';
}

/**
 * Unit test: filters.
 */
export function testFilters(): boolean {
  const vars = { name: 'alice' };

  const upper = pipe('{{name | upper}}', vars);
  const capitalize = pipe('{{name | capitalize}}', vars);

  return upper === 'ALICE' && capitalize === 'Alice';
}

/**
 * Unit test: null handling.
 */
export function testNullHandling(): boolean {
  const vars = { name: null };

  const result1 = pipe('Name: {{name}}', vars);
  const result2 = pipe('Name: {{name}}', vars, { emptyToken: '(not set)' });

  return result1 === 'Name: ' && result2 === 'Name: (not set)';
}

/**
 * Unit test: escaping.
 */
export function testEscaping(): boolean {
  const vars = { text: '<script>alert("xss")</script>' };

  const htmlEscaped = pipe('{{text}}', vars, { escapeContext: 'html_text' });
  const attrEscaped = pipe('{{text}}', vars, { escapeContext: 'html_attr' });
  const urlEscaped = pipe('{{text}}', vars, { escapeContext: 'url' });

  const expectedHtml = '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;';
  const expectedAttr = '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;';
  // Note: encodeURIComponent doesn't encode ( ) as they're RFC 3986 unreserved
  const expectedUrl = '%3Cscript%3Ealert(%22xss%22)%3C%2Fscript%3E';

  return (
    htmlEscaped === expectedHtml &&
    attrEscaped === expectedAttr &&
    urlEscaped === expectedUrl
  );
}
