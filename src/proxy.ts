import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

/**
 * Proxy — Next.js 16's name for what used to be Middleware. Same behaviour,
 * new filename; see `node_modules/next/dist/docs/01-app/01-getting-started/16-proxy.md`.
 *
 * Two jobs, in this order:
 *
 *   1. **Refresh the Supabase session.** Access tokens are short-lived. Server
 *      Components cannot write cookies, so if nothing refreshed the token here
 *      a user would be silently logged out mid-session. `getUser()` performs
 *      the refresh and `setAll` writes the rotated cookies onto the response.
 *
 *   2. **Optimistically gate routes.** This is a redirect for UX, *not* a
 *      security boundary. Next's own guidance is explicit that proxy checks are
 *      not sufficient on their own — the real enforcement is RLS in Postgres
 *      plus `requireSession()` in the Data Access Layer, both of which sit much
 *      closer to the data. Deleting this file must not make anything reachable
 *      that wasn't before; if it does, that is a bug in the DAL.
 */

/**
 * Reachable signed-out. Everything else requires a session.
 *
 * "/" is on the list because it is the marketing page — the one screen whose
 * whole job is to be read by someone without an account.
 */
const PUBLIC_PATHS = ["/", "/login", "/signup", "/auth/callback", "/auth/auth-code-error"];

function isPublic(pathname: string): boolean {
  // The `${p}/` prefix test is what makes "/auth/callback/anything" public
  // too. For "/" that would be "//", which no real pathname starts with, so
  // the root entry stays an exact match rather than opening everything.
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  // Without Supabase configured there is no session to refresh and no way to
  // authenticate anyone. Failing open here would be worse than useless, so
  // fail closed on everything except the public paths.
  if (!url || !key) {
    if (isPublic(request.nextUrl.pathname)) return response;
    const to = request.nextUrl.clone();
    to.pathname = "/login";
    return NextResponse.redirect(to);
  }

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        // Write to the request too, so anything downstream in this same pass
        // reads the rotated token rather than the stale one.
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  // Must be getUser(), not getSession(). getSession() trusts the cookie as-is;
  // getUser() revalidates it against the Auth server, which is both what
  // triggers the refresh and what makes the answer trustworthy.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;

  if (!user && !isPublic(pathname)) {
    const to = request.nextUrl.clone();
    to.pathname = "/login";
    // Preserve where they were headed so login can bounce them back.
    if (pathname !== "/") to.searchParams.set("next", pathname);
    return NextResponse.redirect(to);
  }

  // Signed in, so the pitch and the forms are all behind them: send them to
  // the work. This is what makes the app the default destination once an
  // account exists — typing the bare domain gets the schedule, not the
  // marketing page.
  if (user && (pathname === "/" || pathname === "/login" || pathname === "/signup")) {
    const to = request.nextUrl.clone();
    to.pathname = "/calendar";
    to.search = "";
    return NextResponse.redirect(to);
  }

  // IMPORTANT: return `response`, not a fresh NextResponse. It carries the
  // refreshed auth cookies; dropping it logs the user out on token rotation.
  return response;
}

export const config = {
  // Everything except static assets and image optimisation. Auth wants to run
  // broadly — a route that skips the proxy is a route with a stale session.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
