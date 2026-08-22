/**
 * The Rules pane — P1-12's visual rule builder, wired the way the Preview pane was (P1-11).
 *
 * One pane, four regions: the rule list (the version's registry, filterable the way API §2.7
 * filters), the editor for the selected rule (condition tree + target picker + effect picker +
 * notes), the ResScript toggle, and the two "what affects / what does it affect" panels.
 *
 * ## Where parse and print run
 *
 * Server-side, deliberately: "view as ResScript" is `POST /v1/dsl/print` over the statement
 * this rule maps to, and "apply code" is `PATCH /rules/:id {source}` (or POST with `source` for
 * a new rule) — the same parse the API runs on any write. The client COULD parse in-process,
 * but only the server holds the full registry (items included, so `Q5.Alpha` resolves), and two
 * half-registries would give the editor and the API different opinions of the same text. The
 * price is a round trip per toggle, on an action a user takes a few times a minute at most.
 *
 * ## Effects offered
 *
 * The picker offers the kind/action pairs that BOTH the rules API accepts and the DSL prints
 * (show/hide, skip-to, require/unrequire, enable/disable, terminate). `set_variable` rules are
 * accepted by the API and render read-only here; authoring one is a code-mode task until the
 * value-expression editor exists — offering a half-built SET form would corrupt real rules.
 */

'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Expr } from '@resscript/logic';
import { astBuilder, isExprShape, renumber } from '@resscript/logic';
import { ApiError, apiFetch, type PageEnvelope } from '@/lib/api-client';
import type { RuleSaveView, RuleView, TreeNodeView, VariablePickView } from '@/lib/api-types';
import { statementFromRule } from '@/lib/rule-statement';
import { ruleSummary, WhatAffectsPanel, WhatDoesItAffectPanel } from './AffectsPanels';
import { ConditionTreeEditor } from './ConditionTreeEditor';
import type { LeafVariable } from './operators';
import { defaultLeaf, leafExpr } from './operators';
import { ExprView, type RenderCtx } from './renderers';

/* -------------------------------------------------------------------------- */
/* The effect table — what the builder offers                                  */
/* -------------------------------------------------------------------------- */

interface EffectChoice {
  readonly id: string;
  readonly kind: RuleView['kind'];
  readonly action: string;
  readonly label: string;
}

const EFFECT_CHOICES: readonly EffectChoice[] = [
  { id: 'show', kind: 'display', action: 'show', label: 'Show' },
  { id: 'hide', kind: 'display', action: 'hide', label: 'Hide' },
  { id: 'skip_to', kind: 'skip', action: 'skip_to', label: 'Skip to' },
  { id: 'require', kind: 'validate', action: 'require', label: 'Require' },
  { id: 'unrequire', kind: 'validate', action: 'unrequire', label: 'Make optional' },
  { id: 'enable', kind: 'option_state', action: 'enable', label: 'Enable' },
  { id: 'disable', kind: 'option_state', action: 'disable', label: 'Disable' },
  { id: 'terminate', kind: 'terminate', action: 'terminate', label: 'Terminate at' },
];

interface Draft {
  readonly ruleId: string | null;
  readonly effectId: string;
  readonly targetNodeId: string;
  readonly disposition: string;
  readonly notes: string;
  readonly condition: Expr;
  /** Set when the stored rule cannot be edited visually (a SET rule, an item target). */
  readonly readOnly: boolean;
}

export interface RulesPanelProps {
  readonly versionId: string;
}

