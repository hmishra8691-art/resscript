/**
 * `POST /api/v1/dsl/compile` and `POST /api/v1/dsl/print` (API §5, named by UI §7.3).
 *
 * The behaviour worth pinning, in order of how badly it breaks a client if it changes:
 *
 *  1. **A parse failure is `200 { ok: false }`.** An editor calling this per keystroke must not
 *     have to distinguish a syntax error from a transport failure (API §5.1).
 *  2. **A malformed AST is a `validation_failed` (422).** The asymmetry with (1) is the point:
 *     nobody typed an AST, so a bad one is a bug in the caller rather than an editor mid-keystroke.
 *  3. **Org scoping is a 404, not a 403** — another org's version does not exist here.
 *  4. **Printing uses the version's CURRENT refs**, which is the whole reason the AST stores ids.
 */

import { describe, expect, it } from 'vitest';
import { POST as compile } from '@/app/api/v1/dsl/compile/route';
import { POST as printRoute } from '@/app/api/v1/dsl/print/route';
import { createHarness, readJson, req } from '@/test/harness';
import { registryRowsFor } from '@/test/registry-fixture';

interface CompileBody {
  ok: boolean;
  statements: unknown[];
  diagnostics: { code: string; severity: string; source_span?: { start: number; end: number } }[];
  source_map: { ast_node_id: number; start: number; end: number }[];
  summary: { errors: number; warnings: number; infos: number };
}

const body = (h: ReturnType<typeof createHarness>, source: string): Record<string, unknown> => ({
  source,
  scope: { survey_version_id: h.ids.draftA },
});

describe('POST /api/v1/dsl/compile', () => {
  it('compiles source against the version\'s registry and returns a source map', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    const response = await readJson(
      await compile(req('/api/v1/dsl/compile', { method: 'POST', body: body(h, 'IF S1 = S1.Yes AND AGE >= 18 THEN SHOW Q12\n') })),
    );
    expect(response.status).toBe(200);
    const parsed = response.body as unknown as CompileBody;
    expect(parsed.ok).toBe(true);
    expect(parsed.statements).toHaveLength(1);
    expect(parsed.diagnostics).toEqual([]);
    // `ast_node_id` is the AST's stable `n` — the same key the trace and the memo table use.
    expect(parsed.source_map.length).toBeGreaterThan(0);
    expect(parsed.source_map[0]).toMatchObject({ ast_node_id: expect.any(Number) });
  });

  it('answers 200 { ok: false } with positioned diagnostics for a syntax error', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    const response = await readJson(
      await compile(req('/api/v1/dsl/compile', { method: 'POST', body: body(h, 'IF S1 = ') })),
    );
    // NOT a 400: "the caller asked us to compile something; we did, and it did not compile."
    expect(response.status).toBe(200);
    const parsed = response.body as unknown as CompileBody;
    expect(parsed.ok).toBe(false);
    expect(parsed.summary.errors).toBeGreaterThan(0);
    expect(parsed.diagnostics[0]?.source_span).toEqual({ start: 8, end: 8, line: 1, col: 9 });
  });

  it('type-checks against the registry: an unknown ref is LGC-T001', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    const response = await readJson(
      await compile(req('/api/v1/dsl/compile', { method: 'POST', body: body(h, 'IF NOPE = 1 THEN SHOW Q12\n') })),
    );
    const parsed = response.body as unknown as CompileBody;
    expect(parsed.ok).toBe(false);
    expect(parsed.diagnostics.map((d) => d.code)).toContain('LGC-T001');
  });

  it('rejects a comparison of an enum to a text literal (D §3.4), which is the point of the registry', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    const response = await readJson(
      await compile(req('/api/v1/dsl/compile', { method: 'POST', body: body(h, 'IF S1 = "yes" THEN SHOW Q12\n') })),
    );
    const parsed = response.body as unknown as CompileBody;
    expect(parsed.ok).toBe(false);
    expect(parsed.diagnostics.map((d) => d.code)).toContain('LGC-T003');
  });

  it('is 404 for another org\'s version', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    const response = await readJson(
      await compile(
        req('/api/v1/dsl/compile', {
          method: 'POST',
          body: { source: 'IF S1 = 1 THEN SHOW Q12\n', scope: { survey_version_id: h.ids.draftB } },
        }),
      ),
    );
    expect(response.status).toBe(404);
    expect((response.body['error'] as { code: string }).code).toBe('not_found');
  });

  it('requires a programmer', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.viewerA, activeOrgId: h.ids.orgA });
    const response = await readJson(
      await compile(req('/api/v1/dsl/compile', { method: 'POST', body: body(h, 'IF S1 = 1 THEN SHOW Q12\n') })),
    );
    expect(response.status).toBe(403);
  });

  it('requires `scope.survey_version_id` and rejects unknown request fields', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    const noScope = await readJson(
      await compile(req('/api/v1/dsl/compile', { method: 'POST', body: { source: 'IF S1 = 1' } })),
    );
    // 422 rather than 400: `validation_failed` is a well-formed request whose FIELDS are wrong,
    // and the envelope's status table (packages/observability) owns that mapping app-wide.
    expect(noScope.status).toBe(422);
    expect((noScope.body['error'] as { code: string }).code).toBe('validation_failed');

    const extra = await readJson(
      await compile(
        req('/api/v1/dsl/compile', { method: 'POST', body: { ...body(h, 'IF S1 = 1'), registry: {} } }),
      ),
    );
    expect(extra.status).toBe(400);
    expect((extra.body['error'] as { code: string }).code).toBe('unknown_field');
  });

  it('carries the request id on every answer, including the ok:false one', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    const response = await compile(req('/api/v1/dsl/compile', { method: 'POST', body: body(h, 'IF') }));
    expect(response.headers.get('x-request-id')).toBe('req_test');
  });
});

