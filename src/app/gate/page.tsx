import { redirect } from "next/navigation";

import { GateForm } from "./gate-form";
import { isOwner } from "@/lib/auth";
import { configProblems } from "@/lib/env";

export const metadata = { title: "Foreman" };

/**
 * The passcode screen.
 *
 * The whole of authentication. No email, no account, no reset — one shared
 * passcode, typed once on his phone and remembered for a year. It replaced
 * sign-up, sign-in, magic links, an org table and row level security, none of
 * which a single person running a single job ever needed.
 */
export default async function GatePage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  if (await isOwner()) redirect("/");
  const { next } = await searchParams;

  // An unfinished deployment says so, rather than showing a passcode box that
  // cannot possibly accept anything. Naming the variables gives away nothing —
  // the app is locked either way — and without it the only symptom is a form
  // that rejects the right passcode.
  const problems = configProblems();
  if (problems.length > 0) {
    return (
      <div className="gate">
        <div className="gate-card">
          <h1>Almost there</h1>
          <p>
            This deployment is locked until it is finished being set up. Set
            these in the Vercel dashboard under Settings → Environment
            Variables, then redeploy.
          </p>
          <ul className="setup-list">
            {problems.map((problem) => (
              <li key={problem.variable}>
                <code>{problem.variable}</code>
                <span>{problem.message}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    );
  }

  return (
    <div className="gate">
      <div className="gate-card">
        <h1>Foreman</h1>
        <p>Enter the passcode to change the schedule.</p>
        <GateForm next={next} />
      </div>
    </div>
  );
}
