/**
 * `content_text` renderer and editor.
 *
 * The renderer is deliberately the least interesting one in the package: one `role="note"`
 * region, the body resolved through `ctx.pipe` (so piping works in instructions — "you told us
 * you drink {Q2}" is a real instrument), and *no form controls of any kind*. The a11y contract
 * documents the model; this file's job is to not accidentally exceed it — no tabindex, no
 * aria-live (the page shell owns the only live region, F §8), no aria-invalid (nothing here can
 * be in error).
 *
 * `variant` maps to a class token and nothing else. `legal` copy in particular must not be
 * visually demoted by the plugin (that is the design layer's call, P1-09) — the plugin's whole
 * styling contribution is the hook.
 */

import type { ReactNode } from 'react';
import { defineRenderer, type EditorProps, type RendererProps } from '../../contract/view.js';
import type { ContentTextAnswer, ContentTextConfig } from './core.js';

export const ContentTextRenderer = defineRenderer<ContentTextConfig, ContentTextAnswer>(
  ({ question, ctx }: RendererProps<ContentTextConfig, ContentTextAnswer>): ReactNode => {
    const variant = question.config.variant ?? 'body';
    return (
      <div
        role="note"
        id={ctx.ids.groupId}
        aria-labelledby={ctx.ids.labelId}
        className={`rs-content rs-content--${variant}`}
      >
        <p className="rs-content__body">{ctx.pipe(question.config.bodyKey)}</p>
      </div>
    );
  },
);

/** Studio editor. Patches only, inside the allowlist — see `single-select/view.tsx`. */
export function ContentTextEditor({ question, patch, ctx }: EditorProps<ContentTextConfig>): ReactNode {
  return (
    <div className="rs-editor rs-editor--content-text">
      <label>
        {ctx.t('editor.content_body_key')}
        <input
          type="text"
          value={question.config.bodyKey}
          onChange={(event) =>
            patch([{ op: 'replace', path: '/config/bodyKey', value: event.target.value }])
          }
        />
      </label>
      <label>
        {ctx.t('editor.content_variant')}
        <select
          value={question.config.variant ?? 'body'}
          onChange={(event) =>
            patch([{ op: 'replace', path: '/config/variant', value: event.target.value }])
          }
        >
          {(['body', 'callout', 'legal'] as const).map((variant) => (
            <option key={variant} value={variant}>
              {ctx.t(`editor.content_variant.${variant}`)}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
