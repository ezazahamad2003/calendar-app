import "server-only";

/**
 * Things a deployment needs before it can do anything, reported rather than
 * thrown.
 *
 * This is the second time the same lesson has been learned here, so it is
 * written down: a deployment prerequisite that throws produces an opaque 500 on
 * every route, and the person who has to fix it cannot see which one it is
 * without reading server logs. Reporting costs nothing and turns a dead site
 * into a page that says "connect a Blob store".
 *
 * `storeDriver()` still throws for callers that genuinely cannot continue —
 * server actions, the API route. Pages check here first and render the setup
 * screen instead.
 */

export type SetupProblem = { title: string; message: string };

export function setupProblems(): SetupProblem[] {
  const problems: SetupProblem[] = [];

  // Blob is the only durable store on Vercel. Without it the app appears to
  // work and then silently forgets every change when the function instance is
  // recycled, which is far worse than refusing to start.
  const onVercel = process.env.VERCEL === "1";
  if (onVercel && !process.env.BLOB_READ_WRITE_TOKEN?.trim()) {
    problems.push({
      title: "Connect a Blob store",
      message:
        "The schedule is one JSON document and Vercel Blob is where it lives. " +
        "A serverless function's filesystem is thrown away between requests, so " +
        "without this every change would be lost. In the Vercel dashboard: " +
        "Storage → Create → Blob, set Access to Private, connect it to this " +
        "project, then redeploy. The token is injected for you.",
    });
  }

  return problems;
}
