/**
 * The two panels, against a faked API keyed by URL — asserting which QUERY each panel makes,
 * because that is the panels' whole contract: "what affects" is the target filter, "what does
 * it affect" is the union of the variable-usages read (var GIN) and the depends-on-node filter
 * (node GIN), deduped by rule id.
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RuleView } from '@/lib/api-types';
import { WhatAffectsPanel, WhatDoesItAffectPanel, ruleSummary } from '../AffectsPanels';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function rule(partial: Partial<RuleView> & { readonly id: string }): RuleView {
  return {
    survey_version_id: 'sv_1',
    kind: 'display',
    target_kind: 'node',
    target_node_id: 'qst_q12',
    target_item_id: null,
    target_variable_id: null,
    condition: { op: 'lit', n: 1, v: { k: 'bool', v: true } },
    effect: { action: 'hide' },
    evaluation: 'on_change',
    authored_in: 'visual',
    trivia: {},
    notes: null,
    depends_on_variable_ids: ['var_s1'],
    depends_on_node_ids: [],
    sort_key: 'a0',
    created_at: '2026-08-20T12:00:00Z',
    updated_at: '2026-08-20T12:00:00Z',
    ...partial,
  };
}

const NAMES = {
  variableName: (id: string): string => (id === 'var_s1' ? 'S1' : id),
  nodeRef: (id: string): string => (id === 'qst_q12' ? 'Q12' : id === 'pg_2' ? 'P2' : id),
};

function page(rules: readonly RuleView[]): unknown {
  return { data: rules, page: { next_cursor: null, has_more: false, limit: 50 } };
}

function stubApi(routes: Readonly<Record<string, unknown>>): () => string[] {
  const seen: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      seen.push(url);
      const hit = Object.entries(routes).find(([key]) => url.includes(key));
      return new Response(JSON.stringify(hit?.[1] ?? { error: { code: 'not_found' } }), {
        status: hit === undefined ? 404 : 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  return () => seen;
}

describe('ruleSummary', () => {
  it('says action, target and reads — by NAME, never id', () => {
    const summary = ruleSummary(rule({ id: 'rul_1' }), NAMES);
    expect(summary).toBe('hide Q12 when S1');
  });
});

describe('WhatAffectsPanel', () => {
  it('lists the rules TARGETING the node, from the target_node_id filter', async () => {
    const seen = stubApi({
      'target_node_id=qst_q12': page([rule({ id: 'rul_1', notes: 'screener gate' })]),
    });
    await act(async () => {
      render(<WhatAffectsPanel versionId="sv_1" nodeId="qst_q12" nodeRef="Q12" names={NAMES} />);
    });
    expect(await screen.findByTestId('affects-list')).toHaveTextContent('hide Q12 when S1');
    expect(screen.getByTestId('affects-list')).toHaveTextContent('screener gate');
    expect(seen().some((url) => url.includes('/versions/sv_1/rules?target_node_id=qst_q12'))).toBe(true);
  });
});

describe('WhatDoesItAffectPanel', () => {
  it('merges the usages read (per emitted variable) with the depends_on_node filter, deduped', async () => {
    const shared = rule({ id: 'rul_both', kind: 'skip', target_node_id: 'pg_2', effect: { action: 'skip_to' } });
    const seen = stubApi({
      'depends_on_node_id=qst_s1': page([shared]),
      '/variables/var_s1/usages': {
        variable_id: 'var_s1',
        survey_version_id: 'sv_1',
        rules: [shared, rule({ id: 'rul_var_only', kind: 'validate', effect: { action: 'require' } })],
        quotas: [],
        masks: [],
        pipes: [],
        redirects: [],
      },
    });
    await act(async () => {
      render(
        <WhatDoesItAffectPanel
          versionId="sv_1"
          nodeId="qst_s1"
          nodeRef="S1"
          names={NAMES}
          variableIds={['var_s1']}
        />,
      );
    });
    const list = await screen.findByTestId('affected-by-list');
    // Deduped: the rule found by BOTH indexes renders once.
    expect(list.querySelectorAll('li')).toHaveLength(2);
    expect(list).toHaveTextContent('skip_to P2');
    expect(list).toHaveTextContent('require Q12');
    const urls = seen();
    expect(urls.some((url) => url.includes('depends_on_node_id=qst_s1'))).toBe(true);
    expect(urls.some((url) => url.includes('/variables/var_s1/usages'))).toBe(true);
  });

  it('says so when nothing reads the question', async () => {
    stubApi({
      'depends_on_node_id=qst_s1': page([]),
    });
    await act(async () => {
      render(
        <WhatDoesItAffectPanel versionId="sv_1" nodeId="qst_s1" nodeRef="S1" names={NAMES} variableIds={[]} />,
      );
    });
    expect(await screen.findByText(/no rule depends on this question/i)).toBeInTheDocument();
  });
});
