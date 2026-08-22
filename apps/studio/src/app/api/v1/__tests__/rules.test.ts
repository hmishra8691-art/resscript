/**
 * The rules routes (API §2.7, roadmap P1-12): the central registry, both authoring paths, and
 * the two GIN-backed questions.
 *
 * The suite's centre is DB §4.4's derived-state rule: the `depends_on_*` closure is recomputed
 * from the AST on every save, and BOTH filter directions ("what affects Q12" via target, "what
 * does Q3 affect" via the dependency arrays) answer from what the server computed — never from
 * anything a client sent. And API §2.7's write rule: type-checked on write, `LGC-*` errors are
 * 422 and the rule is NOT stored.
 *
 * Assertions are on status codes, envelope CODES and stored rows. Never on message prose.
 */

import { describe, expect, it } from 'vitest';
import { astBuilder, type Expr } from '@resscript/logic';
import { GET as listRules, POST as postRule } from '@/app/api/v1/versions/[id]/rules/route';
import { DELETE as deleteRule, GET as getRule, PATCH as patchRule } from '@/app/api/v1/rules/[id]/route';
import { GET as getUsages } from '@/app/api/v1/variables/[id]/usages/route';
import { GET as getVariables } from '@/app/api/v1/versions/[id]/variables/route';
import { GET as getTree } from '@/app/api/v1/versions/[id]/tree/route';
import { createHarness, params, readJson, req, type Harness } from '@/test/harness';
import { IDS } from '@/test/registry-fixture';

function envelopeCode(body: Record<string, unknown>): string {
  return (body['error'] as { code: string }).code;
}

function detailCodes(body: Record<string, unknown>): string[] {
  return (body['error'] as { details: { code: string }[] }).details.map((d) => d.code);
}

const DOM_S1 = `dom_${IDS.questionS1}`;
const DOM_Q5 = `dom_${IDS.questionQ5}`;

/** `S1 = Yes AND AGE >= 18` — reads two variables, probes nothing. */
function condition(): Expr {
  const b = astBuilder(1);
  return b.and(
    b.cmp('==', b.variable(IDS.varS1 as never), b.enumLit(1, DOM_S1 as never)),
    b.cmp('>=', b.variable(IDS.varAge as never), b.numLit(18)),
  );
}

function asProgrammer(h: Harness): void {
  h.as({ userId: h.ids.programmerA, activeOrgId: h.ids.orgA });
}

async function createRule(
  h: Harness,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return readJson(
    await postRule(req(`/api/v1/versions/${h.ids.draftA}/rules`, { method: 'POST', body }), params({ id: h.ids.draftA })),
  );
}

const HIDE_Q12 = {
  kind: 'display',
  target: { node_id: IDS.questionQ12 },
  effect: { action: 'hide' },
};

/* ========================================================================== */
/* POST — the AST path                                                        */
/* ========================================================================== */

