/**
 * What the redirect checks must get right.
 *
 * The pair that carries `CMP-0300` is the reachable `SCREENOUT` with no redirect (error) against the
 * reachable `ABANDONED` with no redirect (silent). The second is the whole reason
 * `REDIRECT_REQUIRED_DISPOSITIONS` is imported rather than restated, and if it ever starts
 * reporting, the exemption has been re-implemented locally and gone stale.
 *
 * The precedence claim is asserted through the case that distinguishes it from "any map carries
 * it": a disposition present only in `by_vendor` for one vendor is still missing, and `detail`
 * names the vendor-less contexts. A check that treated coverage as "some map has it" passes every
 * other test in this file.
 *
 * Diagnostics are asserted by code and `detail`, never by message prose.
 */

import { describe, expect, it } from 'vitest';
import type {
  Disposition,
  Expr as SchemaExpr,
  FlowNode,
  IdFactory,
  LogicRule,
  PageNode,
  QuestionNode,
  Redirects,
  Survey,
  Variable,
  Vendor,
} from '@resscript/schema';
import { astBuilder, type Expr } from '@resscript/logic';

import { deterministicIds } from '../../../schema/src/__fixtures__/mini.js';
import type { CompileDiagnostic } from '../diagnostics.js';
import { buildFlowGraph } from '../flow.js';
import { buildRules } from '../rules.js';
import { buildTypeEnvFor } from '../registry.js';
import { analyzeRedirects } from './redirects.js';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

interface Spec {
  /** Extra terminal nodes, hung off the sequence node so they are all reachable. */
  readonly terminals?: readonly FlowNode[];
  readonly redirects?: Redirects;
  readonly vendors?: readonly Vendor[];
  readonly languages?: readonly string[];
  readonly rules?: readonly LogicRule[];
  readonly variables?: readonly Variable[];
}

function run(spec: Spec): readonly CompileDiagnostic[] {
  const ids = deterministicIds();
  const question: QuestionNode = {
    id: ids.next('question'),
    type: 'question',
    ref: 'Q1',
    question_type: 'numeric',
    label: { key: 'q1.label' },
    required: false,
  };
  const p: PageNode = { id: ids.next('page'), type: 'page', ref: 'P1', children: [question] };
  const blockId = ids.next('block');
  const startId = ids.next('flow_node');
  const seqId = ids.next('flow_node');
  const endId = ids.next('flow_node');

  // Every declared terminal is a successor of the branch below, so `graph.reachable` holds them
  // all: this file is about coverage, not about reachability, and an unreachable terminal would
  // silently make a test vacuous.
  const terminals = spec.terminals ?? [];
  const branchId = ids.next('flow_node');

  const survey: Survey = {
    meta: { id: ids.next('survey'), ref: 'REDIR', name: 'Redirect fixture' },
    schema_version: 2,
    settings: {
      navigation: { back_allowed: true },
      resume: { enabled: false, window_s: 3600, position: 'last_page' },
      progress_bar: { mode: 'none' },
      screenout: { show_message: false },
    },
    languages: {
      base: 'en',
      available: (spec.languages ?? ['en']).map((code) => ({ code })),
      bundles: Object.fromEntries((spec.languages ?? ['en']).map((code) => [code, {}])),
      policy: { on_missing: 'fallback_to_base', block_publish_if_incomplete: false },
    },
    variables: spec.variables ?? [],
    content: [{ id: blockId, type: 'block', ref: 'B1', children: [p] }],
    flow: {
      nodes: [
        { id: startId, type: 'start', next: seqId },
        { id: seqId, type: 'sequence', target_id: p.id, next: branchId },
        {
          id: branchId,
          type: 'branch',
          branches: [
            ...terminals.map((node) => ({ condition: TRUE, next: node.id })),
            { condition: null, next: endId },
          ],
        },
        ...terminals,
        { id: endId, type: 'end', disposition: 'COMPLETE' },
      ],
    },
    logic_rules: spec.rules ?? [],
    ...(spec.redirects === undefined ? {} : { redirects: spec.redirects }),
    ...(spec.vendors === undefined ? {} : { vendors: spec.vendors }),
  };

  const env = buildTypeEnvFor(survey).env;
  const graph = buildFlowGraph(survey);
  const rules = buildRules(survey, graph, env).rules;
  return analyzeRedirects({ survey, graph, rules });
}

function toSchema(expression: Expr): SchemaExpr {
  return expression as unknown as SchemaExpr;
}

const TRUE = toSchema(astBuilder().boolLit(true));

function termination(ids: IdFactory, disposition: Disposition, customKey?: string): FlowNode {
  return {
    id: ids.next('flow_node'),
    type: 'termination',
    disposition,
    ...(customKey === undefined ? {} : { custom_key: customKey }),
  };
}

/** Terminal nodes need ids from the same factory the survey uses, so they are built lazily. */
function withTerminals(build: (ids: IdFactory) => readonly FlowNode[], spec: Spec = {}): Spec {
  // `deterministicIds` is seeded, so a second factory with the same seed yields the same ids as
  // the one inside `run` — which is exactly what would collide. A different seed keeps the
  // terminal ids distinct from the content ids.
  const ids = deterministicIds(4242);
  return { ...spec, terminals: build(ids) };
}

