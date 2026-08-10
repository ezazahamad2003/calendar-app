import { NextResponse, type NextRequest } from "next/server";
import { createHash, randomBytes } from "node:crypto";

import { requireMembership } from "@/lib/auth/dal";
import { getEnv, requireEnv } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Start of the Microsoft OAuth dance (SPEC §6: authorization code + PKCE).
 *
 * The verifier and a CSRF state nonce ride in short-lived httpOnly cookies —
 * they only need to survive the round trip to login.microsoftonline.com.
 */
export async function GET(request: NextRequest) {
  try {
    await requireMembership();
  } catch {
    return NextResponse.redirect(new URL("/login", request.nextUrl.origin));
  }

  const env = getEnv();

  // A half-configured environment should say so, not throw a 500. All four are
  // needed: the first three to run the flow, the secret key to store the
  // resulting refresh token in a table only it can reach.
  const missing = (
    [
      ["MS_CLIENT_ID", env.MS_CLIENT_ID],
      ["MS_CLIENT_SECRET", env.MS_CLIENT_SECRET],
      ["MS_REDIRECT_URI", env.MS_REDIRECT_URI],
      ["SUPABASE_SECRET_KEY", env.SUPABASE_SECRET_KEY],
    ] as const
  )
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length > 0) {
    return NextResponse.redirect(
      `${request.nextUrl.origin}/?ms_error=${encodeURIComponent(
        `Outlook isn't configured here — missing ${missing.join(", ")}.`,
      )}`,
    );
  }

  const clientId = requireEnv("MS_CLIENT_ID");
  const redirectUri = requireEnv("MS_REDIRECT_URI");

  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(16).toString("base64url");

  const authorize = new URL(
    `https://login.microsoftonline.com/${env.MS_TENANT_ID}/oauth2/v2.0/authorize`,
  );
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("response_mode", "query");
  authorize.searchParams.set("scope", env.MS_SCOPES);
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("code_challenge", challenge);
  authorize.searchParams.set("code_challenge_method", "S256");

  const response = NextResponse.redirect(authorize);
  const cookie = {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/api/microsoft",
    maxAge: 600,
  };
  response.cookies.set("ms_pkce_verifier", verifier, cookie);
  response.cookies.set("ms_oauth_state", state, cookie);
  return response;
}
