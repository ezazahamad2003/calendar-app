import "server-only";

import { getEnv } from "@/lib/env";

/**
 * The origin to build the crew's read-only link from.
 *
 * Not simply `NEXT_PUBLIC_APP_URL`, because every Vercel preview deployment
 * gets its own hostname. With a single fixed value, a link copied from a
 * preview would point at production — so the thing you were trying to check is
 * the one place you never land. That failure is quiet: the link works, it just
 * shows the wrong data.
 *
 * `VERCEL_ENV` and `VERCEL_URL` are injected by the platform and are not ours
 * to set, which is why they are read here rather than declared in `env.ts`.
 * Locally neither exists and this falls through.
 */
export function getAppOrigin(): string {
  // Production keeps the canonical URL: VERCEL_URL there is the
  // per-deployment hostname, not the pretty one, and a link the crew keeps
  // should point at the stable domain.
  if (process.env.VERCEL_ENV === "preview" && process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`;
  }

  return getEnv().NEXT_PUBLIC_APP_URL.replace(/\/+$/, "");
}