function codes(diagnostics: readonly CompileDiagnostic[]): readonly string[] {
  return diagnostics.map((d) => d.code);
}

function detailOf(
  diagnostics: readonly CompileDiagnostic[],
  code: string,
): { readonly [key: string]: unknown } {
  const found = diagnostics.find((d) => d.code === code);
  if (found?.detail === undefined) throw new Error(`no ${code} with detail`);
  return found.detail;
}

const COMPLETE_ONLY: Redirects = { default: { COMPLETE: 'https://panel.example/complete' } };

/* -------------------------------------------------------------------------- */
/* CMP-0300                                                                    */
/* -------------------------------------------------------------------------- */

describe('a reachable termination with nowhere to send the respondent', () => {
  it('reports SCREENOUT with no redirect', () => {
    const diagnostics = run(
      withTerminals((ids) => [termination(ids, 'SCREENOUT')], { redirects: COMPLETE_ONLY }),
    );

    expect(codes(diagnostics)).toEqual(['CMP-0300']);
    expect(diagnostics[0]?.severity).toBe('error');
    expect(diagnostics[0]?.path).toBe('/redirects/default/SCREENOUT');
    const detail = detailOf(diagnostics, 'CMP-0300');
    expect(detail['disposition']).toBe('SCREENOUT');
    expect(detail['reason']).toBe('no_redirect_configured');
    expect(detail['reached_by']).toBe('flow');
    expect((detail['flow_node_ids'] as readonly string[]).length).toBe(1);
  });

  it('stays silent for a reachable ABANDONED, which needs no redirect', () => {
    // `DISPOSITION_FACTS.ABANDONED.redirect_required` is false because the respondent is gone.
    // A local `if` would have to restate that, and this is the test that would not notice.
    const diagnostics = run(
      withTerminals((ids) => [termination(ids, 'ABANDONED'), termination(ids, 'TIMED_OUT')], {
        redirects: COMPLETE_ONLY,
      }),
    );

    expect(diagnostics).toEqual([]);
  });

  it('reports a terminate rule the same way it reports a termination node', () => {
    const diagnostics = run({
      redirects: COMPLETE_ONLY,
      rules: [
        {
          id: 'rul_quality',
          kind: 'terminate',
          target: { type: 'survey' },
          condition: TRUE,
          effect: { action: 'terminate', disposition: 'QUALITY' },
        } as LogicRule,
      ],
    });

    expect(codes(diagnostics)).toEqual(['CMP-0300']);
    const detail = detailOf(diagnostics, 'CMP-0300');
    expect(detail['disposition']).toBe('QUALITY');
    expect(detail['rule_ids']).toEqual(['rul_quality']);
  });

  it('counts a disposition covered only for one vendor as still missing', () => {
    const ids = deterministicIds(7);
    const vendor: Vendor = {
      id: ids.next('vendor'),
      ref: 'lucid',
      name: 'Lucid',
      inbound_params: [],
    };
    const diagnostics = run(
      withTerminals((terminalIds) => [termination(terminalIds, 'SCREENOUT')], {
        vendors: [vendor],
        languages: ['en', 'fr'],
        redirects: {
          default: { COMPLETE: 'https://panel.example/complete' },
          by_vendor: { lucid: { SCREENOUT: 'https://lucid.example/so' } },
        },
      }),
    );

    expect(codes(diagnostics)).toEqual(['CMP-0300']);
    const detail = detailOf(diagnostics, 'CMP-0300');
    expect(detail['reason']).toBe('not_covered_for_every_respondent');
    // Two vendors (lucid and no vendor) x two languages = four contexts; the two lucid ones
    // resolve, the two vendor-less ones do not.
    expect(detail['context_count']).toBe(4);
    expect(detail['uncovered_context_count']).toBe(2);
    expect(detail['uncovered_contexts']).toEqual([
      { vendor_ref: null, language: 'en' },
      { vendor_ref: null, language: 'fr' },
    ]);
  });

  it('accepts a disposition carried by every declared language even with no default', () => {
    const diagnostics = run(
      withTerminals((ids) => [termination(ids, 'SCREENOUT')], {
        languages: ['en', 'fr'],
        redirects: {
          default: { COMPLETE: 'https://panel.example/complete' },
          by_language: {
            en: { SCREENOUT: 'https://panel.example/so-en' },
            fr: { SCREENOUT: 'https://panel.example/so-fr' },
          },
        },
      }),
    );

    expect(diagnostics).toEqual([]);
  });

  it('reports a CUSTOM termination whose key no map carries', () => {
    const diagnostics = run(
      withTerminals((ids) => [termination(ids, 'CUSTOM', 'sponsor_optout')], {
        redirects: {
          default: {
            COMPLETE: 'https://panel.example/complete',
            CUSTOM: { other_key: 'https://panel.example/other' },
          },
        },
      }),
    );

    expect(codes(diagnostics)).toEqual(['CMP-0300']);
    expect(diagnostics[0]?.path).toBe('/redirects/default/CUSTOM/sponsor_optout');
    const detail = detailOf(diagnostics, 'CMP-0300');
    expect(detail['disposition']).toBe('CUSTOM');
    expect(detail['custom_key']).toBe('sponsor_optout');
    expect(detail['reason']).toBe('no_redirect_configured');
  });

  it('reports a CUSTOM termination that declares no key at all', () => {
    const diagnostics = run(
      withTerminals((ids) => [termination(ids, 'CUSTOM')], {
        redirects: {
          default: {
            COMPLETE: 'https://panel.example/complete',
            CUSTOM: { anything: 'https://panel.example/anything' },
          },
        },
      }),
    );

    expect(codes(diagnostics)).toEqual(['CMP-0300']);
    expect(detailOf(diagnostics, 'CMP-0300')['reason']).toBe('custom_key_absent');
  });

  it('is silent when every reachable disposition resolves through default', () => {
    const diagnostics = run(
      withTerminals(
        (ids) => [termination(ids, 'SCREENOUT'), termination(ids, 'QUOTA_FULL')],
        {
          redirects: {
            default: {
              COMPLETE: 'https://panel.example/c',
              SCREENOUT: 'https://panel.example/s',
              QUOTA_FULL: 'https://panel.example/q',
            },
          },
        },
      ),
    );

    expect(diagnostics).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* CMP-0301                                                                    */
/* -------------------------------------------------------------------------- */

describe('a redirect template that pipes personal data', () => {
  function withVariables(redirects: Redirects, pii: boolean): readonly CompileDiagnostic[] {
    const ids = deterministicIds(31);
    const openEnd: Variable = {
      id: ids.next('variable'),
      name: 'Q9_other',
      kind: 'response',
      type: 'text',
      export: { include: true, column: 'Q9_other' },
      pii,
      persist: true,
    };
    const token: Variable = {
      id: ids.next('variable'),
      name: 'RID',
      kind: 'hidden',
      type: 'text',
      export: { include: true, column: 'RID' },
      pii: false,
      persist: true,
    };
    return run({ redirects, variables: [openEnd, token] });
  }

  const PIPED: Redirects = {
    default: {
      COMPLETE: 'https://panel.example/c?rid={{RID}}&verbatim={{Q9_other}}',
    },
  };

  it('reports an open-end interpolated into a vendor callback URL', () => {
    const diagnostics = withVariables(PIPED, true);

    expect(codes(diagnostics)).toEqual(['CMP-0301']);
    expect(diagnostics[0]?.severity).toBe('error');
    expect(diagnostics[0]?.path).toBe('/redirects/default/COMPLETE');
    const detail = detailOf(diagnostics, 'CMP-0301');
    expect(detail['variable_name']).toBe('Q9_other');
    expect(detail['placeholder']).toBe('{{Q9_other}}');
    expect(detail['disposition']).toBe('COMPLETE');
    expect(detail['scope']).toBe('default');
    expect(detail['matched_case_insensitively']).toBe(false);
  });

  it('says nothing about the same template when the variable is not pii', () => {
    expect(withVariables(PIPED, false)).toEqual([]);
  });

  it('resolves a case variant rather than letting it through', () => {
    const diagnostics = withVariables(
      { default: { COMPLETE: 'https://panel.example/c?v={{q9_OTHER}}' } },
      true,
    );

    expect(codes(diagnostics)).toEqual(['CMP-0301']);
    const detail = detailOf(diagnostics, 'CMP-0301');
    expect(detail['variable_name']).toBe('Q9_other');
    expect(detail['matched_case_insensitively']).toBe(true);
  });

  it('reads a dotted placeholder as a reference to its root variable', () => {
    const diagnostics = withVariables(
      { default: { COMPLETE: 'https://panel.example/c?v={{ Q9_other.label }}' } },
      true,
    );

    expect(codes(diagnostics)).toEqual(['CMP-0301']);
    expect(detailOf(diagnostics, 'CMP-0301')['variable_name']).toBe('Q9_other');
  });

  it('checks by_vendor, by_language and CUSTOM templates too', () => {
    const diagnostics = withVariables(
      {
        default: { COMPLETE: 'https://panel.example/c' },
        by_vendor: { lucid: { SCREENOUT: 'https://lucid.example/s?v={{Q9_other}}' } },
        by_language: { fr: { CUSTOM: { optout: 'https://panel.example/o?v={{Q9_other}}' } } },
      },
      true,
    );

    expect(codes(diagnostics)).toEqual(['CMP-0301', 'CMP-0301']);
    const paths = diagnostics.map((d) => d.path).sort();
    expect(paths).toEqual([
      '/redirects/by_language/fr/CUSTOM/optout',
      '/redirects/by_vendor/lucid/SCREENOUT',
    ]);
    const scopes = diagnostics.map((d) => d.detail?.['scope']).sort();
    expect(scopes).toEqual(['by_language', 'by_vendor']);
  });

  it('says nothing about a placeholder that names no variable', () => {
    expect(
      withVariables({ default: { COMPLETE: 'https://panel.example/c?v={{NOT_A_VARIABLE}}' } }, true),
    ).toEqual([]);
  });
});
