/**
 * Entry parameters into hidden variables — E §3, roadmap P2-04.
 *
 * `captureEntryParams` already stored the raw query string on the session, and that was the whole
 * of it: nothing joined those params against the vendor's declared `inbound_params`, so
 * `session.vars` never received them, `required` was never enforced, and a survey whose logic read
 * `VENDOR_PID` evaluated every condition against UNKNOWN. The parameters were being *recorded* and
 * not *bound*.
 *
 * ## Declared parameters only
 *
 * A parameter binds if and only if a vendor declares it. The query string is attacker-controlled —
 * it is the one input a respondent can type freely — so writing arbitrary params into the variable
 * space would let a respondent set any hidden variable in the survey, including one a quota
 * dimension reads. `inbound_params` is the allowlist, and it is per-vendor because two panels use
 * different parameter names for the same idea.
 *
 * ## Refs, resolved through the variable manifest
 *
 * `VendorInboundParam.variable_ref` addresses a variable by *ref* ("because vendors are authored by
 * hand", schema §9) while `session.vars` is keyed by variable *id* — logic references ids so a
 * rename touches no AST (D §2.1). The manifest is the only place that holds both, so it is the
 * translation table, and a ref that resolves to nothing is reported rather than silently dropped:
 * that is the shape of a vendor config that outlived a variable rename.
 *
 * ## Only hidden variables, and why that is a hard rule
 *
 * A bound parameter must target a `kind: 'hidden'` variable. Binding into a `response` variable
 * would let an entry link pre-answer a question and the export would then disagree with what was
 * asked; binding into `system` would let a link rewrite `SERVER_TIME`. `set_variable` already
 * refuses both for the same reason (`LGC-T030`), and refusing them here keeps the two agreeing.
 *
 * ## Values arrive as text, and stay text unless the variable says otherwise
 *
 * A query parameter is a string. A hidden variable declared `number` gets a parsed number, and one
 * declared anything else gets text — because coercing "01234" to `1234` for a panel id is a real
 * data-loss bug, and the variable's declared type is the only statement of intent available.
 */

import type { ArtifactManifest, Vendor } from '@resscript/schema';

export interface BindInboundInput {
  readonly params: URLSearchParams;
  readonly vendor: Vendor | undefined;
  /** The pinned artifact's variable manifest — the only ref↔id↔type translation table. */
  readonly manifest: Pick<ArtifactManifest, 'variable_manifest'>;
}

export interface BindInboundResult {
  /** `variable_id -> value`, ready to merge into `session.vars`. */
  readonly vars: { readonly [variableId: string]: string | number };
  /** Declared `required` params the link did not supply, by param name. */
  readonly missingRequired: readonly string[];
  /** Declared params whose `variable_ref` resolves to no variable, by `param:ref`. */
  readonly unresolved: readonly string[];
  /** Declared params whose target is not a hidden variable, by `param:ref`. */
  readonly notHidden: readonly string[];
}

const EMPTY: BindInboundResult = { vars: {}, missingRequired: [], unresolved: [], notHidden: [] };

export function bindInboundParams(input: BindInboundInput): BindInboundResult {
  const vendor = input.vendor;
  if (vendor === undefined || vendor.inbound_params.length === 0) return EMPTY;

  // Refs are compared case-sensitively: schema §3 makes a ref case-sensitive precisely because
  // `Q1` and `q1` being the same variable is a trap in an export column name.
  const byRef = new Map(input.manifest.variable_manifest.map(v => [v.name, v]));

  const vars: { [variableId: string]: string | number } = {};
  const missingRequired: string[] = [];
  const unresolved: string[] = [];
  const notHidden: string[] = [];

  for (const declared of vendor.inbound_params) {
    const raw = input.params.get(declared.param);
    if (raw === null || raw === '') {
      if (declared.required) missingRequired.push(declared.param);
      continue;
    }

    const variable = byRef.get(declared.variable_ref);
    if (variable === undefined) {
      unresolved.push(`${declared.param}:${declared.variable_ref}`);
      continue;
    }
    if (variable.kind !== 'hidden') {
      notHidden.push(`${declared.param}:${declared.variable_ref}`);
      continue;
    }

    // Same cap `captureEntryParams` applies to the audit copy: an entry param is stored on every
    // session and an unbounded query string is a cheap way to inflate every row.
    const value = raw.slice(0, 512);
    if (variable.type === 'number') {
      const parsed = Number(value);
      // A non-numeric value for a numeric variable is dropped rather than stored as NaN: NaN is an
      // invariant error in the engine's value model (D §2.2), so admitting one here would crash an
      // evaluation instead of leaving the variable unanswered.
      if (Number.isFinite(parsed)) vars[variable.id] = parsed;
      continue;
    }
    vars[variable.id] = value;
  }

  return { vars, missingRequired, unresolved, notHidden };
}
