/**
 * What we hand Monaco — the adapter, not the vendor. §7.4 spells the registration out line by
 * line, so this suite asserts those lines: the language id and `.rsl`, the comment/bracket/
 * auto-closing/indentation/folding configuration, the Monarch table, and the providers.
 *
 * Monaco's DOM is never rendered here. A stand-in records the calls, which is enough to catch the
 * failures that actually happen: a provider registered against the wrong language id (silently
 * never fires), a second registration doubling every completion list, and a marker written under
 * the wrong owner (never cleared).
 */

import { describe, expect, it, vi } from 'vitest';
import { parse } from '@resscript/rescript-dsl';
import { RESCRIPT_LANGUAGE_CONFIGURATION, RESCRIPT_MONARCH } from '@/code-editor/language';
import {
  applyMarkers,
  clearMarkers,
  registerResScript,
  type CompletionProviderLike,
  type DefinitionProviderLike,
  type FormattingProviderLike,
  type HoverProviderLike,
  type MonacoLike,
  type TextModelLike,
} from '@/code-editor/register';
import { fixtureRegistry } from '@/test/dsl-fixture';

interface Recorder {
  readonly monaco: MonacoLike;
  readonly languages: { id: string; extensions?: string[]; aliases?: string[] }[];
  readonly configurations: unknown[];
  readonly monarch: { id: string; provider: unknown }[];
  readonly completion: { id: string; provider: CompletionProviderLike }[];
  readonly hover: { id: string; provider: HoverProviderLike }[];
  readonly definition: { id: string; provider: DefinitionProviderLike }[];
  readonly formatting: { id: string; provider: FormattingProviderLike }[];
  readonly markers: { owner: string; markers: readonly unknown[] }[];
}

function recorder(): Recorder {
  const r: Omit<Recorder, 'monaco'> = {
    languages: [],
    configurations: [],
    monarch: [],
    completion: [],
    hover: [],
    definition: [],
    formatting: [],
    markers: [],
  };
  const monaco: MonacoLike = {
    languages: {
      register: (language) => r.languages.push(language),
      setLanguageConfiguration: (id, config) => r.configurations.push({ id, config }),
      setMonarchTokensProvider: (id, provider) => r.monarch.push({ id, provider }),
      registerCompletionItemProvider: (id, provider) => r.completion.push({ id, provider }),
      registerHoverProvider: (id, provider) => r.hover.push({ id, provider }),
      registerDefinitionProvider: (id, provider) => r.definition.push({ id, provider }),
      registerDocumentFormattingEditProvider: (id, provider) => r.formatting.push({ id, provider }),
    },
    editor: {
      setModelMarkers: (_model, owner, markers) => r.markers.push({ owner, markers }),
    },
    Uri: { parse: (value) => ({ uri: value }) },
  };
  return { ...r, monaco } as Recorder;
}

function model(source: string): TextModelLike {
  return {
    getValue: () => source,
    // The same UTF-16 arithmetic Monaco does, so a position from a test is a position from Monaco.
    getOffsetAt: (position) => {
      const lines = source.split('\n').slice(0, position.lineNumber - 1);
      return lines.reduce((sum, line) => sum + line.length + 1, 0) + position.column - 1;
    },
  };
}

const services = { environment: () => ({ registry: fixtureRegistry() }) };

