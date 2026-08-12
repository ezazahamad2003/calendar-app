import { Assistant } from "@/components/assistant";
import { ChartView } from "@/components/chart-view";
import { TitleBlock } from "@/components/title-block";
import { SetupScreen } from "@/components/setup-screen";
import { setupProblems } from "@/lib/setup";
import { readDoc } from "@/lib/store";

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
 * The chart. The screen he opens with coffee, and the one he shouts at from
 * the truck.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ from?: string }>;
}) {

  // A deployment without its storage renders instructions, not a 500.
  const problems = setupProblems();
  if (problems.length > 0) return <SetupScreen problems={problems} />;

  const { from } = await searchParams;
  const doc = await readDoc();

  return (
    <div className="frame">
      <TitleBlock project={doc.project} current="chart" />
      <main className="page">
        <ChartView doc={doc} from={from} />
      </main>
      <Assistant enabled />
    </div>
  );
}
