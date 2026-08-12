/**
 * Runs once when a Next.js server instance starts, before it serves any
 * request. Used to validate the environment up front, so a malformed value
 * fails at boot with a clear message rather than deep inside a request.
 *
 * It never throws. Anything that escapes here fails `registerInstrumentation`,
 * and Next treats that as fatal: the process exits and every route 500s with
 * no clue as to why. A bad env var should be a loud log line, not an outage.
 */
export async function register() {
  // Env vars are only fully available in the Node.js runtime. The Edge runtime
  // gets a validated subset lazily via getEnv() at point of use.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  try {
    const { getEnv } = await import("@/lib/env");
    getEnv();
  } catch (err) {
    console.error(
      `\n[foreman] ${err instanceof Error ? err.message : String(err)}\n` +
        "The app is running, but this needs fixing.\n",
    );
  }
}
