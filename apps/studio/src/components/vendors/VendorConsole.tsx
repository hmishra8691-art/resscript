/**
 * The vendor console — API §2.16, migration 0024, roadmap P2-04's Frontend line.
 *
 * ## What this screen is actually for
 *
 * A vendor row decides three security-relevant things: which `?src=` value identifies a panel,
 * which query parameters may write into a variable, and what an entry signature is checked against.
 * Every one of them fails quietly when wrong — an unsigned vendor accepts forged links, an
 * over-broad inbound allowlist lets a respondent set a quota dimension by editing the URL, and a
 * pasted secret ends up on a CDN. So this control's job is less "edit a form" than "make the
 * dangerous states hard to reach and obvious when reached".
 *
 * ## Signed is an explicit choice, not a default
 *
 * The signing block is behind a checkbox that starts UNCHECKED, and an unsigned vendor is a real
 * configuration (a QR code, a client's own mailing list). The alternative — a signing block that is
 * always visible with empty fields — reads as "configured, incompletely", which is exactly the
 * half-state 0024's `vendors_security_all_or_none` CHECK makes unstorable. A screen should not offer
 * a shape the database refuses.
 *
 * ## The secret_ref warning fires while typing
 *
 * 0024 refuses a secret-shaped value and the compiler throws at publish, but both are AFTER the
 * paste. This is the layer that is in front of it, so the warning appears as the field changes
 * rather than on submit: an author who has just pasted an HMAC key needs to know before they move
 * on, and a validation error on save is a validation error they read after tabbing away.
 *
 * ## Prop-driven
 *
 * No QueryClient, no fetch. `onSave` is the container's, which keeps the optimistic-update policy
 * out of the control and makes every refusal below testable without a network.
 */

'use client';

import { useId, useMemo, useState } from 'react';

/** 0024's `vendor_hash_algorithm`. sha1 and md5 exist because panels use them; sha256 is default. */
export const VENDOR_ALGORITHMS = ['sha256', 'sha1', 'md5'] as const;
export type VendorAlgorithm = (typeof VENDOR_ALGORITHMS)[number];

/** What a pasted HMAC key looks like — 0024's CHECK and the compiler's heuristic, restated. */
const LOOKS_LIKE_SECRET = /^[A-Za-z0-9+/=_-]{32,}$/;

export interface VendorDraftParam {
  readonly param: string;
  readonly variable_ref: string;
  readonly required: boolean;
}

export interface VendorDraft {
  readonly id: string;
  readonly ref: string;
  readonly name: string;
  readonly max_completes: number | null;
  readonly inbound_params: readonly VendorDraftParam[];
  readonly security: {
    readonly hash_param: string;
    readonly algorithm: VendorAlgorithm;
    readonly secret_ref: string;
    readonly signed_params: readonly string[];
  } | null;
}

export interface VendorConsoleProps {
  readonly vendors: readonly VendorDraft[];
  /**
   * Variables an inbound parameter may target — HIDDEN ones only.
   *
   * The caller filters, because the reason is the runtime's: `bindInboundParams` refuses a
   * `response` or `system` target, since an entry link that pre-answered a question would make the
   * export disagree with what was asked. Offering one in a picker and having the runtime drop it
   * silently is worse than not offering it.
   */
  readonly hiddenVariables: readonly string[];
  readonly onSave: (vendors: readonly VendorDraft[]) => void;
  readonly disabled?: boolean;
  /** Server-side detail paths from a 422, keyed `vendors.<i>.<field>`. Rendered inline. */
  readonly errors?: Readonly<Record<string, string>>;
  readonly pending?: boolean;
}

/**
 * Client-side mirrors of the refusals the API and 0024 make.
 *
 * Duplicated on purpose, and the duplication is the feature: the server is the authority and this is
 * the layer that stops an author discovering a problem one round trip later. Every message here says
 * what breaks rather than which constraint fired, because an author cannot act on
 * `vendors_ref_key`.
 */
