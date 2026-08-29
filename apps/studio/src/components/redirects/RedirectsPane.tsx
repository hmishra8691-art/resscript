'use client';

/**
 * The container that makes `RedirectEditor` reachable.
 *
 * The editor itself has existed, complete and tested, since P2-10 — and was rendered nowhere. The
 * API route (`GET`/`PUT /versions/{id}/redirects`), the repo methods and the coverage endpoint were
 * all built too. The one missing piece was this: something to fetch the four inputs the editor
 * takes and hand its output back to the route.
 *
 * The cost of that gap was concrete. `CMP-0300` refuses to publish any survey whose flow can reach
 * `COMPLETE` with nowhere to send the respondent, and the synthesized flow always can — so EVERY
 * survey hits it, and there was no way to answer it except an INSERT into `content.redirects` by
 * hand. That is the same shape as three other findings in this codebase: machinery that works,
 * with nothing wired to it.
 *
 * ## Why four fetches
 *
 * `RedirectEditor` is prop-driven, like every component under `components/` — it renders and
 * validates, and knows nothing about HTTP. It needs:
 *
 *   * the redirects themselves;
 *   * the variables a template may pipe, WITH their `pii` flag, because `CMP-0301` refuses a
 *     pii-flagged variable in a redirect and the editor's preview must not offer one;
 *   * the vendor refs, for the `by_vendor` scope key;
 *   * the languages, for `by_language`.
 *
 * There is no `GET /versions/{id}/languages` route (the API doc lists one; it was never built), so
 * the languages come from the translations summary, which carries a row per language and is the
 * same source the Translations tab renders. Deriving them rather than adding a route keeps this
 * change to one file; the missing route is worth adding on its own terms, not as a side effect.
 *
 * The three secondary fetches are best-effort: a failure there disables a scope selector or empties
 * the preview's variable list, which is a degraded editor rather than no editor. The redirects
 * fetch is not — without it there is nothing to edit, and pretending otherwise would let someone
 * save an empty set over a real one.
 */

import { useCallback, useEffect, useState } from 'react';

import { ApiError, apiFetch } from '@/lib/api-client';
import type { OrgRole } from '@resscript/schema';
import type { RedirectRow } from '@/server/repo/types';
import { RedirectEditor } from './RedirectEditor';

interface RedirectsView {
  readonly survey_version_id: string;
  readonly redirects: readonly RedirectRow[];
}

interface VariablesView {
  readonly data: readonly {
    readonly name: string;
    readonly vtype: string;
    readonly pii: boolean;
  }[];
}

interface VendorsView {
  readonly vendors: readonly { readonly ref: string }[];
}

interface TranslationsView {
  readonly languages: readonly { readonly lang: string }[];
}

/**
 * A sample value per type, for the editor's URL preview.
 *
 * Not a real respondent value — there is no session here — and deliberately obvious as a sample, so
 * an author reading the preview cannot mistake it for what a panel will actually receive.
 */
function sampleFor(vtype: string): string {
  switch (vtype) {
    case 'number':
      return '42';
    case 'date':
      return '2026-01-31';
    case 'bool':
      return 'true';
    default:
      return 'sample';
  }
}

