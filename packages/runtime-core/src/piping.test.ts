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
