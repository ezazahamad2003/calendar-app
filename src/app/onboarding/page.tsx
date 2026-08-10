import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { getMembership } from "@/lib/auth/dal";
import { OnboardingForm } from "./onboarding-form";

export const metadata: Metadata = { title: "Set up your company | Foreman" };

/**
 * Reached after sign-up, and by anyone signed in who has no org yet. The proxy
 * guarantees a session; this page's own job is to bounce users who already
 * have an org, so the back button cannot land them on a form that would fail.
 */
export default async function OnboardingPage() {
  const membership = await getMembership();
  if (membership) redirect("/");

  // Enumerated on the server so the option list is identical in the HTML and
  // after hydration. The Postgres function validates against pg_timezone_names
  // regardless — this list is a convenience, not the check.
  const timezones = Intl.supportedValuesOf("timeZone");

  return (
    <main className="auth-shell">
      <OnboardingForm timezones={timezones} />
    </main>
  );
}
