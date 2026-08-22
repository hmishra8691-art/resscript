/**
 * The two panels 03 §7 centralized the rule registry to make cheap (roadmap P1-12):
 *
 *  - **"What affects this question?"** — rules whose TARGET is the node:
 *    `GET /versions/:id/rules?target_node_id=…`, the `rules_target_node_idx` lookup.
 *  - **"What does this question affect?"** — rules that READ it: the union of
 *    `GET /variables/:id/usages` for each variable the question emits (the
 *    `rules_depends_var_gin` lookup) and `GET /versions/:id/rules?depends_on_node_id=…` for
 *    probes that name the question itself (`rules_depends_node_gin`). Two indexes because a
 *    rule can read a question two ways — through its variable (`Q3 = 1`) or through a probe
 *    (`ANSWERED(QUESTION Q3)`) — and answering from only one would silently miss the other.
 *
 * Both lists render each rule through the same one-line summary the rule list uses, so "the
 * same rule" LOOKS the same in every pane.
 */

'use client';

import { useEffect, useState } from 'react';
import { ApiError, apiFetch, type PageEnvelope } from '@/lib/api-client';
import type { RuleView, VariableUsagesView } from '@/lib/api-types';

export interface RuleNames {
  variableName(id: string): string;
  nodeRef(id: string): string;
}

/** One rule, one line: kind, target, what it reads. Shared by both panels and the rule list. */
export function ruleSummary(rule: RuleView, names: RuleNames): string {
  const target =
    rule.target_node_id !== null
      ? names.nodeRef(rule.target_node_id)
      : rule.target_variable_id !== null
        ? names.variableName(rule.target_variable_id)
        : rule.target_item_id ?? '?';
  const action = typeof rule.effect['action'] === 'string' ? (rule.effect['action'] as string) : rule.kind;
  const reads = rule.depends_on_variable_ids.map((id) => names.variableName(id)).join(', ');
  return `${action} ${target}${reads === '' ? '' : ` when ${reads}`}`;
}

interface PanelState {
  readonly rules: readonly RuleView[] | null;
  readonly error: string | null;
}

function useRuleFetch(fetchRules: () => Promise<readonly RuleView[]>, deps: readonly unknown[]): PanelState {
  const [state, setState] = useState<PanelState>({ rules: null, error: null });
  useEffect(() => {
    let cancelled = false;
    setState({ rules: null, error: null });
    fetchRules()
      .then((rules) => {
        if (!cancelled) setState({ rules, error: null });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setState({ rules: null, error: err instanceof ApiError ? `${err.code}: ${err.message}` : String(err) });
        }
      });
    return () => {
      cancelled = true;
    };
    // The caller's deps ARE the query key; the closure is rebuilt with them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps as unknown[]);
  return state;
}

function RuleList({
  state,
  names,
  emptyText,
  testId,
}: {
  readonly state: PanelState;
  readonly names: RuleNames;
  readonly emptyText: string;
  readonly testId: string;
}): React.JSX.Element {
  if (state.error !== null) {
    return (
      <p role="alert" className="rs-muted">
        {state.error}
      </p>
    );
  }
  if (state.rules === null) return <p className="rs-muted">Loading…</p>;
  if (state.rules.length === 0) return <p className="rs-muted">{emptyText}</p>;
  return (
    <ul data-testid={testId}>
      {state.rules.map((rule) => (
        <li key={rule.id}>
          <span className="rs-chip">{rule.kind}</span> {ruleSummary(rule, names)}
          {rule.notes === null ? null : <span className="rs-muted"> — {rule.notes}</span>}
        </li>
      ))}
    </ul>
  );
}

export interface AffectsPanelProps {
  readonly versionId: string;
  readonly nodeId: string;
  readonly nodeRef: string;
  readonly names: RuleNames;
}

/** "What affects Q12?" — every rule targeting the node. */
export function WhatAffectsPanel({ versionId, nodeId, nodeRef, names }: AffectsPanelProps): React.JSX.Element {
  const state = useRuleFetch(
    async () =>
      (
        await apiFetch<PageEnvelope<RuleView>>(
          `/versions/${versionId}/rules?target_node_id=${encodeURIComponent(nodeId)}`,
        )
      ).data.data,
    [versionId, nodeId],
  );
  return (
    <section aria-label={`What affects ${nodeRef}`} className="rs-card">
      <h3 style={{ fontSize: 13 }}>What affects {nodeRef}?</h3>
      <RuleList state={state} names={names} emptyText="No rule targets it." testId="affects-list" />
    </section>
  );
}

export interface AffectedByPanelProps extends AffectsPanelProps {
  /** The variables the question emits — each one queried through the var-GIN usages read. */
  readonly variableIds: readonly string[];
}

/** "What does Q3 affect?" — every rule that reads its variables or probes the node itself. */
export function WhatDoesItAffectPanel(props: AffectedByPanelProps): React.JSX.Element {
  const { versionId, nodeId, nodeRef, names, variableIds } = props;
  const state = useRuleFetch(
    async () => {
      const [byNode, ...byVariable] = await Promise.all([
        apiFetch<PageEnvelope<RuleView>>(
          `/versions/${versionId}/rules?depends_on_node_id=${encodeURIComponent(nodeId)}`,
        ).then((r) => r.data.data),
        ...variableIds.map(async (id) =>
          apiFetch<VariableUsagesView>(`/variables/${id}/usages`).then((r) => r.data.rules),
        ),
      ]);
      const merged = new Map<string, RuleView>();
      for (const rule of [...(byNode ?? []), ...byVariable.flat()]) merged.set(rule.id, rule);
      return [...merged.values()];
    },
    [versionId, nodeId, variableIds.join(',')],
  );
  return (
    <section aria-label={`What does ${nodeRef} affect`} className="rs-card">
      <h3 style={{ fontSize: 13 }}>What does {nodeRef} affect?</h3>
      <RuleList
        state={state}
        names={names}
        emptyText="Nothing reads it — no rule depends on this question."
        testId="affected-by-list"
      />
    </section>
  );
}
