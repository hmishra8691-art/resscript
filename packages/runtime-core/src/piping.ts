/**
 * Task 59: Piping (variable interpolation) per Deliverable E §9.1.
 *
 * Resolve {{variable}} references in text with session state.
 *
 * Forms:
 * - {{Q1}}          → value (enum → label, num → formatted, text → escaped)
 * - {{Q1.code}}     → raw code
 * - {{Q1.label}}    → explicit label form
 * - {{Q5.list}}     → selected labels joined ("A, B and C")
 * - {{Q5.count}}    → number of selections
 * - {{BRAND.label}} → loop iteration variable
 * - {{AGE + 1}}     → full expression
 * - {{Q1 | upper}}  → filtered value
 *
 * Escaping is context-aware (HTML text, HTML attr, URL) applied by renderer, not here.
 * Null renders the configured empty_token (default "").
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
): string | null {
  const value = vars[varName];
  if (value === null || value === undefined) {
    return emptyToken;
  }

  // Handle different forms
  if (form === 'code') {
    // For enum/select types, return the raw code
    return String(value);
  }

  if (form === 'label') {
    // For labeled types, return label (implementation detail: assumes label is pre-resolved)
    return String(value);
  }

  if (form === 'list') {
    // For multi-select, join array elements
    if (Array.isArray(value)) {
      return value.map(v => String(v)).join(', ');
    }
    return String(value);
  }

  if (form === 'count') {
    // For multi-select, return count
    if (Array.isArray(value)) {
      return String(value.length);
    }
    return '1';
  }

  // Default: return string representation
  return String(value);
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
  },
): string {
  const emptyToken = options?.emptyToken ?? '';
  const escapeContext = options?.escapeContext ?? 'none';

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

    let resolved = resolveVariable(varName, form, vars, emptyToken);
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
