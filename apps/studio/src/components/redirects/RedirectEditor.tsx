/**
 * The redirect editor — API §2.9, roadmap P2-10's Frontend line ("Redirect editor per disposition,
 * per vendor, per language, with a live resolved-URL preview").
 *
 * ## Why the preview is the point of the screen
 *
 * A redirect template is a string a panel gave a programmer over email, carrying `{{VAR}}` piping
 * and an optional `{{HMAC}}`. Nobody can read one and be sure what a respondent will be sent to,
 * and the failure mode is that they find out from a client whose completes were never credited. So
 * this control renders the RESOLVED url beside the template as it is typed.
 *
 * The preview interpolates against SAMPLE values, and says so on screen. That distinction matters:
 * a preview that looked authoritative would be read as a guarantee, and the real resolution happens
 * at finalization against a session's actual variables — where `pii: true` variables are BLOCKED
 * (`CMP-0301`, with no override), which the preview shows by refusing to substitute them too.
 *
 * ## Coverage is shown, not just validity
 *
 * `CMP-0300` refuses to publish a survey whose flow can reach a termination with no redirect, and
 * the synthesized flow always reaches `COMPLETE` — so an author who saves a valid but incomplete set
 * gets a publish error later. `missingRedirectCoverage` is the same computation the API's coverage
 * endpoint runs, called here so the gap appears while they are editing rather than at publish.
 *
 * ## Prop-driven
 *
 * No QueryClient, no fetch. `onSave` is the container's, and every refusal below is testable without
 * a network.
 */

'use client';

import { useMemo, useState } from 'react';
import { REDIRECT_REQUIRED_DISPOSITIONS } from '@resscript/schema';

import { missingRedirectCoverage, redirectSetDiagnostics } from '@/server/redirects';
import type { RedirectRow } from '@/server/repo/types';

export interface RedirectEditorProps {
  readonly redirects: readonly RedirectRow[];
  /**
   * Variables a template may pipe, with a sample value for the preview.
   *
   * `pii` is carried because a `pii: true` variable is REFUSED in a redirect template by
   * `CMP-0301`, with no override — so the preview must not substitute one, or it would show an
   * author a URL the compiler will reject.
   */
  readonly variables: readonly { readonly name: string; readonly sample: string; readonly pii: boolean }[];
  /** Vendor refs, for the `by_vendor` scope key. Empty until vendors are configured. */
  readonly vendorRefs: readonly string[];
  readonly languages: readonly string[];
  readonly onSave: (rows: readonly RedirectRow[]) => void;
  readonly disabled?: boolean;
  readonly errors?: Readonly<Record<string, string>>;
  readonly pending?: boolean;
}

/**
 * Interpolate a template against sample values, the way the runtime's `pipe` would.
 *
 * Deliberately NOT an import of the real engine: `packages/runtime-core`'s `pipe` takes a resolved
 * variable map and an escape context, and wiring it here would mean this control claiming to be
 * authoritative. It is a preview, it says so, and its one job is to show an author where their
 * placeholders land and which of them will not resolve.
 *
 * A `pii` variable is left AS ITS PLACEHOLDER and reported, because `CMP-0301` refuses the template
 * outright — substituting it would show a URL that cannot be published.
 */
export function previewTemplate(
  template: string,
  variables: readonly { readonly name: string; readonly sample: string; readonly pii: boolean }[],
): { readonly url: string; readonly unresolved: readonly string[]; readonly blockedPii: readonly string[] } {
  const byName = new Map(variables.map((v) => [v.name, v]));
  const unresolved: string[] = [];
  const blockedPii: string[] = [];

  const url = template.replace(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g, (whole, rawName: string) => {
    const name = rawName.split('.')[0] ?? rawName;
    // `{{HMAC}}` is computed by the runtime from the interpolated query and a vendor secret, so
    // there is nothing to preview and its absence is not a problem to report.
    if (name === 'HMAC') return '<signature>';
    const v = byName.get(name);
    if (v === undefined) {
      unresolved.push(name);
      return whole;
    }
    if (v.pii) {
      blockedPii.push(name);
      return whole;
    }
    return encodeURIComponent(v.sample);
  });

  return { url, unresolved: [...new Set(unresolved)], blockedPii: [...new Set(blockedPii)] };
}

function blankRow(): RedirectRow {
  return {
    scope: 'default',
    scope_key: '',
    disposition: 'COMPLETE',
    custom_key: '',
    url_template: '',
  };
}

