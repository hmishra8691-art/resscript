import { FlatCompat } from '@eslint/eslintrc';

/**
 * ESLint 9 flat config.
 *
 * `eslint-config-next` for Next 15 is still eslintrc-shaped, so it is bridged with `FlatCompat`
 * rather than hand-copying its rule list — a copied rule list is one more thing to drift from
 * the framework's own recommendations. The script calls the `eslint` CLI directly instead of
 * `next lint`, which is deprecated in 15 and, with no config present, prompts interactively and
 * therefore hangs CI.
 */
const compat = new FlatCompat({ baseDirectory: import.meta.dirname });

export default [
  { ignores: ['.next/**', 'node_modules/**', 'next-env.d.ts'] },
  ...compat.extends('next/core-web-vitals'),
  {
    rules: {
      // The runtime bans `Math.random` outright (seeded PRNG only); the studio's only random
      // values are idempotency keys, which use `crypto.randomUUID`. Keep it explicit here so a
      // copy-paste from a tutorial does not introduce one.
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: 'use crypto.randomUUID / getRandomValues' },
      ],
    },
  },
];
