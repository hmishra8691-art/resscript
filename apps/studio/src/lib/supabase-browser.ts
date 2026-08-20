/**
 * The browser Supabase client, created lazily and never at module scope.
 *
 * Returning `null` when the environment is unset is deliberate: `next build` prerenders these
 * pages, and a client constructed at import time would either throw during the build or bake a
 * placeholder URL into the bundle. A null client makes the auth screens render with a clear
 * "not configured" state instead.
 */

'use client';

import { createBrowserClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';

let cached: SupabaseClient | null | undefined;

export function browserSupabase(): SupabaseClient | null {
  if (cached !== undefined) return cached;
  const url = process.env['NEXT_PUBLIC_SUPABASE_URL'];
  const key = process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY'];
  if (url === undefined || key === undefined || url.includes('placeholder')) {
    cached = null;
    return cached;
  }
  cached = createBrowserClient(url, key);
  return cached;
}
