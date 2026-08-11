import type { NextRequest } from "next/server";

import { completeOAuth } from "@/lib/providers/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * OAuth return leg for Google. This path must match an "Authorized redirect
 * URI" in the Google Cloud credential byte for byte, or the exchange fails
 * with redirect_uri_mismatch.
 */
export async function GET(request: NextRequest) {
  return completeOAuth(request, "google");
}
