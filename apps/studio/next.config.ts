import type { NextConfig } from 'next';

/**
 * WHY `transpilePackages`: `@resscript/schema` and `@resscript/observability` publish their
 * `src/*.ts` directly (see their `exports` maps) so the monorepo has one source of truth and
 * no build step between packages. Next must therefore compile them itself instead of
 * treating them as pre-built CJS/ESM dependencies.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: [
    '@resscript/schema',
    '@resscript/observability',
    // P1-07: same story — `@resscript/rescript-dsl` and `@resscript/logic` publish `src/*.ts` and
    // import siblings as `./printer.js`. Listed explicitly rather than relying on the fact that a
    // pnpm symlink resolves outside `node_modules` and therefore happens to hit the app's own SWC
    // loader: that is an accident of the install layout, and the failure mode when it changes is a
    // build error nobody can attribute.
    '@resscript/rescript-dsl',
    '@resscript/logic',
    // P1-11: the preview panel imports `parsePreviewToStudio` from `@resscript/runtime-core` —
    // the SAME validator the preview frame runs, because two hand-maintained copies of a
    // security-relevant contract drift silently (see that package's preview-protocol.ts).
    '@resscript/runtime-core',
  ],
  /**
   * WHY `extensionAlias`: those packages are ESM-correct TypeScript — they import siblings as
   * `./registries.js` because that is what the emitted ESM must say, while the file on disk is
   * `registries.ts`. `tsc` and Vite both resolve that automatically; webpack does not, and
   * without this the build fails with "Can't resolve './registries.js'".
   *
   * The alternative would be to make those packages emit `dist/` and point their `exports` at
   * it, which trades one line here for a build step between every package and every consumer.
   */
  webpack: (config: {
    resolve: { extensionAlias?: Record<string, readonly string[]> };
  }) => {
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js'],
      '.mjs': ['.mts', '.mjs'],
    };
    return config;
  },
  // The studio is an authenticated control plane: nothing here should ever be cached by an
  // intermediary, and the API surface must not be embedded in a third-party page.
  async headers() {
    return [
      {
        source: '/api/:path*',
        headers: [
          { key: 'Cache-Control', value: 'no-store' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ];
  },
};

export default nextConfig;
