/**
 * Runs once when a Next.js server instance starts, before it serves any
 * request. Used to validate the environment up front, so a malformed value
 * fails at boot with a clear message rather than deep inside a request.
 *
 * What it deliberately does NOT do is throw over *missing* production secrets.
 * A throw here does not fail one route — it fails `registerInstrumentation`,
 * which takes the whole Node process down, which meant every route returned an
 * opaque 500 including `/gate`, the one page whose job is to explain what is
 * wrong. The deployment was unusable and undiagnosable at the same time.
 *
 * Missing secrets are handled by `configProblems()` instead: the app stays up
 * and stays locked, and `/gate` says which variables to set. See `src/lib/env.ts`.
 */
export async function register() {
  // Env vars are only fully available in the Node.js runtime. The Edge runtime
  // gets a validated subset lazily via getEnv() at point of use.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { getEnv, configProblems } = await import("@/lib/env");

  // Never allowed to throw. Anything that escapes here fails
  // `registerInstrumentation`, and Next treats that as fatal: the process
  // exits and every route 500s, including the setup screen that would have
  // told you which variable to fix.
  try {
    getEnv();
  } catch (err) {
    console.error(
      `\n[foreman] ${err instanceof Error ? err.message : String(err)}\n` +
        "The app is running but locked. Fix the above and redeploy.\n",
    );
    return;
  }

  const problems = configProblems();
  if (problems.length > 0) {
    console.warn(
      "\n[foreman] This deployment is not finished being set up, so it is " +
        "locked. Set the following and redeploy:\n" +
        problems.map((p) => `  • ${p.variable}: ${p.message}`).join("\n") +
        "\n",
    );
  }
}
