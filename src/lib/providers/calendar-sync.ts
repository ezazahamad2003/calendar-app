import "server-only";

import { createClient } from "@/lib/supabase/server";
import { providerClientFor } from "./factory";
import { ProviderAuthError } from "./client";
import { getEnv } from "@/lib/env";

/**
 * Push the schedule onto the user's own calendar.
 *
 * One event per dated task, on the connected account's default calendar, with
 * any assignees as attendees. Created the first time, updated every time after
 * — the event id is kept on the task, so moving a task moves its event rather
 * than leaving a stale one behind and adding a second.
 *
 * One-way by design (SPEC §1, FEATURE_TWO_WAY_CALENDAR_SYNC): the app is the
 * source of truth and the calendar is a view of it. Reading changes back needs
 * change notifications and subscription renewal, which is a different feature.
 *
 * Never throws. A calendar that failed to update is worth telling the user
 * about, but it must not unwind a schedule change that already committed.
 */

export type SyncResult = {
  created: number;
  updated: number;
  failed: number;
  /** No account connected — nothing was pushed anywhere. */
  skipped: boolean;
};

const NOTHING: SyncResult = { created: 0, updated: 0, failed: 0, skipped: true };

export async function syncTasksToCalendar(
  orgId: string,
  userId: string,
  taskIds: string[],
): Promise<SyncResult> {
  if (taskIds.length === 0) return { ...NOTHING, skipped: false };

  const { client, mocked, provider } = await providerClientFor(orgId, userId);
  // A mock client would hand back fixture ids that then get stored as if they
  // were real, and the next update would PATCH an id no provider knows.
  if (mocked || !provider) return NOTHING;

  const supabase = await createClient();
  const [{ data: tasks }, { data: org }] = await Promise.all([
    supabase
      .from("tasks")
      .select(
        "id, name, start_date, end_date, notes, calendar_event_id, calendar_provider, projects(name)",
      )
      .eq("org_id", orgId)
      .in("id", taskIds),
    supabase.from("orgs").select("timezone").eq("id", orgId).maybeSingle(),
  ]);

  if (!tasks || tasks.length === 0) return { ...NOTHING, skipped: false };

  const timeZone = org?.timezone ?? "UTC";
  const inviteAttendees = getEnv().FEATURE_INVITE_ATTENDEES;

  // Assignees, so the same event carries the people on it rather than a
  // separate invite per person.
  const { data: assigns } = await supabase
    .from("assignments")
    .select("task_id, contacts(name, email)")
    .eq("org_id", orgId)
    .in("task_id", tasks.map((t) => t.id));

  const attendeesByTask = new Map<string, { address: string; name?: string }[]>();
  for (const row of assigns ?? []) {
    if (!row.contacts?.email) continue;
    const list = attendeesByTask.get(row.task_id) ?? [];
    list.push({ address: row.contacts.email, name: row.contacts.name });
    attendeesByTask.set(row.task_id, list);
  }

  let created = 0;
  let updated = 0;
  let failed = 0;

  for (const task of tasks) {
    // An undated task has nothing to put on a calendar. If it previously had
    // an event, it is left alone rather than deleted — losing the id would
    // orphan the event, and deleting is not this function's job.
    if (!task.start_date) continue;

    const event = {
      subject: `${task.name}${task.projects?.name ? ` — ${task.projects.name}` : ""}`,
      startDate: task.start_date,
      endDate: task.end_date ?? task.start_date,
      timeZone,
      body: task.notes ?? undefined,
      attendees: inviteAttendees ? attendeesByTask.get(task.id) : undefined,
    };

    // Only reuse an id the CURRENT provider issued. After switching accounts
    // the old id is meaningless and must produce a fresh event.
    const reusable =
      task.calendar_event_id && task.calendar_provider === provider
        ? task.calendar_event_id
        : null;

    try {
      if (reusable) {
        await client.updateEvent(reusable, event);
        updated += 1;
      } else {
        const { eventId } = await client.createEvent(event);
        await supabase
          .from("tasks")
          .update({ calendar_event_id: eventId, calendar_provider: provider })
          .eq("org_id", orgId)
          .eq("id", task.id);
        created += 1;
      }
    } catch (err) {
      failed += 1;
      // A dead grant fails every remaining task the same way; stop rather than
      // hammer the provider with calls that cannot succeed.
      if (err instanceof ProviderAuthError) break;
    }
  }

  return { created, updated, failed, skipped: false };
}
