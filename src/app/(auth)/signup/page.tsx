import type { Metadata } from "next";

import { SignupForm } from "./signup-form";

export const metadata: Metadata = { title: "Create account | Foreman" };

export default function SignupPage() {
  return (
    <main className="auth-shell">
      <SignupForm />
    </main>
  );
}
