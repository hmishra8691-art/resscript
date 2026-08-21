/**
 * The Monaco adapter: everything that touches the `monaco` namespace, and nothing that decides
 * anything.
 *
 * The namespace arrives as an argument rather than an import, for two reasons that are both
 * load-bearing:
 *
 *  - **`load.ts` owns the `import()`.** A module-level `import 'monaco-editor'` here would put the
 *    editor in the entry graph of every file that registers a provider, which is the one thing
 *    §7.4 forbids.
 *  - **It makes the adapter testable.** The suite passes a recording stand-in and asserts what we
 *    hand Monaco — the language id, `.rsl`, the configuration from §7.4, the Monarch table, and
 *    the shape of the completion items. §7.4's own instruction is to test the adapters, not the
 *    vendor, and Monaco's DOM is explicitly not snapshotted anywhere in this suite.
 *
 * `MonacoLike` is a structural subset: the real namespace satisfies it, so `registerResScript`
 * takes `typeof import('monaco-editor')` with no cast at the call site.
 */

import type * as monaco from 'monaco-editor';
import type { DslDiagnostic } from '@resscript/rescript-dsl';
import { format } from '@resscript/rescript-dsl';
import { RESCRIPT_LANGUAGE_CONFIGURATION, RESCRIPT_LANGUAGE_ID, RESCRIPT_MONARCH } from './language';
import {
  MARKER_OWNER,
  positionAt,
  spanToRange,
  toMarkers,
  toMonacoMarker,
  type MarkerRange,
  type ResScriptMarker,
} from './markers';
import { completionsAt, type CompletionEnvironment } from './completion';
import { definitionAt, hoverAt, type DefinitionTarget } from './hover';

export interface PositionLike {
  readonly lineNumber: number;
  readonly column: number;
}

export interface TextModelLike {
  getValue(): string;
  getOffsetAt(position: PositionLike): number;
}

export interface MarkerSink {
  setModelMarkers(model: TextModelLike, owner: string, markers: readonly unknown[]): void;
}

export interface MonacoLike {
  readonly languages: {
    register(language: { id: string; extensions?: string[]; aliases?: string[] }): void;
    setLanguageConfiguration(id: string, config: monaco.languages.LanguageConfiguration): unknown;
    setMonarchTokensProvider(id: string, provider: monaco.languages.IMonarchLanguage): unknown;
    registerCompletionItemProvider(id: string, provider: CompletionProviderLike): unknown;
    registerHoverProvider(id: string, provider: HoverProviderLike): unknown;
    registerDefinitionProvider(id: string, provider: DefinitionProviderLike): unknown;
    registerDocumentFormattingEditProvider(id: string, provider: FormattingProviderLike): unknown;
  };
  readonly editor: MarkerSink;
  readonly Uri: { parse(value: string): unknown };
}

/**
 * The provider shapes, kept deliberately *assignable to* Monaco's own.
 *
 * They are narrower than Monaco's (two parameters instead of four, no cancellation token), which
 * is what makes them callable from a test with a plain object — but every member's type is
 * Monaco's, so `registerResScript(realMonaco, …)` type-checks with no cast at the call site. That
 * assignability is the property that keeps this file honest: a stand-in the real namespace could
 * not satisfy would let the suite pass while the editor got something else.
 */
export interface CompletionItemLike {
  readonly label: string;
  readonly kind: monaco.languages.CompletionItemKind;
  readonly insertText: string;
  /**
   * Always supplied. Monaco will infer the current word when it is absent, and that inference is
   * wrong for this language: `Q5.Al` is one word to Monaco and two tokens plus a `.` to the lexer,
   * so an inferred range would replace the wrong span.
   */
  readonly range: MarkerRange;
  readonly detail?: string;
  readonly documentation?: { readonly value: string };
  readonly sortText?: string;
}

export interface CompletionProviderLike {
  readonly triggerCharacters?: string[];
  provideCompletionItems(
    model: TextModelLike,
    position: PositionLike,
  ): { suggestions: CompletionItemLike[] };
}

export interface HoverProviderLike {
  provideHover(
    model: TextModelLike,
    position: PositionLike,
  ): { range: MarkerRange; contents: { value: string }[] } | null;
}

export interface DefinitionProviderLike {
  provideDefinition(model: TextModelLike, position: PositionLike): null;
}

export interface TextEditLike {
  readonly range: MarkerRange;
  readonly text: string;
}

export interface FormattingProviderLike {
  readonly displayName?: string;
  provideDocumentFormattingEdits(model: TextModelLike): TextEditLike[];
}

/**
 * What the language services need from the studio, resolved per editor rather than captured once:
 * the registry changes when the version's variables change, and a provider that closed over a
 * stale registry would offer variables that no longer exist.
 */
export interface LanguageServices {
  /** The current completion/hover environment. Called on every request. */
  environment(): CompletionEnvironment;
  /** §7.4: ctrl-click is a *studio* navigation — select the node in the tree, not a file jump. */
  onNavigate?(target: DefinitionTarget): void;
}

