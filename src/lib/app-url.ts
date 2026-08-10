import "server-only";

import { getEnv } from "@/lib/env";

/**
 * The origin to build user-facing absolute URLs from — currently the
 * `emailRedirectTo` on confirmation and magic-link emails.
 *
 * Why this is not just `NEXT_PUBLIC_APP_URL`:
 *
 * Every Vercel preview deployment gets its own hostname. With a single fixed
 * value, a magic link requested from a preview would carry the *production*
 * URL, so clicking it signs you into production — the deployment you were
 * trying to test is the one place you don't end up. That failure is quiet and
 * genuinely confusing, because the email arrives and the link works.
 *
 * `VERCEL_ENV` and `VERCEL_URL` are injected by the platform; they are not ours
 * to set, which is why they are read here rather than declared in `env.ts`.
 * Locally neither exists and this falls through to `NEXT_PUBLIC_APP_URL`.
 *
 * Note that whatever this returns must also be on Supabase's redirect
 * allow-list, or Supabase silently substitutes its Site URL. See DEPLOYMENT.md.
 */
export function getAppOrigin(): string {
  const vercelEnv = process.env.VERCEL_ENV;
  const vercelUrl = process.env.VERCEL_URL;

  // Production deployments keep the canonical URL: VERCEL_URL there is the
  // per-deployment hostname (calendar-app-abc123.vercel.app), not the pretty
  // one, and links in email should point at the stable domain.
  if (vercelEnv === "preview" && vercelUrl) {
    return `https://${vercelUrl}`;
  }

  return getEnv().NEXT_PUBLIC_APP_URL.replace(/\/+$/, "");
}
