import { updateSchedule, type Project } from "@/lib/schedule-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const palette = ["#d85b43", "#447a72", "#b68a2f", "#4778a8", "#9b5875", "#7862a1"];

export async function POST(request: Request) {
  let body: { name?: string; location?: string; color?: string };
  try { body = await request.json(); } catch { return Response.json({ error: "Invalid request." }, { status: 400 }); }
  const name = body.name?.trim();
  const location = body.location?.trim();
  if (!name || !location) return Response.json({ error: "Project name and location are required." }, { status: 400 });

  const project: Project = {
    id: `project-${crypto.randomUUID()}`,
    name: name.slice(0, 80),
    location: location.slice(0, 120),
    color: /^#[0-9a-f]{6}$/i.test(body.color ?? "") ? body.color! : palette[Math.floor(Math.random() * palette.length)],
  };
  const database = await updateSchedule((current) => ({ ...current, projects: [...current.projects, project] }));
  return Response.json({ database, project }, { status: 201 });
}

export async function DELETE(request: Request) {
  let body: { id?: string };
  try { body = await request.json(); } catch { return Response.json({ error: "Invalid request." }, { status: 400 }); }
  if (!body.id) return Response.json({ error: "Project id is required." }, { status: 400 });

  let removed = false;
  let removedJobs = 0;
  const database = await updateSchedule((current) => {
    if (!current.projects.some((project) => project.id === body.id)) return current;
    removed = true;
    const eventIds = new Set(current.events.filter((event) => event.projectId === body.id).map((event) => event.id));
    removedJobs = eventIds.size;
    return {
      ...current,
      projects: current.projects.filter((project) => project.id !== body.id),
      events: current.events.filter((event) => event.projectId !== body.id),
      notifications: current.notifications.filter((notice) => !eventIds.has(notice.eventId)),
    };
  });
  if (!removed) return Response.json({ error: "Project not found." }, { status: 404 });
  return Response.json({ database, removedJobs });
}