export function RedirectsPane({
  versionId,
  role,
}: {
  readonly versionId: string;
  readonly role: OrgRole | null;
}): React.JSX.Element {
  const [redirects, setRedirects] = useState<readonly RedirectRow[]>([]);
  const [variables, setVariables] = useState<
    readonly { name: string; sample: string; pii: boolean }[]
  >([]);
  const [vendorRefs, setVendorRefs] = useState<readonly string[]>([]);
  const [languages, setLanguages] = useState<readonly string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [saveErrors, setSaveErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  // Reading redirects is at the PROGRAMMER floor, not reviewer: the route says why — a redirect row
  // is a vendor relationship, which is not part of what a review link is for.
  const readOnly = role !== 'owner' && role !== 'admin' && role !== 'programmer';

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const { data } = await apiFetch<RedirectsView>('/versions/' + versionId + '/redirects');
      setRedirects(data.redirects);
      setLoaded(true);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : 'could not load redirects');
      return;
    }

    // Best-effort, each independently: a failure degrades one control rather than the pane.
    try {
      const { data } = await apiFetch<VariablesView>('/versions/' + versionId + '/variables');
      setVariables(
        data.data.map((v) => ({ name: v.name, sample: sampleFor(v.vtype), pii: v.pii })),
      );
    } catch {
      setVariables([]);
    }
    try {
      const { data } = await apiFetch<VendorsView>('/versions/' + versionId + '/vendors');
      setVendorRefs(data.vendors.map((v) => v.ref).filter((ref) => ref !== ''));
    } catch {
      setVendorRefs([]);
    }
    try {
      const { data } = await apiFetch<TranslationsView>('/versions/' + versionId + '/translations');
      setLanguages(data.languages.map((l) => l.lang));
    } catch {
      setLanguages([]);
    }
  }, [versionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = (rows: readonly RedirectRow[]): void => {
    setPending(true);
    setSaveErrors({});
    setSaved(null);
    void (async () => {
      try {
        // The route REPLACES the whole set, so the editor's output is sent verbatim rather than
        // diffed — a diff here would be a second definition of what a redirect set is.
        await apiFetch('/versions/' + versionId + '/redirects', {
          method: 'PUT',
          body: { redirects: rows },
        });
        setRedirects(rows);
        setSaved(`${String(rows.length)} redirect${rows.length === 1 ? '' : 's'} saved`);
      } catch (err) {
        if (err instanceof ApiError) {
          // 422 details are addressed `redirects.<index>.<field>` because the rows are not stored
          // and the submitted index is the only address the client has. Passed through to the
          // editor, which renders them per row.
          const details: Record<string, string> = {};
          for (const detail of err.details ?? []) {
            // `path` is nullable: a detail with no path is about the request rather than a row,
            // and belongs in the form-level message instead of keyed under "null".
            if (detail.path === null) details['form'] = detail.message;
            else details[detail.path] = detail.message;
          }
          setSaveErrors(
            Object.keys(details).length > 0 ? details : { form: err.message },
          );
        } else {
          setSaveErrors({ form: 'could not save redirects' });
        }
      } finally {
        setPending(false);
      }
    })();
  };

  if (loadError !== null) {
    return (
      <p className="rs-muted" data-testid="redirects-load-error">
        {loadError}
      </p>
    );
  }

  /*
   * The editor is not mounted until its rows are in hand, and that is load-bearing rather than
   * cosmetic.
   *
   * `RedirectEditor` seeds its draft with `useState(redirects)` — an INITIAL value, which React
   * does not revisit when the prop changes. That is the right design for an editor (once someone
   * is typing, a refetch must not overwrite them), and it means a container that mounts it before
   * the fetch resolves hands it `[]` forever: the rows arrive, the prop updates, and the editor
   * goes on rendering the empty draft it started with. Cost me a test run to see, and it would have
   * shipped as "the redirects tab is always empty".
   */
  if (!loaded) {
    return (
      <p className="rs-muted" data-testid="redirects-loading">
        Loading redirects…
      </p>
    );
  }

  return (
    <section data-testid="redirects-pane">
      <p className="rs-muted" style={{ marginTop: 0 }}>
        Where a respondent goes when they finish. A survey whose flow can reach a disposition with
        no redirect cannot be published (<code>CMP-0300</code>) — a <strong>default</strong>-scope
        row covers every language and vendor.
      </p>
      {saveErrors['form'] === undefined ? null : (
        <p className="rs-error" data-testid="redirects-save-error">
          {saveErrors['form']}
        </p>
      )}
      {saved === null ? null : (
        <p className="rs-muted" data-testid="redirects-saved">
          {saved}
        </p>
      )}
      <RedirectEditor
        redirects={redirects}
        variables={variables}
        vendorRefs={vendorRefs}
        languages={languages}
        onSave={save}
        disabled={readOnly}
        errors={saveErrors}
        pending={pending}
      />
    </section>
  );
}