describe('POST /api/v1/versions/:id/rules (condition AST)', () => {
  it('stores the rule and computes the dependency closure server-side', async () => {
    const h = createHarness();
    asProgrammer(h);
    const { status, body } = await createRule(h, {
      ...HIDE_Q12,
      condition: condition(),
      notes: 'client wants Q12 hidden for young non-buyers',
    });
    expect(status).toBe(201);
    const rule = body['rule'] as Record<string, unknown>;
    expect(rule['kind']).toBe('display');
    expect(rule['target_node_id']).toBe(IDS.questionQ12);
    expect(rule['authored_in']).toBe('visual');
    expect(rule['notes']).toBe('client wants Q12 hidden for young non-buyers');
    // DB §4.4: recomputed from the AST — both variables, first-seen order, nothing else.
    expect(rule['depends_on_variable_ids']).toEqual([IDS.varS1, IDS.varAge]);
    expect(rule['depends_on_node_ids']).toEqual([]);
  });

  it('a probe on a question lands in depends_on_node_ids, not the variable array', async () => {
    const h = createHarness();
    asProgrammer(h);
    const b = astBuilder(1);
    const { status, body } = await createRule(h, {
      ...HIDE_Q12,
      condition: b.probe('answered', { kind: 'question', id: IDS.questionS1 as never }),
    });
    expect(status).toBe(201);
    const rule = body['rule'] as Record<string, unknown>;
    expect(rule['depends_on_node_ids']).toEqual([IDS.questionS1]);
    expect(rule['depends_on_variable_ids']).toEqual([]);
  });

  it('type errors are 422 with the LGC code, and the rule is NOT stored', async () => {
    const h = createHarness();
    asProgrammer(h);
    const b = astBuilder(1);
    // S1 (enum) compared to a TEXT literal — the checker's LGC-T003, message and all.
    const { status, body } = await createRule(h, {
      ...HIDE_Q12,
      condition: b.cmp('==', b.variable(IDS.varS1 as never), b.textLit('yes')),
    });
    expect(status).toBe(422);
    expect(envelopeCode(body)).toBe('validation_failed');
    expect(detailCodes(body)).toContain('LGC-T003');
    const list = await readJson(
      await listRules(req(`/api/v1/versions/${h.ids.draftA}/rules`), params({ id: h.ids.draftA })),
    );
    expect(list.body['data']).toEqual([]);
  });

  it('a non-boolean condition is 422 LGC-T033', async () => {
    const h = createHarness();
    asProgrammer(h);
    const b = astBuilder(1);
    const { status, body } = await createRule(h, { ...HIDE_Q12, condition: b.numLit(7) });
    expect(status).toBe(422);
    expect(detailCodes(body)).toContain('LGC-T033');
  });

  it('a target that is not a node of the version is 422, not a 500 in FK clothing', async () => {
    const h = createHarness();
    asProgrammer(h);
    const { status, body } = await createRule(h, {
      ...HIDE_Q12,
      target: { node_id: 'qst_01JC8KX9Q2M4V7ZB3F0T5NXXX0' },
      condition: condition(),
    });
    expect(status).toBe(422);
    expect(detailCodes(body)).toContain('unknown_target');
  });

  it('refuses writes on a frozen version with 409', async () => {
    const h = createHarness();
    asProgrammer(h);
    const frozen = h.data.seedVersionAt({
      orgId: h.ids.orgA,
      surveyId: h.ids.surveyA,
      versionNo: 7,
      status: 'production',
      createdBy: h.ids.ownerA,
    });
    const { status, body } = await readJson(
      await postRule(
        req(`/api/v1/versions/${frozen.id}/rules`, {
          method: 'POST',
          body: { ...HIDE_Q12, condition: condition() },
        }),
        params({ id: frozen.id }),
      ),
    );
    expect(status).toBe(409);
    expect(envelopeCode(body)).toBe('frozen_version');
  });

  it('reviewer can read but not write; another org sees 404', async () => {
    const h = createHarness();
    asProgrammer(h);
    await createRule(h, { ...HIDE_Q12, condition: condition() });

    h.as({ userId: h.ids.reviewerA, activeOrgId: h.ids.orgA });
    const read = await readJson(
      await listRules(req(`/api/v1/versions/${h.ids.draftA}/rules`), params({ id: h.ids.draftA })),
    );
    expect(read.status).toBe(200);
    expect((read.body['data'] as unknown[]).length).toBe(1);
    const write = await readJson(
      await postRule(
        req(`/api/v1/versions/${h.ids.draftA}/rules`, { method: 'POST', body: { ...HIDE_Q12, condition: condition() } }),
        params({ id: h.ids.draftA }),
      ),
    );
    expect(write.status).toBe(403);

    h.as({ userId: h.ids.ownerB, activeOrgId: h.ids.orgB });
    const crossOrg = await readJson(
      await listRules(req(`/api/v1/versions/${h.ids.draftA}/rules`), params({ id: h.ids.draftA })),
    );
    expect(crossOrg.status).toBe(404);
  });
});

/* ========================================================================== */
/* POST — the source path                                                     */
/* ========================================================================== */

describe('POST /api/v1/versions/:id/rules (ResScript source)', () => {
  it('parses the statement, derives kind/target/effect, stores the AST and marks it dsl', async () => {
    const h = createHarness();
    asProgrammer(h);
    const { status, body } = await createRule(h, {
      source: '# the screener gate\nIF S1 = 1 AND AGE >= 18 THEN HIDE Q12\n',
    });
    expect(status).toBe(201);
    const rule = body['rule'] as Record<string, unknown>;
    expect(rule['kind']).toBe('display');
    expect(rule['authored_in']).toBe('dsl');
    expect(rule['target_node_id']).toBe(IDS.questionQ12);
    expect((rule['effect'] as Record<string, unknown>)['action']).toBe('hide');
    // The closure comes from the PARSED AST — the same two variables the AST path computes.
    expect(rule['depends_on_variable_ids']).toEqual(
      expect.arrayContaining([IDS.varS1, IDS.varAge]),
    );
    // D §6.4: the comment survives, in the trivia the row stores for DSL-authored rules.
    expect((rule['trivia'] as Record<string, unknown>)['leading']).toEqual(['# the screener gate']);
  });

  it('a TERMINATE statement takes its target from the body, since the text names none', async () => {
    const h = createHarness();
    asProgrammer(h);
    const missing = await createRule(h, { source: 'IF S1 = 1 THEN TERMINATE AS SCREENOUT\n' });
    expect(missing.status).toBe(422);
    expect(detailCodes(missing.body)).toContain('target_required');

    const { status, body } = await createRule(h, {
      source: 'IF S1 = 1 THEN TERMINATE AS SCREENOUT\n',
      target: { node_id: IDS.page1 },
    });
    expect(status).toBe(201);
    const rule = body['rule'] as Record<string, unknown>;
    expect(rule['kind']).toBe('terminate');
    expect(rule['target_node_id']).toBe(IDS.page1);
    expect((rule['effect'] as Record<string, unknown>)['disposition']).toBe('SCREENOUT');
  });

  it('refuses what a rule row cannot hold — ELSE and multi-effect — naming the construct', async () => {
    const h = createHarness();
    asProgrammer(h);
    const withElse = await createRule(h, {
      source: 'IF S1 = 1 THEN HIDE Q12 ELSE SHOW Q12\n',
    });
    expect(withElse.status).toBe(422);
    expect(detailCodes(withElse.body)).toContain('else_not_storable');

    const twoEffects = await createRule(h, {
      source: 'IF S1 = 1 THEN HIDE Q12 AND REQUIRE Q5\n',
    });
    expect(twoEffects.status).toBe(422);
    expect(detailCodes(twoEffects.body)).toContain('one_effect');
  });

  it('unparseable source is 422 with the RSL diagnostic code', async () => {
    const h = createHarness();
    asProgrammer(h);
    const { status, body } = await createRule(h, { source: 'IF S1 === THEN\n' });
    expect(status).toBe(422);
    expect(envelopeCode(body)).toBe('validation_failed');
    expect(detailCodes(body).some((code) => code.startsWith('RSL-'))).toBe(true);
  });
});

