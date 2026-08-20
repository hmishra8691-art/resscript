import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    // `include` is scoped to src/ on purpose: `e2e/*.spec.ts` are Playwright specs (a real
    // browser, a live Supabase) and must never be picked up by `pnpm test`.
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // Route-handler tests are plain Node (Request/Response from undici); only the component
    // tests need a DOM, and they are the `.test.tsx` ones.
    environmentMatchGlobs: [['src/**/*.test.tsx', 'jsdom']],
    environment: 'node',
    setupFiles: ['./src/test/setup.ts'],
    restoreMocks: true,
  },
});