const REGISTERED = new WeakSet<object>();

/**
 * Register the `rescript` language and its providers. Idempotent per `monaco` instance: Monaco
 * happily registers a second Monarch provider for the same id and then runs both, so a second
 * call from a second editor instance would double every completion list.
 */
export function registerResScript(m: MonacoLike, services: LanguageServices): void {
  if (REGISTERED.has(m)) return;
  REGISTERED.add(m);

  m.languages.register({
    id: RESCRIPT_LANGUAGE_ID,
    extensions: ['.rsl'],
    aliases: ['ResScript'],
  });
  m.languages.setLanguageConfiguration(RESCRIPT_LANGUAGE_ID, RESCRIPT_LANGUAGE_CONFIGURATION);
  m.languages.setMonarchTokensProvider(RESCRIPT_LANGUAGE_ID, RESCRIPT_MONARCH);

  m.languages.registerCompletionItemProvider(RESCRIPT_LANGUAGE_ID, {
    // §7.4's list. `' '` is there because most positions in this language are keyword-delimited,
    // so without it the author has to press ⌃Space after every `AND`.
    triggerCharacters: ['.', ' ', '[', '"'],
    provideCompletionItems: (model, position) => {
      const source = model.getValue();
      const offset = model.getOffsetAt(position);
      const environment = services.environment();
      const result = completionsAt(source, offset, environment);
      // Mid-token, replace the token; otherwise insert at the cursor as an empty range. See
      // `CompletionItemLike.range` for why this is never left to Monaco's word inference.
      const cursor = positionAt(source, offset);
      const range: MarkerRange =
        result.replace === undefined
          ? {
              startLineNumber: cursor.lineNumber,
              startColumn: cursor.column,
              endLineNumber: cursor.lineNumber,
              endColumn: cursor.column,
            }
          : spanToRange(source, result.replace);
      return {
        suggestions: result.items.map((item): CompletionItemLike => ({
          label: item.label,
          kind: item.kind as monaco.languages.CompletionItemKind,
          insertText: item.insertText,
          range,
          ...(item.detail === undefined ? {} : { detail: item.detail }),
          ...(item.documentation === undefined || item.documentation === ''
            ? {}
            : { documentation: { value: item.documentation } }),
          ...(item.sortText === undefined ? {} : { sortText: item.sortText }),
        })),
      };
    },
  });

  m.languages.registerHoverProvider(RESCRIPT_LANGUAGE_ID, {
    provideHover: (model, position) => {
      const source = model.getValue();
      const hover = hoverAt(source, model.getOffsetAt(position), services.environment());
      if (hover === undefined) return null;
      return {
        range: spanToRange(source, hover.span),
        contents: hover.contents.map((value) => ({ value })),
      };
    },
  });

  m.languages.registerDefinitionProvider(RESCRIPT_LANGUAGE_ID, {
    provideDefinition: (model, position) => {
      const source = model.getValue();
      const target = definitionAt(
        source,
        model.getOffsetAt(position),
        services.environment().registry,
      );
      if (target !== undefined) services.onNavigate?.(target);
      // Always `null`. There is no Monaco model for a tree row, and a fabricated `Location` would
      // move the cursor inside the rule instead of selecting the question — §7.4 is explicit that
      // this is a studio navigation. The provider exists for the ctrl-click affordance and its
      // value is the side effect above.
      return null;
    },
  });

  m.languages.registerDocumentFormattingEditProvider(RESCRIPT_LANGUAGE_ID, {
    displayName: 'ResScript',
    provideDocumentFormattingEdits: (model) => {
      const source = model.getValue();
      const result = format(source, services.environment().registry);
      // Formatting a file that does not parse would replace the author's text with the printer's
      // best effort over a recovered tree — which is the "silently discard unparseable text" that
      // §7.3 forbids one paragraph earlier. So a failed parse formats to nothing.
      if (!result.ok || result.source === source) return [];
      return [
        {
          range: spanToRange(source, { start: 0, end: source.length, line: 1, col: 1 }),
          text: result.source,
        },
      ];
    },
  });
}

/** The `setModelMarkers` half of the loop in `compile-loop.ts`. */
export function applyMarkers(
  m: MonacoLike,
  model: TextModelLike,
  source: string,
  diagnostics: readonly DslDiagnostic[],
): readonly ResScriptMarker[] {
  const markers = toMarkers(source, diagnostics);
  m.editor.setModelMarkers(
    model,
    MARKER_OWNER,
    markers.map((marker) => toMonacoMarker(marker, (target) => m.Uri.parse(target) as monaco.Uri)),
  );
  return markers;
}

/** Clear ours without touching another owner's markers. */
export function clearMarkers(m: MonacoLike, model: TextModelLike): void {
  m.editor.setModelMarkers(model, MARKER_OWNER, []);
}
