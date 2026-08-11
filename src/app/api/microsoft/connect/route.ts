import type { NextRequest } from "next/server";

import { startOAuth } from "@/lib/providers/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Start of the Microsoft OAuth dance. The flow itself is shared with Google
 * (see `lib/providers/oauth.ts`); this path exists because it is registered as
 * a redirect URI in Entra and must not move.
 */
export async function GET(request: NextRequest) {
  return startOAuth(request, "microsoft");
}
