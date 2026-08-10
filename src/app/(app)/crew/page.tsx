import { requireMembership } from "@/lib/auth/dal";
import { listContacts } from "@/lib/org/queries";
import { tradeColor } from "@/lib/trades";
import { NewContactForm } from "./new-contact-form";

/** Crew (SPEC §7): who you work with, their trade, how to reach them. */
export default async function CrewPage() {
  const m = await requireMembership();
  const contacts = await listContacts(m.orgId);

  return (
    <main className="page">
      <header className="page-head">
        <div>
          <p className="page-eyebrow">{m.orgName}</p>
          <h1 className="page-title">Crew</h1>
        </div>
      </header>

      {contacts.length === 0 ? (
        <section className="empty-card">
          <h2 className="empty-title">No crew yet</h2>
          <p className="empty-body">
            Add the subs and suppliers you schedule. Tasks get assigned to
            these people, and Phase 7 sends them email and calendar invites.
          </p>
        </section>
      ) : (
        <ul className="crew-grid">
          {contacts.map((c) => {
            const color = tradeColor(c.trade);
            return (
              <li key={c.id} className="crew-card">
                <span
                  className="crew-swatch"
                  style={{ background: color.fill }}
                  aria-hidden
                />
                <div>
                  <p className="crew-name">{c.name}</p>
                  <p className="crew-meta">
                    {[c.trade, c.company].filter(Boolean).join(" · ") || "—"}
                  </p>
                  {c.email ? <p className="crew-contact">{c.email}</p> : null}
                  {c.phone ? <p className="crew-contact">{c.phone}</p> : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <NewContactForm />
    </main>
  );
}
