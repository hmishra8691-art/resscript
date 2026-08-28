/**
 * Vendor console tests.
 *
 * A vendor row decides which `?src=` identifies a panel, which query parameters may write into a
 * variable, and what an entry signature is checked against — and every one of them fails QUIETLY
 * when wrong. So the load-bearing assertions are the refusals and the warnings, not the happy path:
 *
 *  - a pasted secret is called out AS THE FIELD CHANGES, because 0024 and the compiler both refuse
 *    it only after the paste, and an author who has just pasted an HMAC key needs to know before
 *    they move on;
 *  - signing is an explicit checkbox starting UNCHECKED, because an always-visible empty signing
 *    block reads as "configured, incompletely" — the half-state 0024 makes unstorable;
 *  - the variable picker offers HIDDEN variables only, because `bindInboundParams` refuses any
 *    other kind and offering one that gets silently dropped is worse than not offering it;
 *  - Save is disabled while anything is wrong, with the outstanding count on screen — a disabled
 *    button with no explanation is a dead end.
 */

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  VendorConsole,
  vendorDraftProblems,
  type VendorDraft,
} from '@/components/vendors/VendorConsole';

afterEach(cleanup);

const HIDDEN = ['VENDORPID', 'PANEL_AGE'];

function signed(over: Partial<VendorDraft> = {}): VendorDraft {
  return {
    id: 'vnd_1',
    ref: 'PANEL_A',
    name: 'Panel A',
    max_completes: 500,
    inbound_params: [{ param: 'pid', variable_ref: 'VENDORPID', required: true }],
    security: {
      hash_param: 'hash',
      algorithm: 'sha256',
      secret_ref: 'vendor/panel_a/hmac',
      signed_params: ['pid'],
    },
    ...over,
  };
}

function setup(vendors: readonly VendorDraft[], props: Record<string, unknown> = {}) {
  const onSave = vi.fn();
  render(
    <VendorConsole vendors={vendors} hiddenVariables={HIDDEN} onSave={onSave} {...props} />,
  );
  return { onSave };
}

/* ---------------------------------------------------------------- *
 * The secret warning
 * ---------------------------------------------------------------- */

describe('the secret_ref warning', () => {
  it('fires WHILE TYPING, not on submit', async () => {
    // The whole reason this control exists in front of 0024's CHECK and the compiler's throw: both
    // of those are after the paste. An author who has just pasted a key needs to know now.
    setup([signed()]);
    const field = screen.getByLabelText('Vendor 1 secret reference');
    await userEvent.clear(field);
    await userEvent.paste('k7Fq2mZp9xLtR4vNwYbS3jHcQ8eA6uDg');

    const alert = screen.getByText(/looks like the secret ITSELF/);
    expect(alert).toBeTruthy();
    // And it says what to do, not which constraint fired — an author cannot act on a constraint
    // name.
    expect(alert.textContent).toContain('secrets store');
  });

  it('does not fire for a path-shaped reference', async () => {
    setup([signed()]);
    const field = screen.getByLabelText('Vendor 1 secret reference');
    await userEvent.clear(field);
    await userEvent.type(field, 'vendor/panel_b/hmac');
    expect(screen.queryByText(/looks like the secret ITSELF/)).toBeNull();
  });

  it('blocks Save while a secret is pasted', async () => {
    setup([signed()]);
    const field = screen.getByLabelText('Vendor 1 secret reference');
    await userEvent.clear(field);
    await userEvent.paste('k7Fq2mZp9xLtR4vNwYbS3jHcQ8eA6uDg');
    expect(screen.getByRole('button', { name: 'Save vendors' })).toBeDisabled();
  });
});

/* ---------------------------------------------------------------- *
 * Signing is a choice
 * ---------------------------------------------------------------- */

