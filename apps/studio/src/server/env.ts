/**
 * Environment access, in one place, read lazily.
 *
 * WHY lazily: `next build` imports every module in the route graph to collect metadata. A
 * module that reads `process.env.NEXT_PUBLIC_SUPABASE_URL` at import time and throws turns a
 * missing variable into a build failure on a machine that was never going to run a request —
 * CI, a Docker image build, a contributor's laptop. Reading inside a function means the
 * failure lands on the first request that actually needs the network, where the error message
 * can name the variable and the caller can be told honestly that the app is misconfigured.
 */

export interface SupabaseEnv {
  readonly url: string;
  readonly anonKey: string;
}

/** Values that mean "nobody configured this" — the committed `.env.example` placeholders. */
const PLACEHOLDER_MARKERS = ['placeholder', 'changeme', 'example'];

function read(name: string): string | undefined {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') return undefined;
  return value;
}

function isPlaceholder(value: string): boolean {
  const lower = value.toLowerCase();
  return PLACEHOLDER_MARKERS.some((marker) => lower.includes(marker));
}

/**
 * The browser-safe pair. Present-but-placeholder is reported as configured=false rather than
 * as a value, so a developer running `pnpm build` with `.env.example` copied in gets the
 * "not configured" path instead of DNS errors against `placeholder.supabase.co`.
 */
export function supabaseEnv(): SupabaseEnv | undefined {
  const url = read('NEXT_PUBLIC_SUPABASE_URL');
  const anonKey = read('NEXT_PUBLIC_SUPABASE_ANON_KEY');
  if (url === undefined || anonKey === undefined) return undefined;
  if (isPlaceholder(url) || isPlaceholder(anonKey)) return undefined;
  return { url, anonKey };
}

/**
 * The service-role key, used for exactly one operation: re-minting an access token with a new
 * `app_metadata.active_org_id` (security §2.2 — "switching orgs mints a new token"). It
 * bypasses RLS, so it must never be used for a read and never reach the browser.
 */
export function serviceRoleKey(): string | undefined {
  const key = read('SUPABASE_SERVICE_ROLE_KEY');
  if (key === undefined || isPlaceholder(key)) return undefined;
  return key;
}

export function isSupabaseConfigured(): boolean {
  return supabaseEnv() !== undefined;
}
