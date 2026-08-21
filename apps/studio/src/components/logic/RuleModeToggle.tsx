/**
 * The `[builder | code]` toggle on a rule header — 09-ui §7.3.
 *
 * Controlled: `mode` and `onModeChange` belong to the pane that owns the rule, because the mode is
 * also a URL concern (§6's `?mode=` precedent) and because two panes on screen must not fight.
 * What this component owns is the *refusal*, and there are exactly two:
 *
 *  - **Unparseable source blocks the switch.** The diagnostic is rendered with its `RSL-`/`LGC-`
 *    code and its line/column, and `onRevealSpan` puts the cursor there. `onModeChange` is not
 *    called, so the parent never renders a builder for a tree that does not exist — §7.3's "we
 *    never show a half-built tree" is structural here, not a convention.
 *  - **A DSL-authored rule warns once before losing its trivia**, with §7.3's "keep editing as
 *    code" escape as a real button rather than a cancel affordance.
 *
 * The `authored_in` chip is always visible: §7.3 wants a programmer to know "whether the code they
 * are reading is theirs or the printer's" before they read it, not after they notice reformatting.
 */

'use client';

import { useState } from 'react';
import type { DslDiagnostic, DslRegistry, Program, Span } from '@resscript/rescript-dsl';
import {
  describeTriviaLoss,
  toBuilder,
  toCode,
  type AuthoredIn,
  type RuleEditorMode,
  type TriviaLoss,
} from '@/code-editor/mode-toggle';
import { prefetchMonaco } from '@/code-editor/load';

export interface RuleModeToggleProps {
  readonly ruleId: string;
  /** `visible(Q12)` — the rule's target, printed by the caller. */
  readonly title: string;
  readonly authoredIn: AuthoredIn;
  readonly mode: RuleEditorMode;
  /** The source shown in code mode. Owned by the parent so a keystroke is not lost on a re-render. */
  readonly source: string;
  /** The AST behind the builder. Printed on the way into code mode. */
  readonly program: Program;
  readonly registry: DslRegistry;
  readonly onModeChange: (next: RuleEditorMode, payload: ModeChangePayload) => void;
  /** §13.1: reveal the offending span and place the cursor there. */
  readonly onRevealSpan?: (span: Span) => void;
  /** Set once the author has accepted the trivia loss for THIS rule (see the store slice). */
  readonly triviaWarningAcknowledged?: boolean;
  readonly onAcknowledgeTriviaWarning?: (ruleId: string) => void;
  readonly builder?: React.ReactNode;
  readonly code?: React.ReactNode;
  /** Overridable so a test does not pull in the editor chunk. Defaults to §7.4's hover prefetch. */
  readonly onPrefetchCode?: () => void;
}

export type ModeChangePayload =
  | { readonly mode: 'code'; readonly source: string }
  | { readonly mode: 'builder'; readonly program: Program };

interface Blocked {
  readonly diagnostic: DslDiagnostic;
}

interface Pending {
  readonly loss: TriviaLoss;
  readonly program: Program;
}

