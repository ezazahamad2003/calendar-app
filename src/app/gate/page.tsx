import { redirect } from "next/navigation";

import { GateForm } from "./gate-form";
import { isOwner } from "@/lib/auth";

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
