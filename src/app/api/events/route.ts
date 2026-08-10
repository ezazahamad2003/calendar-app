import { z } from "zod";
import { updateSchedule, type ScheduleEvent, type ScheduleNotification } from "@/lib/schedule-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const eventInput = z.object({
  title: z.string().trim().min(2).max(100),
  projectId: z.string().trim().min(1),
  assigneeIds: z.array(z.string()).max(12).default([]),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  durationMinutes: z.number().int().min(30).max(720),
  trade: z.string().trim().min(2).max(60),
  notes: z.string().trim().max(500).default(""),
});

export async function POST(request: Request) {
  const parsed = eventInput.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Please complete the required job details." }, { status: 400 });

  let created!: ScheduleEvent;
  const database = await updateSchedule((current) => {
    if (!current.projects.some((project) => project.id === parsed.data.projectId)) throw new Error("Unknown project");
    const assigneeIds = parsed.data.assigneeIds.filter((id) => current.people.some((person) => person.id === id));
    created = {
      id: `event-${crypto.randomUUID()}`,
      ...parsed.data,
      assigneeIds,
      createdAt: new Date().toISOString(),
    };
    const notifications: ScheduleNotification[] = assigneeIds.map((personId) => ({
      id: `notification-${crypto.randomUUID()}`,
      eventId: created.id,
      personId,
      channel: "email",
      status: "sent",
      subject: `New assignment: ${created.title}`,
      createdAt: new Date().toISOString(),
    }));
    return { ...current, events: [...current.events, created], notifications: [...current.notifications, ...notifications] };
  }).catch((error: unknown) => {
    if (error instanceof Error && error.message === "Unknown project") return null;
    throw error;
  });

  if (!database) return Response.json({ error: "That project no longer exists." }, { status: 400 });
  return Response.json({ database, event: created }, { status: 201 });
}