export function RuleModeToggle(props: RuleModeToggleProps): React.JSX.Element {
  const {
    ruleId,
    title,
    authoredIn,
    mode,
    source,
    program,
    registry,
    onModeChange,
    onRevealSpan,
    triviaWarningAcknowledged = false,
    onAcknowledgeTriviaWarning,
    builder,
    code,
    onPrefetchCode = prefetchMonaco,
  } = props;

  const [blocked, setBlocked] = useState<Blocked | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);

  const goCode = (): void => {
    setBlocked(null);
    setPending(null);
    const result = toCode(program, registry);
    if (result.kind === 'switched' && result.mode === 'code') {
      onModeChange('code', { mode: 'code', source: result.source });
    }
  };

  const goBuilder = (acknowledged = triviaWarningAcknowledged): void => {
    const result = toBuilder({ source, registry, authoredIn, triviaWarningAcknowledged: acknowledged });
    if (result.kind === 'blocked') {
      setPending(null);
      setBlocked({ diagnostic: result.diagnostic });
      if (result.diagnostic.span !== undefined) onRevealSpan?.(result.diagnostic.span);
      return;
    }
    if (result.kind === 'confirm') {
      setBlocked(null);
      setPending({ loss: result.loss, program: result.program });
      return;
    }
    setBlocked(null);
    setPending(null);
    if (result.mode === 'builder') onModeChange('builder', { mode: 'builder', program: result.program });
  };

  const acceptTriviaLoss = (): void => {
    const target = pending;
    setPending(null);
    if (target === null) return;
    onAcknowledgeTriviaWarning?.(ruleId);
    onModeChange('builder', { mode: 'builder', program: target.program });
  };

  return (
    <section className="rs-card" data-testid="rule-mode">
      <header style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <strong>{title}</strong>
        {/* §7.3's chip. Colour is never the sole carrier: the word is the label (§11). */}
        <span
          className="rs-chip"
          data-testid="rule-authored-in"
          title={
            authoredIn === 'dsl'
              ? 'Authored in ResScript. Its comments, blank lines and parentheses are preserved.'
              : 'Authored in the builder. It has no comments to preserve and prints canonically.'
          }
        >
          {authoredIn === 'dsl' ? 'DSL' : 'visual'}
        </span>
        <div role="group" aria-label="Rule editor mode" style={{ marginLeft: 'auto', display: 'flex' }}>
          <button
            type="button"
            className="rs-button"
            data-testid="rule-mode-builder"
            aria-pressed={mode === 'builder'}
            onClick={() => goBuilder()}
          >
            builder
          </button>
          <button
            type="button"
            className="rs-button"
            data-testid="rule-mode-code"
            aria-pressed={mode === 'code'}
            // §7.4/§12: the chunk is warmed on hover and on focus, so the first open feels instant
            // for a keyboard user too.
            onMouseEnter={onPrefetchCode}
            onFocus={onPrefetchCode}
            onClick={goCode}
          >
            code
          </button>
        </div>
      </header>

      {blocked === null ? null : (
        <div role="alert" className="rs-alert" data-testid="rule-mode-blocked">
          <strong>{blocked.diagnostic.code}</strong>{' '}
          <span data-testid="rule-mode-blocked-message">{blocked.diagnostic.message}</span>
          <div className="rs-muted">
            {blocked.diagnostic.span === undefined
              ? 'This rule cannot be shown in the builder until it parses.'
              : `Line ${String(blocked.diagnostic.span.line)}, column ${String(blocked.diagnostic.span.col)}. The builder stays closed until this parses.`}
          </div>
          {blocked.diagnostic.span === undefined || onRevealSpan === undefined ? null : (
            <button
              type="button"
              className="rs-button"
              data-testid="rule-mode-goto-error"
              onClick={() => {
                if (blocked.diagnostic.span !== undefined) onRevealSpan(blocked.diagnostic.span);
              }}
            >
              go to the error
            </button>
          )}
        </div>
      )}

      {pending === null ? null : (
        <div role="alertdialog" aria-label="Trivia loss" className="rs-alert" data-testid="rule-mode-trivia-warning">
          <span data-testid="rule-mode-trivia-message">{describeTriviaLoss(pending.loss)}</span>
          <div className="rs-muted">
            The round-trip fidelity report will record this rule as reformatted.
          </div>
          <button
            type="button"
            className="rs-button"
            data-testid="rule-mode-trivia-accept"
            onClick={acceptTriviaLoss}
          >
            open in builder anyway
          </button>
          <button
            type="button"
            className="rs-button"
            data-testid="rule-mode-trivia-keep-code"
            onClick={() => setPending(null)}
          >
            keep editing as code
          </button>
        </div>
      )}

      <div data-testid="rule-mode-body">{mode === 'builder' ? builder : code}</div>
    </section>
  );
}
