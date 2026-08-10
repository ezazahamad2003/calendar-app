import { redirect } from "next/navigation";

import { getMembership } from "@/lib/auth/dal";
import { signOut } from "@/app/(auth)/actions";

/**
 * The dashboard (SPEC §7: "the screen he opens in the morning with coffee").
 *
 * Phase 2 ships the authenticated shell and the empty state — the Phase 2 gate
 * is "register → create org → land on empty dashboard, end to end". Phase 3
 * fills it with real projects, the Gantt and the calendar.
 */
export default async function DashboardPage() {
  const membership = await getMembership();

  // Signed in but no org yet — finish onboarding first. The proxy has already
  // established there is a session, so this is the only remaining gap.
  if (!membership) redirect("/onboarding");

  return (
    <main className="dash-shell">
      <header className="dash-header">
        <div>
          <p className="dash-eyebrow">{membership.orgName}</p>
          <h1 className="dash-title">Today</h1>
        </div>
        <form action={signOut}>
          <button className="dash-signout" type="submit">
            Sign out
          </button>
        </form>
      </header>

      <section className="dash-empty">
        <h2 className="dash-empty-title">No projects yet</h2>
        <p className="dash-empty-body">
          Once you add a job, this is where its health shows up each morning:
          what&rsquo;s in flight, what&rsquo;s late, what&rsquo;s blocked, and
          the next milestone.
        </p>
        <p className="dash-empty-meta">
          Scheduling dates are calculated in {membership.timezone}. You&rsquo;re
          signed in as {membership.email ?? "your account"} ({membership.role}).
        </p>
      </section>
    </main>
  );
}