describe('signing', () => {
  it('a NEW vendor starts unsigned, with no signing block', async () => {
    // An always-visible empty signing block reads as "configured, incompletely", which is the
    // half-state 0024's vendors_security_all_or_none CHECK makes unstorable. A screen should not
    // offer a shape the database refuses.
    setup([]);
    await userEvent.click(screen.getByRole('button', { name: 'Add vendor' }));

    expect(screen.getByLabelText('Vendor 1 entry links are signed')).not.toBeChecked();
    expect(screen.queryByLabelText('Vendor 1 secret reference')).toBeNull();
  });

  it('reveals the signing block when checked, and requires both halves', async () => {
    setup([]);
    await userEvent.click(screen.getByRole('button', { name: 'Add vendor' }));
    await userEvent.type(screen.getByLabelText('Vendor 1 ref'), 'PANEL_A');
    await userEvent.type(screen.getByLabelText('Vendor 1 name'), 'Panel A');
    await userEvent.click(screen.getByLabelText('Vendor 1 entry links are signed'));

    expect(screen.getByLabelText('Vendor 1 secret reference')).toBeTruthy();
    // Signed with neither a secret nor params: both are named, and Save stays disabled.
    expect(screen.getByText(/needs a secret reference/)).toBeTruthy();
    expect(screen.getByText(/signature over nothing verifies everything/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save vendors' })).toBeDisabled();
  });

  it('unchecking drops the signing config entirely', async () => {
    const { onSave } = setup([signed()]);
    await userEvent.click(screen.getByLabelText('Vendor 1 entry links are signed'));
    await userEvent.click(screen.getByRole('button', { name: 'Save vendors' }));

    expect(onSave).toHaveBeenCalledTimes(1);
    expect((onSave.mock.calls[0]?.[0] as VendorDraft[])[0]?.security).toBeNull();
  });

  it('refuses a signature over params the vendor never declares', async () => {
    // A signature that covers nothing the panel sends. 0024 requires signed_params to be non-empty;
    // this is the cross-field version it cannot express.
    setup([signed()]);
    const field = screen.getByLabelText('Vendor 1 signed parameters');
    await userEvent.clear(field);
    await userEvent.type(field, 'not_declared');

    expect(screen.getByText(/nothing the panel actually sends/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save vendors' })).toBeDisabled();
  });
});

/* ---------------------------------------------------------------- *
 * The inbound allowlist
 * ---------------------------------------------------------------- */

describe('inbound parameters', () => {
  it('offers HIDDEN variables only', () => {
    // `bindInboundParams` refuses a `response` or `system` target — an entry link that pre-answered
    // a question would make the export disagree with what was asked — so offering one here and
    // having the runtime drop it silently is worse than not offering it.
    setup([signed()]);
    const picker = screen.getByLabelText('Vendor 1 parameter 1 variable') as HTMLSelectElement;
    const options = [...picker.options].map((o) => o.value).filter((v) => v !== '');
    expect(options).toEqual(HIDDEN);
  });

  it('requires a variable to be chosen', async () => {
    setup([signed()]);
    await userEvent.click(
      screen.getByRole('button', { name: 'Add parameter to vendor 1' }),
    );
    await userEvent.type(screen.getByLabelText('Vendor 1 parameter 2 name'), 'sid');

    expect(screen.getByText(/Choose the hidden variable/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save vendors' })).toBeDisabled();
  });

  it('refuses a param name that would split the canonical string', async () => {
    setup([signed()]);
    const field = screen.getByLabelText('Vendor 1 parameter 1 name');
    await userEvent.clear(field);
    await userEvent.type(field, 'a&b');

    expect(screen.getByText(/split the signature/)).toBeTruthy();
  });

  it('refuses two mappings for one parameter', async () => {
    setup([signed()]);
    await userEvent.click(screen.getByRole('button', { name: 'Add parameter to vendor 1' }));
    await userEvent.type(screen.getByLabelText('Vendor 1 parameter 2 name'), 'pid');
    await userEvent.selectOptions(
      screen.getByLabelText('Vendor 1 parameter 2 variable'),
      'PANEL_AGE',
    );

    expect(screen.getByText(/depend on iteration order/)).toBeTruthy();
  });
});

/* ---------------------------------------------------------------- *
 * Refs, saving, and server errors
 * ---------------------------------------------------------------- */

describe('the set as a whole', () => {
  it('refuses a duplicate ref, naming what breaks', async () => {
    setup([signed(), signed({ id: 'vnd_2', ref: 'PANEL_A', name: 'Panel A copy' })]);
    expect(screen.getByText(/Another vendor already uses PANEL_A/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save vendors' })).toBeDisabled();
  });

  it('shows the outstanding count while Save is disabled', async () => {
    // A disabled button with no explanation is a dead end — the same rule PublishDialog's tests
    // state for its acknowledgement gate.
    setup([signed({ ref: '' })]);
    expect(screen.getByRole('status').textContent).toMatch(/problem\(s\) to fix/);
  });

  it('saves a clean set, passing the draft back', async () => {
    const { onSave } = setup([signed()]);
    await userEvent.click(screen.getByRole('button', { name: 'Save vendors' }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect((onSave.mock.calls[0]?.[0] as VendorDraft[])[0]?.ref).toBe('PANEL_A');
  });

  it('removes a vendor', async () => {
    const { onSave } = setup([signed(), signed({ id: 'vnd_2', ref: 'PANEL_B', name: 'B' })]);
    await userEvent.click(screen.getAllByRole('button', { name: 'Remove' })[0] as HTMLElement);
    await userEvent.click(screen.getByRole('button', { name: 'Save vendors' }));
    expect((onSave.mock.calls[0]?.[0] as VendorDraft[]).map((v) => v.ref)).toEqual(['PANEL_B']);
  });

  it('renders a SERVER error inline, and lets it win over the local message', () => {
    // The server saw the row the database saw. A local message that overrode it would tell the
    // author something less true than what actually happened.
    setup([signed()], {
      errors: { 'vendors.0.ref': 'the database said no, specifically' },
    });
    expect(screen.getByText('the database said no, specifically')).toBeTruthy();
  });

  it('disables everything while a save is pending', () => {
    setup([signed()], { pending: true });
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
  });

  it('disables every control when the version is not editable', () => {
    setup([signed()], { disabled: true });
    expect(screen.getByLabelText('Vendor 1 ref')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save vendors' })).toBeDisabled();
  });
});

/* ---------------------------------------------------------------- *
 * The validator, directly
 * ---------------------------------------------------------------- */

describe('vendorDraftProblems', () => {
  it('is empty for a clean set', () => {
    expect(vendorDraftProblems([signed()], HIDDEN)).toEqual({});
  });

  it('reports a variable that is not hidden in this version', () => {
    // The shape of a vendor config that outlived a variable rename — the failure
    // `vendor/inbound.ts` names.
    const p = vendorDraftProblems(
      [signed({ inbound_params: [{ param: 'pid', variable_ref: 'GONE', required: true }] })],
      HIDDEN,
    );
    expect(p['vendors.0.inbound_params.0.variable_ref']).toMatch(/not a hidden variable/);
  });

  it('reports a zero ceiling', () => {
    const p = vendorDraftProblems([signed({ max_completes: 0 })], HIDDEN);
    expect(p['vendors.0.max_completes']).toMatch(/vendor you remove/);
  });

  it('keys every problem by the path the API uses, so a 422 lands in the same place', () => {
    // The wire's detail paths are `vendors.<i>.<field>`; using the same keys means a server error
    // and a local one render in the same slot rather than in two places.
    const p = vendorDraftProblems([signed({ ref: '' })], HIDDEN);
    expect(Object.keys(p)).toContain('vendors.0.ref');
  });
});
