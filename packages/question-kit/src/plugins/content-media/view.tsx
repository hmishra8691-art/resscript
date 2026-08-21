/**
 * `content_media` renderer and editor.
 *
 * The renderer's one real decision: **what each `kind` renders and what names it.**
 *
 *  - `image` → `<figure><img alt={altKey}/></figure>`. When `altKey` is somehow absent at
 *    render time (compile blocks it with `missing_alt`, but a renderer must not crash on a
 *    state upstream forbids), the fallback is `alt=""` — explicitly decorative is strictly
 *    better than an `img` announcing its file name.
 *  - `video`/`audio` → the native element with `controls`, named via `aria-label={altKey}`.
 *    Native controls rather than a custom transport for the `date` plugin's reason inverted:
 *    the a11y contract here declares no widget, so the browser's own — which every screen
 *    reader already knows — is the honest floor. The `<track>` captions slot is where the
 *    runtime injects caption assets; the plugin renders the media element and the hook, never
 *    resolves an asset itself (F §6).
 *
 * `autoplay` passes through as authored: `staticChecks` already made the author acknowledge the
 * warning, and a plugin that silently strips a config value teaches authors the config lies.
 *
 * Exposure telemetry is NOT collected here. `Q_viewed`/`Q_dwell_s` are written by the runtime
 * (visibility and timing live in the page shell, which owns the viewport), not by a renderer
 * calling `onChange` — the codec would reject it anyway, by design.
 */

import type { ReactNode } from 'react';
import { defineRenderer, type EditorProps, type RendererProps } from '../../contract/view.js';
import type { ContentMediaAnswer, ContentMediaConfig } from './core.js';

const ACCEPT_BY_KIND = {
  image: ['image/*'],
  video: ['video/*'],
  audio: ['audio/*'],
} as const;

export const ContentMediaRenderer = defineRenderer<ContentMediaConfig, ContentMediaAnswer>(
  ({ question, ctx }: RendererProps<ContentMediaConfig, ContentMediaAnswer>): ReactNode => {
    const config = question.config;
    const name = config.altKey === undefined ? undefined : ctx.pipe(config.altKey);

    if (config.kind === 'image') {
      return (
        <figure id={ctx.ids.groupId} className="rs-media rs-media--image">
          <img className="rs-media__asset" src={config.assetRef} alt={name ?? ''} />
        </figure>
      );
    }

    if (config.kind === 'video') {
      return (
        <div id={ctx.ids.groupId} className="rs-media rs-media--video">
          <video
            className="rs-media__asset"
            src={config.assetRef}
            controls
            preload="metadata"
            autoPlay={config.autoplay ? true : undefined}
            aria-label={name}
          >
            {/* Captions hook: the runtime appends <track kind="captions"> children here. */}
          </video>
        </div>
      );
    }

    return (
      <div id={ctx.ids.groupId} className="rs-media rs-media--audio">
        <audio
          className="rs-media__asset"
          src={config.assetRef}
          controls
          preload="metadata"
          autoPlay={config.autoplay ? true : undefined}
          aria-label={name}
        />
      </div>
    );
  },
);

/** Studio editor. Patches only, inside the allowlist — see `single-select/view.tsx`. */
export function ContentMediaEditor({ question, patch, ctx }: EditorProps<ContentMediaConfig>): ReactNode {
  const config = question.config;
  // `remove` for a cleared altKey: "no alt yet" and "alt of the empty string" are different
  // states, and the second fails the config schema's minLength (the `date` bound pattern).
  const altPatch = (raw: string): void =>
    patch([
      raw === ''
        ? { op: 'remove', path: '/config/altKey' }
        : { op: 'add', path: '/config/altKey', value: raw },
    ]);

  return (
    <div className="rs-editor rs-editor--content-media">
      <label>
        {ctx.t('editor.media_kind')}
        <select
          value={config.kind}
          onChange={(event) =>
            patch([{ op: 'replace', path: '/config/kind', value: event.target.value }])
          }
        >
          {(['image', 'video', 'audio'] as const).map((kind) => (
            <option key={kind} value={kind}>
              {ctx.t(`editor.media_kind.${kind}`)}
            </option>
          ))}
        </select>
      </label>
      {/* The editor never holds a storage credential: it asks, studio picks, studio patches
          `/config/assetRef` (F §6). */}
      <button type="button" onClick={() => ctx.requestAsset(ACCEPT_BY_KIND[config.kind])}>
        {ctx.t('editor.media_pick_asset')}
      </button>
      <label>
        {ctx.t('editor.media_alt_key')}
        <input
          type="text"
          value={config.altKey ?? ''}
          onChange={(event) => altPatch(event.target.value)}
        />
      </label>
      <label>
        {ctx.t('editor.media_autoplay')}
        <input
          type="checkbox"
          checked={config.autoplay}
          onChange={(event) =>
            patch([{ op: 'replace', path: '/config/autoplay', value: event.target.checked }])
          }
        />
      </label>
      <label>
        {ctx.t('editor.media_track_exposure')}
        <input
          type="checkbox"
          checked={config.trackExposure}
          onChange={(event) =>
            patch([{ op: 'replace', path: '/config/trackExposure', value: event.target.checked }])
          }
        />
      </label>
    </div>
  );
}