export function RulesPanel({ versionId }: RulesPanelProps): React.JSX.Element {
  const [variables, setVariables] = useState<readonly VariablePickView[] | null>(null);
  const [nodes, setNodes] = useState<readonly TreeNodeView[] | null>(null);
  const [rules, setRules] = useState<readonly RuleView[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [panelNodeId, setPanelNodeId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      apiFetch<{ data: readonly VariablePickView[] }>(`/versions/${versionId}/variables`),
      apiFetch<{ data: readonly TreeNodeView[] }>(`/versions/${versionId}/tree?fields=summary`),
      apiFetch<PageEnvelope<RuleView>>(`/versions/${versionId}/rules`),
    ])
      .then(([vars, tree, list]) => {
        if (cancelled) return;
        setVariables(vars.data.data);
        setNodes(tree.data.data);
        setRules(list.data.data);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [versionId]);

  /* ---- names and the leaf-variable projection ---------------------------- */

  const leafVariables = useMemo((): readonly LeafVariable[] => {
    return (variables ?? []).map((v) => ({
      id: v.id,
      name: v.name,
      vtype: v.vtype,
      // The SAME domain identity the server's registry mapper synthesizes (dsl/registry.ts) —
      // a different one here would make the builder's own leaves fail the write-time check.
      ...(v.vtype === 'enum' || v.vtype === 'set' ? { domain: `dom_${v.source_question_id ?? v.id}` } : {}),
      // 0007 has no ordinal column yet (dsl/registry.ts's header) — so no ordered enum ops.
      ordinal: false,
      ...(v.enum_domain === null
        ? {}
        : { options: v.enum_domain.map((entry) => ({ code: entry.code, label: entry.label_key })) }),
    }));
  }, [variables]);

  const names = useMemo(() => {
    const variableName = new Map((variables ?? []).map((v) => [v.id, v.name]));
    const nodeRef = new Map((nodes ?? []).map((n) => [n.id, n.ref ?? n.id]));
    const optionLabels = new Map<string, string>();
    for (const v of variables ?? []) {
      const domain = `dom_${v.source_question_id ?? v.id}`;
      for (const entry of v.enum_domain ?? []) optionLabels.set(`${domain}:${String(entry.code)}`, entry.label_key);
    }
    return {
      variableName: (id: string): string => variableName.get(id) ?? id,
      nodeRef: (id: string): string => nodeRef.get(id) ?? id,
      optionLabel: (domain: string, code: number): string =>
        optionLabels.get(`${domain}:${String(code)}`) ?? String(code),
    };
  }, [variables, nodes]);

  const ctx = useMemo((): RenderCtx => {
    // Self-referential on purpose: recursion goes THROUGH the ctx, so the read-only renderer
    // and the tree editor share one recursion without a second registry lookup path.
    const self: RenderCtx = {
      variableName: names.variableName,
      nodeRef: names.nodeRef,
      optionLabel: names.optionLabel,
      child: (node: Expr) => <ExprView node={node} ctx={self} />,
    };
    return self;
  }, [names]);

  const targetNodes = useMemo(
    () => (nodes ?? []).filter((n) => n.kind === 'question' || n.kind === 'page' || n.kind === 'block'),
    [nodes],
  );
  const questionNodes = useMemo(() => (nodes ?? []).filter((n) => n.kind === 'question'), [nodes]);

  /* ---- draft plumbing ----------------------------------------------------- */

  const openRule = useCallback((rule: RuleView): void => {
    const condition = rule.condition as unknown;
    const effectAction = typeof rule.effect['action'] === 'string' ? (rule.effect['action'] as string) : '';
    const choice = EFFECT_CHOICES.find((c) => c.kind === rule.kind && c.action === effectAction);
    setSource(null);
    setError(null);
    setDraft({
      ruleId: rule.id,
      effectId: choice?.id ?? 'show',
      targetNodeId: rule.target_node_id ?? '',
      disposition: typeof rule.effect['disposition'] === 'string' ? (rule.effect['disposition'] as string) : '',
      notes: rule.notes ?? '',
      condition: isExprShape(condition) ? condition : astBuilder(1).boolLit(true),
      readOnly: choice === undefined || rule.target_node_id === null || !isExprShape(condition),
    });
  }, []);

  const newRule = useCallback((): void => {
    const firstVariable = leafVariables[0];
    const firstTarget = targetNodes[0];
    if (firstVariable === undefined || firstTarget === undefined) return;
    setSource(null);
    setError(null);
    setDraft({
      ruleId: null,
      effectId: 'show',
      targetNodeId: firstTarget.id,
      disposition: '',
      notes: '',
      condition: renumber(leafExpr(defaultLeaf(firstVariable), firstVariable, astBuilder(1)), 1),
      readOnly: false,
    });
  }, [leafVariables, targetNodes]);

  const refreshList = useCallback(async (): Promise<void> => {
    const list = await apiFetch<PageEnvelope<RuleView>>(`/versions/${versionId}/rules`);
    setRules(list.data.data);
  }, [versionId]);

  const run = useCallback(async (work: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (err: unknown) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  const save = useCallback(async (): Promise<void> => {
    if (draft === null || draft.readOnly) return;
    const choice = EFFECT_CHOICES.find((c) => c.id === draft.effectId);
    if (choice === undefined) return;
    const body = {
      kind: choice.kind,
      target: { node_id: draft.targetNodeId },
      condition: draft.condition,
      effect: {
        action: choice.action,
        ...(choice.action === 'skip_to' ? { target_id: draft.targetNodeId } : {}),
        ...(choice.action === 'terminate' && draft.disposition !== '' ? { disposition: draft.disposition } : {}),
      },
      ...(draft.notes === '' ? {} : { notes: draft.notes }),
    };
    await run(async () => {
      const saved =
        draft.ruleId === null
          ? await apiFetch<RuleSaveView>(`/versions/${versionId}/rules`, { method: 'POST', body })
          : await apiFetch<RuleSaveView>(`/rules/${draft.ruleId}`, {
              method: 'PATCH',
              // PATCH replaces the semantic fields wholesale — a rule is edited as a unit.
              body,
            });
      await refreshList();
      openRule(saved.data.rule);
    });
  }, [draft, versionId, run, refreshList, openRule]);

  const removeRule = useCallback(async (): Promise<void> => {
    if (draft === null || draft.ruleId === null) return;
    const id = draft.ruleId;
    await run(async () => {
      await apiFetch<void>(`/rules/${id}`, { method: 'DELETE' });
      setDraft(null);
      await refreshList();
    });
  }, [draft, run, refreshList]);

  /* ---- the ResScript round trip ------------------------------------------ */

  const viewAsCode = useCallback(async (): Promise<void> => {
    if (draft === null) return;
    const current = rules?.find((r) => r.id === draft.ruleId);
    const choice = EFFECT_CHOICES.find((c) => c.id === draft.effectId);
    // Print the DRAFT, not the stored row: what the author sees is what they are editing.
    const statement = statementFromRule(
      current !== undefined && draft.readOnly
        ? current
        : {
            kind: choice?.kind ?? 'display',
            target_node_id: draft.targetNodeId === '' ? null : draft.targetNodeId,
            target_variable_id: null,
            condition: draft.condition,
            effect: {
              action: choice?.action ?? 'show',
              ...(choice?.action === 'skip_to' ? { target_id: draft.targetNodeId } : {}),
              ...(choice?.action === 'terminate' && draft.disposition !== ''
                ? { disposition: draft.disposition }
                : {}),
            },
            ...(current === undefined ? {} : { trivia: current.trivia }),
          },
      {
        nodeRef: (id) => {
          const node = (nodes ?? []).find((n) => n.id === id);
          return node === undefined
            ? undefined
            : { ref: node.ref ?? id, kind: node.kind === 'text' ? 'question' : node.kind };
        },
        variableName: (id) => names.variableName(id),
      },
    );
    if (!statement.ok) {
      setError(statement.reason);
      return;
    }
    await run(async () => {
      const printed = await apiFetch<{ source: string }>(`/dsl/print`, {
        method: 'POST',
        body: { statements: [statement.statement], scope: { survey_version_id: versionId } },
      });
      setSource(printed.data.source);
    });
  }, [draft, rules, nodes, names, versionId, run]);

  const applyCode = useCallback(async (): Promise<void> => {
    if (draft === null || source === null) return;
    await run(async () => {
      const saved =
        draft.ruleId === null
          ? await apiFetch<RuleSaveView>(`/versions/${versionId}/rules`, {
              method: 'POST',
              body: { source, target: { node_id: draft.targetNodeId } },
            })
          : await apiFetch<RuleSaveView>(`/rules/${draft.ruleId}`, { method: 'PATCH', body: { source } });
      await refreshList();
      // Reopen from the SAVED row: the acceptance criterion is that this reopened rule is the
      // same rule, and reopening from anything but the stored AST would beg that question.
      openRule(saved.data.rule);
    });
  }, [draft, source, versionId, run, refreshList, openRule]);

  /* ---- render -------------------------------------------------------------- */

  if (error !== null && rules === null) return <p role="alert">{error}</p>;
  if (variables === null || nodes === null || rules === null) {
    return <p className="rs-muted">Loading rules…</p>;
  }

  const selectedPanelNode =
    questionNodes.find((n) => n.id === panelNodeId) ?? questionNodes[0] ?? null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }} data-testid="rules-panel">
      {error === null ? null : (
        <p role="alert" className="rs-alert">
          {error}
        </p>
      )}

      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        {/* The rule list */}
        <section aria-label="Rules" className="rs-card" style={{ flex: 1, minWidth: 260 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
            <h3 style={{ fontSize: 13 }}>Rules ({rules.length})</h3>
            <button type="button" className="rs-button" data-testid="new-rule" onClick={newRule} disabled={busy}>
              + rule
            </button>
          </div>
          {rules.length === 0 ? (
            <p className="rs-muted">No rules yet.</p>
          ) : (
            <ul data-testid="rule-list">
              {rules.map((rule) => (
                <li key={rule.id}>
                  <button type="button" className="rs-button" onClick={() => openRule(rule)}>
                    <span className="rs-chip">{rule.kind}</span> {ruleSummary(rule, names)}
                    <span className="rs-chip" title="authoring surface">
                      {rule.authored_in}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* The editor */}
        {draft === null ? null : (
          <section aria-label="Rule editor" className="rs-card" style={{ flex: 2, minWidth: 360, display: 'grid', gap: 8 }}>
            {draft.readOnly ? (
              <p className="rs-muted" data-testid="rule-read-only">
                This rule has no visual form yet (a SET rule, or an item/variable target) — view
                or edit it as ResScript below.
              </p>
            ) : (
              <>
                <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span className="rs-muted">IF</span>
                </div>
                <ConditionTreeEditor
                  root={draft.condition}
                  variables={leafVariables}
                  ctx={ctx}
                  onChange={(condition) => setDraft({ ...draft, condition })}
                />
                <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span className="rs-muted">THEN</span>
                  <select
                    className="rs-input"
                    aria-label="Effect"
                    data-testid="effect-picker"
                    value={draft.effectId}
                    onChange={(event) => setDraft({ ...draft, effectId: event.target.value })}
                  >
                    {EFFECT_CHOICES.map((choice) => (
                      <option key={choice.id} value={choice.id}>
                        {choice.label}
                      </option>
                    ))}
                  </select>
                  <select
                    className="rs-input"
                    aria-label="Target"
                    data-testid="target-picker"
                    value={draft.targetNodeId}
                    onChange={(event) => setDraft({ ...draft, targetNodeId: event.target.value })}
                  >
                    {targetNodes.map((node) => (
                      <option key={node.id} value={node.id}>
                        {node.kind}: {node.ref ?? node.id}
                      </option>
                    ))}
                  </select>
                  {draft.effectId === 'terminate' ? (
                    <input
                      className="rs-input"
                      aria-label="Disposition"
                      placeholder="SCREENOUT"
                      value={draft.disposition}
                      onChange={(event) => setDraft({ ...draft, disposition: event.target.value })}
                    />
                  ) : null}
                </div>
              </>
            )}

            <label style={{ display: 'grid', gap: 2 }}>
              {/* 03 §7: six months later, "why does this rule exist" is the expensive question. */}
              <span className="rs-muted">Notes — why this rule exists</span>
              <textarea
                className="rs-input"
                aria-label="Rule notes"
                data-testid="rule-notes"
                value={draft.notes}
                onChange={(event) => setDraft({ ...draft, notes: event.target.value })}
              />
            </label>

            <div style={{ display: 'flex', gap: 4 }}>
              <button type="button" className="rs-button" data-testid="save-rule" onClick={() => void save()} disabled={busy || draft.readOnly}>
                {draft.ruleId === null ? 'Create rule' : 'Save rule'}
              </button>
              {draft.ruleId === null ? null : (
                <button type="button" className="rs-button" data-testid="delete-rule" onClick={() => void removeRule()} disabled={busy}>
                  Delete
                </button>
              )}
              <button type="button" className="rs-button" data-testid="view-as-code" onClick={() => void viewAsCode()} disabled={busy}>
                view as ResScript
              </button>
            </div>

            {source === null ? null : (
              <div style={{ display: 'grid', gap: 4 }}>
                <textarea
                  className="rs-input"
                  aria-label="ResScript source"
                  data-testid="rule-source"
                  rows={4}
                  value={source}
                  onChange={(event) => setSource(event.target.value)}
                />
                <div style={{ display: 'flex', gap: 4 }}>
                  <button type="button" className="rs-button" data-testid="apply-code" onClick={() => void applyCode()} disabled={busy}>
                    apply code
                  </button>
                  <button type="button" className="rs-button" onClick={() => setSource(null)}>
                    close
                  </button>
                </div>
              </div>
            )}
          </section>
        )}
      </div>

      {/* The two panels */}
      {selectedPanelNode === null ? null : (
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', gap: 4, alignItems: 'center', width: '100%' }}>
            <span className="rs-muted">Question</span>
            <select
              className="rs-input"
              aria-label="Panel question"
              value={selectedPanelNode.id}
              onChange={(event) => setPanelNodeId(event.target.value)}
            >
              {questionNodes.map((node) => (
                <option key={node.id} value={node.id}>
                  {node.ref ?? node.id}
                </option>
              ))}
            </select>
          </label>
          <div style={{ flex: 1, minWidth: 280 }}>
            <WhatAffectsPanel
              versionId={versionId}
              nodeId={selectedPanelNode.id}
              nodeRef={selectedPanelNode.ref ?? selectedPanelNode.id}
              names={names}
            />
          </div>
          <div style={{ flex: 1, minWidth: 280 }}>
            <WhatDoesItAffectPanel
              versionId={versionId}
              nodeId={selectedPanelNode.id}
              nodeRef={selectedPanelNode.ref ?? selectedPanelNode.id}
              names={names}
              variableIds={(variables ?? [])
                .filter((v) => v.source_question_id === selectedPanelNode.id)
                .map((v) => v.id)}
            />
          </div>
        </div>
      )}
    </div>
  );
}
