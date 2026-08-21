/**
 * The pane's wiring, with a stand-in for the editor.
 *
 * Monaco's DOM is not rendered and not asserted on. What is asserted is what this component is
 * responsible for: the options it creates the editor with (§7.4's accessibility and
 * word-suggestion decisions), that the compile loop runs once on open so an existing rule's
 * diagnostics are on screen before the first keystroke, that markers go to the model, and that a
 * failed load leaves the author's text editable instead of stranded.
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodeEditorPane } from '@/components/logic/CodeEditorPane';
import type { MonacoApi } from '@/code-editor/load';
import { fixtureRegistry } from '@/test/dsl-fixture';

afterEach(cleanup);

interface FakeEditor {
  options: Record<string, unknown>;
  fire(value: string): void;
  readonly markerWrites: { owner: string; count: number }[];
}

function fakeMonaco(): { monaco: MonacoApi; editor: FakeEditor } {
  let handler: (() => void) | undefined;
  let value = '';
  const state: FakeEditor = {
    options: {},
    fire: (next: string) => {
      value = next;
      handler?.();
    },
    markerWrites: [],
  };
  const monaco = {
    editor: {
      create: (_host: unknown, options: Record<string, unknown>) => {
        state.options = options;
        value = String(options['value'] ?? '');
        return {
          getModel: () => ({ id: 'model' }),
          getValue: () => value,
          onDidChangeModelContent: (fn: () => void) => {
            handler = fn;
            return { dispose: () => undefined };
          },
          onDidBlurEditorText: () => ({ dispose: () => undefined }),
          dispose: () => undefined,
        };
      },
      setModelMarkers: (_model: unknown, owner: string, markers: readonly unknown[]) => {
        state.markerWrites.push({ owner, count: markers.length });
      },
    },
    Uri: { parse: (v: string) => ({ uri: v }) },
  } as unknown as MonacoApi;
  return { monaco, editor: state };
}

describe('CodeEditorPane', () => {
  it('creates the editor with §7.4\'s options and compiles once on open', async () => {
    const fake = fakeMonaco();
    const onDiagnostics = vi.fn();
    render(
      <CodeEditorPane
        source={'IF NOPE = 1 THEN SHOW Q12\n'}
        registry={fixtureRegistry()}
        onChange={vi.fn()}
        onDiagnostics={onDiagnostics}
        accessibilitySupport="on"
        loadEditor={async () => fake.monaco}
      />,
    );

    await waitFor(() => {
      expect(onDiagnostics).toHaveBeenCalled();
    });
    expect(fake.editor.options['language']).toBe('rescript');
    // A DSL pane must not offer the author's own words as suggestions: the registry is the source.
    expect(fake.editor.options['wordBasedSuggestions']).toBe('off');
    // §7.4: exposed as a setting, and tab must not be trapped.
    expect(fake.editor.options['accessibilitySupport']).toBe('on');
    expect(fake.editor.options['tabFocusMode']).toBe(false);

    // The unknown ref produced a marker, written under our owner.
    expect(fake.editor.markerWrites[0]?.owner).toBe('resscript');
    expect(fake.editor.markerWrites[0]?.count).toBeGreaterThan(0);
    const [diagnostics] = onDiagnostics.mock.calls[0] as [readonly { code: string }[]];
    expect(diagnostics.map((d) => d.code)).toContain('LGC-T001');
  });

  it('reports every keystroke upward and re-compiles after the debounce', async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeMonaco();
      const onChange = vi.fn();
      const onDiagnostics = vi.fn();
      render(
        <CodeEditorPane
          source={'IF S1 = 1 THEN SHOW Q12\n'}
          registry={fixtureRegistry()}
          onChange={onChange}
          onDiagnostics={onDiagnostics}
          loadEditor={async () => fake.monaco}
        />,
      );
      await vi.waitFor(() => {
        expect(onDiagnostics).toHaveBeenCalledTimes(1);
      });

      fake.editor.fire('IF S1 = ');
      expect(onChange).toHaveBeenCalledWith('IF S1 = ');
      // Not yet: the compile is debounced (§7.4's 150 ms).
      expect(onDiagnostics).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(150);
      expect(onDiagnostics).toHaveBeenCalledTimes(2);
      const [diagnostics] = onDiagnostics.mock.calls[1] as [readonly { severity: string }[]];
      expect(diagnostics.some((d) => d.severity === 'error')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the text editable when the editor chunk cannot load', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <CodeEditorPane
        source={'IF S1 = 1 THEN SHOW Q12\n'}
        registry={fixtureRegistry()}
        onChange={onChange}
        loadEditor={async () => {
          throw new Error('chunk load failed');
        }}
      />,
    );

    const fallback = await screen.findByTestId('code-editor-fallback-input');
    expect(screen.getByRole('alert')).toHaveTextContent('Your text is safe');
    await user.type(fallback, ' ');
    expect(onChange).toHaveBeenCalled();
  });
});
