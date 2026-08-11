import type { NextRequest } from "next/server";

import { completeOAuth } from "@/lib/providers/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** OAuth return leg for Microsoft. Must stay at this exact path (Entra). */
export async function GET(request: NextRequest) {
  return completeOAuth(request, "microsoft");
}
