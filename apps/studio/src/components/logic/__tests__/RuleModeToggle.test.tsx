/**
 * The toggle, in the DOM (§7.3).
 *
 * Two behaviours are the point of the suite, and both are refusals:
 *
 *  - unparseable source **blocks** the switch, shows the diagnostic at its position, and never
 *    renders the builder;
 *  - a DSL-authored rule warns **once**, and "keep editing as code" is a real escape.
 *
 * No Monaco here: the toggle takes the builder and the code pane as nodes, so this suite exercises
 * the decision and the copy without loading the editor. `onPrefetchCode` is injected for the same
 * reason — the real one starts a 330 KB `import()`.
 */

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse } from '@resscript/rescript-dsl';
import { RuleModeToggle, type ModeChangePayload } from '@/components/logic/RuleModeToggle';
import type { RuleEditorMode } from '@/code-editor/mode-toggle';
import { fixtureRegistry } from '@/test/dsl-fixture';

afterEach(cleanup);

const registry = fixtureRegistry();
const BUILDER = <span data-testid="builder-tree">the condition tree</span>;
const CODE = <span data-testid="code-pane">the source</span>;

interface Options {
  readonly source: string;
  readonly authoredIn?: 'visual' | 'dsl';
  readonly mode?: RuleEditorMode;
  readonly acknowledged?: boolean;
}

function setup(options: Options) {
  const onModeChange = vi.fn<(mode: RuleEditorMode, payload: ModeChangePayload) => void>();
  const onAcknowledge = vi.fn();
  const onPrefetchCode = vi.fn();
  const onRevealSpan = vi.fn();
  const { program } = parse(options.source, registry);
  const view = render(
    <RuleModeToggle
      ruleId="rul_01JC8KX9Q2M4V7ZB3F0T5N6R8W"
      title="visible(Q12)"
      authoredIn={options.authoredIn ?? 'dsl'}
      mode={options.mode ?? 'code'}
      source={options.source}
      program={program}
      registry={registry}
      onModeChange={onModeChange}
      onRevealSpan={onRevealSpan}
      triviaWarningAcknowledged={options.acknowledged ?? false}
      onAcknowledgeTriviaWarning={onAcknowledge}
      onPrefetchCode={onPrefetchCode}
      builder={BUILDER}
      code={CODE}
    />,
  );
  return { view, onModeChange, onAcknowledge, onPrefetchCode, onRevealSpan };
}

describe('the authored_in chip', () => {
  it('says which form the reader is looking at (§7.3)', () => {
    setup({ source: 'IF S1 = 1 THEN SHOW Q12\n', authoredIn: 'dsl' });
    expect(screen.getByTestId('rule-authored-in')).toHaveTextContent('DSL');
    cleanup();
    setup({ source: 'IF S1 = 1 THEN SHOW Q12\n', authoredIn: 'visual' });
    expect(screen.getByTestId('rule-authored-in')).toHaveTextContent('visual');
  });
});

describe('unparseable source', () => {
  it('blocks the switch and shows the diagnostic instead of a half-built tree', async () => {
    const user = userEvent.setup();
    const { onModeChange, onRevealSpan } = setup({ source: 'IF S1 = ' });

    await user.click(screen.getByTestId('rule-mode-builder'));

    expect(onModeChange).not.toHaveBeenCalled();
    const alert = screen.getByTestId('rule-mode-blocked');
    expect(alert).toHaveTextContent('RSL-0001');
    expect(alert).toHaveTextContent('Line 1, column 9');
    // The builder is not rendered, and neither is a partial one.
    expect(screen.queryByTestId('builder-tree')).toBeNull();
    expect(screen.getByTestId('code-pane')).toBeDefined();
    // §13.1: the cursor goes to the span.
    expect(onRevealSpan).toHaveBeenCalledWith(expect.objectContaining({ start: 8 }));
  });

  it('offers a "go to the error" action that reveals the span again', async () => {
    const user = userEvent.setup();
    const { onRevealSpan } = setup({ source: 'IF S1 = ' });
    await user.click(screen.getByTestId('rule-mode-builder'));
    await user.click(screen.getByTestId('rule-mode-goto-error'));
    expect(onRevealSpan).toHaveBeenCalledTimes(2);
  });

  it('clears the block once the source parses', async () => {
    const user = userEvent.setup();
    const { onModeChange } = setup({ source: 'IF S1 = 1 THEN SHOW Q12\n' });
    await user.click(screen.getByTestId('rule-mode-builder'));
    expect(screen.queryByTestId('rule-mode-blocked')).toBeNull();
    expect(onModeChange).toHaveBeenCalledWith('builder', expect.objectContaining({ mode: 'builder' }));
  });
});

