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
        'same evaluator runs in Node, the browser, a worker and QuickJS-WASM.',
      severity: 'error',
      from: { path: '^packages/logic/' },
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
    exclude: { path: '(node_modules|dist|\\.next|__fixtures__)' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
    },
    reporterOptions: { text: { highlightFocused: true } },
  },
};
