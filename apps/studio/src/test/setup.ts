/**
 * Vitest setup.
 *
 * Silences the structured logger for the suite: `@resscript/observability`'s default sink
 * writes JSON to stdout, and a route-handler test that exercises the error path would otherwise
 * bury the assertion output in log lines. The logger is still exercised — the tests install a
 * capturing sink where the log content matters.
 */

import { afterEach } from 'vitest';
import { resetContextResolver } from '@/server/context';

process.env['LOG_LEVEL'] = 'error';

// jest-dom's matchers only make sense with a DOM, and the route-handler suite runs in plain
// Node (see `environmentMatchGlobs` in vitest.config.ts). Importing conditionally keeps one
// setup file for both environments instead of two that can drift.
if (typeof document !== 'undefined') {
  await import('@testing-library/jest-dom/vitest');
}

afterEach(() => {
  // A leaked resolver would make the next test authenticate as the previous test's actor, which
  // is the kind of cross-test bleed that makes an authorization suite lie.
  resetContextResolver();
});
