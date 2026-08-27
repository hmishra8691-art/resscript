/**
 * Entry parameters into hidden variables — E §3, roadmap P2-04.
 *
 * The properties worth testing here are all refusals. Binding a declared parameter to a declared
 * variable is the easy half; the half that matters is that the query string — the one input a
 * respondent types freely — cannot reach anything it was not explicitly granted:
 *
 *  - an undeclared parameter binds to nothing, or a respondent could set any hidden variable in
 *    the survey, including one a quota dimension reads;
 *  - a declared parameter targeting a `response` or `system` variable is refused, matching
 *    `LGC-T030`'s rule for `set_variable`, so an entry link cannot pre-answer a question or rewrite
 *    `SERVER_TIME`;
 *  - a `variable_ref` that resolves to nothing is reported rather than dropped — the shape of a
 *    vendor config that outlived a variable rename.
 */

import { describe, expect, it } from 'vitest';
import type { ArtifactManifest, Vendor } from '@resscript/schema';

import { bindInboundParams } from './inbound.js';

const MANIFEST: Pick<ArtifactManifest, 'variable_manifest'> = {
  variable_manifest: [
    {
      id: 'var_pid' as never,
      name: 'VENDOR_PID',
      kind: 'hidden',
      type: 'text',
      export_column: 'VENDOR_PID',
      export_include: true,
      pii: false,
      persist: true,
    },
    {
      id: 'var_quota_age' as never,
      name: 'PANEL_AGE',
      kind: 'hidden',
      type: 'number',
      export_column: 'PANEL_AGE',
      export_include: true,
      pii: false,
      persist: true,
    },
    {
      id: 'var_q1' as never,
      name: 'Q1',
      kind: 'response',
      type: 'enum',
      export_column: 'Q1',
      export_include: true,
      pii: false,
      persist: true,
    },
    {
      id: 'var_time' as never,
      name: 'SERVER_TIME',
      kind: 'system',
      type: 'date',
      export_column: 'SERVER_TIME',
      export_include: false,
      pii: false,
      persist: true,
    },
  ],
};

function vendor(params: Vendor['inbound_params']): Vendor {
  return {
    id: 'ven_01' as never,
    ref: 'V_A',
    name: 'Panel A',
    inbound_params: params,
  } as Vendor;
}

function bind(query: string, params: Vendor['inbound_params']) {
  return bindInboundParams({
    params: new URLSearchParams(query),
    vendor: vendor(params),
    manifest: MANIFEST,
  });
}

describe('bindInboundParams', () => {
  it('binds a declared param to its hidden variable, keyed by variable ID', () => {
    // Keyed by id, not ref: `session.vars` is what the engine reads, and logic references ids so a
    // rename touches no AST.
    const r = bind('pid=P12345', [{ param: 'pid', variable_ref: 'VENDOR_PID', required: true }]);

    expect(r.vars).toEqual({ var_pid: 'P12345' });
    expect(r.missingRequired).toEqual([]);
  });

  it('binds NOTHING for an undeclared parameter', () => {
    // The allowlist property. Without it a respondent appending `?PANEL_AGE=99` sets a variable a
    // quota dimension reads.
    const r = bind('pid=P1&PANEL_AGE=99&anything=x', [
      { param: 'pid', variable_ref: 'VENDOR_PID', required: true },
    ]);

    expect(r.vars).toEqual({ var_pid: 'P1' });
  });

  it('reports a required param the link did not supply', () => {
    const r = bind('sid=S1', [{ param: 'pid', variable_ref: 'VENDOR_PID', required: true }]);

    expect(r.vars).toEqual({});
    expect(r.missingRequired).toEqual(['pid']);
  });

  it('treats an empty value as absent for the required check', () => {
    // `?pid=` is a vendor template that failed to interpolate, not a panel id.
    const r = bind('pid=', [{ param: 'pid', variable_ref: 'VENDOR_PID', required: true }]);

    expect(r.missingRequired).toEqual(['pid']);
  });

  it('does not report an optional param the link omits', () => {
    const r = bind('', [{ param: 'sid', variable_ref: 'VENDOR_PID', required: false }]);

    expect(r.missingRequired).toEqual([]);
    expect(r.vars).toEqual({});
  });

  it('refuses to bind into a response variable', () => {
    // An entry link that pre-answered a question would make the export disagree with what was
    // asked. Same rule `LGC-T030` applies to `set_variable`.
    const r = bind('pid=1', [{ param: 'pid', variable_ref: 'Q1', required: false }]);

    expect(r.vars).toEqual({});
    expect(r.notHidden).toEqual(['pid:Q1']);
  });

  it('refuses to bind into a system variable', () => {
    const r = bind('pid=x', [{ param: 'pid', variable_ref: 'SERVER_TIME', required: false }]);

    expect(r.vars).toEqual({});
    expect(r.notHidden).toEqual(['pid:SERVER_TIME']);
  });

  it('reports a variable_ref that resolves to nothing', () => {
    // A vendor config that outlived a variable rename.
    const r = bind('pid=x', [{ param: 'pid', variable_ref: 'GONE', required: false }]);

    expect(r.vars).toEqual({});
    expect(r.unresolved).toEqual(['pid:GONE']);
  });

  it('parses a value for a numeric hidden variable', () => {
    const r = bind('age=34', [{ param: 'age', variable_ref: 'PANEL_AGE', required: false }]);

    expect(r.vars).toEqual({ var_quota_age: 34 });
  });

  it('drops a non-numeric value for a numeric variable rather than storing NaN', () => {
    // NaN is an invariant error in the engine's value model, so admitting one would crash an
    // evaluation instead of leaving the variable unanswered.
    const r = bind('age=notanumber', [{ param: 'age', variable_ref: 'PANEL_AGE', required: false }]);

    expect(r.vars).toEqual({});
  });

  it('keeps a leading-zero panel id as text', () => {
    // Coercing "01234" to 1234 for a panel id is real data loss, and the variable's declared type
    // is the only statement of intent available.
    const r = bind('pid=01234', [{ param: 'pid', variable_ref: 'VENDOR_PID', required: false }]);

    expect(r.vars).toEqual({ var_pid: '01234' });
  });

  it('caps a value at the same length the audit copy is capped at', () => {
    const r = bind(`pid=${'x'.repeat(900)}`, [
      { param: 'pid', variable_ref: 'VENDOR_PID', required: false },
    ]);

    expect((r.vars['var_pid'] as string).length).toBe(512);
  });

  it('binds nothing when the link names no vendor', () => {
    // Direct traffic, a QR code, a test link.
    const r = bindInboundParams({
      params: new URLSearchParams('pid=P1'),
      vendor: undefined,
      manifest: MANIFEST,
    });

    expect(r.vars).toEqual({});
    expect(r.missingRequired).toEqual([]);
  });

  it('matches refs case-sensitively', () => {
    // Schema §3 makes a ref case-sensitive precisely because `Q1` and `q1` being the same variable
    // is a trap in an export column name.
    const r = bind('pid=x', [{ param: 'pid', variable_ref: 'vendor_pid', required: false }]);

    expect(r.unresolved).toEqual(['pid:vendor_pid']);
  });
});
