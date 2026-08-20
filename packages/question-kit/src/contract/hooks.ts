/**
 * Lifecycle hooks — Deliverable F §1.3.
 *
 * All client-side, all UX-only, and that is a security boundary rather than a simplification:
 * per ADR-004 the server re-evaluates everything that decides data, so a hook can improve the
 * experience and can never be the thing that makes an answer valid. Third-party plugins get no
 * server-side hooks at all (F §6), which is only enforceable because the hook surface here
 * contains nothing a server would call.
 */

import type { RenderContext } from './view.js';
import type { ResolvedQuestion, ValidationIssue } from './validate.js';

export interface HookContext<Config, Answer> {
  readonly question: ResolvedQuestion<Config>;
  readonly value: Answer | undefined;
  readonly ctx: RenderContext;
}

export interface PluginHooks<Config, Answer> {
  /** Returns an optional teardown, like `useEffect`. */
  onMount(ctx: HookContext<Config, Answer>): void | (() => void);
  onValueChange(
    ctx: HookContext<Config, Answer> & { readonly previous: Answer | undefined },
  ): void;
  onBlur(ctx: HookContext<Config, Answer>): void;
  /** Called before the page submits. May veto with an issue; may not mutate state. */
  onBeforeSubmit(ctx: HookContext<Config, Answer>): readonly ValidationIssue[] | void;
}
