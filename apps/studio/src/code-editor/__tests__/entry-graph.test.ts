/**
 * The chunking guard rail. §7.4: Monaco is "`import()`ed on first use, **never in the route's entry
 * graph**", and §12 budgets 180 KB gz for a dashboard route against Monaco's ~330 KB alone.
 *
 * That property is not something a unit test of behaviour can see — it is a property of the import
 * graph, and it breaks silently: one `import * as monaco from 'monaco-editor'` added for a type
 * that could have been `import type`, and every route that touches the logic pane grows by a third
 * of a megabyte with no test turning red. So the graph is asserted directly, over the source.
 *
 * Two files are allowed to name the editor at runtime, and both are the boundary rather than users
 * of it: `load.ts` (the single memoised `import()`) and `editor.worker.ts` (the worker chunk
 * `MonacoEnvironment.getWorker` hands back). Everything else may use `import type`, which erases.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { globSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve(fileURLToPath(new URL('../../', import.meta.url)));

/** Files permitted to pull the editor in at runtime. */
const BOUNDARY = ['code-editor/load.ts', 'code-editor/editor.worker.ts'];

function sourceFiles(): string[] {
  return globSync('**/*.{ts,tsx}', { cwd: SRC }).filter((file) => !file.includes('__tests__'));
}

/**
 * Comments are stripped first, because these files *discuss* the import they must not make — the
 * boundary is explained where it is enforced, and a scan that cannot tell prose from code would
 * make the explanation the violation.
 */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('the Monaco entry graph', () => {
  it('is entered from exactly two files, and every other reference is `import type`', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const text = code(readFileSync(resolve(SRC, file), 'utf8'));
      // Every mention of the package with its line, which is enough to tell
      // `import type * as monaco from 'monaco-editor'` from a value import.
      for (const match of text.matchAll(/[^\n]*['"]monaco-editor[^'"]*['"]/g)) {
        const line = match[0];
        const isTypeOnly = /import\s+type/.test(line);
        const isDynamic = /import\s*\(/.test(line);
        if (isTypeOnly) continue;
        if (BOUNDARY.includes(file) && (isDynamic || file.endsWith('editor.worker.ts'))) continue;
        offenders.push(`${file}: ${line.trim()}`);
      }
    }
    expect(offenders, 'a runtime import of monaco-editor outside the two boundary files').toEqual([]);
  });

  it('keeps the pure language services free of the editor even as types', () => {
    // These are the modules a route's entry graph legitimately reaches (the tree renders printed
    // conditions, the Problems tab renders diagnostics). A *type* import is free at runtime, but a
    // module that needs Monaco's types is a module one refactor away from needing its values.
    const pure = ['code-editor/completion.ts', 'code-editor/hover.ts', 'code-editor/operators.ts', 'code-editor/mode-toggle.ts', 'code-editor/compile-loop.ts'];
    for (const file of pure) {
      const text = code(readFileSync(resolve(SRC, file), 'utf8'));
      expect(text.includes('monaco-editor'), `${file} should not reference monaco at all`).toBe(false);
    }
  });

  it('is reachable only through load.ts from the components', () => {
    const pane = code(readFileSync(resolve(SRC, 'components/logic/CodeEditorPane.tsx'), 'utf8'));
    expect(pane).toContain("from '@/code-editor/load'");
    expect(pane.includes("'monaco-editor")).toBe(false);
    // Sanity: this test file's own path assumptions hold.
    expect(relative(SRC, resolve(SRC, 'code-editor/load.ts'))).toBe('code-editor/load.ts');
  });
});