export function RedirectEditor({
  redirects,
  variables,
  vendorRefs,
  languages,
  onSave,
  disabled = false,
  errors = {},
  pending = false,
}: RedirectEditorProps): React.JSX.Element {
  const [rows, setRows] = useState<readonly RedirectRow[]>(redirects);

  // The SAME functions the API runs, called here so a problem appears while editing rather than in
  // a 422 — and so the two cannot disagree about what a valid set is.
  const details = useMemo(() => redirectSetDiagnostics(rows), [rows]);
  const missing = useMemo(() => missingRedirectCoverage(rows), [rows]);

  const localByPath = useMemo(() => {
    const out: Record<string, string> = {};
    for (const d of details) if (d.path !== null) out[d.path] = d.message;
    return out;
  }, [details]);
  const shown: Readonly<Record<string, string>> = { ...localByPath, ...errors };
  const blocked = details.length > 0;

  const update = (i: number, next: RedirectRow): void => {
    setRows(rows.map((r, j) => (j === i ? next : r)));
  };

  return (
    <section aria-label="Redirects">
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {rows.map((row, i) => {
          const preview = previewTemplate(row.url_template, variables);
          const err = (f: string): string | undefined => shown[`redirects.${String(i)}.${f}`];
          return (
            <li key={String(i)} style={{ border: '1px solid #c9c9c9', padding: 12, marginBottom: 12 }}>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <label>
                  Scope
                  <select
                    aria-label={`Redirect ${String(i + 1)} scope`}
                    value={row.scope}
                    disabled={disabled}
                    onChange={(e) => {
                      const scope = e.target.value as RedirectRow['scope'];
                      // `''` is the TABLE's encoding of "not applicable" (0010's biconditional
                      // CHECKs), so switching to `default` clears the key rather than leaving a
                      // stale one that makes the row silently never match.
                      update(i, { ...row, scope, scope_key: scope === 'default' ? '' : row.scope_key });
                    }}
                  >
                    <option value="default">default</option>
                    <option value="vendor">vendor</option>
                    <option value="language">language</option>
                  </select>
                </label>

                {row.scope !== 'default' && (
                  <label>
                    {row.scope === 'vendor' ? 'Vendor' : 'Language'}
                    <select
                      aria-label={`Redirect ${String(i + 1)} scope key`}
                      value={row.scope_key}
                      disabled={disabled}
                      onChange={(e) => update(i, { ...row, scope_key: e.target.value })}
                    >
                      <option value="">Choose…</option>
                      {(row.scope === 'vendor' ? vendorRefs : languages).map((k) => (
                        <option key={k} value={k}>
                          {k}
                        </option>
                      ))}
                    </select>
                  </label>
                )}

                <label>
                  Disposition
                  <select
                    aria-label={`Redirect ${String(i + 1)} disposition`}
                    value={row.disposition}
                    disabled={disabled}
                    onChange={(e) => {
                      const disposition = e.target.value;
                      // Same biconditional, the other way: only CUSTOM carries a key.
                      update(i, {
                        ...row,
                        disposition,
                        custom_key: disposition === 'CUSTOM' ? row.custom_key : '',
                      });
                    }}
                  >
                    {REDIRECT_REQUIRED_DISPOSITIONS.map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                  </select>
                </label>

                {row.disposition === 'CUSTOM' && (
                  <label>
                    Custom key
                    <input
                      aria-label={`Redirect ${String(i + 1)} custom key`}
                      value={row.custom_key}
                      disabled={disabled}
                      onChange={(e) => update(i, { ...row, custom_key: e.target.value })}
                    />
                  </label>
                )}

                <button type="button" disabled={disabled} onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                  {`Remove redirect ${String(i + 1)}`}
                </button>
              </div>

              <label style={{ display: 'block', marginTop: 6 }}>
                URL template
                <input
                  aria-label={`Redirect ${String(i + 1)} url template`}
                  value={row.url_template}
                  disabled={disabled}
                  style={{ width: '100%' }}
                  onChange={(e) => update(i, { ...row, url_template: e.target.value })}
                />
              </label>

              {/* The live preview P2-10's Frontend line asks for, labelled as a preview so it is
                  not read as a guarantee — the real resolution happens at finalization against a
                  session's actual variables. */}
              {row.url_template !== '' && (
                <p aria-label={`Redirect ${String(i + 1)} preview`}>
                  {`Preview (sample values): ${preview.url}`}
                </p>
              )}
              {preview.unresolved.length > 0 && (
                <p role="alert">
                  {`No such variable: ${preview.unresolved.join(', ')}. A placeholder that resolves ` +
                    'to nothing is sent as-is, so the panel receives a literal {{…}}.'}
                </p>
              )}
              {preview.blockedPii.length > 0 && (
                <p role="alert">
                  {`${preview.blockedPii.join(', ')} is marked pii, and CMP-0301 refuses a pii ` +
                    'variable in a redirect template with no override — publishing will fail until ' +
                    'it is removed.'}
                </p>
              )}
              {err('url_template') !== undefined && <p role="alert">{err('url_template')}</p>}
              {err('scope_key') !== undefined && <p role="alert">{err('scope_key')}</p>}
              {err('custom_key') !== undefined && <p role="alert">{err('custom_key')}</p>}
            </li>
          );
        })}
      </ul>

      <button type="button" disabled={disabled} onClick={() => setRows([...rows, blankRow()])}>
        Add redirect
      </button>

      {/* Coverage, not just validity. CMP-0300 refuses a publish whose flow can reach a termination
          with nowhere to send the respondent, and the synthesized flow always reaches COMPLETE — so
          without this an author saves a valid set and meets the error at publish. */}
      {missing.length > 0 && (
        <p role="status">
          {`${String(missing.length)} disposition(s) have no redirect: ` +
            `${missing.map((m) => m.disposition).join(', ')}. Publishing is blocked until every ` +
            'one has somewhere to send the respondent (CMP-0300).'}
        </p>
      )}

      {blocked && (
        <p role="status">{`${String(details.length)} row(s) to fix before saving`}</p>
      )}

      <button
        type="button"
        disabled={disabled || pending || blocked}
        onClick={() => onSave(rows)}
      >
        {pending ? 'Saving…' : 'Save redirects'}
      </button>
    </section>
  );
}
