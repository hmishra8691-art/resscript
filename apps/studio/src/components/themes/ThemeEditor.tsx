/**
 * The theme and token editor — roadmap P2-12's Frontend line, migration 0021.
 *
 * ## Why the token vocabulary comes from the compiler
 *
 * `TOKENS` in `@resscript/compiler`'s theme emitter is the canonical list, and the per-kind value
 * patterns are its too. Restating either here would let the editor accept a value the compiler
 * refuses — and a token value is interpolated into a stylesheet, so "refuses" means the survey does
 * not publish. Importing the registry means the picker cannot drift from what actually compiles, the
 * same rule `MemberRoleEditor` follows for `ORG_ROLES`.
 *
 * ## A token value is an injection site, and the editor says so
 *
 * `--rs-color-brand: red;} body{display:none} .x{` closes the declaration and writes arbitrary
 * rules, and the CSS sanitizer never sees it because a token is not an author stylesheet.
 * `validateTokens` is the compiler's own check, called here so the refusal lands next to the field
 * rather than at publish.
 *
 * ## Inheritance is shown as inheritance
 *
 * A theme with a parent shows, per token, whether the value is its own or inherited — because the
 * difference decides what happens when the parent changes, and an editor that showed only the
 * effective value would make "why did my brand colour move" unanswerable. Clearing a token returns
 * it to the parent rather than to the platform default, which is what `resolveTokens`' nearest-last
 * merge actually does.
 *
 * ## The publish warning
 *
 * 0021 snapshots the RESOLVED tokens at publish, so editing a theme does not restyle a version
 * already in field. That is the safe behaviour and it is also surprising — an operator who edits a
 * theme and reloads a live survey will see no change — so the screen states it where they are
 * editing.
 */

'use client';

import { useMemo, useState } from 'react';
import { TOKENS, validateTokens } from '@resscript/compiler/theme';

export interface ThemeEditorProps {
  readonly themeName: string;
  /** This theme's OWN tokens. A token absent here is inherited. */
  readonly tokens: Readonly<Record<string, string>>;
  /** The parent's resolved tokens, or null for a root theme. */
  readonly parentTokens: Readonly<Record<string, string>> | null;
  readonly parentName: string | null;
  readonly onSave: (tokens: Readonly<Record<string, string>>) => void;
  readonly disabled?: boolean;
  readonly pending?: boolean;
}

/** Where a token's effective value comes from — the distinction the editor exists to show. */
export type TokenOrigin = 'own' | 'inherited' | 'platform';

export function tokenOrigin(
  name: string,
  own: Readonly<Record<string, string>>,
  parent: Readonly<Record<string, string>> | null,
): TokenOrigin {
  if (own[name] !== undefined && own[name] !== '') return 'own';
  if (parent !== null && parent[name] !== undefined) return 'inherited';
  return 'platform';
}

export function ThemeEditor({
  themeName,
  tokens,
  parentTokens,
  parentName,
  onSave,
  disabled = false,
  pending = false,
}: ThemeEditorProps): React.JSX.Element {
  const [draft, setDraft] = useState<Readonly<Record<string, string>>>(tokens);

  // The COMPILER's own validator, so the editor cannot accept a value that fails to publish.
  const problems = useMemo(() => validateTokens(draft), [draft]);
  const byToken = useMemo(() => {
    const out: Record<string, string> = {};
    for (const p of problems) {
      out[p.token] =
        p.reason === 'unknown_token'
          ? `${p.token} is not a token this platform renders.`
          : `${JSON.stringify(p.value)} is not a valid ${TOKENS[p.token]?.kind ?? 'value'}. A token ` +
            'is interpolated straight into a stylesheet, so anything that could close the ' +
            'declaration is refused — that is how a theme would become a CSS injection.';
    }
    return out;
  }, [problems]);
  const blocked = problems.length > 0;

  const effective = (name: string): string => {
    const own = draft[name];
    if (own !== undefined && own !== '') return own;
    if (parentTokens !== null && parentTokens[name] !== undefined) {
      return parentTokens[name] as string;
    }
    return TOKENS[name]?.fallback ?? '';
  };

  return (
    <section aria-label={`Theme ${themeName}`}>
      {/* Stated where the editing happens, because the safe behaviour is the surprising one. */}
      <p role="note">
        {'Editing a theme does not change a survey already in field: a version pins the resolved ' +
          'tokens when it publishes, so a wave keeps the appearance it was approved with. ' +
          'Republish to adopt a change.'}
      </p>

      <ul style={{ listStyle: 'none', padding: 0 }}>
        {Object.keys(TOKENS)
          .sort()
          .map((name) => {
            const origin = tokenOrigin(name, draft, parentTokens);
            const spec = TOKENS[name];
            return (
              <li key={name} style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                <label style={{ minWidth: 180 }}>
                  {name}
                  <input
                    aria-label={`${name} value`}
                    value={draft[name] ?? ''}
                    placeholder={effective(name)}
                    disabled={disabled}
                    onChange={(e) => {
                      const next = { ...draft };
                      if (e.target.value === '') delete next[name];
                      else next[name] = e.target.value;
                      setDraft(next);
                    }}
                  />
                </label>
                {/* The origin, per token. An editor showing only the effective value makes "why did
                    my brand colour move" unanswerable. */}
                <span aria-label={`${name} origin`}>
                  {origin === 'own'
                    ? 'set here'
                    : origin === 'inherited'
                      ? `inherited from ${parentName ?? 'parent'}`
                      : 'platform default'}
                </span>
                <span aria-label={`${name} kind`}>{spec?.kind ?? ''}</span>
                {origin === 'own' && (
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => {
                      const next = { ...draft };
                      delete next[name];
                      setDraft(next);
                    }}
                  >
                    {`Reset ${name}`}
                  </button>
                )}
                {byToken[name] !== undefined && <p role="alert">{byToken[name]}</p>}
              </li>
            );
          })}
      </ul>

      {blocked && (
        <p role="status">{`${String(problems.length)} token(s) to fix before saving`}</p>
      )}

      <button
        type="button"
        disabled={disabled || pending || blocked}
        onClick={() => onSave(draft)}
      >
        {pending ? 'Saving…' : 'Save theme'}
      </button>
    </section>
  );
}
