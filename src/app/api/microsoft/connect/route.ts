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
