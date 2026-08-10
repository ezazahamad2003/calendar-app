import "server-only";

import { promises as fs } from "node:fs";
import path from "node:path";

export type Project = { id: string; name: string; location: string; color: string };
export type Person = { id: string; name: string; email: string; role: string; initials: string };
export type ScheduleEvent = {
  id: string;
  title: string;
  projectId: string;
  assigneeIds: string[];
  date: string;
  startTime: string;
  durationMinutes: number;
  trade: string;
  notes: string;
  createdAt: string;
};
export type ScheduleNotification = {
  id: string;
  eventId: string;
  personId: string;
  channel: "email";
  status: "sent";
  subject: string;
  createdAt: string;
};
export type ScheduleDatabase = {
  company: { name: string; timezone: string };
  projects: Project[];
  people: Person[];
  events: ScheduleEvent[];
  notifications: ScheduleNotification[];
};

const databasePath = path.join(process.cwd(), "data", "demo-db.json");
const james: Person = {
  id: "person-james",
  name: "James Foster",
  email: "james@northstar.demo",
  role: "Project Engineer",
  initials: "JF",
};
let writeQueue = Promise.resolve();

export async function readSchedule(): Promise<ScheduleDatabase> {
  const source = await fs.readFile(databasePath, "utf8");
  const parsed = JSON.parse(source) as Partial<ScheduleDatabase> & Pick<ScheduleDatabase, "company" | "projects" | "people" | "events">;
  return {
    ...parsed,
    people: parsed.people.some((person) => person.id === james.id) ? parsed.people : [...parsed.people, james],
    notifications: parsed.notifications ?? [],
  };
}

export async function updateSchedule(updater: (database: ScheduleDatabase) => ScheduleDatabase): Promise<ScheduleDatabase> {
  let result!: ScheduleDatabase;
  writeQueue = writeQueue.catch(() => undefined).then(async () => {
    const current = await readSchedule();
    result = updater(current);
    const temporaryPath = `${databasePath}.tmp`;
    await fs.writeFile(temporaryPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    await fs.rename(temporaryPath, databasePath);
  });
  await writeQueue;
  return result;
}
