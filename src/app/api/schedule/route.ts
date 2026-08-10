import { readSchedule } from "@/lib/schedule-store";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(await readSchedule(), {
    headers: { "Cache-Control": "no-store" },
  });
}