describe('the trivia-loss warning', () => {
  const source = '# heavy buyers only, per R2 feedback\nIF S1 = 1 THEN SHOW Q12\n';

  it('fires once, names what is lost, and does not switch on its own', async () => {
    const user = userEvent.setup();
    const { onModeChange } = setup({ source, authoredIn: 'dsl' });

    await user.click(screen.getByTestId('rule-mode-builder'));
    expect(screen.getByTestId('rule-mode-trivia-message')).toHaveTextContent('1 comment');
    expect(onModeChange).not.toHaveBeenCalled();
    expect(screen.queryByTestId('builder-tree')).toBeNull();
  });

  it('is escapable: "keep editing as code" dismisses it and stays in code', async () => {
    const user = userEvent.setup();
    const { onModeChange, onAcknowledge } = setup({ source, authoredIn: 'dsl' });

    await user.click(screen.getByTestId('rule-mode-builder'));
    await user.click(screen.getByTestId('rule-mode-trivia-keep-code'));

    expect(screen.queryByTestId('rule-mode-trivia-warning')).toBeNull();
    expect(onModeChange).not.toHaveBeenCalled();
    expect(onAcknowledge).not.toHaveBeenCalled();
    expect(screen.getByTestId('code-pane')).toBeDefined();
  });

  it('switches and records the acknowledgement when accepted', async () => {
    const user = userEvent.setup();
    const { onModeChange, onAcknowledge } = setup({ source, authoredIn: 'dsl' });

    await user.click(screen.getByTestId('rule-mode-builder'));
    await user.click(screen.getByTestId('rule-mode-trivia-accept'));

    expect(onAcknowledge).toHaveBeenCalledWith('rul_01JC8KX9Q2M4V7ZB3F0T5N6R8W');
    expect(onModeChange).toHaveBeenCalledWith('builder', expect.objectContaining({ mode: 'builder' }));
    expect(screen.queryByTestId('rule-mode-trivia-warning')).toBeNull();
  });

  it('does not warn a second time once the rule is acknowledged', async () => {
    const user = userEvent.setup();
    const { onModeChange } = setup({ source, authoredIn: 'dsl', acknowledged: true });
    await user.click(screen.getByTestId('rule-mode-builder'));
    expect(screen.queryByTestId('rule-mode-trivia-warning')).toBeNull();
    expect(onModeChange).toHaveBeenCalledTimes(1);
  });

  it('never warns for a visually authored rule — there is nothing to lose', async () => {
    const user = userEvent.setup();
    const { onModeChange } = setup({ source, authoredIn: 'visual' });
    await user.click(screen.getByTestId('rule-mode-builder'));
    expect(screen.queryByTestId('rule-mode-trivia-warning')).toBeNull();
    expect(onModeChange).toHaveBeenCalledTimes(1);
  });
});

describe('builder → code', () => {
  it('prints the AST and warms the editor chunk on hover and on focus (§7.4, §12)', async () => {
    const user = userEvent.setup();
    const { onModeChange, onPrefetchCode } = setup({
      source: 'IF S1 = 1 THEN SHOW Q12\n',
      mode: 'builder',
    });
    expect(screen.getByTestId('builder-tree')).toBeDefined();

    await user.hover(screen.getByTestId('rule-mode-code'));
    expect(onPrefetchCode).toHaveBeenCalled();

    await user.click(screen.getByTestId('rule-mode-code'));
    expect(onModeChange).toHaveBeenCalledWith('code', {
      mode: 'code',
      source: 'IF S1 = 1 THEN SHOW Q12\n',
    });
  });
});
