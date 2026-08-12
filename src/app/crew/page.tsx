import { redirect } from "next/navigation";

import { ContactRow } from "./contact-row";
import { ShareCard } from "./share-card";
import { TitleBlock } from "@/components/title-block";
import { isOwner } from "@/lib/auth";
import { getAppOrigin } from "@/lib/app-url";
import { readDoc } from "@/lib/store";

export const metadata = { title: "Crew — Foreman" };

/**
 * The trades, and who to tell.
 *
 * This page exists because of one fact about the imported data: the wall chart
 * names companies, not addresses. Every team arrived with `email: null`, and
 * the app will not invent one — so until somebody fills these in, a schedule
 * change reaches nobody. That is stated plainly at the top rather than left to
 * be discovered when a crew turns up on the wrong day.
 */
export default async function CrewPage() {
  if (!(await isOwner())) redirect("/gate");

  const doc = await readDoc();
  const jobCount = new Map<string, number>();
  for (const task of doc.tasks) {
    if (!task.contactId) continue;
    jobCount.set(task.contactId, (jobCount.get(task.contactId) ?? 0) + 1);
  }

  const contacts = [...doc.contacts].sort((a, b) => a.name.localeCompare(b.name));
  const missing = contacts.filter((c) => !c.email).length;

  return (
    <div className="frame">
      <TitleBlock project={doc.project} current="crew" />
      <main className="page">
        <div className="stack">
          {missing > 0 && (
            <div className="note note-warn">
              {missing} of {contacts.length} trades have no email address. They will
              not be told when their dates change — the app never guesses an
              address. Add them here.
            </div>
          )}

          <div className="card">
            <h2>Trades</h2>
            <p className="muted" style={{ margin: "0 0 12px", fontSize: 13 }}>
              Taken from the TEAM column of the wall chart. An address here is
              what turns a date change into an email.
            </p>
            <div className="contact-list">
              {contacts.map((contact) => (
                <ContactRow
                  key={contact.id}
                  id={contact.id}
                  name={contact.name}
                  email={contact.email}
                  jobs={jobCount.get(contact.id) ?? 0}
                />
              ))}
            </div>
          </div>

          <ShareCard
            origin={getAppOrigin()}
            token={doc.share.token}
            enabled={doc.share.enabled}
          />
        </div>
      </main>
    </div>
  );
}
