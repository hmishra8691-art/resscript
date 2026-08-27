/**
 * The question-type picker — driven by registry METADATA, which is the whole point.
 *
 * P1-04's acceptance is "adding a fourth plugin requires touching no file in `apps/studio`", and
 * `question-kit`'s `react.ts` says the same from the other side: "adding a fourth plugin means
 * adding it to this list and nothing else — no file in `apps/studio` names a question type". So
 * this component names none. It reads `FIRST_PARTY_PLUGINS`, groups by `meta.category`, renders
 * `meta.icon` and gates on `meta.entitlementKey`. Grep the studio for `single_select` or `nps`
 * and the absence is the test.
 *
 * Two details that are contract, not styling:
 *
 *  - **An unentitled type is listed, disabled.** F §7: "'we do not have that' is more useful than
 *    'it does not exist'", and hiding it makes the upgrade path invisible. `PluginOption` is a
 *    component rather than a loop body because the entitlement answer comes from a hook, and one
 *    hook per plugin is legal exactly as long as the list is stable — which a static registry is.
 *  - **The label is humanized from the plugin ID, not from `displayName`.** `displayName` is an
 *    i18n key (`qt.consent.name`) and studio has no UI bundle in Phase 1; resolving the key's
 *    tail would render "Name" for every plugin. The key travels in `title` so a real bundle has
 *    an obvious hook, and `wire.ts`'s `humanizeId` is the one function to replace.
 *
 * The ICON_GLYPH map is the stand-in for the studio icon set (`PluginMeta.icon`: "Icon id from
 * the studio icon set. Plugins ship no image assets."). It is keyed by ICON ID, never by plugin
 * id, so a new plugin reusing an existing icon needs nothing here and a new icon degrades to a
 * neutral glyph rather than to a blank.
 */

'use client';

import { FIRST_PARTY_PLUGINS } from '@resscript/question-kit/react';
import type { PluginMeta } from '@resscript/question-kit';
import { useEntitlement } from '@/hooks/useEntitlement';
import { humanizeId } from './wire';

const ICON_GLYPH: Readonly<Record<string, string>> = {
  radio: '◉',
  checkbox: '☑',
  toggle: '⇄',
  gauge: '◑',
  star: '★',
  text_field: '▭',
  text_area: '▤',
  paragraph: '¶',
  list: '☰',
  'list-ordered': '⒈',
  hash: '#',
  calendar: '▦',
  grid: '▩',
  image: '▣',
  shield_check: '⛨',
};

function glyphFor(icon: string): string {
  return ICON_GLYPH[icon] ?? '◻';
}

/** Categories in the registry's own order (`PLUGIN_CATEGORIES`), so the palette is stable. */
function groupByCategory(metas: readonly PluginMeta[]): readonly (readonly [string, readonly PluginMeta[]])[] {
  const groups = new Map<string, PluginMeta[]>();
  for (const meta of metas) {
    const bucket = groups.get(meta.category);
    if (bucket === undefined) groups.set(meta.category, [meta]);
    else bucket.push(meta);
  }
  return [...groups.entries()];
}

export interface TypePickerProps {
  readonly value: string | null;
  readonly disabled?: boolean;
  readonly onChange: (questionType: string) => void;
  readonly testId?: string;
}

export function TypePicker({ value, disabled = false, onChange, testId }: TypePickerProps): React.JSX.Element {
  const metas = FIRST_PARTY_PLUGINS.map((plugin) => plugin.meta);
  return (
    <select
      className="rs-input"
      aria-label="Question type"
      data-testid={testId ?? 'type-picker'}
      disabled={disabled}
      value={value ?? ''}
      onChange={(event) => {
        onChange(event.target.value);
      }}
    >
      {value === null ? <option value="">Choose a type…</option> : null}
      {groupByCategory(metas).map(([category, group]) => (
        <optgroup key={category} label={category}>
          {group.map((meta) => (
            <PluginOption key={meta.id} meta={meta} />
          ))}
        </optgroup>
      ))}
    </select>
  );
}

function PluginOption({ meta }: { readonly meta: PluginMeta }): React.JSX.Element {
  // `'none'` for an ungated type: the hook is unconditional (a hook must be), and its answer is
  // only read when the plugin actually declares a key.
  const entitlement = useEntitlement(meta.entitlementKey ?? 'none');
  const gated = meta.entitlementKey !== null && !entitlement.enabled;
  return (
    <option value={meta.id} disabled={gated} title={meta.displayName}>
      {glyphFor(meta.icon)} {humanizeId(meta.id)}
      {gated ? ' — not in your plan' : ''}
    </option>
  );
}

/** The plugin whose editor and defaults a question of this type uses, or `undefined`. */
export function pluginFor(questionType: string | null): (typeof FIRST_PARTY_PLUGINS)[number] | undefined {
  if (questionType === null) return undefined;
  return FIRST_PARTY_PLUGINS.find((plugin) => plugin.meta.id === questionType);
}
