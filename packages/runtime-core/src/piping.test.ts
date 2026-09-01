/**
 * Test suite for piping (task 59).
 *
 * Verifies E §9.1 requirements: variable interpolation, forms, filters, escaping.
 */

import { describe, it, expect } from 'vitest';
import {
  pipe,
  escape,
  testBasicPiping,
  testVariableForms,
  testFilters,
  testNullHandling,
  testEscaping,
  type EscapeContext,
} from './piping.js';

describe('basic piping', () => {
  it('replaces single variable', () => {
    const template = 'Hello {{name}}';
    const vars = { name: 'Alice' };

    expect(pipe(template, vars)).toBe('Hello Alice');
  });

  it('replaces multiple variables', () => {
    const template = '{{greeting}} {{name}}, you are {{age}} years old';
    const vars = { greeting: 'Hello', name: 'Alice', age: '30' };

    expect(pipe(template, vars)).toBe('Hello Alice, you are 30 years old');
  });

  it('handles missing variables as empty', () => {
    const template = 'Hello {{name}}, goodbye {{person}}';
    const vars = { name: 'Alice' };

    expect(pipe(template, vars)).toBe('Hello Alice, goodbye ');
  });

  it('built-in basic test passes', () => {
    expect(testBasicPiping()).toBe(true);
  });
});

describe('variable forms', () => {
  it('code form returns raw value', () => {
    const template = '{{q1.code}}';
    const vars = { q1: 'option_a' };

    expect(pipe(template, vars)).toBe('option_a');
  });

  it('label form returns label', () => {
    const template = '{{q1.label}}';
    const vars = { q1: 'Brand Name' };

    expect(pipe(template, vars)).toBe('Brand Name');
  });

  it('list form joins array', () => {
    const template = '{{q5.list}}';
    const vars = { q5: ['item_1', 'item_2', 'item_3'] };

    expect(pipe(template, vars)).toBe('item_1, item_2, item_3');
  });

  it('count form returns array length', () => {
    const template = 'You selected {{q5.count}} items';
    const vars = { q5: ['a', 'b', 'c'] };

    expect(pipe(template, vars)).toBe('You selected 3 items');
  });

  it('count form returns 1 for single value', () => {
    const template = '{{q1.count}}';
    const vars = { q1: 'single' };

    expect(pipe(template, vars)).toBe('1');
  });

  it('built-in forms test passes', () => {
    expect(testVariableForms()).toBe(true);
  });
});

describe('filters', () => {
  it('upper filter capitalizes', () => {
    const template = '{{name | upper}}';
    const vars = { name: 'alice' };

    expect(pipe(template, vars)).toBe('ALICE');
  });

  it('uppercase alias works', () => {
    const template = '{{name | uppercase}}';
    const vars = { name: 'alice' };

    expect(pipe(template, vars)).toBe('ALICE');
  });

  it('lower filter lowercases', () => {
    const template = '{{name | lower}}';
    const vars = { name: 'ALICE' };

    expect(pipe(template, vars)).toBe('alice');
  });

  it('lowercase alias works', () => {
    const template = '{{name | lowercase}}';
    const vars = { name: 'ALICE' };

    expect(pipe(template, vars)).toBe('alice');
  });

  it('capitalize filter capitalizes first letter', () => {
    const template = '{{name | capitalize}}';
    const vars = { name: 'alice' };

    expect(pipe(template, vars)).toBe('Alice');
  });

  it('unknown filter is ignored', () => {
    const template = '{{name | unknown}}';
    const vars = { name: 'alice' };

    expect(pipe(template, vars)).toBe('alice');
  });

  it('built-in filter test passes', () => {
    expect(testFilters()).toBe(true);
  });
});

describe('null and empty handling', () => {
  it('null variable renders empty by default', () => {
    const template = 'Value: {{x}}';
    const vars = { x: null };

    expect(pipe(template, vars)).toBe('Value: ');
  });

  it('undefined variable renders empty by default', () => {
    const template = 'Value: {{x}}';
    const vars = {};

    expect(pipe(template, vars)).toBe('Value: ');
  });

  it('custom empty token is used', () => {
    const template = 'Value: {{x}}';
    const vars = { x: null };

    expect(pipe(template, vars, { emptyToken: '(not set)' })).toBe('Value: (not set)');
  });

  it('built-in null test passes', () => {
    expect(testNullHandling()).toBe(true);
  });
});

