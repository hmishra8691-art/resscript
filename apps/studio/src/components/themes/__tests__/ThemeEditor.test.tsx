/**
 * Theme editor tests.
 *
 * Two things carry the screen, and both are about not lying to the operator:
 *
 *  - a token value is an INJECTION SITE the CSS sanitizer never sees, because a token is not an
 *    author stylesheet. The editor calls the compiler's own `validateTokens`, so a value that would
 *    close the declaration is refused next to the field rather than at publish;
 *  - inheritance is shown AS inheritance. An editor displaying only the effective value makes "why
 *    did my brand colour move" unanswerable, and clearing a token returns it to the PARENT rather
 *    than to the platform default — which is what `resolveTokens`' nearest-last merge does.
 *
 * The vocabulary is imported from the compiler rather than restated, so the picker cannot drift from
 * what actually compiles.
 */

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TOKENS } from '@resscript/compiler/theme';

import { ThemeEditor, tokenOrigin } from '@/components/themes/ThemeEditor';

afterEach(cleanup);

function setup(props: Record<string, unknown> = {}) {
  const onSave = vi.fn();
  render(
    <ThemeEditor
      themeName="Child"
      tokens={{ 'color-brand': '#222222' }}
      parentTokens={{ 'color-brand': '#111111', radius: '2px' }}
      parentName="Base"
      onSave={onSave}
      {...props}
    />,
  );
  return { onSave };
}

/* ---------------------------------------------------------------- *
 * The injection refusal
 * ---------------------------------------------------------------- */

describe('token values', () => {
  it('REFUSES a value that would close the declaration', async () => {
    // `--rs-color-brand: red;} body{display:none} .x{` writes arbitrary rules, and the CSS sanitizer
    // never sees it because a token is not an author stylesheet. This is the layer that catches it.
    setup();
    const field = screen.getByLabelText('color-brand value');
    await userEvent.clear(field);
    await userEvent.paste('red;} body{display:none} .x{');

    expect(screen.getByText(/CSS injection/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save theme' })).toBeDisabled();
  });

  it('names the KIND a token expects, so the message is actionable', async () => {
    setup();
    const field = screen.getByLabelText('radius value');
    await userEvent.type(field, '6');
    // A length needs a unit; `6` alone is not one.
    expect(screen.getByText(/is not a valid length/)).toBeTruthy();
  });

  it('accepts an ordinary value', async () => {
    const { onSave } = setup();
    const field = screen.getByLabelText('color-brand value');
    await userEvent.clear(field);
    await userEvent.type(field, '#abcdef');
    await userEvent.click(screen.getByRole('button', { name: 'Save theme' }));

    expect(onSave).toHaveBeenCalledTimes(1);
    expect((onSave.mock.calls[0]?.[0] as Record<string, string>)['color-brand']).toBe('#abcdef');
  });

  it('offers exactly the compiler vocabulary, no more and no less', () => {
    // Imported rather than restated, so the picker cannot drift from what compiles — the rule
    // MemberRoleEditor follows for ORG_ROLES.
    setup();
    for (const name of Object.keys(TOKENS)) {
      expect(screen.getByLabelText(`${name} value`)).toBeTruthy();
    }
  });
});

/* ---------------------------------------------------------------- *
 * Inheritance, shown as inheritance
 * ---------------------------------------------------------------- */

describe('tokenOrigin', () => {
  it('distinguishes own, inherited and platform', () => {
    const own = { 'color-brand': '#222' };
    const parent = { radius: '2px' };
    expect(tokenOrigin('color-brand', own, parent)).toBe('own');
    expect(tokenOrigin('radius', own, parent)).toBe('inherited');
    expect(tokenOrigin('space', own, parent)).toBe('platform');
  });

  it('treats an empty own value as not set', () => {
    // Clearing a field must return the token to its parent, not pin it to the empty string.
    expect(tokenOrigin('color-brand', { 'color-brand': '' }, { 'color-brand': '#111' })).toBe(
      'inherited',
    );
  });

  it('reports platform for a root theme with no parent', () => {
    expect(tokenOrigin('radius', {}, null)).toBe('platform');
  });
});

describe('the origin on screen', () => {
  it('says where each value comes from', () => {
    setup();
    expect(screen.getByLabelText('color-brand origin').textContent).toBe('set here');
    expect(screen.getByLabelText('radius origin').textContent).toBe('inherited from Base');
    expect(screen.getByLabelText('space origin').textContent).toBe('platform default');
  });

  it('shows the inherited value as the placeholder, so the effective look is visible', () => {
    setup();
    expect(screen.getByLabelText('radius value')).toHaveAttribute('placeholder', '2px');
  });

  it('falls back to the platform value in the placeholder when nothing inherits', () => {
    setup();
    expect(screen.getByLabelText('space value')).toHaveAttribute(
      'placeholder',
      TOKENS['space']?.fallback ?? '',
    );
  });

  it('resetting a token returns it to the PARENT, not to the platform default', async () => {
    // What `resolveTokens`' nearest-last merge actually does. An editor that reset to the platform
    // value would silently drop the parent's brand.
    const { onSave } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Reset color-brand' }));

    expect(screen.getByLabelText('color-brand origin').textContent).toBe('inherited from Base');
    expect(screen.getByLabelText('color-brand value')).toHaveAttribute('placeholder', '#111111');

    await userEvent.click(screen.getByRole('button', { name: 'Save theme' }));
    expect((onSave.mock.calls[0]?.[0] as Record<string, string>)['color-brand']).toBeUndefined();
  });

  it('offers Reset only for a token set here', () => {
    setup();
    expect(screen.queryByRole('button', { name: 'Reset radius' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Reset color-brand' })).toBeTruthy();
  });
});

/* ---------------------------------------------------------------- *
 * The publish warning
 * ---------------------------------------------------------------- */

describe('the in-field warning', () => {
  it('states that editing does not restyle a live wave', () => {
    // 0021 snapshots the resolved tokens at publish, so a version keeps the appearance it was
    // approved with. Safe, and surprising — an operator who edits and reloads a live survey sees no
    // change — so the screen says it where they are editing.
    setup();
    const note = screen.getByRole('note');
    expect(note.textContent).toContain('does not change a survey already in field');
    expect(note.textContent).toContain('Republish');
  });
});

describe('permissions', () => {
  it('disables every field when the caller cannot write', () => {
    setup({ disabled: true });
    expect(screen.getByLabelText('color-brand value')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save theme' })).toBeDisabled();
  });

  it('shows a pending save', () => {
    setup({ pending: true });
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
  });
});
