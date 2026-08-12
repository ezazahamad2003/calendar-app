import { NextResponse, type NextRequest } from "next/server";

/**
 * Proxy — Next.js 16's name for Middleware. See
 * `node_modules/next/dist/docs/01-app/01-getting-started/16-proxy.md`.
 *
 * One job: send someone without a session to the passcode screen, so they get a
 * form instead of an error. That is a redirect for the address bar, **not** the
 * security boundary. Next's own guidance is explicit that a proxy check is not
 * sufficient on its own, and it cannot be here — a server action is reachable
 * by POST without rendering any page.
 *
 * The real enforcement is `requireOwner()` at the top of every action that
 * writes, and `isOwner()` in every page that renders owner-only data. Deleting
 * this file must not make anything reachable that was not reachable before; if
 * it does, that is a bug in the actions.
 *
 * The cookie is only *inspected* here, never verified: verifying needs an HMAC
 * over a secret, and the proxy runs on the edge runtime where `node:crypto` is
 * not available. A forged cookie therefore gets past the redirect and straight
 * into `requireOwner()`, which is exactly where it should be refused.
 */

const COOKIE = "foreman_owner";

/** Reachable without the passcode. */
function isPublic(pathname: string): boolean {
  return (
    pathname === "/gate" ||
    // The read-only crew link. Its own token is checked by the page, in
    // constant time, against the document.
    pathname === "/s" ||
    pathname.startsWith("/s/")
  );
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (isPublic(pathname)) return NextResponse.next();

  // Presence only — see the note above about the edge runtime.
  if (request.cookies.get(COOKIE)?.value) return NextResponse.next();

  const to = request.nextUrl.clone();
  to.pathname = "/gate";
  to.search = "";
  // Preserve where they were headed so the gate can bounce them back.
  if (pathname !== "/") to.searchParams.set("next", pathname);
  return NextResponse.redirect(to);
}

export const config = {
  matcher: [
    // Everything except static assets, the icon, and the API routes that do
    // their own checking.
    "/((?!_next/static|_next/image|favicon.ico|api/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
