import {
  readSchedule,
  updateSchedule,
  type ScheduleDatabase,
  type ScheduleEvent,
  type ScheduleNotification,
} from "@/lib/schedule-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ChatMessage = { role: "user" | "assistant"; content: string };
type PlannedAction = {
  type: "create" | "update" | "delete" | "create_project" | "delete_project" | "create_person" | "delete_person";
  eventId: string | null;
  title: string | null;
  projectId: string | null;
  projectName: string | null;
  projectLocation: string | null;
  assigneeIds: string[];
  replaceAssignees: boolean;
  date: string | null;
  startTime: string | null;
  durationMinutes: number | null;
  trade: string | null;
  notes: string | null;
  personId: string | null;
  personName: string | null;
  personEmail: string | null;
  personRole: string | null;
};
type Plan = { reply: string; actions: PlannedAction[] };
type ApplyResult = {
  database: ScheduleDatabase;
  changedIds: string[];
  notifiedPeople: string[];
  summaries: string[];
};

const planSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    reply: { type: "string" },
    actions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          type: { type: "string", enum: ["create", "update", "delete", "create_project", "delete_project", "create_person", "delete_person"] },
          eventId: { type: ["string", "null"] },
          title: { type: ["string", "null"] },
          projectId: { type: ["string", "null"] },
          projectName: { type: ["string", "null"] },
          projectLocation: { type: ["string", "null"] },
          assigneeIds: { type: "array", items: { type: "string" } },
          replaceAssignees: { type: "boolean" },
          date: { type: ["string", "null"] },
          startTime: { type: ["string", "null"] },
          durationMinutes: { type: ["integer", "null"] },
          trade: { type: ["string", "null"] },
          notes: { type: ["string", "null"] },
          personId: { type: ["string", "null"] },
          personName: { type: ["string", "null"] },
          personEmail: { type: ["string", "null"] },
          personRole: { type: ["string", "null"] },
        },
        required: ["type", "eventId", "title", "projectId", "projectName", "projectLocation", "assigneeIds", "replaceAssignees", "date", "startTime", "durationMinutes", "trade", "notes", "personId", "personName", "personEmail", "personRole"],
      },
    },
  },
  required: ["reply", "actions"],
} as const;
function localNow(timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("weekday")}, ${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

function extractOutputText(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const response = payload as { output_text?: string; output?: Array<{ content?: Array<{ type?: string; text?: string }> }> };
  if (response.output_text) return response.output_text;
  for (const item of response.output ?? []) {
    for (const content of item.content ?? []) {
      if (content.type === "output_text" && content.text) return content.text;
    }
  }
  return null;
}

async function createPlan(message: string, history: ChatMessage[], database: ScheduleDatabase, selectedEventId: string | null): Promise<Plan> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return fallbackPlan(message, database, selectedEventId);
  const selectedEvent = database.events.find((event) => event.id === selectedEventId) ?? null;
  const conversation = history.slice(-12).map((entry) => `${entry.role.toUpperCase()}: ${entry.content}`).join("\n");
  const instructions = `You are Foreman, a scheduling agent for a small construction company.
Current local date/time: ${localNow(database.company.timezone)} (${database.company.timezone}).
Answer questions from the supplied calendar, crew, projects, and assignments. Resolve relative dates and conversational references from the selected job and recent conversation.

Only claim a change when you emit the action that performs it. Never promise to do work later. Preserve user-provided project and person names exactly unless they explicitly ask for a correction.

EVENT ACTIONS
- create: provide title, an existing projectId OR projectName created earlier in the same action list, complete assigneeIds, YYYY-MM-DD date, HH:mm time, duration, trade, and notes.
- update: provide exact eventId. Set unchanged scalar fields to null. For crew changes provide the COMPLETE final assigneeIds and replaceAssignees true.
- delete: provide exact eventId and leave unrelated fields null or empty.

PROJECT ACTIONS
- create_project: use whenever the user asks for a new project. Provide projectName and projectLocation; use "Location TBD" if no location was supplied.
- delete_project: provide the existing projectId. This removes that project's jobs.
- If a request creates a project and schedules its first job, emit create_project FIRST, then create with projectId null and the exact same projectName.

CREW ACTIONS
- create_person: provide personName, personEmail, and personRole. Ask for any missing required value instead of inventing it.
- delete_person: provide the existing personId. This unassigns them from jobs.

Availability means the person has no overlapping assignment at the requested date and time. Prefer a crew member whose role matches the requested trade. If no timeframe is provided, ask which date/time instead of listing all future assignments as "available."
Ignore obvious incidental speech unrelated to the scheduling request when the main intent is clear. If asked whether you can hear them, say you received their last voice message; do not imply continuous listening.
If a request matches multiple jobs and context does not disambiguate it, ask one short question with no actions. Use only supplied IDs. The app handles confirmed email notices, so do not claim one was sent. Keep reply concise and do not mention JSON or IDs.`;

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: process.env.OPENAI_PLANNER_MODEL || "gpt-5.6-sol",
      instructions,
      input: `SELECTED JOB:\n${selectedEvent ? JSON.stringify(selectedEvent) : "(none)"}\n\nCURRENT SCHEDULE:\n${JSON.stringify({ company: database.company, projects: database.projects, people: database.people, events: database.events })}\n\nRECENT CONVERSATION:\n${conversation || "(none)"}\n\nNEW USER MESSAGE:\n${message}`,
      text: { format: { type: "json_schema", name: "schedule_plan", strict: true, schema: planSchema } },
    }),
  });

  if (!response.ok) {
    console.error("OpenAI planning failed", response.status, (await response.text()).slice(0, 500));
    return fallbackPlan(message, database, selectedEventId);
  }
  const output = extractOutputText(await response.json());
  if (!output) return fallbackPlan(message, database, selectedEventId);
  try {
    return JSON.parse(output) as Plan;
  } catch {
    return fallbackPlan(message, database, selectedEventId);
  }
}

