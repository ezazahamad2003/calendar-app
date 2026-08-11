import { NextResponse, type NextRequest } from "next/server";

import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Where email confirmation and magic links land.
 *
 * Supabase sends the user here with a one-time `code`; exchanging it sets the
 * session cookies. Until that exchange happens the user is not signed in, so
 * this route is on the proxy's public list.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const code = searchParams.get("code");

  // Supabase reports link failures (expired, already used) as query params
  // rather than an HTTP error, so they have to be read off the URL.
  const authError = searchParams.get("error_description") ?? searchParams.get("error");
  if (authError) {
    return NextResponse.redirect(
      `${origin}/auth/auth-code-error?reason=${encodeURIComponent(authError)}`,
    );
  }

  if (!code) {
    return NextResponse.redirect(
      `${origin}/auth/auth-code-error?reason=${encodeURIComponent(
        "That link is missing its confirmation code.",
      )}`,
    );
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    return NextResponse.redirect(
      `${origin}/auth/auth-code-error?reason=${encodeURIComponent(error.message)}`,
    );
  }

  // Land on "/calendar", which routes to onboarding or the schedule depending
  // on whether this user has an org yet. Keeping that decision in one place
  // means the callback does not need to know about it. Not "/" — that is the
  // marketing page, and a confirmation link that lands on a sales pitch reads
  // like the confirmation did not work.
  //
  // Only a relative path is honoured — `next` arrives from a URL the user
  // clicked in an email, so treating it as trusted would be an open redirect.
  const next = searchParams.get("next");
  const target =
    next && next.startsWith("/") && !next.startsWith("//") ? next : "/calendar";

  return NextResponse.redirect(`${origin}${target}`);
}
