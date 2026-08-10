import Link from "next/link";

/**
 * Shown when a confirmation or magic link fails to exchange — almost always
 * because it expired or had already been used. SPEC §8: say what happened and
 * what to do about it.
 */
export default async function AuthCodeErrorPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string }>;
}) {
  const { reason } = await searchParams;

  return (
    <main className="auth-shell">
      <div className="auth-card">
        <h1 className="auth-title">That link didn&rsquo;t work</h1>
        <p className="auth-lede">
          Sign-in links can only be used once, and they expire after an hour.
          Asking for a new one is the fix.
        </p>
        {reason ? (
          <p className="auth-error" role="status">
            {reason}
          </p>
        ) : null}
        <Link className="auth-submit auth-submit--link" href="/login">
          Get a new link
        </Link>
      </div>
    </main>
  );
}
