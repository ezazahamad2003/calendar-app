import type { Metadata } from "next";

import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in | Foreman" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;

  // Sanitised again in the action; doing it here too keeps a hostile value out
  // of the rendered hidden input in the first place.
  const safeNext = next && next.startsWith("/") && !next.startsWith("//") ? next : "/";

  return (
    <main className="auth-shell">
      <LoginForm next={safeNext} />
    </main>
  );
}
