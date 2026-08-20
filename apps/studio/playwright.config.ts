import { defineConfig } from '@playwright/test';

/**
 * The P1-01 acceptance journey lives in `e2e/` and is NOT run by `pnpm test` — `vitest.config.ts`
 * scopes its `include` to `src/**` for exactly that reason. Playwright needs a browser and a
 * live Supabase; both are CI concerns, not unit-test concerns.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  reporter: process.env['CI'] === undefined ? 'list' : 'github',
  use: {
    baseURL: process.env['STUDIO_BASE_URL'] ?? 'http://localhost:3000',
    trace: 'retain-on-failure',
  },
});
