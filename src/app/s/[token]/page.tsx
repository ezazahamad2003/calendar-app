import { notFound } from "next/navigation";

import { ChartView } from "@/components/chart-view";
import { TitleBlock } from "@/components/title-block";
import { shareTokenMatches } from "@/lib/auth";
import { readDoc } from "@/lib/store";

export const metadata = {
  title: "Job schedule",
  // The crew's link should not turn up in a search for the client's name.
  robots: { index: false, follow: false },
};

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
 * The crew's view.
 *
 * Read-only by construction rather than by permission check — there is nothing
 * on this page that can write. It imports the chart and the title block, and
 * not the assistant, so the microphone and the confirm button are not merely
 * disabled here, they are absent from the bundle.
 *
 * Contacts, addresses, the change log and the passcode are all on other routes
 * behind `isOwner()`. Handing someone this link discloses the schedule and
 * nothing else.
 */
export default async function SharedPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ from?: string }>;
}) {
  const { token } = await params;
  const { from } = await searchParams;
  const doc = await readDoc();

  // Constant-time, and a wrong token is indistinguishable from a switched-off
  // one: both are 404. Anything else lets someone probe for a live link.
  if (!doc.share.enabled || !shareTokenMatches(token, doc.share.token)) {
    notFound();
  }

  return (
    <div className="frame">
      <TitleBlock project={doc.project} current="share" readOnly />
      <main className="page">
        <ChartView doc={doc} from={from} basePath={`/s/${token}`} />
        <p className="muted" style={{ marginTop: 18, fontSize: 12.5 }}>
          This is a read-only copy of the job schedule. Dates change — check back
          rather than working from a screenshot.
        </p>
      </main>
    </div>
  );
}
