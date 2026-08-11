import { requireMembership } from "@/lib/auth/dal";
import { connectionStates, summarize } from "@/lib/providers/factory";
import { ConnectionCard } from "./connection-card";

/**
 * Connections: the user decides which outside accounts Foreman may use.
 *
 * Both providers are offered independently — connect Outlook, connect Gmail,
 * connect both, connect neither. When two are connected one of them is the
 * primary, which is simply the answer to "which account does mail go out
 * from?"; the app never guesses that on the user's behalf.
 */
export default async function ConnectionsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; connected?: string }>;
}) {
  const m = await requireMembership();
  const [states, params] = await Promise.all([
    connectionStates(m.orgId, m.userId),
    searchParams,
  ]);
  const { anyAvailable, active } = summarize(states);

  const justConnected = states.find(
    (s) => s.provider === params.connected && s.connected,
  );

  return (
    <main className="page">
      <header className="page-head">
        <div>
          <p className="page-eyebrow">{m.orgName}</p>
          <h1 className="page-title">Connections</h1>
        </div>
      </header>

      <p className="page-intro">
        Connect the accounts you want Foreman to send from. Everything works
        without them — schedules, crew, the voice bar — but until one is
        connected, emails and calendar invites are{" "}
        <strong>simulated</strong>: marked sent without leaving the app.
      </p>

      {params.error ? (
        <p className="form-error" role="alert">
          {params.error}
        </p>
      ) : null}

      {justConnected ? (
        <p className="form-ok" role="status">
          {justConnected.label} connected
          {justConnected.email ? ` as ${justConnected.email}` : ""}.
        </p>
      ) : null}

      {!anyAvailable ? (
        <p className="outbox-mode">
          No provider is set up in this environment yet. Add either the{" "}
          <code>MS_*</code> or the <code>GOOGLE_*</code> variables from{" "}
          <code>.env.example</code> and restart — whichever you configure shows
          up here.
        </p>
      ) : null}

      <ul className="connection-list">
        {states.map((state) => (
          <ConnectionCard
            key={state.provider}
            state={state}
            /* Demoting the last working account would silently switch every
               send back to simulated, so the primary toggle only appears once
               there is somewhere else for it to go. */
            canChoosePrimary={
              states.filter((s) => s.connected).length > 1 &&
              active?.provider !== state.provider
            }
          />
        ))}
      </ul>
    </main>
  );
}
