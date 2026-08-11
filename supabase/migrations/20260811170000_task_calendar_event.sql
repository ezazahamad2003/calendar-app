-- ============================================================================
-- Foreman — Phase 9c · The schedule shows up on your own calendar
--
-- Calendar events were only ever created as a side effect of *assigning
-- someone*: no assignee, no event. So a contractor who scheduled their own
-- week in Foreman saw none of it in Google Calendar or Outlook, which is where
-- they actually look. The app's whole subject is the schedule; not putting it
-- on the user's calendar was the gap.
--
-- Every dated task now gets one event on the connected account's default
-- calendar, with any assignees as attendees. One event, not one per person —
-- which also removes a duplicate-event bug waiting to happen, where an
-- assignment invite and a calendar copy would both have been created for the
-- same task.
--
-- Two columns rather than one: an event id is only meaningful against the
-- provider that issued it. Someone who connects Gmail, syncs, then switches to
-- Outlook must get fresh events created rather than PATCHes against a Google
-- id that Microsoft has never heard of.
-- ============================================================================

alter table public.tasks add column calendar_event_id text;
alter table public.tasks add column calendar_provider public.oauth_provider;

comment on column public.tasks.calendar_event_id is
  'Event id on the connected account, so a rescheduled task updates its event instead of creating a second one. NULL = never synced.';

comment on column public.tasks.calendar_provider is
  'Which provider issued calendar_event_id. An id from one provider is meaningless to the other, so both are stored and compared before any update.';

-- Both columns are written by the app through the user-scoped client, so the
-- existing task RLS policies already cover them. No grant changes needed.