export function vendorDraftProblems(
  vendors: readonly VendorDraft[],
  hiddenVariables: readonly string[],
): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  const refs = new Map<string, number>();
  const known = new Set(hiddenVariables);

  vendors.forEach((v, i) => {
    if (v.ref.trim() === '') {
      out[`vendors.${String(i)}.ref`] = 'A ref is required — it is what ?src= matches.';
    } else if (refs.has(v.ref)) {
      out[`vendors.${String(i)}.ref`] =
        `Another vendor already uses ${v.ref}. The ref is what ?src= matches, so a duplicate ` +
        'makes which vendor an entry link belongs to non-deterministic.';
    } else {
      refs.set(v.ref, i);
    }
    if (v.name.trim() === '') out[`vendors.${String(i)}.name`] = 'A name is required.';
    if (v.max_completes !== null && v.max_completes <= 0) {
      out[`vendors.${String(i)}.max_completes`] =
        'A ceiling of zero is a vendor you remove, not a vendor you cap.';
    }

    if (v.security !== null) {
      if (v.security.secret_ref.trim() === '') {
        out[`vendors.${String(i)}.security.secret_ref`] =
          'A signed vendor needs a secret reference.';
      } else if (LOOKS_LIKE_SECRET.test(v.security.secret_ref)) {
        // The warning this screen exists to show early.
        out[`vendors.${String(i)}.security.secret_ref`] =
          'That looks like the secret ITSELF, not a reference to it. Store the key in the secrets ' +
          'store and name it here (for example vendor/panel_a/hmac) — artifacts are served from a ' +
          'CDN, so a secret in a survey is a published secret.';
      }
      if (v.security.signed_params.length === 0) {
        out[`vendors.${String(i)}.security.signed_params`] =
          'Name at least one signed parameter: a signature over nothing verifies everything.';
      } else if (v.inbound_params.length > 0) {
        const declared = new Set(v.inbound_params.map((p) => p.param));
        if (!v.security.signed_params.some((p) => declared.has(p))) {
          out[`vendors.${String(i)}.security.signed_params`] =
            'None of these is a parameter this vendor declares, so the signature would cover ' +
            'nothing the panel actually sends.';
        }
      }
    }

    const params = new Set<string>();
    v.inbound_params.forEach((p, j) => {
      const at = `vendors.${String(i)}.inbound_params.${String(j)}`;
      if (!/^[A-Za-z0-9_.-]{1,64}$/.test(p.param)) {
        out[`${at}.param`] =
          'Use letters, digits, dot, dash or underscore. Anything else would split the ' +
          "signature's canonical string.";
      } else if (params.has(p.param)) {
        out[`${at}.param`] =
          'Two mappings for one parameter would make which variable it writes depend on ' +
          'iteration order.';
      } else {
        params.add(p.param);
      }
      if (p.variable_ref === '') {
        out[`${at}.variable_ref`] = 'Choose the hidden variable this parameter writes into.';
      } else if (!known.has(p.variable_ref)) {
        out[`${at}.variable_ref`] =
          `${p.variable_ref} is not a hidden variable in this version. A vendor config that ` +
          'outlived a variable rename binds nothing at entry.';
      }
    });
  });

  return out;
}

function blankVendor(index: number): VendorDraft {
  return {
    // A placeholder the container replaces with a minted ULID before saving. Deliberately NOT a
    // random id generated here: the console does not own identity, and a client-minted id that
    // reached the API would be an id nobody can trace to a mint.
    id: `new:${String(index)}`,
    ref: '',
    name: '',
    max_completes: null,
    inbound_params: [],
    // Unsigned by default — see the header. An empty signing block reads as "configured,
    // incompletely", which is the half-state 0024 makes unstorable.
    security: null,
  };
}

