/**
 * Redirect editor tests.
 *
 * The screen's reason to exist is that nobody can read a redirect template and be sure where a
 * respondent will be sent, and the failure mode is finding out from a client whose completes were
 * never credited. So the load-bearing assertions are the preview and the coverage warning:
 *
 *  - the preview substitutes sample values and is LABELLED a preview, because one that looked
 *    authoritative would be read as a guarantee;
 *  - a `pii` variable is NOT substituted and is called out, because `CMP-0301` refuses it with no
 *    override — a preview that resolved it would show a URL that cannot be published;
 *  - an unknown placeholder is called out, because it is sent to the panel as a literal `{{…}}`;
 *  - missing COVERAGE is shown while editing, since `CMP-0300` otherwise turns a valid-but-incomplete
 *    set into a publish error much later;
 *  - the scope/key and disposition/custom_key biconditionals are maintained by the control, so
 *    0010's CHECKs cannot be violated by clicking.
 */

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { previewTemplate, RedirectEditor } from '@/components/redirects/RedirectEditor';
import type { RedirectRow } from '@/server/repo/types';

afterEach(cleanup);

const VARIABLES = [
  { name: 'RID', sample: 'r-123', pii: false },
  { name: 'EMAIL', sample: 'a@b.test', pii: true },
];

function row(over: Partial<RedirectRow> = {}): RedirectRow {
  return {
    scope: 'default',
    scope_key: '',
    disposition: 'COMPLETE',
    custom_key: '',
    url_template: 'https://cb.panel.test/c?rid={{RID}}',
    ...over,
  };
}

/** Every redirect-required disposition covered, so the coverage warning is silent by default. */
function fullSet(): RedirectRow[] {
  return (
    ['COMPLETE', 'SCREENOUT', 'QUOTA_FULL', 'QUALITY', 'DUPLICATE', 'FRAUD', 'TERMINATE'] as const
  )
    .map((d) => row({ disposition: d, url_template: `https://cb.panel.test/${d.toLowerCase()}` }))
    .concat([
      row({ disposition: 'CUSTOM', custom_key: 'k', url_template: 'https://cb.panel.test/k' }),
    ]);
}

function setup(rows: readonly RedirectRow[], props: Record<string, unknown> = {}) {
  const onSave = vi.fn();
  render(
    <RedirectEditor
      redirects={rows}
      variables={VARIABLES}
      vendorRefs={['PANEL_A']}
      languages={['en', 'fr']}
      onSave={onSave}
      {...props}
    />,
  );
  return { onSave };
}

/* ---------------------------------------------------------------- *
 * previewTemplate, directly
 * ---------------------------------------------------------------- */

describe('previewTemplate', () => {
  it('substitutes a known variable, url-encoded', () => {
    const p = previewTemplate('https://x.test/?r={{RID}}', VARIABLES);
    expect(p.url).toBe('https://x.test/?r=r-123');
    expect(p.unresolved).toEqual([]);
  });

  it('leaves a PII variable as its placeholder and reports it', () => {
    // CMP-0301 refuses a pii variable in a redirect template with NO override. Substituting it
    // would show an author a URL the compiler will reject.
    const p = previewTemplate('https://x.test/?e={{EMAIL}}', VARIABLES);
    expect(p.url).toContain('{{EMAIL}}');
    expect(p.blockedPii).toEqual(['EMAIL']);
  });

  it('leaves an unknown placeholder alone and reports it', () => {
    // It is sent to the panel as a literal `{{GHOST}}`, which is the actual runtime behaviour and
    // the thing an author needs to see.
    const p = previewTemplate('https://x.test/?g={{GHOST}}', VARIABLES);
    expect(p.url).toContain('{{GHOST}}');
    expect(p.unresolved).toEqual(['GHOST']);
  });

  it('shows {{HMAC}} as a placeholder signature without reporting it', () => {
    // The runtime computes it from the interpolated query and a vendor secret, so there is nothing
    // to preview and its absence is not a problem.
    const p = previewTemplate('https://x.test/?s={{HMAC}}', VARIABLES);
    expect(p.url).toBe('https://x.test/?s=<signature>');
    expect(p.unresolved).toEqual([]);
  });

  it('resolves a dotted form against its base variable', () => {
    // `{{Q1.label}}` and `{{Q1.code}}` are the same variable in different forms — the preview cares
    // which variable, not which form.
    expect(previewTemplate('https://x.test/?r={{RID.code}}', VARIABLES).unresolved).toEqual([]);
  });

  it('reports each unknown name once', () => {
    const p = previewTemplate('{{A}}{{A}}{{B}}', VARIABLES);
    expect(p.unresolved).toEqual(['A', 'B']);
  });
});

/* ---------------------------------------------------------------- *
 * The screen
 * ---------------------------------------------------------------- */

