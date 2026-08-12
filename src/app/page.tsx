import { redirect } from "next/navigation";

import { Assistant } from "@/components/assistant";
import { ChartView } from "@/components/chart-view";
import { TitleBlock } from "@/components/title-block";
import { isOwner } from "@/lib/auth";
import { readDoc } from "@/lib/store";

/**
 * The chart. The screen he opens with coffee, and the one he shouts at from
 * the truck.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ from?: string }>;
}) {
  // The proxy redirects here too, but only on cookie *presence* — it runs on
  // the edge and cannot verify a signature. This is the check that decides.
  if (!(await isOwner())) redirect("/gate");

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