describe('POST /api/v1/dsl/print', () => {
  /** Round-trips through compile so the AST under test is the real one, not a hand-written stub. */
  async function statementsFor(h: ReturnType<typeof createHarness>, source: string): Promise<unknown[]> {
    const response = await readJson(
      await compile(req('/api/v1/dsl/compile', { method: 'POST', body: body(h, source) })),
    );
    return (response.body as unknown as CompileBody).statements;
  }

  it('prints an AST back to canonical source (T2)', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    const statements = await statementsFor(h, 'if   S1 == S1.Yes and AGE >= 18 then show Q12\n');
    const response = await readJson(
      await printRoute(
        req('/api/v1/dsl/print', {
          method: 'POST',
          body: { statements, scope: { survey_version_id: h.ids.draftA } },
        }),
      ),
    );
    expect(response.status).toBe(200);
    // Keyword case and `==` → `=` are normalized; the author's symbolic ref is not.
    expect(response.body['source']).toBe('IF S1 = S1.Yes AND AGE >= 18 THEN SHOW Q12\n');
  });

  it('renders ids through the CURRENT ref, so a rename needs no find-and-replace', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    const statements = await statementsFor(h, 'IF AGE >= 18 THEN SHOW Q12\n');

    // Rename the question in the registry — ids untouched, exactly as a tree rename does.
    const rows = registryRowsFor(h.ids.draftA);
    h.data.seedRegistry({
      ...rows,
      nodes: rows.nodes.map((node) => (node.ref === 'Q12' ? { ...node, ref: 'Q12_PURCHASE' } : node)),
    });

    const response = await readJson(
      await printRoute(
        req('/api/v1/dsl/print', {
          method: 'POST',
          body: { statements, scope: { survey_version_id: h.ids.draftA } },
        }),
      ),
    );
    expect(response.body['source']).toBe('IF AGE >= 18 THEN SHOW Q12_PURCHASE\n');
  });

  it('is 422 for a malformed AST, naming the field', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    const response = await readJson(
      await printRoute(
        req('/api/v1/dsl/print', {
          method: 'POST',
          body: { statements: [{ s: 'not_a_statement_kind' }], scope: { survey_version_id: h.ids.draftA } },
        }),
      ),
    );
    expect(response.status).toBe(422);
    const error = response.body['error'] as { code: string; details: { path: string; code: string }[] };
    expect(error.code).toBe('validation_failed');
    expect(error.details[0]).toMatchObject({ path: 'statements', code: 'invalid_ast' });
  });

  it('refuses `symbolic_option_refs: false` rather than ignoring it', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    const response = await readJson(
      await printRoute(
        req('/api/v1/dsl/print', {
          method: 'POST',
          body: {
            statements: [],
            scope: { survey_version_id: h.ids.draftA },
            options: { symbolic_option_refs: false },
          },
        }),
      ),
    );
    expect(response.status).toBe(422);
    const error = response.body['error'] as { details: { path: string; code: string }[] };
    expect(error.details[0]).toMatchObject({
      path: 'options.symbolic_option_refs',
      code: 'not_implementable',
    });
  });

  it('is 404 for another org\'s version', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
    const response = await readJson(
      await printRoute(
        req('/api/v1/dsl/print', {
          method: 'POST',
          body: { statements: [], scope: { survey_version_id: h.ids.draftB } },
        }),
      ),
    );
    expect(response.status).toBe(404);
  });
});
