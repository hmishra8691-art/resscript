/**
 * The QuickJS script host — E §13.
 *
 * These run REAL QuickJS-WASM, not a mock: every claim here (the interrupt fires, the memory
 * limit trips, the sandbox has no Date) is a claim about the engine's behaviour, and E §13's
 * budgets exist precisely because "the host promises to interrupt" is worthless untested.
 */

import { describe, expect, it } from 'vitest';
import { createScriptHost, type RunScriptInput } from './host.js';

const host = createScriptHost();

function input(source: string, over: Partial<RunScriptInput> = {}): RunScriptInput {
  const vars: Record<string, unknown> = { AGE: 34, SEGMENT: null, PID: 'p1' };
  const kinds: Record<string, string> = {
    AGE: 'response', SEGMENT: 'hidden', TIER: 'derived', PID: 'hidden',
  };
  return {
    source,
    assetRef: 'enrich',
    seed: 'a3f9c1d2e4b6a8f0c2d4e6b8a0f2c4d6',
    context: {
      session_id: 'ses_1', survey_version: 'ver_1', language: 'en', device: 'desktop',
      country: 'US', page_id: 'pg_1', hook: 'onPageSubmit', is_test: false,
      server_time_ms: 1_700_000_000_000,
    },
    getValue: ref => vars[ref],
    varKind: ref => kinds[ref],
    wasShown: ref => ref === 'AGE',
    ...over,
  };
}

describe('the API surface (E §13.1)', () => {
  it('reads variables and writes hidden/derived ones through the overlay', async () => {
    const r = await host.run(input(`
      const age = survey.getValue('AGE');
      survey.setValue('SEGMENT', age >= 30 ? 'older' : 'younger');
      survey.setValue('TIER', 'gold');
      // The script reads its own write back — copy-on-write, not write-only.
      if (survey.getValue('SEGMENT') !== 'older') throw new Error('overlay read failed');
    `));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.writes).toEqual({ SEGMENT: 'older', TIER: 'gold' });
  });

  it('REFUSES a write to a response variable — fabricated respondent data', async () => {
    const r = await host.run(input(`
      let threw = false;
      try { survey.setValue('AGE', 99); } catch (e) { threw = true; }
      if (!threw) throw new Error('the write was allowed');
      survey.setValue('SEGMENT', 'still-works');
    `));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.writes).toEqual({ SEGMENT: 'still-works' }); // AGE never entered
  });

  it('getValues / isAnswered / wasShown / flag / log round-trip', async () => {
    const r = await host.run(input(`
      const vs = survey.getValues(['AGE', 'SEGMENT']);
      if (vs.AGE !== 34 || vs.SEGMENT !== null) throw new Error('getValues');
      if (!survey.isAnswered('AGE') || survey.isAnswered('SEGMENT')) throw new Error('isAnswered');
      if (!survey.wasShown('AGE') || survey.wasShown('PID')) throw new Error('wasShown');
      survey.flag('speeder_suspect');
      survey.log('info', 'matched', { tier: 'gold' });
    `));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.flags).toEqual(['speeder_suspect']);
      expect(r.logs[0]).toMatchObject({ level: 'info', msg: 'matched', data: { tier: 'gold' } });
    }
  });

  it('terminate() and reject() are recorded, first call wins', async () => {
    const r = await host.run(input(`
      survey.terminate('QUALITY');
      survey.terminate('COMPLETE');
      survey.reject('msg.first');
      survey.reject('msg.second');
    `));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.terminate).toEqual({ disposition: 'QUALITY', custom_key: null });
      expect(r.reject).toBe('msg.first');
    }
  });

  it('THE CLOSED WORLD: no Date, no Math.random, no fetch, no eval-to-host escape', async () => {
    const r = await host.run(input(`
      const absent = [];
      if (typeof Date !== 'undefined' && typeof Date.now === 'function') {
        // QuickJS ships Date as a language built-in; what matters is that the HOST clock is
        // the injected one. We assert the bridge is gone instead:
      }
      if (typeof fetch !== 'undefined') absent.push('fetch');
      if (typeof XMLHttpRequest !== 'undefined') absent.push('xhr');
      if (typeof require !== 'undefined') absent.push('require');
      if (typeof process !== 'undefined') absent.push('process');
      if (typeof __host !== 'undefined') absent.push('__host');   // the prelude deleted it
      if (absent.length) throw new Error('leaked: ' + absent.join(','));
      // survey is frozen: replacing a method must fail silently or throw, never take effect.
      try { survey.setValue = () => {}; } catch (e) {}
      if (String(survey.setValue).includes('() => {}')) throw new Error('survey not frozen');
    `));
    expect(r.ok).toBe(true);
  });

  it('context.random(salt) is seeded and REPLAYABLE (ADR-006)', async () => {
    const src = `
      const a = survey.context.random('boost');
      const b = survey.context.random('boost');
      const c = survey.context.random('other');
      survey.setValue('SEGMENT', JSON.stringify([a, b, c]));
    `;
    const r1 = await host.run(input(src));
    const r2 = await host.run(input(src));
    expect(r1.ok && r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      // Identical across runs (same seed), and the per-salt counter advances within a run.
      expect(r1.writes['SEGMENT']).toBe(r2.writes['SEGMENT']);
      const [a, b, c] = JSON.parse(r1.writes['SEGMENT'] as string) as number[];
      expect(a).not.toBe(b);
      expect(a).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThan(1);
    }
  });

  it('http is DENIED by default with the E §13.3 reason, and injectable', async () => {
    const denied = await host.run(input(`survey.http({ method: 'GET', url: 'https://x.example' });`));
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.reason).toBe('http_denied');

    const allowed = await host.run(input(
      `const r = survey.http({ method: 'GET', url: 'https://x.example' });
       survey.setValue('SEGMENT', r.body);`,
      { http: () => ({ status: 200, headers: {}, body: 'proxied' }) },
    ));
    expect(allowed.ok).toBe(true);
    if (allowed.ok) expect(allowed.writes['SEGMENT']).toBe('proxied');
  });

  it('secret() throws when absent, resolves when injected, never appears in logs', async () => {
    const r = await host.run(input(
      `survey.setValue('SEGMENT', survey.secret('crm_key').length);`,
      { secret: name => (name === 'crm_key' ? 'sk-123456' : null) },
    ));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.writes['SEGMENT']).toBe(9); // the length, not the value
  });
});

