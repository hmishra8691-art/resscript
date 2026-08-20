/**
 * Enforces the import graph from ADR-010. These rules are not style preferences —
 * each one protects a decision that is expensive to reverse:
 *
 *  - packages/logic must stay dependency-free so the identical evaluator can run in
 *    Node, a browser, a worker and inside QuickJS-WASM (ADR-004 dual evaluation).
 *  - apps/runtime must never reach an authoring table, which in practice means it must
 *    never link a Supabase client (ADR-001 control plane / data plane).
 *  - packages/schema must not depend on question-kit, or the canonical model and the
 *    plugin contract become mutually recursive and neither can be versioned alone.
 */
module.exports = {
  forbidden: [
    {
      name: 'logic-is-dependency-free',
      comment:
        'ADR-004/ADR-010: packages/logic must have zero third-party dependencies so the ' +
        'same evaluator runs in Node, the browser, a worker and QuickJS-WASM.\n' +
        '\n' +
        'The `from.pathNot` carve-out is for test files only, which may import vitest and ' +
        'fast-check: those never ship, and QuickJS never loads them. It exists because this ' +
        'rule is no longer blind to installed packages (see `options.exclude` below), so ' +
        'without it the suite itself would be the first violation reported.',
      severity: 'error',
      from: { path: '^packages/logic/', pathNot: '\\.test\\.ts$' },
      to: {
        pathNot: '^packages/logic/',
        dependencyTypesNot: ['core'],
      },
    },
    {
      name: 'logic-no-node-builtins',
      comment:
        'ADR-004: packages/logic must be usable inside QuickJS-WASM, which has no Node builtins.',
      severity: 'error',
      from: { path: '^packages/logic/' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'runtime-no-supabase',
      comment:
        'ADR-001: apps/runtime is the data plane. It reads immutable artifacts and writes ' +
        'through narrow RPCs as runtime_writer. Linking a Supabase client is how the plane ' +
        'boundary gets quietly deleted.',
      severity: 'error',
      from: { path: '^apps/runtime/' },
      // Matched WITHOUT a `node_modules/` anchor, deliberately. dependency-cruiser matches
      // `to.path` against a dependency's `resolved` field, which is `node_modules/@supabase/…`
      // only when the package is actually installed. `@supabase/supabase-js` is not a
      // dependency of apps/runtime — that is the whole point — so the import is UNRESOLVABLE
      // and `resolved` is the bare specifier. An anchored pattern therefore matched nothing
      // and the rule was decorative: a deliberate violation passed CI. Verified by the
      // negative-control test in tools/ci/test-graph-rules.mjs.
      to: { path: '@supabase' },
    },
    {
      name: 'no-unresolvable',
      comment:
        'An import that does not resolve is either a typo or a missing dependency, and it ' +
        'silently defeats any rule matched on a resolved path (see runtime-no-supabase). ' +
        'Catching it generally is cheaper than rediscovering that class of hole per rule.\n' +
        '\n' +
        'Scoped to the libraries and the two framework-free apps. apps/studio is excluded ' +
        'because Next.js resolves its `@/*` alias from apps/studio/tsconfig.json, while ' +
        'dependency-cruiser is pointed at tsconfig.base.json (which has no `paths`, and ' +
        'should not gain a studio-specific one). Every `@/…` import there would be reported ' +
        'as unresolvable — 100+ false positives that would get this rule deleted within a ' +
        'week. The data plane, the worker and every package are the surfaces where an ' +
        'unresolved import actually hides a boundary violation, and none of them use aliases.',
      severity: 'error',
      from: {
        path: '^(packages/|apps/(runtime|worker)/)',
        pathNot: '(\\.test\\.ts$|__fixtures__|e2e/)',
      },
      to: { couldNotResolve: true },
    },
    {
      name: 'runtime-not-depend-on-studio',
      comment: 'ADR-001: the data plane must not import the control plane.',
      severity: 'error',
      from: { path: '^apps/runtime/' },
      to: { path: '^apps/studio/' },
    },
    {
      name: 'schema-not-depend-on-question-kit',
      comment:
        'ADR-010: the canonical model must be versionable independently of the plugin ' +
        'contract. Otherwise the two become mutually recursive and neither can ship alone.',
      severity: 'error',
      from: { path: '^packages/schema/' },
      // Both spellings, for the same reason as runtime-no-supabase: question-kit is not a
      // dependency of schema, so the import is unresolvable and never has a
      // `packages/question-kit/` resolved path. Matching only the path meant the violation
      // was reported by the generic no-unresolvable rule instead of by the rule that names
      // the actual architectural constraint — a much worse error message for whoever hits it.
      to: { path: '(^packages/question-kit/|@resscript/question-kit)' },
    },
    {
      name: 'apps-not-imported-by-packages',
      comment: 'Packages are libraries. An app importing into a package inverts the graph.',
      severity: 'error',
      from: { path: '^packages/' },
      to: { path: '^apps/' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    // `node_modules` is deliberately ABSENT from `exclude`, and that distinction is the whole
    // guard rail. `doNotFollow` keeps a third-party dependency IN the graph while declining to
    // traverse into it; `exclude` deletes it from the graph entirely. With node_modules
    // excluded, every rule matched on a third-party package silently depended on that package
    // NOT BEING INSTALLED: the import resolved under node_modules, the dependency vanished,
    // and the rule reported nothing.
    //
    // That is not hypothetical. `logic-is-dependency-free` and `runtime-no-supabase` both
    // passed their deliberate violations on a checkout whose node_modules had been flattened
    // by an accidental `npm install` (npm hoists every transitive package to the root, where
    // pnpm's per-package layout would not have made fast-check reachable from packages/logic).
    // The negative-control suite went green-with-2-failures on one machine and clean on
    // another, from the same commit — the guard rails were a function of install history.
    //
    // This is the same class of bug as the original `runtime-no-supabase` (matching a
    // `node_modules/` path that an uninstalled package never has), and the second time it has
    // bitten. Recorded here because the fix is one word and rediscovering it cost a day.
    exclude: { path: '(dist|\\.next|__fixtures__)' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
    },
    reporterOptions: { text: { highlightFocused: true } },
  },
};
