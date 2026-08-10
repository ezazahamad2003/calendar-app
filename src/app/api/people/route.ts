import { updateSchedule, type Person } from "@/lib/schedule-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0].toUpperCase()).join("");
}

export async function POST(request: Request) {
  let body: { name?: string; email?: string; role?: string };
  try { body = await request.json(); } catch { return Response.json({ error: "Invalid request." }, { status: 400 }); }
  const name = body.name?.trim();
  const email = body.email?.trim().toLowerCase();
  const role = body.role?.trim();
  if (!name || !email || !role || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return Response.json({ error: "Name, role, and a valid email are required." }, { status: 400 });
  }

  let duplicate = false;
  const person: Person = { id: `person-${crypto.randomUUID()}`, name: name.slice(0, 80), email: email.slice(0, 160), role: role.slice(0, 80), initials: initials(name) };
  const database = await updateSchedule((current) => {
    if (current.people.some((item) => item.email.toLowerCase() === email)) { duplicate = true; return current; }
    return { ...current, people: [...current.people, person] };
  });
  if (duplicate) return Response.json({ error: "A crew member with that email already exists." }, { status: 409 });
  return Response.json({ database, person }, { status: 201 });
}

export async function DELETE(request: Request) {
  let body: { id?: string };
  try { body = await request.json(); } catch { return Response.json({ error: "Invalid request." }, { status: 400 }); }
  if (!body.id) return Response.json({ error: "Crew member id is required." }, { status: 400 });

  let removed = false;
  let updatedJobs = 0;
  const database = await updateSchedule((current) => {
    if (!current.people.some((person) => person.id === body.id)) return current;
    removed = true;
    updatedJobs = current.events.filter((event) => event.assigneeIds.includes(body.id!)).length;
    return {
      ...current,
      people: current.people.filter((person) => person.id !== body.id),
      events: current.events.map((event) => ({ ...event, assigneeIds: event.assigneeIds.filter((id) => id !== body.id) })),
      notifications: current.notifications.filter((notice) => notice.personId !== body.id),
    };
  });
  if (!removed) return Response.json({ error: "Crew member not found." }, { status: 404 });
  return Response.json({ database, updatedJobs });
}