/* ========================================================================== */
/* GET — the two questions, as filters                                        */
/* ========================================================================== */

describe('GET /api/v1/versions/:id/rules filters', () => {
  async function seedThree(h: Harness): Promise<void> {
    const b1 = astBuilder(1);
    await createRule(h, {
      ...HIDE_Q12,
      condition: b1.cmp('==', b1.variable(IDS.varS1 as never), b1.enumLit(1, DOM_S1 as never)),
    });
    const b2 = astBuilder(1);
    await createRule(h, {
      kind: 'validate',
      target: { node_id: IDS.questionQ5 },
      effect: { action: 'require' },
      condition: b2.cmp('>=', b2.variable(IDS.varAge as never), b2.numLit(18)),
    });
    const b3 = astBuilder(1);
    await createRule(h, {
      kind: 'skip',
      target: { node_id: IDS.page2 },
      effect: { action: 'skip_to', target_id: IDS.page2 },
      condition: b3.probe('answered', { kind: 'question', id: IDS.questionQ5 as never }),
    });
  }

  it('answers "what affects Q12" by target and "what does S1/Q5 affect" by the closure', async () => {
    const h = createHarness();
    asProgrammer(h);
    await seedThree(h);
    const base = `/api/v1/versions/${h.ids.draftA}/rules`;

    const byTarget = await readJson(
      await listRules(req(`${base}?target_node_id=${IDS.questionQ12}`), params({ id: h.ids.draftA })),
    );
    expect((byTarget.body['data'] as { kind: string }[]).map((r) => r.kind)).toEqual(['display']);

    const byVariable = await readJson(
      await listRules(req(`${base}?depends_on_variable_id=${IDS.varS1}`), params({ id: h.ids.draftA })),
    );
    expect((byVariable.body['data'] as { kind: string }[]).map((r) => r.kind)).toEqual(['display']);

    const byNode = await readJson(
      await listRules(req(`${base}?depends_on_node_id=${IDS.questionQ5}`), params({ id: h.ids.draftA })),
    );
    expect((byNode.body['data'] as { kind: string }[]).map((r) => r.kind)).toEqual(['skip']);

    const byKind = await readJson(
      await listRules(req(`${base}?kind=validate`), params({ id: h.ids.draftA })),
    );
    expect((byKind.body['data'] as { kind: string }[]).map((r) => r.kind)).toEqual(['validate']);
  });

  it('GET /variables/:id/usages returns the rules reading the variable, 404 elsewhere', async () => {
    const h = createHarness();
    asProgrammer(h);
    await seedThree(h);
    const { status, body } = await readJson(
      await getUsages(req(`/api/v1/variables/${IDS.varAge}/usages`), params({ id: IDS.varAge })),
    );
    expect(status).toBe(200);
    expect((body['rules'] as { kind: string }[]).map((r) => r.kind)).toEqual(['validate']);
    // The documented shape, with the honest empty arrays present (see the route header).
    expect(body['quotas']).toEqual([]);
    expect(body['masks']).toEqual([]);

    h.as({ userId: h.ids.ownerB, activeOrgId: h.ids.orgB });
    const crossOrg = await readJson(
      await getUsages(req(`/api/v1/variables/${IDS.varAge}/usages`), params({ id: IDS.varAge })),
    );
    expect(crossOrg.status).toBe(404);
  });
});

