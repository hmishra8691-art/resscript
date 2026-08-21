/**
 * The preview/debug postMessage protocol — security §3.2, E §12.3.
 *
 * One typed protocol for two consumers: studio's sandboxed preview iframe and the debug
 * panel, which rides the same channel ("this is not overhead we take on for security alone").
 * It lives in `runtime-core` because BOTH ends must agree on it byte for byte — the client
 * bundle validates what the studio sends, the studio validates what the frame sends back, and
 * two hand-maintained copies of that contract would drift the way all duplicated contracts
 * drift: silently, and discovered in production.
 *
 * The security rules the shapes exist to serve (security §3.2): both sides check
 * `event.origin` against the expected value AND validate the message structurally before
 * touching it. Origin alone is insufficient — a compromised preview origin can send a
 * structurally hostile message; validation alone is insufficient because any frame can
 * postMessage. Both, always. These validators are the "validate" half; they are hand-rolled
 * because `runtime-core` ships in the respondent bundle where a schema library is 12 KB of
 * budget (ADR-010), and the studio may wrap them in Zod if it likes — over the SAME types.
 *
 * Doc reconciliation, recorded rather than silently chosen: security §3.2 names this file and
 * uses colon-namespaced messages (`preview:init`); E §12.3 sketches the same protocol with
 * dot names (`preview.init`) and a few extra messages. The file the security doc names wins
 * on naming; E's extra messages (`setSeed` as an init field, `stepBack`, trace levels) are
 * carried where Phase 1 has server behaviour to back them.
 */

/* ------------------------------------------------------------------ *
 * Messages: studio -> preview frame
 * ------------------------------------------------------------------ */

export type DeviceClass = 'desktop' | 'tablet' | 'mobile';

export type StudioToPreview =
  /** Start (or restart) a preview session on this artifact. `seed` reproduces a session. */
  | { readonly t: 'preview:init'; readonly artifact_hash: string; readonly language: string;
      readonly device: DeviceClass; readonly seed?: string }
  /** Jump to a page. Server-verified: the preview session must actually be able to hold it. */
  | { readonly t: 'preview:goto'; readonly page_id: string }
  /** Jump into a variable state. Test-mode only; re-validated server-side (security §3.2). */
  | { readonly t: 'preview:setVars'; readonly vars: Readonly<Record<string, unknown>> }
  | { readonly t: 'preview:setDevice'; readonly device: DeviceClass }
  | { readonly t: 'preview:reload'; readonly artifact_hash: string };

/* ------------------------------------------------------------------ *
 * Messages: preview frame -> studio
 * ------------------------------------------------------------------ */

export type PreviewToStudio =
  | { readonly t: 'preview:ready'; readonly artifact_hash: string; readonly session_id: string }
  | { readonly t: 'preview:page'; readonly page_id: string; readonly height: number }
  /** The full E §14.2 trace for the page, PII-redacted server-side. */
  | { readonly t: 'preview:trace'; readonly trace: unknown }
  | { readonly t: 'preview:validation'; readonly issues: readonly unknown[] }
  | { readonly t: 'preview:disposition'; readonly disposition: string;
      readonly redirect_url: string | null }
  | { readonly t: 'preview:error'; readonly code: string; readonly message: string };

/* ------------------------------------------------------------------ *
 * Validators
 * ------------------------------------------------------------------ */

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

const DEVICES: readonly string[] = ['desktop', 'tablet', 'mobile'];
const HASH = /^[0-9a-f]{64}$/;

/**
 * `null` for anything that is not a well-formed studio message — including near-misses with
 * extra meaning smuggled into a field. Returning the INPUT object on success would hand the
 * caller unvalidated extra properties, so a fresh object is built from exactly the validated
 * fields and nothing else.
 */
export function parseStudioToPreview(x: unknown): StudioToPreview | null {
  if (!isRecord(x) || typeof x['t'] !== 'string') return null;
  switch (x['t']) {
    case 'preview:init': {
      if (typeof x['artifact_hash'] !== 'string' || !HASH.test(x['artifact_hash'])) return null;
      if (typeof x['language'] !== 'string' || x['language'].length > 16) return null;
      if (typeof x['device'] !== 'string' || !DEVICES.includes(x['device'])) return null;
      if (x['seed'] !== undefined &&
          (typeof x['seed'] !== 'string' || !/^[0-9a-f]{32}$/.test(x['seed']))) return null;
      return {
        t: 'preview:init', artifact_hash: x['artifact_hash'], language: x['language'],
        device: x['device'] as DeviceClass,
        ...(x['seed'] !== undefined ? { seed: x['seed'] as string } : {}),
      };
    }
    case 'preview:goto':
      if (typeof x['page_id'] !== 'string' || x['page_id'].length > 64) return null;
      return { t: 'preview:goto', page_id: x['page_id'] };
    case 'preview:setVars': {
      if (!isRecord(x['vars'])) return null;
      const entries = Object.entries(x['vars']);
      if (entries.length > 256) return null; // a hostile message is bounded before it is parsed
      return { t: 'preview:setVars', vars: Object.fromEntries(entries) };
    }
    case 'preview:setDevice':
      if (typeof x['device'] !== 'string' || !DEVICES.includes(x['device'])) return null;
      return { t: 'preview:setDevice', device: x['device'] as DeviceClass };
    case 'preview:reload':
      if (typeof x['artifact_hash'] !== 'string' || !HASH.test(x['artifact_hash'])) return null;
      return { t: 'preview:reload', artifact_hash: x['artifact_hash'] };
    default:
      return null;
  }
}

/** The studio-side twin. Same construction discipline: validated fields only. */
export function parsePreviewToStudio(x: unknown): PreviewToStudio | null {
  if (!isRecord(x) || typeof x['t'] !== 'string') return null;
  switch (x['t']) {
    case 'preview:ready':
      if (typeof x['artifact_hash'] !== 'string' || typeof x['session_id'] !== 'string') return null;
      return { t: 'preview:ready', artifact_hash: x['artifact_hash'], session_id: x['session_id'] };
    case 'preview:page':
      if (typeof x['page_id'] !== 'string' || typeof x['height'] !== 'number') return null;
      return { t: 'preview:page', page_id: x['page_id'], height: x['height'] };
    case 'preview:trace':
      return { t: 'preview:trace', trace: x['trace'] };
    case 'preview:validation':
      if (!Array.isArray(x['issues'])) return null;
      return { t: 'preview:validation', issues: x['issues'] };
    case 'preview:disposition':
      if (typeof x['disposition'] !== 'string') return null;
      if (x['redirect_url'] !== null && typeof x['redirect_url'] !== 'string') return null;
      return { t: 'preview:disposition', disposition: x['disposition'],
               redirect_url: x['redirect_url'] };
    case 'preview:error':
      if (typeof x['code'] !== 'string' || typeof x['message'] !== 'string') return null;
      return { t: 'preview:error', code: x['code'], message: x['message'] };
    default:
      return null;
  }
}
