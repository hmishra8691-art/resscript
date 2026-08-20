/**
 * Vitest setup for `apps/worker`.
 *
 * The default span exporter is `ConsoleSpanExporter`, which is correct in production and useless
 * in a test run: every job the suite executes writes a span line to stdout, burying the actual
 * test output. Swapping in the noop exporter keeps the test report readable. The two tests that
 * assert on spans install `InMemorySpanExporter` themselves and restore whatever was there
 * before, so they are unaffected.
 *
 * Metrics need no equivalent: the default metric sink is already `NoopSink`.
 */
import { NoopSpanExporter, setSpanExporter } from '@resscript/observability';

setSpanExporter(new NoopSpanExporter());