describe('the preview on screen', () => {
  it('renders the resolved url, labelled as a preview', async () => {
    // Labelled, because a preview that looked authoritative would be read as a guarantee — the real
    // resolution happens at finalization against a session's actual variables.
    setup(fullSet());
    const p = screen.getByLabelText('Redirect 1 preview');
    expect(p.textContent).toContain('Preview (sample values)');
  });

  it('updates as the template is edited', async () => {
    // PASTE, not `type`. userEvent treats `{{` as an escape for a literal `{`, so typing
    // `{{RID}}` enters `{RID}` and the preview correctly finds no placeholder — the test failing
    // was the library working as documented, not the control misbehaving.
    setup([row({ url_template: '' })]);
    const field = screen.getByLabelText('Redirect 1 url template');
    await userEvent.click(field);
    await userEvent.paste('https://x.test/?r={{RID}}');
    expect(screen.getByLabelText('Redirect 1 preview').textContent).toContain('r=r-123');
  });

  it('warns about a pii variable, naming CMP-0301', async () => {
    setup([row({ url_template: 'https://x.test/?e={{EMAIL}}' })]);
    expect(screen.getByText(/CMP-0301/)).toBeTruthy();
  });

  it('warns about an unknown placeholder', async () => {
    setup([row({ url_template: 'https://x.test/?g={{GHOST}}' })]);
    expect(screen.getByText(/No such variable: GHOST/)).toBeTruthy();
  });
});

describe('coverage', () => {
  it('names the dispositions with no redirect', () => {
    // CMP-0300 refuses a publish whose flow can reach a termination with nowhere to send the
    // respondent, and the synthesized flow always reaches COMPLETE — so without this an author
    // saves a valid set and meets the error at publish.
    setup([row()]);
    const status = screen.getAllByRole('status').find((n) => /no redirect/.test(n.textContent ?? ''));
    expect(status).toBeTruthy();
    expect(status?.textContent).toContain('SCREENOUT');
    expect(status?.textContent).toContain('CMP-0300');
  });

  it('is silent once every disposition is covered', () => {
    setup(fullSet());
    const nag = screen.queryAllByRole('status').find((n) => /no redirect/.test(n.textContent ?? ''));
    expect(nag).toBeUndefined();
  });
});

describe('the biconditionals 0010 enforces', () => {
  it('clears the scope key when switching back to default', async () => {
    // `''` is the TABLE's encoding of "not applicable". A stale key on a `default` row is a row
    // that silently never matches, which 0010's redirects_scope_key_shape makes unstorable.
    const { onSave } = setup(fullSet());
    await userEvent.selectOptions(screen.getByLabelText('Redirect 1 scope'), 'vendor');
    await userEvent.selectOptions(screen.getByLabelText('Redirect 1 scope key'), 'PANEL_A');
    await userEvent.selectOptions(screen.getByLabelText('Redirect 1 scope'), 'default');
    await userEvent.click(screen.getByRole('button', { name: 'Save redirects' }));

    expect((onSave.mock.calls[0]?.[0] as RedirectRow[])[0]?.scope_key).toBe('');
  });

  it('clears the custom key when switching away from CUSTOM', async () => {
    // A TWO-row set, not the full one. Switching a CUSTOM row to any disposition the full set
    // already covers creates a duplicate primary key, which correctly disables Save — so the first
    // version of this test asserted a call that never happened. The narrow fixture isolates the
    // biconditional from the uniqueness rule.
    const { onSave } = setup([
      row({ disposition: 'CUSTOM', custom_key: 'over_quota', url_template: 'https://x.test/q' }),
    ]);
    await userEvent.selectOptions(screen.getByLabelText('Redirect 1 disposition'), 'QUALITY');
    await userEvent.click(screen.getByRole('button', { name: 'Save redirects' }));

    expect(onSave).toHaveBeenCalledTimes(1);
    expect((onSave.mock.calls[0]?.[0] as RedirectRow[])[0]?.custom_key).toBe('');
  });

  it('offers a scope key only for a non-default scope', async () => {
    setup(fullSet());
    expect(screen.queryByLabelText('Redirect 1 scope key')).toBeNull();
    await userEvent.selectOptions(screen.getByLabelText('Redirect 1 scope'), 'language');
    expect(screen.getByLabelText('Redirect 1 scope key')).toBeTruthy();
  });
});

describe('saving', () => {
  it('blocks Save while a row is invalid, with a count', async () => {
    // An empty template is 0010's redirects_template_nonempty: a row that exists and sends the
    // respondent to the empty string is worse than a missing row, because CMP-0300 would pass.
    setup([row({ url_template: '' })]);
    expect(screen.getByRole('button', { name: 'Save redirects' })).toBeDisabled();
    const nag = screen.getAllByRole('status').find((n) => /to fix before saving/.test(n.textContent ?? ''));
    expect(nag).toBeTruthy();
  });

  it('saves a clean set', async () => {
    const { onSave } = setup(fullSet());
    await userEvent.click(screen.getByRole('button', { name: 'Save redirects' }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect((onSave.mock.calls[0]?.[0] as RedirectRow[])).toHaveLength(8);
  });

  it('adds and removes rows', async () => {
    const { onSave } = setup(fullSet());
    await userEvent.click(screen.getByRole('button', { name: 'Remove redirect 1' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save redirects' }));
    // Still blocked? No — removing COMPLETE leaves the set valid but INCOMPLETE, which is a coverage
    // warning rather than a validity error. Saving an incomplete set is allowed; publishing it is
    // not, which is the division CMP-0300 draws.
    expect(onSave).toHaveBeenCalledTimes(1);
    expect((onSave.mock.calls[0]?.[0] as RedirectRow[])).toHaveLength(7);
  });

  it('renders a server error inline and lets it win', () => {
    setup(fullSet(), { errors: { 'redirects.0.url_template': 'the database said no' } });
    expect(screen.getByText('the database said no')).toBeTruthy();
  });

  it('disables everything when the version is not editable', () => {
    setup(fullSet(), { disabled: true });
    expect(screen.getByLabelText('Redirect 1 url template')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save redirects' })).toBeDisabled();
  });
});
