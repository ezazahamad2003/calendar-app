import { TitleBlock } from "@/components/title-block";
import { humanRange } from "@/lib/format-date";
import { SetupScreen } from "@/components/setup-screen";
import { setupProblems } from "@/lib/setup";
import { readDoc } from "@/lib/store";
import type { Notification } from "@/lib/store/types";

export const metadata = { title: "History — Foreman" };

/**
 * Always rendered per request.
 *
 * Every page here reads the schedule document, which changes. Without this
 * Next prerenders the ones that touch no dynamic API and serves a snapshot of
 * the seed forever — you would add an email address and the page would keep
 * showing it blank. Previously the passcode check read cookies() and made
 * these dynamic as a side effect; removing the gate removed that accident, so
 * now it is stated.
 */
export const dynamic = "force-dynamic";

/**
 * What changed, when, why, and who was told.
 *
 * Contractors argue about dates constantly, and this is the record that settles
 * it — a product feature rather than debug logging. It is also the only place
 * the *outcome* of a notification is visible: an address that bounced, a trade
 * with no address on file, a send that was deliberately turned off.
 */
export default async function HistoryPage() {
  // A deployment without its storage renders instructions, not a 500.
  const problems = setupProblems();
  if (problems.length > 0) return <SetupScreen problems={problems} />;

  const doc = await readDoc();

  return (
    <div className="frame">
      <TitleBlock project={doc.project} current="history" />
      <main className="page">
        <div className="stack">
          {doc.changeLog.length === 0 && (
            <div className="card">
              <h2>Nothing yet</h2>
              <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                Every confirmed change lands here with its reason and the emails
                it sent.
              </p>
            </div>
          )}

          {doc.changeLog.map((entry) => (
            <article key={entry.id} className="card">
              <div className="entry-head">
                <h2>{entry.summary}</h2>
                <time className="label" dateTime={entry.at}>
                  {new Date(entry.at).toLocaleString(undefined, {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                </time>
              </div>

              {entry.reason && <p className="entry-reason">“{entry.reason}”</p>}

              {entry.transcript && (
                <p className="muted" style={{ fontSize: 12.5, margin: "0 0 10px" }}>
                  Heard: “{entry.transcript}”
                </p>
              )}

              <ul className="diff" style={{ marginTop: 6 }}>
                {entry.moves.map((move) => (
                  <li key={move.taskId} className={move.direct ? "" : "cascaded"}>
                    <span className="diff-name">
                      {!move.direct && <span className="arrow">↳</span>}
                      {move.taskName}
                    </span>
                    <span className="diff-dates num">
                      {move.fromStartDate
                        ? humanRange(move.fromStartDate, move.fromEndDate)
                        : "no date"}{" "}
                      →{" "}
                      <b>
                        {move.toStartDate
                          ? humanRange(move.toStartDate, move.toEndDate)
                          : "no date"}
                      </b>
                    </span>
                  </li>
                ))}
              </ul>

              {entry.notifications.length > 0 && (
                <div className="notified">
                  {entry.notifications.map((n) => (
                    <NotificationLine key={n.id} n={n} />
                  ))}
                </div>
              )}
            </article>
          ))}
        </div>
      </main>
    </div>
  );
}

function NotificationLine({ n }: { n: Notification }) {
  const label =
    n.status === "sent"
      ? "Sent"
      : n.status === "failed"
        ? "Failed"
        : n.status === "queued"
          ? "Queued"
          : "Not sent";

  return (
    <div className={`notif notif-${n.status}`}>
      <span className="diff-tag">{label}</span>
      <span className="notif-who">
        {n.recipientName}
        {n.to && <span className="num"> {n.to}</span>}
      </span>
      {n.error && <span className="notif-why">{n.error}</span>}
    </div>
  );
}
