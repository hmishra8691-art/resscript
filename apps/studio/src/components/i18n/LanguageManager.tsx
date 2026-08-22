/**
 * The language manager (roadmap P1-12 Frontend: "Language manager with per-string state and a
 * completeness gauge").
 *
 * ## Everything it shows is SERVER math
 *
 * The gauge renders `complete_pct` off `GET /versions/:id/translations` and never re-derives
 * it: the denominator is the BASE language's key set, which only the server has whole (the
 * summary route's header says why), and a client-side recount would drift the moment either
 * side changed what "translated" means. The same applies to per-string state — the `?lang=`
 * detail materializes missing keys as `missing` server-side, so this component renders rows,
 * it does not infer them.
 *
 * ## Export is a download, import is a file — both are THE flat file
 *
 * Export fetches `GET /translations/:lang` (the body IS the file) and hands it to the browser
 * as a Blob download; import reads a picked file, parses it as JSON, and PUTs it verbatim.
 * No transformation in either direction, deliberately: the round trip is the contract, and a
 * component that "helpfully" reshaped the file would be a second file format. An import whose
 * keys the base does not carry comes back as a 422 naming every offending key, rendered
 * inline — the translator's typo is a message, never a silent no-op.
 *
 * ## What it refuses to hide
 *
 * Add-language is rendered DISABLED with the reason when the viewer is below the programmer
 * floor (F §7: "shown as unavailable, never hidden"), same for import below reviewer. Like
 * `PreviewPanel`, this component owns its fetching — it is a pane, not a form control.
 */

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { OrgRole } from '@resscript/schema';
import { meetsRole } from '@/server/auth';
import { ApiError, apiFetch } from '@/lib/api-client';
import type {
  TranslationImportResultView,
  TranslationLanguageView,
  TranslationsSummaryView,
} from '@/lib/api-types';

export interface LanguageManagerProps {
  readonly versionId: string;
  /** The viewer's role in the active org, as the membership row states it. */
  readonly role: OrgRole | null;
}

