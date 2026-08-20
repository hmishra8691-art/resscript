/**
 * Middleware: session refresh, auth gate, and the `[org]` path assertion.
 *
 * Three jobs, in order:
 *
 *  1. Refresh the Supabase session. A Server Component cannot set cookies, so the refreshed
 *     token has to be written here or every RSC render races an expiring access token.
 *  2. Redirect an unauthenticated request for an app route to `/login`.
 *  3. Assert that the `[org]` segment matches the token's `active_org_id` (UI §2, security §2.2:
 *     "no org context is ever inferred from the request path"). A mismatch redirects to the
 *     org-switch flow rather than rendering — the URL is a convenience for shareable links and
 *     must never become the authorization input.
 *
 * FAILS CLOSED when Supabase is not configured: every app route redirects to
 * `/login?configuration=missing`. The alternative — passing the request through — would render
 * the shell for an unauthenticated visitor whenever an env var went missing in a deploy.
 */

import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

const PUBLIC_PATHS = ['/login', '/signup', '/accept-invite', '/auth/callback'];

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(path + '/'));
}

/** Control-plane ids are prefixed ULIDs; `/org_01H…/projects` is an org-scoped route. */
function orgSegmentOf(pathname: string): string | null {
  const first = pathname.split('/')[1];
  if (first === undefined) return null;
  return /^org_[0-9A-HJKMNP-TV-Z]{26}$/.test(first) ? first : null;
}

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;
  if (isPublic(pathname)) return NextResponse.next();

  const url = process.env['NEXT_PUBLIC_SUPABASE_URL'];
  const key = process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY'];
  if (url === undefined || key === undefined || url.includes('placeholder')) {
    const redirect = request.nextUrl.clone();
    redirect.pathname = '/login';
    redirect.searchParams.set('configuration', 'missing');
    return NextResponse.redirect(redirect);
  }

  let response = NextResponse.next({ request });
  const supabase = createServerClient(url, key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (toSet) => {
        for (const { name, value } of toSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of toSet) response.cookies.set(name, value, options);
      },
    },
  });

  // `getUser()` validates the token against the auth server. `getSession()` would decode the
  // cookie and trust it, which is not evidence for an authorization decision.
  const { data } = await supabase.auth.getUser();
  const user = data.user;

  if (user === null) {
    const redirect = request.nextUrl.clone();
    redirect.pathname = '/login';
    redirect.searchParams.set('next', pathname);
    return NextResponse.redirect(redirect);
  }

  const pathOrg = orgSegmentOf(pathname);
  if (pathOrg !== null) {
    const metadata = user.app_metadata as Record<string, unknown> | undefined;
    const activeOrg = metadata?.['active_org_id'];
    if (typeof activeOrg !== 'string' || activeOrg === '') {
      const redirect = request.nextUrl.clone();
      redirect.pathname = '/orgs';
      return NextResponse.redirect(redirect);
    }
    if (activeOrg !== pathOrg) {
      // The client-side `OrgGuard` offers the switch; this stops the page from rendering at all
      // under the wrong URL, so no request is ever issued from a page whose address disagrees
      // with the token.
      const redirect = request.nextUrl.clone();
      redirect.pathname = '/orgs';
      redirect.searchParams.set('requested', pathOrg);
      return NextResponse.redirect(redirect);
    }
  }

  return response;
}

export const config = {
  // API routes are deliberately excluded: they authenticate themselves through `route()` and
  // must answer with the JSON error envelope, not with a 307 to an HTML login page.
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],
};