export function VendorConsole({
  vendors,
  hiddenVariables,
  onSave,
  disabled = false,
  errors = {},
  pending = false,
}: VendorConsoleProps): React.JSX.Element {
  const [draft, setDraft] = useState<readonly VendorDraft[]>(vendors);
  const baseId = useId();

  const localProblems = useMemo(
    () => vendorDraftProblems(draft, hiddenVariables),
    [draft, hiddenVariables],
  );
  // The SERVER's message wins where both have one: it saw the row the database saw.
  const shown: Readonly<Record<string, string>> = { ...localProblems, ...errors };
  const blocked = Object.keys(localProblems).length > 0;

  const update = (i: number, next: VendorDraft): void => {
    setDraft(draft.map((v, j) => (j === i ? next : v)));
  };

  return (
    <section aria-label="Vendors">
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {draft.map((v, i) => {
          const err = (field: string): string | undefined => shown[`vendors.${String(i)}.${field}`];
          return (
            <li key={v.id} style={{ border: '1px solid #c9c9c9', padding: 12, marginBottom: 12 }}>
              <div style={{ display: 'flex', gap: 8 }}>
                <label>
                  Ref
                  <input
                    aria-label={`Vendor ${String(i + 1)} ref`}
                    value={v.ref}
                    disabled={disabled}
                    onChange={(e) => update(i, { ...v, ref: e.target.value })}
                  />
                </label>
                <label>
                  Name
                  <input
                    aria-label={`Vendor ${String(i + 1)} name`}
                    value={v.name}
                    disabled={disabled}
                    onChange={(e) => update(i, { ...v, name: e.target.value })}
                  />
                </label>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => setDraft(draft.filter((_, j) => j !== i))}
                >
                  Remove
                </button>
              </div>
              {err('ref') !== undefined && <p role="alert">{err('ref')}</p>}
              {err('name') !== undefined && <p role="alert">{err('name')}</p>}

              <label style={{ display: 'block', marginTop: 8 }}>
                <input
                  type="checkbox"
                  aria-label={`Vendor ${String(i + 1)} entry links are signed`}
                  checked={v.security !== null}
                  disabled={disabled}
                  onChange={(e) =>
                    update(i, {
                      ...v,
                      security: e.target.checked
                        ? {
                            hash_param: 'hash',
                            algorithm: 'sha256',
                            secret_ref: '',
                            signed_params: [],
                          }
                        : null,
                    })
                  }
                />
                {' Entry links are signed'}
              </label>

              {v.security !== null && (
                <fieldset style={{ marginTop: 8 }}>
                  <legend>Signature</legend>
                  <label>
                    Secret reference
                    <input
                      aria-label={`Vendor ${String(i + 1)} secret reference`}
                      value={v.security.secret_ref}
                      disabled={disabled}
                      placeholder="vendor/panel_a/hmac"
                      onChange={(e) =>
                        update(i, {
                          ...v,
                          security: { ...v.security!, secret_ref: e.target.value },
                        })
                      }
                    />
                  </label>
                  {err('security.secret_ref') !== undefined && (
                    <p role="alert">{err('security.secret_ref')}</p>
                  )}
                  <label>
                    Algorithm
                    <select
                      aria-label={`Vendor ${String(i + 1)} algorithm`}
                      value={v.security.algorithm}
                      disabled={disabled}
                      onChange={(e) =>
                        update(i, {
                          ...v,
                          security: {
                            ...v.security!,
                            algorithm: e.target.value as VendorAlgorithm,
                          },
                        })
                      }
                    >
                      {VENDOR_ALGORITHMS.map((a) => (
                        <option key={a} value={a}>
                          {a}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Signed parameters (comma separated)
                    <input
                      aria-label={`Vendor ${String(i + 1)} signed parameters`}
                      value={v.security.signed_params.join(',')}
                      disabled={disabled}
                      onChange={(e) =>
                        update(i, {
                          ...v,
                          security: {
                            ...v.security!,
                            signed_params: e.target.value
                              .split(',')
                              .map((s) => s.trim())
                              .filter((s) => s !== ''),
                          },
                        })
                      }
                    />
                  </label>
                  {err('security.signed_params') !== undefined && (
                    <p role="alert">{err('security.signed_params')}</p>
                  )}
                </fieldset>
              )}

              <fieldset style={{ marginTop: 8 }}>
                <legend>Inbound parameters</legend>
                {v.inbound_params.map((p, j) => (
                  <div key={`${v.id}:${String(j)}`} style={{ display: 'flex', gap: 6 }}>
                    <input
                      aria-label={`Vendor ${String(i + 1)} parameter ${String(j + 1)} name`}
                      value={p.param}
                      disabled={disabled}
                      onChange={(e) =>
                        update(i, {
                          ...v,
                          inbound_params: v.inbound_params.map((q, k) =>
                            k === j ? { ...q, param: e.target.value } : q,
                          ),
                        })
                      }
                    />
                    <select
                      aria-label={`Vendor ${String(i + 1)} parameter ${String(j + 1)} variable`}
                      value={p.variable_ref}
                      disabled={disabled}
                      onChange={(e) =>
                        update(i, {
                          ...v,
                          inbound_params: v.inbound_params.map((q, k) =>
                            k === j ? { ...q, variable_ref: e.target.value } : q,
                          ),
                        })
                      }
                    >
                      <option value="">Choose a hidden variable…</option>
                      {hiddenVariables.map((name) => (
                        <option key={name} value={name}>
                          {name}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() =>
                        update(i, {
                          ...v,
                          inbound_params: v.inbound_params.filter((_, k) => k !== j),
                        })
                      }
                    >
                      {`Remove parameter ${String(j + 1)}`}
                    </button>
                    {shown[`vendors.${String(i)}.inbound_params.${String(j)}.param`] !==
                      undefined && (
                      <p role="alert">
                        {shown[`vendors.${String(i)}.inbound_params.${String(j)}.param`]}
                      </p>
                    )}
                    {shown[`vendors.${String(i)}.inbound_params.${String(j)}.variable_ref`] !==
                      undefined && (
                      <p role="alert">
                        {shown[`vendors.${String(i)}.inbound_params.${String(j)}.variable_ref`]}
                      </p>
                    )}
                  </div>
                ))}
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() =>
                    update(i, {
                      ...v,
                      inbound_params: [
                        ...v.inbound_params,
                        { param: '', variable_ref: '', required: false },
                      ],
                    })
                  }
                >
                  {`Add parameter to vendor ${String(i + 1)}`}
                </button>
              </fieldset>
            </li>
          );
        })}
      </ul>

      <button
        type="button"
        disabled={disabled}
        onClick={() => setDraft([...draft, blankVendor(draft.length)])}
      >
        Add vendor
      </button>

      {/* The outstanding count is on screen while the button is disabled, for the reason
          PublishDialog's tests state: a disabled button with no explanation is a dead end. */}
      {blocked && (
        <p role="status">
          {`${String(Object.keys(localProblems).length)} problem(s) to fix before saving`}
        </p>
      )}

      <button
        type="button"
        id={`${baseId}-save`}
        disabled={disabled || pending || blocked}
        onClick={() => onSave(draft)}
      >
        {pending ? 'Saving…' : 'Save vendors'}
      </button>
    </section>
  );
}
