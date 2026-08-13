import type { NextRequest } from "next/server";

import { startOAuth } from "@/lib/providers/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Send the user to microsoft's consent screen. See `lib/providers/oauth.ts`. */
export async function GET(request: NextRequest) {
  return startOAuth(request, "microsoft");
}
