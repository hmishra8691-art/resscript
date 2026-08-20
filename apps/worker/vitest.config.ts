import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Silences the ConsoleSpanExporter for the whole suite. See src/test-setup.ts.
    setupFiles: ['./src/test-setup.ts'],
  },
});
