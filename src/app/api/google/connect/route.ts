import type { NextRequest } from "next/server";

import { startOAuth } from "@/lib/providers/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Start of the Google OAuth dance (Gmail + Calendar). Same flow as Microsoft,
 * different endpoints and two extra query params — see `lib/providers/oauth.ts`
 * and the `extraAuthParams` note in `catalog.ts`.
 */
export async function GET(request: NextRequest) {
  return startOAuth(request, "google");
}
