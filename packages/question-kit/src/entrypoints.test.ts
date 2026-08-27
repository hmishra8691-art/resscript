/**
 * The entry-point separation, asserted rather than commented.
 *
 * `./index.ts` is imported by the compiler, the exporter, the worker and the API boundary.
 * `./react.ts` is imported by studio and the runtime's renderer bundle. If a value import of React
 * ever leaks from the second into the first, React lands in `apps/worker` and — once the runtime
 * imports the same object graph — the *editor* lands in the respondent bundle, on the page-load
 * path of every survey we run. Nothing else in CI would notice: it type-checks, it tests, it just
 * quietly costs every respondent a few hundred kilobytes.
 *
 * The walk below is a static one over the source files, not a bundler run, because the property is
 * about the module graph rather than about any particular bundler's tree-shaking.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * `import`/`export … from '…'` specifiers, split into value and type-only.
 *
 * Type-only imports are erased under `verbatimModuleSyntax`, so `import type { ReactNode } from
 * 'react'` costs nothing at runtime and is *allowed* on the React-free path — the contract has to
 * be able to name a component type without shipping React. A value import is the thing that
 * actually pulls a module in, so only those are followed and only those are forbidden.
 */
function importsOf(source: string): { readonly value: readonly string[]; readonly type: readonly string[] } {
  const value: string[] = [];
  const type: string[] = [];
  const pattern = /(?:^|\n)\s*(?:import|export)(\s+type)?\s+(?:[\s\S]*?)from\s+'([^']+)'/g;
  for (const match of source.matchAll(pattern)) {
    const specifier = match[2];
    if (specifier === undefined) continue;
    // `import { type X, foo }` is a value import of `foo`; `import type { … }` is not an import at
    // all after compilation. Only the statement-level `import type` form is treated as erased.
    if (match[1] === undefined) value.push(specifier);
    else type.push(specifier);
  }
  return { value, type };
}

/** Resolve a specifier to a real file, returning both the path and its source. */
function readModule(path: string): { readonly file: string; readonly source: string } | undefined {
  for (const candidate of [path, `${path}.ts`, `${path}.tsx`, `${path}/index.ts`]) {
    try {
      return { file: candidate, source: readFileSync(candidate, 'utf8') };
    } catch {
      continue;
    }
  }
  return undefined;
}

interface Graph {
  readonly files: readonly string[];
  readonly externalValueImports: readonly string[];
}

function walk(entry: string): Graph {
  const visited = new Set<string>();
  const files = new Set<string>();
  const external = new Set<string>();
  const queue = [resolvePath(here, entry)];

  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined || visited.has(current)) continue;
    visited.add(current);
    const module = readModule(current);
    if (module === undefined) continue;
    // The *resolved* path is recorded, extension included: a set of extensionless paths cannot
    // answer "is any component module on this side of the split?".
    files.add(module.file);

    for (const specifier of importsOf(module.source).value) {
      if (!specifier.startsWith('.')) {
        external.add(specifier);
        continue;
      }
      // Local imports are written with a `.js` suffix (moduleResolution: Bundler resolves it to
      // the `.ts`/`.tsx` source), so the suffix is stripped before probing the filesystem.
      queue.push(resolvePath(dirname(current), specifier.replace(/\.js$/, '')));
    }
  }

  return { files: [...files], externalValueImports: [...external] };
}

describe('the React-free entry point', () => {
  const graph = walk('index.ts');

  it('reaches a non-trivial part of the package', () => {
    // Guards the guard: a walk that resolved nothing would find no React either.
    expect(graph.files.length).toBeGreaterThan(15);
  });

  it('value-imports neither react nor react-dom, anywhere in its graph', () => {
    const reactish = graph.externalValueImports.filter((specifier) =>
      /^react(-dom)?(\/|$)/.test(specifier),
    );
    expect(reactish).toEqual([]);
  });

  it('imports no test framework, and no component module', () => {
    expect(graph.externalValueImports).not.toContain('vitest');
    expect(graph.externalValueImports).not.toContain('@testing-library/react');
    expect(graph.files.filter((file) => file.endsWith('.tsx'))).toEqual([]);
  });

  it('depends on schema and nothing else outside the workspace', () => {
    // `packages/schema` is the one allowed direction (ADR-010). A second third-party dependency
    // here would be a decision, and it should be visible as a failing test rather than a diff.
    expect([...graph.externalValueImports].sort()).toEqual(['@resscript/schema']);
  });
});

describe('the React entry point', () => {
  const graph = walk('react.ts');

  it('does reach React, which is the point of the split', () => {
    // What this suite protects is the CORE entry point staying React-free (asserted above, and
    // unchanged): a worker, the compiler and the export path all import `index.ts`, and a React
    // import there would put a UI framework in a headless bundle.
    //
    // On THIS side the presence of the component modules is the property that matters, and it is
    // asserted directly. The original form of this test also required that no source here named
    // `react` as a value import, reasoning that JSX compiles through `react/jsx-runtime` so the
    // source "need not name React at all". That was true of every Phase-1 plugin, all of which are
    // pure functions of their props — but "need not" was encoded as "must not", and P2-05's
    // `searchable_select` is the first view with genuine per-respondent interaction state (the
    // query, whether the popup is open, which option is highlighted). That state is UI, not an
    // answer, so it must not travel through `onChange`; a `RendererComponent` is a node factory
    // that React never mounts, so it cannot hold state itself; and the alternative — a native
    // `<datalist>` — cannot fold diacritics, so a respondent typing `espana` would not find
    // `España`. Hooks in a nested component are the honest way to get all three.
    //
    // So the rule is now the one the split is actually for: React may be imported here, never in
    // `index.ts`.
    expect(graph.files.some((file) => file.endsWith('view.tsx'))).toBe(true);
  });

  it('is the only side that may reach React at all', () => {
    // The invariant restated as a comparison rather than as an absolute, so the guarantee is still
    // mechanically checked: whatever this side imports, the core must not.
    const coreGraph = walk('index.ts');
    expect(coreGraph.externalValueImports.filter((s) => /^react(-dom)?(\/|$)/.test(s))).toEqual([]);
  });
});

describe('the test kit', () => {
  const graph = walk('testkit/index.ts');

  it('is the only entry point that pulls the test framework and the DOM harness', () => {
    expect(graph.externalValueImports).toContain('vitest');
    expect(graph.externalValueImports).toContain('react-dom/client');
    expect(graph.externalValueImports).toContain('react-dom/server');
  });
});
