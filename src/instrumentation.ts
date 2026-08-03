/**
 * Runs once when a Next.js server instance starts, before it serves any
 * request. We use it to validate the environment up front: a bad `.env` should
 * stop the server at boot with a clear message, not surface as a confusing
 * runtime failure on the first API call. See `src/lib/env.ts`.
 */
export async function register() {
  // Env vars are only fully available in the Node.js runtime. The Edge runtime
  // gets a validated subset lazily via getEnv() at point of use.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { getEnv } = await import("@/lib/env");
    getEnv();
  }
}