describe('registerResScript', () => {
  it('registers the language exactly as §7.4 specifies', () => {
    const r = recorder();
    registerResScript(r.monaco, services);
    expect(r.languages).toEqual([{ id: 'rescript', extensions: ['.rsl'], aliases: ['ResScript'] }]);
    expect(r.configurations).toEqual([{ id: 'rescript', config: RESCRIPT_LANGUAGE_CONFIGURATION }]);
    expect(r.monarch).toEqual([{ id: 'rescript', provider: RESCRIPT_MONARCH }]);

    const config = RESCRIPT_LANGUAGE_CONFIGURATION;
    expect(config.comments?.lineComment).toBe('#');
    expect(config.brackets).toEqual([['(', ')'], ['[', ']']]);
    expect(config.autoClosingPairs).toEqual([
      { open: '(', close: ')' },
      { open: '[', close: ']' },
      { open: '"', close: '"' },
    ]);
    expect('IF S1 = 1').toMatch(config.indentationRules?.increaseIndentPattern as RegExp);
    expect('  END').toMatch(config.indentationRules?.decreaseIndentPattern as RegExp);
    expect('QUESTION Q5').toMatch(config.folding?.markers?.start as RegExp);
    expect('END').toMatch(config.folding?.markers?.end as RegExp);
  });

  it('registers every provider against the `rescript` id and only once per monaco instance', () => {
    const r = recorder();
    registerResScript(r.monaco, services);
    registerResScript(r.monaco, services); // a second editor mounting
    expect(r.completion.map((c) => c.id)).toEqual(['rescript']);
    expect(r.hover).toHaveLength(1);
    expect(r.definition).toHaveLength(1);
    expect(r.formatting).toHaveLength(1);
    expect(r.completion[0]?.provider.triggerCharacters).toEqual(['.', ' ', '[', '"']);
  });

  it('maps our completion items into Monaco suggestions with a replacement range', () => {
    const r = recorder();
    registerResScript(r.monaco, services);
    const source = 'IF HEAV';
    const suggestions =
      r.completion[0]?.provider.provideCompletionItems(model(source), {
        lineNumber: 1,
        column: source.length + 1,
      }).suggestions ?? [];

    const heavy = suggestions.find((s) => s.label === 'HEAVY_BUYER');
    expect(heavy).toBeDefined();
    // The partial word is REPLACED, not appended to: `range` covers `HEAV`.
    expect(heavy?.range).toEqual({ startLineNumber: 1, startColumn: 4, endLineNumber: 1, endColumn: 8 });
  });

  it('calls the studio navigation on go-to-definition and returns null to Monaco', () => {
    const r = recorder();
    const onNavigate = vi.fn();
    registerResScript(r.monaco, { ...services, onNavigate });
    const source = 'IF S1 = 1 THEN SHOW Q12\n';
    const value = r.definition[0]?.provider.provideDefinition(model(source), {
      lineNumber: 1,
      column: source.indexOf('Q12') + 2,
    });
    expect(value).toBeNull();
    expect(onNavigate).toHaveBeenCalledWith(expect.objectContaining({ kind: 'question', ref: 'Q12' }));
  });

  it('formats with print(parse(src)) and refuses to format source that does not parse', () => {
    const r = recorder();
    registerResScript(r.monaco, services);
    const provider = r.formatting[0]?.provider;

    // Lower-case keywords and a doubled space; the ref keeps its case, because refs are
    // case-sensitive and `s1` would be an unknown variable rather than sloppy formatting.
    const messy = 'if S1 == 1 then show   Q12\n';
    const edits = provider?.provideDocumentFormattingEdits(model(messy)) as { text: string }[];
    expect(edits[0]?.text).toBe('IF S1 = 1 THEN SHOW Q12\n');

    // Idempotent by D §6.4 T2: formatting the formatted text is a no-op, which is what keeps
    // format-on-save from fighting the author.
    expect(provider?.provideDocumentFormattingEdits(model('IF S1 = 1 THEN SHOW Q12\n'))).toEqual([]);
    // Broken source formats to nothing rather than to the printer's guess.
    expect(provider?.provideDocumentFormattingEdits(model('IF S1 = '))).toEqual([]);
  });
});

describe('applyMarkers', () => {
  it('writes under the ResScript owner with a parsed docs Uri, and clears the same owner', () => {
    const r = recorder();
    const source = 'IF NOPE = 1 THEN SHOW Q12\n';
    const { diagnostics } = parse(source, fixtureRegistry());
    const written = applyMarkers(r.monaco, model(source), source, diagnostics);

    expect(written).toHaveLength(diagnostics.length);
    expect(r.markers[0]?.owner).toBe('resscript');
    const marker = r.markers[0]?.markers[0] as { code: { target: unknown }; startColumn: number };
    expect(marker.code.target).toEqual({ uri: '/docs/diagnostics/LGC-T001' });
    expect(marker.startColumn).toBe(4);

    clearMarkers(r.monaco, model(source));
    expect(r.markers[1]).toEqual({ owner: 'resscript', markers: [] });
  });
});
