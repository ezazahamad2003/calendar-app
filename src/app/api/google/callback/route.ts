import type { NextRequest } from "next/server";

import { completeOAuth } from "@/lib/providers/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Where google sends the user back. See `lib/providers/oauth.ts`. */
export async function GET(request: NextRequest) {
  return completeOAuth(request, "google");
}