export function LanguageManager({ versionId, role }: LanguageManagerProps): React.JSX.Element {
  const [summary, setSummary] = useState<TranslationsSummaryView | null>(null);
  const [detailLang, setDetailLang] = useState<string | null>(null);
  const [newLang, setNewLang] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const importLang = useRef<string | null>(null);

  const canImport = meetsRole(role, 'reviewer');
  const canAddLanguage = meetsRole(role, 'programmer');

  const load = useCallback(
    async (lang: string | null): Promise<void> => {
      try {
        const { data } = await apiFetch<TranslationsSummaryView>(
          '/versions/' + versionId + '/translations' + (lang === null ? '' : '?lang=' + encodeURIComponent(lang)),
        );
        setSummary(data);
        setError(null);
      } catch (err: unknown) {
        setError(err instanceof ApiError ? err.message : 'could not reach the studio API');
      }
    },
    [versionId],
  );

  useEffect(() => {
    setDetailLang(null);
    void load(null);
  }, [versionId, load]);

  const addLanguage = async (): Promise<void> => {
    setError(null);
    setNotice(null);
    try {
      await apiFetch('/versions/' + versionId + '/translations', {
        method: 'POST',
        body: { lang: newLang.trim() },
      });
      setNewLang('');
      setNotice('added ' + newLang.trim());
      await load(detailLang);
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : 'could not reach the studio API');
    }
  };

  const exportLanguage = async (lang: string): Promise<void> => {
    setError(null);
    try {
      const { data } = await apiFetch<Record<string, string>>(
        '/versions/' + versionId + '/translations/' + encodeURIComponent(lang),
      );
      // The body IS the file: two-space indent for hand-editing, no reshaping (the header).
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = versionId + '.' + lang + '.json';
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : 'could not reach the studio API');
    }
  };

  const importFile = async (file: File, lang: string): Promise<void> => {
    setError(null);
    setNotice(null);
    let body: unknown;
    try {
      body = JSON.parse(await file.text());
    } catch {
      setError('that file is not valid JSON');
      return;
    }
    try {
      const { data } = await apiFetch<TranslationImportResultView>(
        '/versions/' + versionId + '/translations/' + encodeURIComponent(lang),
        { method: 'PUT', body },
      );
      setNotice(
        `imported ${String(data.written)} ${lang} string(s)` +
          (data.cleared > 0 ? ` (${String(data.cleared)} cleared back to missing)` : ''),
      );
      await load(detailLang);
    } catch (err: unknown) {
      if (err instanceof ApiError && err.details.length > 0) {
        // The 422 names every offending key — surface them all, not the first.
        setError(err.message + ': ' + err.details.map((d) => d.path ?? d.message).join(', '));
      } else {
        setError(err instanceof ApiError ? err.message : 'could not reach the studio API');
      }
    }
  };

  if (summary === null) {
    return error === null ? (
      <p className="rs-muted">Loading languages…</p>
    ) : (
      <p role="alert">{error}</p>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
      <table className="rs-table" data-testid="language-list">
        <thead>
          <tr>
            <th>Language</th>
            <th>Completeness</th>
            <th>Translated</th>
            <th>Reviewed</th>
            <th>Machine</th>
            <th>Missing</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {summary.languages.map((language) => (
            <LanguageGaugeRow
              key={language.lang}
              language={language}
              canImport={canImport}
              selected={detailLang === language.lang}
              onSelect={() => {
                const next = detailLang === language.lang ? null : language.lang;
                setDetailLang(next);
                void load(next);
              }}
              onExport={() => {
                void exportLanguage(language.lang);
              }}
              onImport={() => {
                importLang.current = language.lang;
                fileInput.current?.click();
              }}
            />
          ))}
        </tbody>
      </table>

      {/* One hidden input shared by every Import button; the ref carries which language. */}
      <input
        ref={fileInput}
        type="file"
        accept="application/json,.json"
        style={{ display: 'none' }}
        data-testid="translation-import-file"
        onChange={(event) => {
          const file = event.target.files?.[0];
          const lang = importLang.current;
          event.target.value = '';
          if (file !== undefined && lang !== null) void importFile(file, lang);
        }}
      />

      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <span className="rs-muted">Add language</span>
          <input
            className="rs-input"
            value={newLang}
            size={8}
            placeholder="fr-CA"
            disabled={!canAddLanguage}
            onChange={(event) => {
              setNewLang(event.target.value.trim());
            }}
          />
        </label>
        <button
          type="button"
          className="rs-button"
          disabled={!canAddLanguage || newLang === ''}
          onClick={() => {
            void addLanguage();
          }}
        >
          Add
        </button>
        {/* Never hidden, always explained (F §7): who to ask beats a missing control. */}
        {canAddLanguage ? null : (
          <span className="rs-muted">
            adding a language requires the programmer role or higher
            {role === null ? '' : ' (you are ' + role + ')'}
          </span>
        )}
      </div>

      {error === null ? null : (
        <p role="alert" data-testid="i18n-error">
          {error}
        </p>
      )}
      {notice === null ? null : (
        <p className="rs-muted" data-testid="i18n-notice">
          {notice}
        </p>
      )}

      {detailLang !== null && summary.strings !== undefined ? (
        <table className="rs-table" data-testid="string-states">
          <thead>
            <tr>
              <th>Key</th>
              <th>{detailLang}</th>
              <th>State</th>
            </tr>
          </thead>
          <tbody>
            {summary.strings.map((row) => (
              <tr key={row.key}>
                <td>
                  <code>{row.key}</code>
                </td>
                <td>{row.value ?? <span className="rs-muted">—</span>}</td>
                <td>{row.state}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}

function LanguageGaugeRow({
  language,
  canImport,
  selected,
  onSelect,
  onExport,
  onImport,
}: {
  readonly language: TranslationLanguageView;
  readonly canImport: boolean;
  readonly selected: boolean;
  readonly onSelect: () => void;
  readonly onExport: () => void;
  readonly onImport: () => void;
}): React.JSX.Element {
  return (
    <tr data-testid={'language-' + language.lang}>
      <td>
        <button type="button" className="rs-button" aria-pressed={selected} onClick={onSelect}>
          {language.lang}
        </button>{' '}
        {language.is_base ? <span className="rs-muted">(base)</span> : null}
        {language.rtl ? <span className="rs-muted"> rtl</span> : null}
      </td>
      <td>
        {/* The gauge: a plain meter over the SERVER's percentage — one denominator. */}
        <meter min={0} max={100} value={language.complete_pct} /> {language.complete_pct}%
      </td>
      <td>{language.translated}</td>
      <td>{language.reviewed}</td>
      <td>{language.machine}</td>
      <td>{language.missing}</td>
      <td style={{ whiteSpace: 'nowrap' }}>
        <button type="button" className="rs-button" onClick={onExport}>
          Export
        </button>{' '}
        <button type="button" className="rs-button" disabled={!canImport} onClick={onImport}>
          Import
        </button>
      </td>
    </tr>
  );
}