/* ========================================================================== */
/* PATCH and DELETE                                                            */
/* ========================================================================== */

describe('PATCH and DELETE /api/v1/rules/:id', () => {
  it('replacing the condition recomputes the closure; notes edits leave it alone', async () => {
    const h = createHarness();
    asProgrammer(h);
    const created = await createRule(h, { ...HIDE_Q12, condition: condition() });
    const id = (created.body['rule'] as { id: string }).id;

    const noteEdit = await readJson(
      await patchRule(req(`/api/v1/rules/${id}`, { method: 'PATCH', body: { notes: 'why' } }), params({ id })),
    );
    expect(noteEdit.status).toBe(200);
    expect((noteEdit.body['rule'] as Record<string, unknown>)['depends_on_variable_ids']).toEqual([
      IDS.varS1,
      IDS.varAge,
    ]);

    const b = astBuilder(1);
    const conditionEdit = await readJson(
      await patchRule(
        req(`/api/v1/rules/${id}`, {
          method: 'PATCH',
          body: { condition: b.cmp('<', b.variable(IDS.varAge as never), b.numLit(65)) },
        }),
        params({ id }),
      ),
    );
    expect(conditionEdit.status).toBe(200);
    const rule = conditionEdit.body['rule'] as Record<string, unknown>;
    expect(rule['depends_on_variable_ids']).toEqual([IDS.varAge]);
    // A hand-supplied AST makes it a visual rule again, and the DSL trivia is gone with it.
    expect(rule['authored_in']).toBe('visual');
  });

  it('PATCH {source} re-parses, re-derives and re-marks dsl — the "edited in ResScript" leg', async () => {
    const h = createHarness();
    asProgrammer(h);
    const created = await createRule(h, { ...HIDE_Q12, condition: condition() });
    const id = (created.body['rule'] as { id: string }).id;

    const { status, body } = await readJson(
      await patchRule(
        req(`/api/v1/rules/${id}`, { method: 'PATCH', body: { source: 'IF Q5 CONTAINS 1 THEN SHOW Q12\n' } }),
        params({ id }),
      ),
    );
    expect(status).toBe(200);
    const rule = body['rule'] as Record<string, unknown>;
    expect(rule['authored_in']).toBe('dsl');
    expect((rule['effect'] as Record<string, unknown>)['action']).toBe('show');
    expect(rule['depends_on_variable_ids']).toEqual([IDS.varQ5]);
  });

  it('DELETE is soft: 204, gone from the list, gone from GET', async () => {
    const h = createHarness();
    asProgrammer(h);
    const created = await createRule(h, { ...HIDE_Q12, condition: condition() });
    const id = (created.body['rule'] as { id: string }).id;

    const removed = await deleteRule(req(`/api/v1/rules/${id}`, { method: 'DELETE' }), params({ id }));
    expect(removed.status).toBe(204);
    const list = await readJson(
      await listRules(req(`/api/v1/versions/${h.ids.draftA}/rules`), params({ id: h.ids.draftA })),
    );
    expect(list.body['data']).toEqual([]);
    const read = await readJson(await getRule(req(`/api/v1/rules/${id}`), params({ id })));
    expect(read.status).toBe(404);
    // Soft: the row is still in the store with deleted_at set (the editor's undo buffer).
    expect(h.data.rules.find((r) => r.id === id)?.deleted_at).not.toBeNull();
  });
});

/* ========================================================================== */
/* The picker-backing reads                                                    */
/* ========================================================================== */

describe('GET /versions/:id/variables and /versions/:id/tree', () => {
  it('serve what the builder pickers need, in registry order', async () => {
    const h = createHarness();
    h.as({ userId: h.ids.reviewerA, activeOrgId: h.ids.orgA });
    const variables = await readJson(
      await getVariables(req(`/api/v1/versions/${h.ids.draftA}/variables`), params({ id: h.ids.draftA })),
    );
    expect(variables.status).toBe(200);
    const names = (variables.body['data'] as { name: string; vtype: string }[]).map((v) => v.name);
    expect(names).toEqual(['S1', 'Q5', 'AGE', 'HEAVY_BUYER']);

    const tree = await readJson(
      await getTree(req(`/api/v1/versions/${h.ids.draftA}/tree?fields=summary`), params({ id: h.ids.draftA })),
    );
    expect(tree.status).toBe(200);
    const kinds = (tree.body['data'] as { kind: string }[]).map((n) => n.kind);
    expect(kinds).toContain('question');
    expect(kinds).toContain('page');

    h.as({ userId: h.ids.ownerB, activeOrgId: h.ids.orgB });
    const crossOrg = await readJson(
      await getVariables(req(`/api/v1/versions/${h.ids.draftA}/variables`), params({ id: h.ids.draftA })),
    );
    expect(crossOrg.status).toBe(404);
  });
});
