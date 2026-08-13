import { SetupScreen } from "@/components/setup-screen";
import { TitleBlock } from "@/components/title-block";
import { DisconnectButton } from "./disconnect-button";
import { missingProviderEnv, providerConfig, PROVIDERS } from "@/lib/providers/catalog";
import { setupProblems } from "@/lib/setup";
import { readDoc } from "@/lib/store";
import { humanDay } from "@/lib/format-date";

export const metadata = { title: "Connections — Foreman" };

/** Always rendered per request — the connection changes. */
export const dynamic = "force-dynamic";

/**
 * The mailbox the schedule sends from.
 *
 * One connection, not a list. There is one contractor and one mailbox, so
 * "which account does this send from?" has no way to become ambiguous —
 * connecting a second replaces the first, and the page says so before you do
 * it.
 */
export default async function ConnectionsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; connected?: string }>;
}) {
  const problems = setupProblems();
  if (problems.length > 0) return <SetupScreen problems={problems} />;

  const { error, connected } = await searchParams;
  const doc = await readDoc();
  const current = doc.connection;

  return (
    <div className="frame">
      <TitleBlock project={doc.project} current="connections" />
      <main className="page">
        <div className="stack">
          {error && (
            <div className="note note-warn" role="alert">
              {error}
            </div>
          )}
          {connected && !error && (
            <div className="note note-good" role="status">
              Connected. Schedule changes will send from this account.
            </div>
          )}

          {current?.status === "needs_reauth" && (
            <div className="note note-warn">
              That sign-in has expired, so nothing can send. Connect it again
              below — the schedule itself is untouched.
            </div>
          )}

          <div className="card">
            <h2>Sending account</h2>
            {current ? (
              <>
                <p className="muted" style={{ margin: "0 0 12px", fontSize: 13 }}>
                  Date changes go out from this mailbox, so subcontractors see an
                  address they recognise and their replies reach you.
                </p>
                <div className="conn-current">
                  <div>
                    <div className="conn-name">
                      {providerConfig(current.provider).label}
                      <span className={`pill pill-${current.status === "active" ? "confirmed" : "blocked"}`}>
                        {current.status === "active" ? "Connected" : "Needs reconnecting"}
                      </span>
                    </div>
                    <div className="conn-meta num">
                      {current.email ?? "address unknown"} · connected{" "}
                      {humanDay(current.connectedAt.slice(0, 10))}
                    </div>
                  </div>
                  <DisconnectButton label={providerConfig(current.provider).label} />
                </div>
              </>
            ) : (
              <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                No mailbox connected. Schedule changes are composed and recorded
                but not sent — see History for what would have gone out.
              </p>
            )}
          </div>

          <div className="card">
            <h2>{current ? "Change the account" : "Connect an account"}</h2>
            <p className="muted" style={{ margin: "0 0 12px", fontSize: 13 }}>
              {current
                ? "Connecting a different mailbox replaces the one above."
                : "You will be sent to sign in and approve sending mail. Nothing else is requested — no reading, no calendar."}
            </p>

            <div className="conn-options">
              {PROVIDERS.map((provider) => {
                const config = providerConfig(provider);
                const missing = missingProviderEnv(provider);
                return (
                  <div key={provider} className="conn-option">
                    <div>
                      <div className="conn-name">{config.label}</div>
                      {missing.length > 0 && (
                        <div className="conn-meta">
                          Not set up on this deployment — missing{" "}
                          <span className="num">{missing.join(", ")}</span>
                        </div>
                      )}
                    </div>
                    {missing.length === 0 ? (
                      // A plain link, not a form: this has to leave the site for
                      // a consent screen, which a server action cannot do.
                      <a className="btn" href={config.connectPath}>
                        {current?.provider === provider ? "Reconnect" : "Connect"}
                      </a>
                    ) : (
                      <button className="btn" disabled>
                        Unavailable
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="note">
            The app has no sign-in, so anyone with this URL can reach this page
            and change which mailbox sends. Worth knowing before you share the
            address around — the crew should get the read-only link from Crew
            instead.
          </div>
        </div>
      </main>
    </div>
  );
}
