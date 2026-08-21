/**
 * The ResScript code pane — the Monaco half of 09-ui §7.3/§7.4.
 *
 * Everything expensive is behind `loadEditor`, which defaults to the memoised `import()` in
 * `code-editor/load.ts`. Nothing in this file imports `monaco-editor` at module scope, so a route
 * that renders the logic tab does not pull 330 KB of editor into its entry graph — the chunk
 * arrives on hover (the toggle prefetches) or on mount, whichever happens first.
 *
 * Three behaviours worth naming:
 *
 *  1. **The compile loop is owned here** (`code-editor/compile-loop.ts`): 150 ms debounce, markers
 *     at the diagnostic's own span, and `onDiagnostics` so the Problems tab and the "reads: …"
 *     footer update from the same result (§7.4's fan-out).
 *  2. **Save is separate from compile.** This component reports source changes upward on every
 *     keystroke and flushes the compile on blur; what to persist — and §7.4 is explicit that it is
 *     the *AST*, not the source — is the owning pane's decision, not the editor's.
 *  3. **A failed load is not a locked-out author.** If the chunk cannot load (offline, a CSP
 *     mistake, a bundler regression) the pane falls back to a plain textarea carrying the same
 *     text and the same `onChange`. Losing syntax colouring is an inconvenience; losing the rule
 *     the author is halfway through typing is a data-loss bug.
 */

'use client';

import { useEffect, useId, useRef, useState } from 'react';
import type { DslDiagnostic, DslRegistry } from '@resscript/rescript-dsl';
import type { CompletionEnvironment, FlowOrder } from '@/code-editor/completion';
import type { DefinitionTarget } from '@/code-editor/hover';
import { RESCRIPT_LANGUAGE_ID } from '@/code-editor/language';
import { applyMarkers, type MonacoLike, type TextModelLike } from '@/code-editor/register';
import { createDiagnosticsLoop, createInProcessCompiler } from '@/code-editor/compile-loop';
import { loadResScriptEditor, type MonacoApi } from '@/code-editor/load';

export interface CodeEditorPaneProps {
  readonly source: string;
  readonly registry: DslRegistry;
  readonly flow?: FlowOrder;
  readonly labelOf?: (key: string) => string | undefined;
  readonly onChange: (source: string) => void;
  readonly onDiagnostics?: (diagnostics: readonly DslDiagnostic[], source: string) => void;
  readonly onNavigate?: (target: DefinitionTarget) => void;
  readonly readOnly?: boolean;
  /** §7.4: exposed as a studio setting rather than left on `auto`, which guesses wrong. */
  readonly accessibilitySupport?: 'auto' | 'on' | 'off';
  readonly ariaLabel?: string;
  readonly heightPx?: number;
  /** Test/Storybook seam. Defaults to the real lazy loader. */
  readonly loadEditor?: (services: {
    environment: () => CompletionEnvironment;
    onNavigate?: (target: DefinitionTarget) => void;
  }) => Promise<MonacoApi>;
}

type LoadState = 'loading' | 'ready' | 'failed';

export function CodeEditorPane(props: CodeEditorPaneProps): React.JSX.Element {
  const {
    source,
    registry,
    flow,
    labelOf,
    onChange,
    onDiagnostics,
    onNavigate,
    readOnly = false,
    accessibilitySupport = 'on',
    ariaLabel = 'ResScript source',
    heightPx = 240,
    loadEditor = loadResScriptEditor,
  } = props;

  const hostRef = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<LoadState>('loading');
  const fallbackId = useId();

  // Refs, not state: the providers and the loop are created once and must see the CURRENT props
  // without being torn down and rebuilt on every keystroke (which would drop the debounce window
  // and re-register the language).
  const latest = useRef({ source, registry, flow, labelOf, onChange, onDiagnostics, onNavigate });
  latest.current = { source, registry, flow, labelOf, onChange, onDiagnostics, onNavigate };

  useEffect(() => {
    let disposed = false;
    let dispose: (() => void) | undefined;

    const environment = (): CompletionEnvironment => {
      const current = latest.current;
      return {
        registry: current.registry,
        ...(current.flow === undefined ? {} : { flow: current.flow }),
        ...(current.labelOf === undefined ? {} : { labelOf: current.labelOf }),
      };
    };

    void loadEditor({
      environment,
      ...(onNavigate === undefined
        ? {}
        : { onNavigate: (target: DefinitionTarget) => latest.current.onNavigate?.(target) }),
    })
      .then((monaco) => {
        const host = hostRef.current;
        if (disposed || host === null) return;

        const editor = monaco.editor.create(host, {
          value: latest.current.source,
          language: RESCRIPT_LANGUAGE_ID,
          readOnly,
          accessibilitySupport,
          // §7.4: keyboard users must be able to leave the editor.
          tabFocusMode: false,
          automaticLayout: true,
          minimap: { enabled: false },
          // A DSL pane offering the author's own words back as suggestions competes with the
          // registry-driven list and offers refs that do not exist. The registry is the source.
          wordBasedSuggestions: 'off',
          scrollBeyondLastLine: false,
          renderLineHighlight: 'none',
          fontSize: 13,
          lineNumbersMinChars: 3,
        });

        const model = editor.getModel();
        const loop = createDiagnosticsLoop({
          compile: createInProcessCompiler(latest.current.registry),
          onResult: (result, compiled) => {
            if (model !== null) {
              applyMarkers(monaco as unknown as MonacoLike, model as unknown as TextModelLike, compiled, result.diagnostics);
            }
            latest.current.onDiagnostics?.(result.diagnostics, compiled);
          },
        });

        const changeSub = editor.onDidChangeModelContent(() => {
          const next = editor.getValue();
          latest.current.onChange(next);
          loop.push(next);
        });
        const blurSub = editor.onDidBlurEditorText(() => {
          loop.flush();
        });

        // One compile on open, so an existing rule's diagnostics are on screen before the first
        // keystroke rather than 150 ms after it.
        loop.push(latest.current.source);
        loop.flush();

        setState('ready');
        dispose = (): void => {
          changeSub.dispose();
          blurSub.dispose();
          loop.dispose();
          editor.dispose();
        };
      })
      .catch(() => {
        if (!disposed) setState('failed');
      });

    return (): void => {
      disposed = true;
      dispose?.();
    };
    // Intentionally mount-only: prop changes are read through `latest`. Re-running this would
    // dispose and rebuild the editor mid-edit, which loses the cursor and the undo history.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div data-testid="code-editor-pane">
      <div
        ref={hostRef}
        data-testid="code-editor-host"
        aria-label={ariaLabel}
        style={{ height: heightPx, display: state === 'failed' ? 'none' : 'block' }}
      />
      {state === 'loading' ? (
        <p className="rs-muted" role="status" data-testid="code-editor-loading">
          loading the editor…
        </p>
      ) : null}
      {state === 'failed' ? (
        <div data-testid="code-editor-fallback">
          <p role="alert" className="rs-alert">
            The code editor could not load. Your text is safe and still editable below — you are
            without syntax colouring and inline diagnostics until this pane reloads.
          </p>
          <label htmlFor={fallbackId} className="rs-muted">
            {ariaLabel}
          </label>
          <textarea
            id={fallbackId}
            className="rs-input"
            data-testid="code-editor-fallback-input"
            defaultValue={source}
            readOnly={readOnly}
            rows={8}
            spellCheck={false}
            onChange={(event) => {
              onChange(event.target.value);
            }}
          />
        </div>
      ) : null}
    </div>
  );
}
