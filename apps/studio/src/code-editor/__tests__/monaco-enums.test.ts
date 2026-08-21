/**
 * The numeric constants this app restates from Monaco (`MarkerSeverity`, `CompletionItemKind`)
 * against Monaco's own declaration file.
 *
 * Why they are restated at all: importing them means importing `monaco-editor`, and every module
 * that maps a diagnostic or builds a completion item would then drag the editor into its entry
 * graph — the one thing §7.4 forbids. So the values are copied, and the copy is pinned here.
 *
 * The pinning reads the enum out of `monaco-editor/esm/vs/editor/editor.api.d.ts` rather than
 * importing the runtime module, deliberately: the runtime import pulls in the whole editor (and
 * fails outside a browser), while the declaration file is the same artifact TypeScript type-checks
 * this app against. If Monaco renumbers an enum, this fails by name.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { MARKER_SEVERITY } from '@/code-editor/markers';
import { COMPLETION_KIND } from '@/code-editor/completion';

const require_ = createRequire(import.meta.url);
const declarationPath = require_.resolve('monaco-editor/esm/vs/editor/editor.api.d.ts');
const declaration = readFileSync(declarationPath, 'utf8');

/** `enum Name { A = 1, B = 2 }` → `{ A: 1, B: 2 }`, from the declaration text. */
function enumMembers(name: string): Record<string, number> {
  const match = new RegExp(`enum ${name} \\{([^}]*)\\}`).exec(declaration);
  if (match === null) throw new Error(`monaco's declaration file has no enum ${name}`);
  const members: Record<string, number> = {};
  for (const line of (match[1] ?? '').split('\n')) {
    const member = /([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(\d+)/.exec(line);
    if (member !== null) members[member[1] as string] = Number(member[2]);
  }
  return members;
}

describe('MarkerSeverity', () => {
  it('matches monaco', () => {
    const monaco = enumMembers('MarkerSeverity');
    expect(MARKER_SEVERITY.hint).toBe(monaco['Hint']);
    expect(MARKER_SEVERITY.info).toBe(monaco['Info']);
    expect(MARKER_SEVERITY.warning).toBe(monaco['Warning']);
    expect(MARKER_SEVERITY.error).toBe(monaco['Error']);
  });
});

describe('CompletionItemKind', () => {
  it('matches monaco for every kind this app emits', () => {
    const monaco = enumMembers('CompletionItemKind');
    expect(COMPLETION_KIND.variable).toBe(monaco['Variable']);
    expect(COMPLETION_KIND.operator).toBe(monaco['Operator']);
    expect(COMPLETION_KIND.enumMember).toBe(monaco['EnumMember']);
    expect(COMPLETION_KIND.keyword).toBe(monaco['Keyword']);
    expect(COMPLETION_KIND.reference).toBe(monaco['Reference']);
  });
});
