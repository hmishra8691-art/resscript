import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: {
      // The entry endpoint logs one `session_entered` line per request, which buries the test
      // output. Raising the floor to `error` keeps a genuine failure visible while dropping the
      // ~50 info lines the handler suite emits.
      LOG_LEVEL: 'error',
    },
  },
});