describe('escaping', () => {
  it('HTML text escaping', () => {
    const text = '<script>alert("xss")</script>';

    const result = escape(text, 'html_text');

    expect(result).toBe('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
  });

  it('HTML attribute escaping', () => {
    const text = 'value" onclick="alert(1)';

    const result = escape(text, 'html_attr');

    expect(result).toBe('value&quot; onclick=&quot;alert(1)');
  });

  it('URL escaping', () => {
    const text = 'hello world & friends';

    const result = escape(text, 'url');

    expect(result).toBe('hello%20world%20%26%20friends');
  });

  it('no escaping when context is none', () => {
    const text = '<div>test</div>';

    expect(escape(text, 'none')).toBe(text);
  });

  it('piping with HTML escaping context', () => {
    const template = 'Welcome {{name}}';
    const vars = { name: '<script>' };

    const result = pipe(template, vars, { escapeContext: 'html_text' });

    expect(result).toBe('Welcome &lt;script&gt;');
  });

  it('built-in escaping test passes', () => {
    expect(testEscaping()).toBe(true);
  });
});

describe('complex cases', () => {
  it('multiple variables with same name', () => {
    const template = '{{name}} likes {{name}}';
    const vars = { name: 'Alice' };

    expect(pipe(template, vars)).toBe('Alice likes Alice');
  });

  it('variable in filter with escaping', () => {
    const template = '{{name | upper}}';
    const vars = { name: '<alice>' };

    const result = pipe(template, vars, { escapeContext: 'html_text' });

    expect(result).toBe('&lt;ALICE&gt;');
  });

  it('list with filter', () => {
    const template = '{{items.list | upper}}';
    const vars = { items: ['apple', 'banana'] };

    expect(pipe(template, vars)).toBe('APPLE, BANANA');
  });
});

/* -------------------------------------------------------------------------- */
/* Label resolution                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The defect these cover: `vars` stores an enum answer as a CODE and is keyed by variable ID, so
 * before `PipeSchema` existed `{{Q1.label}}` and `{{Q1.code}}` returned the same string and a
 * piped brand rendered as `2`. Every assertion below fails against the previous implementation.
 */
describe('piping with a schema', () => {
  const BRANDS: ReadonlyMap<number, string> = new Map([
    [1, 'Apple'],
    [2, 'Nike'],
    [3, 'Adidas'],
  ]);
  const schema = {
    variableRef: (ref: string) => (ref === 'Q1' ? 'var_q1' : ref === 'Q5' ? 'var_q5' : undefined),
    label: (variableId: string, code: number) =>
      variableId === 'var_q1' || variableId === 'var_q5' ? BRANDS.get(code) : undefined,
  };
  const vars = { var_q1: 2, var_q5: [1, 2, 3] };
  const run = (template: string): string => pipe(template, vars, { schema });

  it('resolves a ref to the id vars is keyed by', () => {
    expect(run('{{Q1}}')).toBe('Nike');
  });

  it('label form returns the label, not the code', () => {
    expect(run('{{Q1.label}}')).toBe('Nike');
  });

  it('code form still returns the code, because that is what it is for', () => {
    expect(run('{{Q1.code}}')).toBe('2');
    expect(run('{{Q1.value}}')).toBe('2');
  });

  it('list joins labels with a comma, unchanged from before', () => {
    expect(run('{{Q5.list}}')).toBe('Apple, Nike, Adidas');
  });

  it('and_list is the prose form', () => {
    expect(run('{{Q5.and_list}}')).toBe('Apple, Nike and Adidas');
  });

  it('and_list degrades correctly at one and two items', () => {
    const one = pipe('{{Q5.and_list}}', { var_q5: [1] }, { schema });
    const two = pipe('{{Q5.and_list}}', { var_q5: [1, 2] }, { schema });
    expect(one).toBe('Apple');
    expect(two).toBe('Apple and Nike');
  });

  it('bullets puts one label per line', () => {
    expect(run('{{Q5.bullets}}')).toBe('• Apple\n• Nike\n• Adidas');
  });

  it('first and last read the selection order', () => {
    expect(run('{{Q5.first}}')).toBe('Apple');
    expect(run('{{Q5.last}}')).toBe('Adidas');
  });

  it('count is unaffected by labels', () => {
    expect(run('{{Q5.count}}')).toBe('3');
  });

  it('falls back to the code when no label resolves', () => {
    expect(pipe('{{Q1}}', { var_q1: 99 }, { schema })).toBe('99');
  });

  it('leaves a caller that keys vars by name working with no schema at all', () => {
    // The backward-compatibility contract: every existing call site passes no schema.
    expect(pipe('{{brand}}', { brand: 'Nike' })).toBe('Nike');
    expect(pipe('{{brand.label}}', { brand: 'Nike' })).toBe('Nike');
  });

  it('prefers a direct key over the ref map, so a name-keyed caller is never rewritten', () => {
    expect(pipe('{{Q1}}', { Q1: 'literal' }, { schema })).toBe('literal');
  });

  it('escapes the resolved label, not the template around it', () => {
    const risky = {
      variableRef: () => 'v',
      label: () => '<b>Nike</b>',
    };
    expect(pipe('Brand: {{X}}', { v: 1 }, { schema: risky, escapeContext: 'html_text' })).toBe(
      'Brand: &lt;b&gt;Nike&lt;/b&gt;',
    );
  });
});