function isoDate(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function todayIn(timezone: string) {
  const label = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const [year, month, day] = label.split("-").map(Number);
  return new Date(year, month - 1, day, 12);
}

function parseDate(message: string, timezone: string): string | null {
  const explicit = message.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (explicit) return explicit[0];
  const date = todayIn(timezone);
  const lower = message.toLowerCase();
  if (lower.includes("day after tomorrow")) date.setDate(date.getDate() + 2);
  else if (lower.includes("tomorrow")) date.setDate(date.getDate() + 1);
  else if (lower.includes("yesterday")) date.setDate(date.getDate() - 1);
  else {
    const weekdays = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    const requested = weekdays.findIndex((weekday) => lower.includes(weekday));
    if (requested >= 0) {
      let delta = (requested - date.getDay() + 7) % 7;
      if (delta === 0 || lower.includes(`next ${weekdays[requested]}`)) delta += 7;
      date.setDate(date.getDate() + delta);
    } else if (!lower.includes("today")) return null;
  }
  return isoDate(date);
}

function parseOptionalTime(message: string) {
  const match = message.match(/\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\b/i);
  if (!match) return null;
  let hour = Number(match[1]) % 12;
  if (match[3].toLowerCase().startsWith("p")) hour += 12;
  return `${String(hour).padStart(2, "0")}:${match[2] ?? "00"}`;
}

function emptyAction(type: PlannedAction["type"], values: Partial<PlannedAction>): PlannedAction {
  return { type, eventId: null, title: null, projectId: null, projectName: null, projectLocation: null, assigneeIds: [], replaceAssignees: false, date: null, startTime: null, durationMinutes: null, trade: null, notes: null, personId: null, personName: null, personEmail: null, personRole: null, ...values };
}

function fallbackPlan(message: string, database: ScheduleDatabase, selectedEventId: string | null): Plan {
  const lower = message.toLowerCase();
  const date = parseDate(message, database.company.timezone);
  const time = parseOptionalTime(message);
  const project = database.projects.find((item) => lower.includes(item.name.toLowerCase()) || lower.includes(item.name.split(" ").at(-1)!.toLowerCase()));
  const namedPeople = database.people.filter((person) => lower.includes(person.name.toLowerCase()) || lower.includes(person.name.split(" ")[0].toLowerCase()));
  const selected = database.events.find((event) => event.id === selectedEventId);
  const candidateEvents = database.events.filter((event) =>
    (!date || event.date === date) &&
    (!project || event.projectId === project.id) &&
    (!namedPeople.length || namedPeople.some((person) => event.assigneeIds.includes(person.id))) &&
    (!/plumb|electric|inspect|carpent|framing|lighting/i.test(lower) || lower.includes(event.trade.toLowerCase()) || lower.includes(event.title.toLowerCase())),
  );
  const target = selected ?? (candidateEvents.length === 1 ? candidateEvents[0] : undefined);

  const newProjectMatch = message.match(/\b(?:create|add|make)\s+(?:a\s+)?(?:new\s+)?project(?:\s+(?:called|named))?\s+["']?(.+?)["']?(?=\s+(?:and|with|then)\b|[,.]|$)/i);
  if (newProjectMatch) {
    const projectName = newProjectMatch[1].trim();
    const actions: PlannedAction[] = [emptyAction("create_project", { projectName, projectLocation: /chico/i.test(message) ? "Chico, CA" : "Location TBD" })];
    const trade = ["plumbing", "electrical", "carpentry", "inspection", "concrete", "roofing"].find((item) => lower.includes(item));
    if (date && time && trade) {
      const matchingCrew = database.people.filter((person) => person.role.toLowerCase().includes(trade.replace("ing", "")) || (trade === "plumbing" && person.role.toLowerCase().includes("plumb")));
      const available = matchingCrew.find((person) => !database.events.some((event) => event.date === date && event.assigneeIds.includes(person.id) && event.startTime === time));
      actions.push(emptyAction("create", { title: `${trade[0].toUpperCase()}${trade.slice(1)} appointment`, projectName, date, startTime: time, durationMinutes: 120, trade: `${trade[0].toUpperCase()}${trade.slice(1)}`, notes: "Added by Foreman AI", assigneeIds: available ? [available.id] : [], replaceAssignees: true }));
    }
    return { reply: `Create ${projectName}.`, actions };
  }

  if (/\b(delete|remove)\b/.test(lower) && /\bproject\b/.test(lower) && project) {
    return { reply: `Remove ${project.name}.`, actions: [emptyAction("delete_project", { projectId: project.id })] };
  }

  if (/\b(delete|remove|cancel)\b/.test(lower)) {
    return target
      ? { reply: `Remove ${target.title}.`, actions: [emptyAction("delete", { eventId: target.id })] }
      : { reply: candidateEvents.length > 1 ? "I found more than one matching job. Which one should I remove?" : "I could not find a matching job. Include its project and date.", actions: [] };
  }

  if (/\b(change|move|reschedule|update|add .* to|assign .* to)\b/.test(lower) && target) {
    const finalPeople = namedPeople.length ? Array.from(new Set([...target.assigneeIds, ...namedPeople.map((person) => person.id)])) : [];
    return { reply: `Update ${target.title}.`, actions: [emptyAction("update", { eventId: target.id, date, startTime: time, assigneeIds: finalPeople, replaceAssignees: finalPeople.length > 0 })] };
  }

  if (/\b(add|book|schedule|create|make)\b/.test(lower) && date && project) {
    const trade = ["plumbing", "electrical", "carpentry", "inspection", "concrete", "roofing"].find((item) => lower.includes(item));
    const title = trade ? `${trade[0].toUpperCase()}${trade.slice(1)} job` : "Site work";
    return { reply: `Schedule ${title.toLowerCase()} for ${project.name}.`, actions: [emptyAction("create", { title, projectId: project.id, assigneeIds: namedPeople.map((person) => person.id), replaceAssignees: true, date, startTime: time ?? "08:00", durationMinutes: 120, trade: trade ? `${trade[0].toUpperCase()}${trade.slice(1)}` : "General", notes: "Added by Foreman AI" })] };
  }

  if (/\b(available|availability|free)\b/.test(lower) && !date) {
    return { reply: "What date and time should I check crew availability for?", actions: [] };
  }

  if (/\b(what|show|list|scheduled|calendar|busy|happening)\b/.test(lower)) {
    const start = todayIn(database.company.timezone);
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
    const end = new Date(start); end.setDate(start.getDate() + 6);
    const events = database.events.filter((event) => event.date >= isoDate(start) && event.date <= isoDate(end)).sort((a, b) => `${a.date}${a.startTime}`.localeCompare(`${b.date}${b.startTime}`));
    const summary = events.length ? events.map((event) => `${event.date}: ${event.title} at ${event.startTime}`).join("; ") : "nothing is booked";
    return { reply: `This week, ${summary}.`, actions: [] };
  }

  return { reply: "I can answer schedule questions and manage jobs, projects, and crew. Include the project and date when a request could match more than one item.", actions: [] };
}
function validDate(value: string | null): value is string {
  return Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value));
}
function validTime(value: string | null): value is string {
  return Boolean(value && /^([01]\d|2[0-3]):[0-5]\d$/.test(value));
}

function applyPlan(database: ScheduleDatabase, plan: Plan): ApplyResult {
  let projects = [...database.projects];
  let people = [...database.people];
  let events = [...database.events];
  let notifications = [...database.notifications];
  const changedIds: string[] = [];
  const notifiedIds = new Set<string>();
  const summaries: string[] = [];
  const palette = ["#d85b43", "#447a72", "#b68a2f", "#4778a8", "#9b5875", "#7862a1"];
  let lastCreatedProjectId: string | null = null;
  const normalize = (value: string) => value.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

  const notify = (event: ScheduleEvent, personIds: string[], subject: string) => {
    for (const personId of personIds) {
      if (!people.some((person) => person.id === personId)) continue;
      const notification: ScheduleNotification = { id: `notification-${crypto.randomUUID()}`, eventId: event.id, personId, channel: "email", status: "sent", subject, createdAt: new Date().toISOString() };
      notifications.push(notification);
      notifiedIds.add(personId);
    }
  };

  for (const action of plan.actions) {
    if (action.type === "create_project" && action.projectName?.trim()) {
      const existing = projects.find((project) => normalize(project.name) === normalize(action.projectName!));
      if (existing) { lastCreatedProjectId = existing.id; summaries.push(`Project ${existing.name} already exists`); continue; }
      const project = { id: `project-${crypto.randomUUID()}`, name: action.projectName.trim(), location: action.projectLocation?.trim() || "Location TBD", color: palette[projects.length % palette.length] };
      projects.push(project); lastCreatedProjectId = project.id; summaries.push(`Created project ${project.name}`);
      continue;
    }

    if (action.type === "delete_project") {
      const target = projects.find((project) => project.id === action.projectId || (action.projectName && normalize(project.name) === normalize(action.projectName)));
      if (!target) continue;
      const projectEvents = events.filter((event) => event.projectId === target.id);
      for (const event of projectEvents) notify(event, event.assigneeIds, `Assignment canceled: ${event.title}`);
      events = events.filter((event) => event.projectId !== target.id);
      projects = projects.filter((project) => project.id !== target.id);
      summaries.push(`Deleted project ${target.name}${projectEvents.length ? ` and ${projectEvents.length} scheduled job${projectEvents.length === 1 ? "" : "s"}` : ""}`);
      continue;
    }

    if (action.type === "create_person" && action.personName?.trim() && action.personEmail?.trim() && action.personRole?.trim()) {
      if (people.some((person) => person.email.toLowerCase() === action.personEmail!.trim().toLowerCase())) { summaries.push(`${action.personName.trim()} is already on the crew`); continue; }
      const name = action.personName.trim();
      people.push({ id: `person-${crypto.randomUUID()}`, name, email: action.personEmail.trim().toLowerCase(), role: action.personRole.trim(), initials: name.split(/\s+/).slice(0, 2).map((part) => part[0].toUpperCase()).join("") });
      summaries.push(`Added ${name} to the crew`);
      continue;
    }

    if (action.type === "delete_person" && action.personId) {
      const target = people.find((person) => person.id === action.personId);
      if (!target) continue;
      people = people.filter((person) => person.id !== target.id);
      events = events.map((event) => ({ ...event, assigneeIds: event.assigneeIds.filter((id) => id !== target.id) }));
      notifications = notifications.filter((notice) => notice.personId !== target.id);
      summaries.push(`Removed ${target.name} from the crew`);
      continue;
    }

    if (action.type === "delete" && action.eventId) {
      const target = events.find((event) => event.id === action.eventId);
      if (!target) continue;
      notify(target, target.assigneeIds, `Assignment canceled: ${target.title}`);
      events = events.filter((event) => event.id !== target.id);
      changedIds.push(target.id); summaries.push(`Removed ${target.title}`);
      continue;
    }

    if (action.type === "update" && action.eventId) {
      const index = events.findIndex((event) => event.id === action.eventId);
      if (index < 0) continue;
      const before = events[index];
      const resolvedProject = projects.find((project) => project.id === action.projectId || (action.projectName && normalize(project.name) === normalize(action.projectName)));
      const validPeople = action.assigneeIds.filter((id) => people.some((person) => person.id === id));
      const updated: ScheduleEvent = { ...before, title: action.title?.trim() || before.title, projectId: resolvedProject?.id || before.projectId, assigneeIds: action.replaceAssignees ? validPeople : before.assigneeIds, date: validDate(action.date) ? action.date : before.date, startTime: validTime(action.startTime) ? action.startTime : before.startTime, durationMinutes: action.durationMinutes ? Math.max(30, Math.min(action.durationMinutes, 720)) : before.durationMinutes, trade: action.trade?.trim() || before.trade, notes: action.notes?.trim() || before.notes };
      events[index] = updated; changedIds.push(updated.id); summaries.push(`Updated ${updated.title}`);
      const newlyAssigned = updated.assigneeIds.filter((id) => !before.assigneeIds.includes(id));
      const scheduleChanged = updated.date !== before.date || updated.startTime !== before.startTime;
      notify(updated, newlyAssigned.length ? newlyAssigned : scheduleChanged ? updated.assigneeIds : [], `Schedule updated: ${updated.title}`);
      continue;
    }

    if (action.type === "create") {
      const resolvedProject = projects.find((project) => project.id === action.projectId || (action.projectName && normalize(project.name) === normalize(action.projectName)) || project.id === lastCreatedProjectId);
      const validPeople = action.assigneeIds.filter((id) => people.some((person) => person.id === id));
      if (!resolvedProject || !action.title || !validDate(action.date) || !validTime(action.startTime)) continue;
      const event: ScheduleEvent = { id: `event-${crypto.randomUUID()}`, title: action.title.trim(), projectId: resolvedProject.id, assigneeIds: validPeople, date: action.date, startTime: action.startTime, durationMinutes: Math.max(30, Math.min(action.durationMinutes ?? 120, 720)), trade: action.trade?.trim() || "General", notes: action.notes?.trim() || "Added by Foreman AI", createdAt: new Date().toISOString() };
      events.push(event); changedIds.push(event.id); summaries.push(`Added ${event.title} to ${resolvedProject.name}`); notify(event, event.assigneeIds, `New assignment: ${event.title}`);
    }
  }

  return { database: { ...database, projects, people, events, notifications }, changedIds, notifiedPeople: [...notifiedIds].map((id) => people.find((person) => person.id === id)?.name).filter((name): name is string => Boolean(name)), summaries };
}
function streamLine(controller: ReadableStreamDefaultController, value: unknown) {
  controller.enqueue(new TextEncoder().encode(`${JSON.stringify(value)}\n`));
}

export async function POST(request: Request) {
  let body: { message?: string; history?: ChatMessage[]; selectedEventId?: string | null };
  try { body = await request.json(); } catch { return Response.json({ error: "Invalid request." }, { status: 400 }); }
  const message = body.message?.trim();
  if (!message || message.length > 5000) return Response.json({ error: "Please send a message under 5,000 characters." }, { status: 400 });

  const stream = new ReadableStream({
    async start(controller) {
      try {
        streamLine(controller, { type: "step", id: "understand", label: "Understanding your request", state: "active" });
        const current = await readSchedule();
        const plan = await createPlan(message, body.history ?? [], current, body.selectedEventId ?? null);
        streamLine(controller, { type: "step", id: "understand", label: "Request understood", state: "complete" });
        streamLine(controller, { type: "step", id: "schedule", label: "Checked projects, crew, and conflicts", state: "complete" });

        let result: ApplyResult = { database: current, changedIds: [], notifiedPeople: [], summaries: [] };
        if (plan.actions.length) {
          streamLine(controller, { type: "step", id: "apply", label: "Applying calendar changes", state: "active" });
          result = await new Promise<ApplyResult>((resolve, reject) => {
            let applied!: ApplyResult;
            updateSchedule((latest) => {
              applied = applyPlan(latest, plan);
              return applied.database;
            }).then(() => resolve(applied), reject);
          });
          streamLine(controller, { type: "step", id: "apply", label: result.summaries.join(" · ") || "No changes needed", state: "complete" });
          if (result.notifiedPeople.length) streamLine(controller, { type: "step", id: "notify", label: `Demo email sent to ${result.notifiedPeople.join(", ")}`, state: "complete" });
        } else {
          streamLine(controller, { type: "step", id: "answer", label: "Prepared calendar answer", state: "complete" });
        }

        const notificationNote = result.notifiedPeople.length
          ? ` Demo email sent to ${result.notifiedPeople.map((name) => name.split(" ")[0]).join(" and ")} with the updated timing.`
          : "";
        const confirmedReply = plan.actions.length
          ? result.summaries.length ? `${result.summaries.join(". ")}.` : "I could not apply that change because a required project, person, or time was missing."
          : plan.reply.trim();
        const reply = `${confirmedReply}${notificationNote}`;
        for (const chunk of reply.match(/\S+\s*/g) ?? [reply]) {
          streamLine(controller, { type: "delta", text: chunk });
          await new Promise((resolve) => setTimeout(resolve, 22));
        }
        streamLine(controller, { type: "done", database: result.database, changedIds: result.changedIds, notifiedPeople: result.notifiedPeople });
      } catch (error) {
        console.error(error);
        streamLine(controller, { type: "error", text: "I hit a snag reading the local schedule. Nothing was changed — please try again." });
      } finally { controller.close(); }
    },
  });

  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" } });
}