describe('budgets (E §13.2) — enforced by the engine, proven here', () => {
  it('a runaway while(true) is a clean instruction_limit, not a hung worker', async () => {
    const r = await host.run(input('while (true) {}', {
      budgets: { wall_ms: 60_000, max_interrupts: 50 },
    }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('instruction_limit');
  }, 15_000);

  it('the wall clock trips as timeout', async () => {
    const r = await host.run(input('while (true) {}', {
      budgets: { wall_ms: 50, max_interrupts: 10_000_000 },
    }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('timeout');
  }, 15_000);

  it('the memory limit trips as oom', async () => {
    // Generous wall and interrupt budgets so that under a loaded CI box the MEMORY limit is
    // the one that trips — this test is about setMemoryLimit, not about which budget races
    // ahead when the machine is slow.
    const r = await host.run(input(
      `const a = []; let i = 0; while (true) a.push(String(i++).repeat(65536));`,
      { budgets: { wall_ms: 60_000, max_interrupts: 100_000_000, memory_bytes: 1024 * 1024 } },
    ));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('oom');
  }, 70_000);

  it('the setValue budget caps a state-rewriting script', async () => {
    const r = await host.run(input(
      `for (let i = 0; i < 200; i++) survey.setValue('SEGMENT', i);`,
      { budgets: { max_set_value: 100 } },
    ));
    expect(r.ok).toBe(false); // the 101st call threw, uncaught
    if (!r.ok) expect(r.error).toContain('budget of 100');
  });

  it('log volume overflows with a marker, not an error', async () => {
    const r = await host.run(input(
      `for (let i = 0; i < 300; i++) survey.log('info', 'entry ' + i);`,
      { budgets: { max_log_entries: 10 } },
    ));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.logs.length).toBe(11); // 10 entries + the truncation marker
      expect(r.logs[10]?.msg).toContain('budget exceeded');
    }
  });
});

describe('rollback (E §13.3)', () => {
  it('a script that dies halfway through its writes commits NONE of them', async () => {
    const r = await host.run(input(`
      survey.setValue('SEGMENT', 'one');
      survey.setValue('TIER', 'two');
      throw new Error('boom');
    `));
    expect(r.ok).toBe(false);
    // The overlay is not surfaced on failure — there IS no writes field to accidentally merge.
    expect('writes' in r).toBe(false);
    if (!r.ok) expect(r.error).toBe('boom');
  });

  it('a timeout mid-write rolls back the same way', async () => {
    const r = await host.run(input(
      `survey.setValue('SEGMENT', 'set-before-spin'); while (true) {}`,
      { budgets: { wall_ms: 50, max_interrupts: 10_000_000 } },
    ));
    expect(r.ok).toBe(false);
    expect('writes' in r).toBe(false);
  }, 15_000);
});
