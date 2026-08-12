import type { IsoDate, IsoWeekday, TaskDep } from "@/lib/schedule";

/**
 * The whole schedule, as one document.
 *
 * This replaced Postgres. One job, one contractor, a few dozen activities — the
 * entire thing is smaller than a photograph, and every read the app performs
 * wants all of it at once (the wall chart is a single screen showing
 * everything). A relational store bought normalisation nobody was using and
 * charged a network round trip per page for it.
 *
 * The shape is the wall chart's shape on purpose: sections, activities with a
 * team against each, and dates. Anything the chart does not have, this does not
 * have either.
 */

/**
 * The marks in the chart's day cells.
 *
 *   done       "D" — happened, do not move it
 *   confirmed  "X" — booked with the trade
 *   tentative  "?" — pencilled in, nobody has committed
 *   planned          real work, no date yet — the chart's undated rows
 *   blocked          cannot proceed; something upstream is in the way
 */
export type TaskStatus = "planned" | "tentative" | "confirmed" | "done" | "blocked";

export const TASK_STATUSES: readonly TaskStatus[] = [
  "planned",
  "tentative",
  "confirmed",
  "done",
  "blocked",
] as const;

export type Section = {
  id: string;
  /** "AG SHOP BUILDING", "ORDERS". */
  name: string;
  order: number;
};

export type Activity = {
  id: string;
  sectionId: string;
  name: string;
  /**
   * The chart's TEAM column — "Harvpro", "VacaValley". Free text, and kept
   * even when a contact exists, because the chart's wording is what the
   * contractor recognises at a glance and it is not always a company name
   * ("Adair Crew", "Tammi / Lisa").
   */
  team: string | null;
  /** Who gets emailed when this moves. Null until someone supplies an address. */
  contactId: string | null;
  /** First working day. Null for the chart's undated backlog rows. */
  startDate: IsoDate | null;
  /** Work days, never calendar days. */
  durationDays: number;
  status: TaskStatus;
  notes: string | null;
  /** Position in the chart, top to bottom, within its section. */
  order: number;
};

export type Contact = {
  id: string;
  name: string;
  company: string | null;
  trade: string | null;
  /** Null is normal and load-bearing: never guess an address. */
  email: string | null;
  phone: string | null;
};

/** One task's movement, as it will be shown and as it happened. */
export type Move = {
  taskId: string;
  /** Denormalised so history stays readable after a task is renamed or deleted. */
  taskName: string;
  fromStartDate: IsoDate | null;
  toStartDate: IsoDate | null;
  fromEndDate: IsoDate | null;
  toEndDate: IsoDate | null;
  /** True when the user asked for this one; false when a dependency moved it. */
  direct: boolean;
};

export type NotificationStatus = "queued" | "sent" | "failed" | "skipped";

export type Notification = {
  id: string;
  contactId: string | null;
  /** Copied at send time — history should not change when a contact is edited. */
  to: string | null;
  recipientName: string;
  subject: string;
  body: string;
  status: NotificationStatus;
  /** Why it was skipped, or why it failed. Null when it went. */
  error: string | null;
  createdAt: string;
  sentAt: string | null;
  /**
   * Written before the send is attempted, and checked on retry. A
   * subcontractor who gets the same schedule change twice phones up about it.
   */
  idempotencyKey: string;
};

/**
 * An append-only record of what changed and why.
 *
 * Contractors argue about dates constantly and this is the record that settles
 * it — a product feature, not debug logging. The `reason` is the part the
 * client cared about most: the email says *why* it moved, and this is where
 * that sentence comes from.
 */
export type ChangeEntry = {
  id: string;
  at: string;
  summary: string;
  /** "Framing crew never showed." Null when nobody gave one. */
  reason: string | null;
  source: "voice" | "ui";
  /** What was actually said, when it came from voice. */
  transcript: string | null;
  moves: Move[];
  notifications: Notification[];
};

export type ProjectMeta = {
  name: string;
  client: string | null;
  address: string | null;
  /** IANA zone. Every "today" in the app is resolved against this. */
  timezone: string;
};

export type ScheduleDoc = {
  /**
   * Bumped on every write. A writer that read version N refuses to store N+1
   * if the document already moved on — two tabs, or a voice command racing a
   * drag, otherwise silently discard each other's work.
   */
  version: number;
  updatedAt: string;
  project: ProjectMeta;
  calendar: { workingDays: IsoWeekday[]; holidays: IsoDate[] };
  sections: Section[];
  tasks: Activity[];
  deps: TaskDep[];
  contacts: Contact[];
  /** Newest first, capped — see `MAX_CHANGE_LOG` in `history.ts`. */
  changeLog: ChangeEntry[];
  /** The read-only link handed to the crew. */
  share: { token: string; enabled: boolean };
};
